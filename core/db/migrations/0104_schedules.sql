-- Schedules (core/schedules). A schedule runs an operation's form at the times of a cron
-- expression. The columns after created_at are its run state, which the scheduler writes as runs
-- start and end. Times are in ms.

CREATE TABLE schedules (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL COLLATE NOCASE UNIQUE,
  operation        TEXT NOT NULL CHECK (operation IN ('copy','move','sync','bisync','delete','purge')),
  args             TEXT NOT NULL,               -- the operation's arguments (operations.Form.MarshalArgs), which each run starts from
  cron             TEXT NOT NULL,
  paused           INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  baselined        INTEGER NOT NULL DEFAULT 0,  -- for a bisync: a merge has succeeded for its two paths
  last_due         INTEGER NOT NULL,            -- the latest scheduled time that was dealt with
  last_run_at      INTEGER,                     -- when the last run ended
  last_result      TEXT NOT NULL DEFAULT '',    -- '', 'completed', 'nothing', 'failed', 'stopped' or 'interrupted'
  last_error       TEXT NOT NULL DEFAULT '',
  last_transfer_id TEXT NOT NULL DEFAULT '',    -- the last run's transfer, '' for a run refused before it started
  last_skipped_at  INTEGER,                     -- a time skipped because the run before it was still going
  running_id       TEXT NOT NULL DEFAULT '',    -- the transfer of the run in progress, until its end is recorded
  resume           INTEGER NOT NULL DEFAULT 0   -- the last run was cut short by a quit: it runs once more at the next start
);
