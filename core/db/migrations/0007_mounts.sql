CREATE TABLE automounts (
  id          TEXT PRIMARY KEY,
  remote      TEXT NOT NULL,
  remote_path TEXT NOT NULL DEFAULT '',
  mount_point TEXT NOT NULL,
  options     TEXT NOT NULL DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

CREATE TABLE stopped_mounts (
  folder      TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  mount_point TEXT NOT NULL,
  args        TEXT NOT NULL,
  pending     INTEGER,
  stopped_ms  INTEGER NOT NULL
);
