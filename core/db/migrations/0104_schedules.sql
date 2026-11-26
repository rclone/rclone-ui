CREATE TABLE schedules (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL COLLATE NOCASE UNIQUE,
  operation        TEXT NOT NULL CHECK (operation IN ('copy','move','sync','bisync','delete','purge')),
  args             TEXT NOT NULL,
  cron             TEXT NOT NULL,
  paused           INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  baselined        INTEGER NOT NULL DEFAULT 0,
  last_due         INTEGER NOT NULL,
  last_run_at      INTEGER,
  last_result      TEXT NOT NULL DEFAULT '',
  last_error       TEXT NOT NULL DEFAULT '',
  last_transfer_id TEXT NOT NULL DEFAULT '',
  last_skipped_at  INTEGER,
  running_id       TEXT NOT NULL DEFAULT '',
  resume           INTEGER NOT NULL DEFAULT 0
);
