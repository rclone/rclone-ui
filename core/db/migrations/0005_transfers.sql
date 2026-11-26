CREATE TABLE transfers (
  id           TEXT PRIMARY KEY,
  seq          INTEGER NOT NULL UNIQUE,
  created_ms   INTEGER NOT NULL,
  started_ms   INTEGER,
  ended_ms     INTEGER,
  state        TEXT NOT NULL CHECK (state IN
                ('queued','running','completed','failed','stopped','interrupted')),
  resume       INTEGER NOT NULL DEFAULT 0,
  operation    TEXT NOT NULL,
  sources      TEXT NOT NULL,
  destination  TEXT,
  is_dry_run   INTEGER NOT NULL DEFAULT 0,
  origin_kind  TEXT NOT NULL CHECK (origin_kind IN
                ('page','commander','template','watcher','schedule','agent')),
  origin_id    TEXT,
  origin_name  TEXT,
  args         TEXT,
  preset       TEXT,
  request      TEXT NOT NULL,
  stats_group  TEXT NOT NULL,
  retry_of     TEXT,
  error        TEXT,
  final_stats  TEXT,
  job_output   TEXT
);
CREATE INDEX transfers_created ON transfers(created_ms DESC, id DESC);
CREATE INDEX transfers_open    ON transfers(state) WHERE state IN ('queued','running');

CREATE TABLE transfer_files (
  transfer_id  TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  outcome      TEXT NOT NULL CHECK (outcome IN ('transferred','failed','checked')),
  src_fs       TEXT NOT NULL,
  name         TEXT NOT NULL,
  input        INTEGER,
  what         TEXT,
  dst_fs       TEXT,
  size         INTEGER,
  bytes        INTEGER,
  error        TEXT,
  completed_ms INTEGER,
  PRIMARY KEY (transfer_id, outcome, src_fs, name)
);
