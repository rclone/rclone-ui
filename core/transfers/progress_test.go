package transfers

import (
	"context"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone/fs/accounting"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/operations"
)

// TestProgressOf checks that a running transfer's numbers come from rclone. The keys themselves
// are checked by TestStatsAreRclones in core/rclone.
func TestProgressOf(t *testing.T) {
	ctx := context.Background()
	stats := accounting.NewStats(ctx)
	tr := stats.NewTransferRemoteSize("moving.bin", 100, nil, nil)
	acc := tr.Account(ctx, io.NopCloser(strings.NewReader(strings.Repeat("x", 100))))
	if _, err := io.CopyN(io.Discard, acc, 40); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = acc.Close()
		tr.Done(ctx, nil)
	}()

	p := progressOf(7, stats, nil)
	if p.Bytes != 40 || p.TotalBytes != 100 || p.Pct != 40 || p.TotalFiles != 1 || len(p.Transferring) != 1 {
		t.Errorf("progress: %+v", p)
	}
}

// TestNoProgressAfterTheEnd checks a tick that read a transfer's numbers before its end was
// written. The tick must not publish the transfer as live, because its end may already have been
// reported. It must not record the transfer's files after the end recorded its own.
func TestNoProgressAfterTheEnd(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	const id = "3000-aaaaaa"
	f.seed(id, 3000, map[string]any{"state": "running", "ended_ms": nil})
	stats := accounting.NewStats(ctx)
	tr := stats.NewTransferRemoteSize("late.bin", 1, nil, nil)
	tr.Done(ctx, nil)
	plan := planOf(operations.Step{Op: operations.OpDelete, Src: "/a"})
	rn := &running{id: id, seq: 3000, plan: *plan, rec: operations.NewRecord(*plan), stats: stats}
	f.s.mu.Lock()
	f.s.running[id] = rn
	f.s.mu.Unlock()
	f.s.snapshotted = func() {
		// The end handler runs between the tick's read and its writes.
		f.exec(`UPDATE transfers SET ended_ms = 3010, state = 'completed' WHERE id = ?`, id)
		f.s.mu.Lock()
		delete(f.s.running, id)
		f.s.mu.Unlock()
	}
	f.s.tick(ctx)
	testutil.Eventually(t, 5*time.Second, "the tick's progress", func() bool { return len(f.published(bus.TransfersProgress)) == 1 })
	if items := f.published(bus.TransfersProgress)[0].Data.(bus.TransfersProgressData).Items; len(items) != 0 {
		t.Errorf("published %+v after the end", items)
	}
	var n int
	if err := f.db.R.QueryRow(`SELECT COUNT(*) FROM transfer_files WHERE transfer_id = ?`, id).Scan(&n); err != nil || n != 0 {
		t.Errorf("%d rows recorded after the end (%v)", n, err)
	}
}

// TestStoppedKeepsLiveTotal checks that the total from the last tick is kept when the stats group
// lost the files a stop cut short, and that a larger final total wins.
func TestStoppedKeepsLiveTotal(t *testing.T) {
	stopped := withLiveTotal(Summary{Bytes: 3 << 20, TotalBytes: 3 << 20}, &bus.TransferProgress{TotalBytes: 600 << 20})
	if stopped.TotalBytes != 600<<20 || stopped.Bytes != 3<<20 {
		t.Errorf("stopped: %+v", stopped)
	}
	grown := withLiveTotal(Summary{Bytes: 10, TotalBytes: 20}, &bus.TransferProgress{TotalBytes: 15})
	if grown.TotalBytes != 20 {
		t.Errorf("a final total above the last tick's: %+v", grown)
	}
	if none := withLiveTotal(Summary{TotalBytes: 5}, nil); none.TotalBytes != 5 {
		t.Errorf("no tick: %+v", none)
	}
}

// A bisync lifts the cap on the finished files of its stats group. Each tick puts it back, so the
// group keeps no more than maxCompleted finished files, plus rclone's margin for the running ones.
func TestCapCompleted(t *testing.T) {
	ctx := context.Background()
	stats := accounting.NewStats(ctx)
	stats.SetMaxCompletedTransfers(-1) // as bisync does
	for i := range maxCompleted + 500 {
		stats.NewTransferRemoteSize(fmt.Sprint(i), 1, nil, nil).Done(ctx, nil)
	}
	if n := len(stats.Transferred()); n != maxCompleted+500 {
		t.Fatalf("before: %d finished files kept", n)
	}
	capCompleted(stats)
	if n := len(stats.Transferred()); n > maxCompleted+4 {
		t.Errorf("after: %d finished files kept, want at most %d", n, maxCompleted+4)
	}
}
