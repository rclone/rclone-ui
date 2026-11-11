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
	tickEvery = time.Second
	// liveTransferred is how many of the newest finished files transfers.progress includes.
	liveTransferred = 50
)

// startTicker starts the progress ticker unless it is already running. The caller holds s.mu.
func (s *Service) startTicker() {
	if s.ticking {
		return
	}
	s.ticking = true
	s.run.Go("transfers.progress", s.tickLoop)
}

// tickLoop runs one tick a second while any transfer is running, and returns when none is.
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

// tick reads each running transfer's stats through the pointer to its own group, never through
// an rc call by the group's name. It merges the files they finished into transfer_files in one
// transaction, and publishes transfers.progress. It returns false when nothing is running, and
// the ticker then stops.
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
		stepOf := stepMatcher(rn.plan, rn.rec.Steps()) // what the steps have opened by now
		items[rn.id] = progressOf(rn.seq, rn.stats, done)
		if rn.watcher {
			p := items[rn.id]
			p.Watcher = true
			items[rn.id] = p
		}
		// Keep only what is new since the last tick, because rclone lists up to maxCompleted
		// files again each time.
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
				// If the transfer's end was written since, the end merged its files and trimmed
				// them to their limits. These rows would come after it, so skip them.
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
	// Publish only the transfers that still run. One that ended after its numbers were read may
	// have had its end reported already, and the pages would treat it as live again. The numbers
	// are published under the lock, so an end that comes later is reported after them.
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

// progressOf returns one running transfer's numbers in the form that transfers.progress sends.
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
	if st.Eta != nil {
		e := int64(math.Round(*st.Eta))
		p.Eta = &e
	}
	if p.TotalBytes > 0 {
		p.Pct = int(min(100, math.Round(float64(p.Bytes)*100/float64(p.TotalBytes))))
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
