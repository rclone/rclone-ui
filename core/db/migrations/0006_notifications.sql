CREATE TABLE notification_targets (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  provider     TEXT NOT NULL,
  url          TEXT NOT NULL,
  url_key      TEXT NOT NULL UNIQUE,
  events       TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_sent_ms INTEGER,
  last_error   TEXT,
  created_ms   INTEGER NOT NULL,
  updated_ms   INTEGER NOT NULL
);

CREATE TABLE notification_smtp (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  host         TEXT NOT NULL,
  port         INTEGER NOT NULL,
  encryption   TEXT NOT NULL,
  username     TEXT NOT NULL DEFAULT '',
  from_address TEXT NOT NULL,
  from_name    TEXT NOT NULL DEFAULT '',
  updated_ms   INTEGER NOT NULL
);
