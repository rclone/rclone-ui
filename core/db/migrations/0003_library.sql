-- Templates (core/templates) and favourites (core/favorites).

CREATE TABLE templates (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  tags       TEXT NOT NULL,              -- JSON array of operation names
  options    TEXT NOT NULL DEFAULT '{}', -- JSON object of flat rclone flags, in order
  paths      TEXT,                       -- JSON {sources, destination}, or NULL
  position   INTEGER NOT NULL,           -- the order shown in the list
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE favorites (
  path     TEXT PRIMARY KEY,             -- an rclone path
  added_at INTEGER NOT NULL
);

