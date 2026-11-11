-- App-level markers, one row per key. These are facts the core records about itself rather than
-- about a domain, such as the hash of the schema that made the file (schema, core/db/schema.go)
-- or whether the remote tunnel comes back at the next start (tunnel.restore). Domains keep their
-- own tables. Rows are written with db.SetMeta and read with (*DB).GetMeta.
CREATE TABLE meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL  -- ms since the epoch, UTC (db.NowMS)
);
