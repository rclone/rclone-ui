package transfers

import (
	"errors"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/internal/testutil"
	"github.com/rclone/rclone-ui/core/notifications"
	"github.com/rclone/rclone-ui/core/operations"
)

// fakeOwner owns transfers as a watcher does: an end that changed nothing is quiet. It hands
// each end it hears to ended.
type fakeOwner struct {
	ended chan Transfer
}

func (o *fakeOwner) Quiet(state State, _ string, s *Summary) bool {
	return state == StateCompleted && ChangedNothing(s)
}

func (o *fakeOwner) Ended(t Transfer) { o.ended <- t }

// An owned transfer tells neither the desktop nor the notification targets. When its owner finds
// its end quiet, it is dropped from the record before the pages hear about its end. Any other end
// stays. The owner hears each end. A retry of an owned transfer is the user's own run: its owner
// hears nothing, and the targets are told.
func TestOwnedRuns(t *testing.T) {
	f := newFixture(t)
	src, dst := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(src, "a.txt"), 10)
	owner := &fakeOwner{ended: make(chan Transfer, 4)}
	run := func(source, retryOf string) Started {
		t.Helper()
		// A prebuilt plan, so that a missing source is recorded and fails as it runs.
		started, err := f.s.Start(f.ctx, Spec{
			Form: operations.Form{Operation: "sync"}, Sources: []string{source}, Destination: dst, Plan: syncOf(source, dst),
			Origin: Origin{Kind: OriginWatcher, ID: "w1", Name: "Photos"}, RetryOf: retryOf, Owner: owner,
		})
		if err != nil && started.ID == "" {
			t.Fatal(err)
		}
		return started
	}

	// f.wait reads the row, which a quiet run no longer has, so wait for the owner to hear it.
	next := func() Transfer {
		t.Helper()
		select {
		case tr := <-owner.ended:
			testutil.Eventually(t, 5*time.Second, "the end published", func() bool { return f.endPublished(tr.ID) })
			return tr
		case <-time.After(30 * time.Second):
			t.Fatal("no end")
		}
		return Transfer{}
	}

	changed := run(src, "")
	if tr := next(); tr.ID != changed.ID || tr.State != StateCompleted || tr.Stats == nil || tr.Stats.Transfers != 1 {
		t.Fatalf("the first run ended as %+v", tr)
	}
	if _, err := f.s.get(f.ctx, changed.ID); err != nil {
		t.Errorf("a run that copied a file was dropped: %v", err)
	}

	// The quiet run is never seen as ended: each read of it while it runs finds it running or
	// gone.
	stopReads := make(chan struct{})
	readsDone := make(chan struct{})
	var seenEnded []string
	go func() {
		defer close(readsDone)
		for {
			select {
			case <-stopReads:
				return
			default:
			}
			page, err := f.s.Ended(f.ctx, EndedQuery{Limit: 50})
			if err == nil {
				for _, tr := range page.Items {
					if tr.ID != changed.ID {
						seenEnded = append(seenEnded, tr.ID)
					}
				}
			}
		}
	}()
	idle := run(src, "")
	tr := next()
	close(stopReads)
	<-readsDone
	if tr.ID != idle.ID || tr.State != StateCompleted || tr.EndedAt == nil {
		t.Fatalf("the idle run ended as %+v", tr)
	}
	if len(seenEnded) > 0 {
		t.Errorf("the idle run was read as ended: %v", seenEnded)
	}
	if _, err := f.s.get(f.ctx, idle.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("a run that changed nothing is still recorded: %v", err)
	}

	failed := run(filepath.Join(src, "missing"), "")
	if tr := next(); tr.ID != failed.ID || tr.State != StateFailed {
		t.Fatalf("the failing run ended as %+v", tr)
	}
	if _, err := f.s.get(f.ctx, failed.ID); err != nil {
		t.Errorf("a failed run was dropped: %v", err)
	}

	f.settled()
	for _, started := range []Started{changed, idle, failed} {
		if got := f.notes.events(started.Seq); len(got) > 0 {
			t.Errorf("run %d notified %v", started.Seq, got)
		}
	}
	if got := f.toasts(); len(got) > 0 {
		t.Errorf("desktop notifications %+v", got)
	}
	for _, ev := range f.published(bus.TransfersChanged) {
		d := ev.Data.(bus.TransfersChangedData)
		if d.ID == idle.ID && d.State != string(StateRunning) && d.State != string(StateDropped) {
			t.Errorf("the idle run was reported %s", d.State)
		}
	}

	retry := run(filepath.Join(src, "missing"), failed.ID)
	if got := f.wait(retry.ID); got.State != StateFailed || got.Origin.Kind != OriginWatcher {
		t.Fatalf("the retry ended as %+v", got)
	}
	f.settled()
	select {
	case tr := <-owner.ended:
		t.Errorf("the owner heard the retry's end: %+v", tr)
	default:
	}
	if got := f.notes.events(retry.Seq); !slices.Equal(got, []notifications.NotificationEvent{notifications.NotificationEventJobFailed}) {
		t.Errorf("the retry notified %v", got)
	}
}
