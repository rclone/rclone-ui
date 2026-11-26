package transfers

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"slices"
	"time"

	"github.com/rclone/rclone/fs/accounting"

	"github.com/rclone/rclone-ui/core/bus"
	"github.com/rclone/rclone-ui/core/rclone"
)

const (
	tickEvery       = time.Second
	liveTransferred = 50
)

func (s *Service) startTicker() {
	if s.ticking {
		return
	}
	s.ticking = true
	s.run.Go("transfers.progress", s.tickLoop)
}

func (s *Service) tickLoop(ctx context.Context) {
	t := time.NewTicker(tickEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			s.mu.Lock()
			s.ticking = false
			s.mu.Unlock()
			return
		case <-t.C:
		}
		if !s.tick(ctx) {
			return
		}
	}
}

func (s *Service) tick(ctx context.Context) bool {
	s.mu.Lock()
	if len(s.running) == 0 {
		s.ticking = false
		s.mu.Unlock()
		return false
	}
	all := make([]*running, 0, len(s.running))
	for _, rn := range s.running {
		all = append(all, rn)
	}
	s.mu.Unlock()

	type merge struct {
		id   string
		rows []fileRow
	}
	var merges []merge
	items := make(map[string]bus.TransferProgress, len(all))
	for _, rn := range all {
		done := rn.stats.Transferred()
		capCompleted(rn.stats)
		stepOf := stepMatcher(rn.plan, rn.rec.Steps())
		items[rn.id] = progressOf(rn.seq, rn.stats, done)
		if rn.watcher {
			p := items[rn.id]
			p.Watcher = true
			items[rn.id] = p
		}
		// rclone lists up to maxCompleted finished files again on each tick.
		seen := make(map[fileKey]int64, len(done))
		var rows []fileRow
		for _, snap := range done {
			k := fileKey{snap.SrcFs, snap.Name, snap.What}
			at := snap.CompletedAt.UnixNano()
			seen[k] = at
			if rn.prev[k] != at {
				rows = append(rows, rowOf(snap, stepOf))
			}
		}
		rn.prev = seen
		if len(rows) > 0 {
			merges = append(merges, merge{rn.id, rows})
		}
	}
	if s.snapshotted != nil {
		s.snapshotted()
	}
	if len(merges) > 0 {
		err := s.db.Write(ctx, func(tx *sql.Tx) error {
			m, err := newFileMerger(ctx, tx)
			if err != nil {
				return err
			}
			defer m.close()
			for _, mg := range merges {
				var open bool
				err := tx.QueryRowContext(ctx, `SELECT ended_ms IS NULL FROM transfers WHERE id = ?`, mg.id).Scan(&open)
				if errors.Is(err, sql.ErrNoRows) || err == nil && !open {
					continue
				}
				if err != nil {
					return err
				}
				for _, r := range mg.rows {
					if err := m.add(ctx, mg.id, r); err != nil {
						return err
					}
				}
			}
			return m.trim(ctx)
		})
		if err != nil && ctx.Err() == nil {
			s.log.ErrorContext(ctx, "recording transfers' files", "error", err)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	live := make(map[string]bus.TransferProgress, len(all))
	for _, rn := range all {
		if s.running[rn.id] != rn {
			continue
		}
		p := items[rn.id]
		rn.live = &p
		live[rn.id] = p
	}
	s.bus.Publish(bus.TransfersProgress, bus.TransfersProgressData{Items: live})
	return true
}

func progressOf(seq int64, stats *accounting.StatsInfo, done []accounting.TransferSnapshot) bus.TransferProgress {
	st := rclone.StatsOf(stats, false)
	p := bus.TransferProgress{
		Seq: seq, State: string(StateRunning),
		Bytes: stats.GetBytes(), TotalBytes: st.TotalBytes, Speed: st.Speed,
		Files: stats.GetTransfers(), TotalFiles: st.TotalTransfers,
		Errors: stats.GetErrors(), Checks: stats.GetChecks(), Listed: st.Listed,
		Transferring: []bus.TransferringFile{}, Checking: []bus.CheckingFile{},
		Transferred: []bus.TransferredFile{},
	}
	if st.ETASeconds != nil {
		e := int64(math.Round(*st.ETASeconds))
		p.ETASeconds = &e
	}
	if p.TotalBytes > 0 {
		p.Pct = int(min(100, p.Bytes*100/p.TotalBytes))
	}
	for _, tr := range st.Transferring {
		p.Transferring = append(p.Transferring, bus.TransferringFile{
			Name: tr.Name, Size: tr.Size, Bytes: tr.Bytes, Pct: tr.Percentage, Speed: tr.Speed,
		})
	}
	for _, name := range st.Checking {
		p.Checking = append(p.Checking, bus.CheckingFile{Name: name})
	}
	var files []accounting.TransferSnapshot
	for _, snap := range done {
		if !snap.Checked {
			files = append(files, snap)
		}
	}
	slices.SortStableFunc(files, func(a, b accounting.TransferSnapshot) int {
		return b.CompletedAt.Compare(a.CompletedAt)
	})
	for _, snap := range files[:min(len(files), liveTransferred)] {
		f := bus.TransferredFile{Name: snap.Name, Size: snap.Size, Bytes: snap.Bytes}
		if snap.Error != nil {
			f.Error = snap.Error.Error()
		}
		p.Transferred = append(p.Transferred, f)
	}
	return p
}

// capCompleted sets the most finished files that stats keeps back to maxCompleted, and lets go of
// the oldest ones past it. A bisync lifts the cap (see maxCompleted), and without it each tick
// would copy and sort every file that the bisync finished, and its end would write them all.
func capCompleted(stats *accounting.StatsInfo) {
	stats.SetMaxCompletedTransfers(maxCompleted)
	stats.RemoveDoneTransfers()
}
