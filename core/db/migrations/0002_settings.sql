-- The settings document (core/settings) and the UI's preferences (core/prefs).

-- A single row. doc holds the settings as JSON (settings.Settings).
CREATE TABLE settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  doc        TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Pure UI preferences: a JSON value per key.
CREATE TABLE prefs (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
