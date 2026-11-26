CREATE TABLE config (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  password_command TEXT NOT NULL DEFAULT ''
);

CREATE TABLE remote_fsinfo (
  remote        TEXT PRIMARY KEY,
  fsinfo        TEXT,
  fsinfo_ms     INTEGER,
  updated_ms    INTEGER NOT NULL
);
