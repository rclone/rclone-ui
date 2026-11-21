-- Watchers (core/watchers). A watcher keeps two folders the same with a bisync every minute. The
-- columns after created_at are its run state, which the scheduler writes as runs end.

CREATE TABLE watchers (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL COLLATE NOCASE UNIQUE,
  path_a           TEXT NOT NULL,
  path_b           TEXT NOT NULL,
  paused           INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  baselined        INTEGER NOT NULL DEFAULT 0,  -- a resync has succeeded for these two paths
  last_run_at      INTEGER,                     -- when the last run ended
  last_result      TEXT NOT NULL DEFAULT '',    -- '' before the first run ends, 'synced' or 'failed'
  last_error       TEXT NOT NULL DEFAULT '',
  last_change_at   INTEGER,                     -- when the last run that changed something ended
  last_change_id   TEXT NOT NULL DEFAULT '',    -- that run's transfer
  last_transfer_id TEXT NOT NULL DEFAULT '',    -- the last run that History keeps (changed or failed)
  attention        TEXT NOT NULL DEFAULT '',    -- '', or why it needs the user: 'resync' or 'deletes'
  deleted_side     TEXT NOT NULL DEFAULT ''     -- for 'deletes': 'a' or 'b', or '' when not known
);
