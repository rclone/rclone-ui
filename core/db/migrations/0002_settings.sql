CREATE TABLE settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  doc        TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE prefs (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
