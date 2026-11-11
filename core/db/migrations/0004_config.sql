-- The rclone config file (core/config), and each of its remotes' cached fsinfo (core/remotes). The
-- file belongs to rclone, and these rows only refer to it.

-- One row (id 1), written when the config's password command is first set.
CREATE TABLE config (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  password_command TEXT NOT NULL DEFAULT ''
);

-- One row per remote in the config file, with a cached copy of rclone's fsinfo. The row is added
-- when the app sees the remote, and the cache only fills existing rows, so a remote deleted while
-- its fsinfo was being fetched gets no row back.
CREATE TABLE remote_fsinfo (
  remote        TEXT PRIMARY KEY,
  fsinfo        TEXT,
  fsinfo_ms     INTEGER,
  updated_ms    INTEGER NOT NULL
);
