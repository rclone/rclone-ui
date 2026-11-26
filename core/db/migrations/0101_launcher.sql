CREATE TABLE launcher_usage (
  key       TEXT PRIMARY KEY,
  count     INTEGER NOT NULL,
  last_used INTEGER NOT NULL,
  queries   TEXT NOT NULL DEFAULT '[]'
);
