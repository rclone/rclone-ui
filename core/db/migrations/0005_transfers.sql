-- The transfer history (core/transfers): every transfer the app starts, and each file that a
-- transfer has finished with.

CREATE TABLE transfers (
  id           TEXT PRIMARY KEY,         -- <ms>-<6 hex>
  seq          INTEGER NOT NULL UNIQUE,  -- the number shown in the pages
  created_ms   INTEGER NOT NULL,
  started_ms   INTEGER,
  ended_ms     INTEGER,
  state        TEXT NOT NULL CHECK (state IN
                ('queued','running','completed','failed','stopped','interrupted')),
  resume       INTEGER NOT NULL DEFAULT 0, -- 1: start again after a planned restart
  operation    TEXT NOT NULL,            -- copy|move|sync|bisync|delete|purge|download|cleanup
  sources      TEXT NOT NULL,            -- JSON array
  destination  TEXT,
  is_dry_run   INTEGER NOT NULL DEFAULT 0,
  origin_kind  TEXT NOT NULL CHECK (origin_kind IN
                ('page','commander','template','watcher','schedule','agent')),
  origin_id    TEXT,                     -- the template's, watcher's or schedule's id
  origin_name  TEXT,                     -- and its name when the transfer started, or the agent's client
  args         TEXT,                     -- JSON form arguments
  preset       TEXT,                     -- JSON {operation, args}, for "Reuse settings" and retries
  request      TEXT NOT NULL,            -- JSON of the plan it runs (core/operations Plan)
  stats_group  TEXT NOT NULL,            -- transfer/<id>
  retry_of     TEXT,
  error        TEXT,
  final_stats  TEXT,                     -- JSON {bytes,totalBytes,transfers,checks,errors,durationMs}
  job_output   TEXT                      -- JSON {v, errors}: each step's error by index, for a retry
);
CREATE INDEX transfers_created ON transfers(created_ms DESC, id DESC);
CREATE INDEX transfers_open    ON transfers(state) WHERE state IN ('queued','running');

-- The outcome of each file, merged in from the stats group every second.
CREATE TABLE transfer_files (
  transfer_id  TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  outcome      TEXT NOT NULL CHECK (outcome IN ('transferred','failed','checked')),
  src_fs       TEXT NOT NULL,            -- the same name under a different source is a different file
  name         TEXT NOT NULL,
  input        INTEGER,                  -- the index of the plan step it belongs to, when known
  what         TEXT,                     -- rclone's what and dstFs, for a retry
  dst_fs       TEXT,
  size         INTEGER,
  bytes        INTEGER,
  error        TEXT,
  completed_ms INTEGER,
  PRIMARY KEY (transfer_id, outcome, src_fs, name)
);
-- Each transfer keeps up to 1 000 failed files, and the newest 1 000 transferred and checked
-- files.
