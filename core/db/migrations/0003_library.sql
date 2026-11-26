CREATE TABLE templates (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  tags       TEXT NOT NULL,
  options    TEXT NOT NULL DEFAULT '{}',
  paths      TEXT,
  position   INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE favorites (
  path     TEXT PRIMARY KEY,
  added_at INTEGER NOT NULL
);

