-- Mounts (core/mounts): the automounts, which the app mounts each time it starts, and the
-- stopped mounts whose cache still holds uploads that rclone hadn't sent.

-- An automount. A remote can have several, each with its own folder and mount point.
CREATE TABLE automounts (
  id          TEXT PRIMARY KEY,
  remote      TEXT NOT NULL,              -- the remote's name, which a rename rewrites
  remote_path TEXT NOT NULL DEFAULT '',   -- the folder in the remote, '' for its root
  mount_point TEXT NOT NULL,
  options     TEXT NOT NULL DEFAULT '{}', -- the Mount form's option groups, JSON
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

-- A stopped mount whose VFS cache (<cache>/vfs/<folder>) still holds uploads. "Mount again"
-- sends them, and "Discard" deletes them.
CREATE TABLE stopped_mounts (
  folder      TEXT PRIMARY KEY,  -- 16 hex
  source      TEXT NOT NULL,
  mount_point TEXT NOT NULL,
  args        TEXT NOT NULL,     -- the Mount form's arguments, JSON
  pending     INTEGER,           -- files waiting, when known
  stopped_ms  INTEGER NOT NULL
);
