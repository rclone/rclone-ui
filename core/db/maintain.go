package db

import (
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"time"

	"github.com/rclone/rclone-ui/core/logs"
)

const (
	maintainEvery   = 10 * time.Minute
	optimizeEvery   = 24 * time.Hour
	checkpointAbove = 16 << 20 // WAL bytes
	// maintenanceBusyMS limits how long a checkpoint may hold writers back while it waits for
	// readers. After that, it checkpoints what it can without waiting.
	maintenanceBusyMS = 100
)

// Maintain blocks until ctx ends. Every 10 minutes it truncates the WAL if it has grown over
// 16 MB, and once a day it refreshes the query planner's statistics. Start it with the core's Go.
func (d *DB) Maintain(ctx context.Context) {
	log := logs.Logger(logs.CompDB, logs.SubMaintenance)
	// Use a separate connection, not the writer, because the core's writes queue behind the
	// writer.
	m, err := sql.Open("sqlite", d.dsn(maintenanceBusyMS))
	if err != nil {
		log.ErrorContext(ctx, "maintenance connection", "error", err)
		return
	}
	defer func() { _ = m.Close() }()
	m.SetMaxOpenConns(1)

	optimized := time.Now() // Open ran optimize=0x10002
	tick := time.NewTicker(maintainEvery)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		if _, err := d.checkpoint(ctx, m, checkpointAbove, log); err != nil && ctx.Err() == nil {
			log.WarnContext(ctx, "checkpoint", "error", err)
		}
		if time.Since(optimized) >= optimizeEvery {
			if _, err := d.W.ExecContext(ctx, "PRAGMA optimize"); err != nil && ctx.Err() == nil {
				log.WarnContext(ctx, "optimize", "error", err)
			}
			optimized = time.Now()
		}
	}
}

// checkpoint runs wal_checkpoint(TRUNCATE) on m when the WAL is larger than above bytes. If a
// reader is still on an older snapshot, it waits only for m's busy timeout and then falls back
// to a passive checkpoint (and reports busy), instead of holding writers back.
func (d *DB) checkpoint(ctx context.Context, m *sql.DB, above int64, log *slog.Logger) (busy bool, err error) {
	info, err := os.Stat(d.Path + "-wal")
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if info.Size() <= above {
		return false, nil
	}
	var blocked, frames, done int
	if err := m.QueryRowContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)").Scan(&blocked, &frames, &done); err != nil {
		return false, err
	}
	log.DebugContext(ctx, "checkpoint", "wal_bytes", info.Size(), "busy", blocked == 1, "frames", frames, "checkpointed", done)
	return blocked == 1, nil
}
