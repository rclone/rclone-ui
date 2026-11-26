CREATE TABLE watchers (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL COLLATE NOCASE UNIQUE,
  path_a           TEXT NOT NULL,
  path_b           TEXT NOT NULL,
  paused           INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  baselined        INTEGER NOT NULL DEFAULT 0,
  last_run_at      INTEGER,
  last_result      TEXT NOT NULL DEFAULT '',
  last_error       TEXT NOT NULL DEFAULT '',
  last_change_at   INTEGER,
  last_change_id   TEXT NOT NULL DEFAULT '',
  last_transfer_id TEXT NOT NULL DEFAULT '',
  attention        TEXT NOT NULL DEFAULT '',
  deleted_side     TEXT NOT NULL DEFAULT ''
);
