-- The launcher's usage history (core/launcher), with one row per result the user picked.

CREATE TABLE launcher_usage (
  key       TEXT PRIMARY KEY,            -- the launcher's Key
  count     INTEGER NOT NULL,
  last_used INTEGER NOT NULL,            -- ms
  queries   TEXT NOT NULL DEFAULT '[]'   -- JSON array: the last distinct queries, newest first
);
