CREATE TABLE automounts (
id TEXT PRIMARY KEY,
remote TEXT NOT NULL,
remote_path TEXT NOT NULL DEFAULT '',
mount_point TEXT NOT NULL,
options TEXT NOT NULL DEFAULT '{}',
enabled INTEGER NOT NULL DEFAULT 1,
created_at INTEGER NOT NULL
);
CREATE TABLE config (
id INTEGER PRIMARY KEY CHECK (id = 1),
password_command TEXT NOT NULL DEFAULT ''
);
CREATE TABLE favorites (
path TEXT PRIMARY KEY,
added_at INTEGER NOT NULL
);
CREATE TABLE launcher_usage (
key TEXT PRIMARY KEY,
count INTEGER NOT NULL,
last_used INTEGER NOT NULL,
queries TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE meta (
key TEXT PRIMARY KEY,
value TEXT NOT NULL,
updated_at INTEGER NOT NULL
);
CREATE TABLE notification_smtp (
id INTEGER PRIMARY KEY CHECK (id = 1),
host TEXT NOT NULL,
port INTEGER NOT NULL,
encryption TEXT NOT NULL,
username TEXT NOT NULL DEFAULT '',
from_address TEXT NOT NULL,
from_name TEXT NOT NULL DEFAULT '',
updated_ms INTEGER NOT NULL
);
CREATE TABLE notification_targets (
id TEXT PRIMARY KEY,
name TEXT NOT NULL,
provider TEXT NOT NULL,
url TEXT NOT NULL,
url_key TEXT NOT NULL UNIQUE,
events TEXT NOT NULL,
enabled INTEGER NOT NULL DEFAULT 1,
last_sent_ms INTEGER,
last_error TEXT,
created_ms INTEGER NOT NULL,
updated_ms INTEGER NOT NULL
);
CREATE TABLE prefs (
key TEXT PRIMARY KEY,
value TEXT NOT NULL,
updated_at INTEGER NOT NULL
);
CREATE TABLE remote_fsinfo (
remote TEXT PRIMARY KEY,
fsinfo TEXT,
fsinfo_ms INTEGER,
updated_ms INTEGER NOT NULL
);
CREATE TABLE schedules (
id TEXT PRIMARY KEY,
name TEXT NOT NULL COLLATE NOCASE UNIQUE,
operation TEXT NOT NULL CHECK (operation IN ('copy','move','sync','bisync','delete','purge')),
args TEXT NOT NULL,
cron TEXT NOT NULL,
paused INTEGER NOT NULL DEFAULT 0,
created_at INTEGER NOT NULL,
baselined INTEGER NOT NULL DEFAULT 0,
last_due INTEGER NOT NULL,
last_run_at INTEGER,
last_result TEXT NOT NULL DEFAULT '',
last_error TEXT NOT NULL DEFAULT '',
last_transfer_id TEXT NOT NULL DEFAULT '',
last_skipped_at INTEGER,
running_id TEXT NOT NULL DEFAULT '',
resume INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE settings (
id INTEGER PRIMARY KEY CHECK (id = 1),
doc TEXT NOT NULL,
updated_at INTEGER NOT NULL
);
CREATE TABLE stopped_mounts (
folder TEXT PRIMARY KEY,
source TEXT NOT NULL,
mount_point TEXT NOT NULL,
args TEXT NOT NULL,
pending INTEGER,
stopped_ms INTEGER NOT NULL
);
CREATE TABLE templates (
id TEXT PRIMARY KEY,
name TEXT NOT NULL,
tags TEXT NOT NULL,
options TEXT NOT NULL DEFAULT '{}',
paths TEXT,
position INTEGER NOT NULL,
created_at INTEGER NOT NULL,
updated_at INTEGER NOT NULL
);
CREATE TABLE transfer_files (
transfer_id TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
outcome TEXT NOT NULL CHECK (outcome IN ('transferred','failed','checked')),
src_fs TEXT NOT NULL,
name TEXT NOT NULL,
input INTEGER,
what TEXT,
dst_fs TEXT,
size INTEGER,
bytes INTEGER,
error TEXT,
completed_ms INTEGER,
PRIMARY KEY (transfer_id, outcome, src_fs, name)
);
CREATE TABLE transfers (
id TEXT PRIMARY KEY,
seq INTEGER NOT NULL UNIQUE,
created_ms INTEGER NOT NULL,
started_ms INTEGER,
ended_ms INTEGER,
state TEXT NOT NULL CHECK (state IN
('queued','running','completed','failed','stopped','interrupted')),
resume INTEGER NOT NULL DEFAULT 0,
operation TEXT NOT NULL,
sources TEXT NOT NULL,
destination TEXT,
is_dry_run INTEGER NOT NULL DEFAULT 0,
origin_kind TEXT NOT NULL CHECK (origin_kind IN
('page','commander','template','watcher','schedule','agent')),
origin_id TEXT,
origin_name TEXT,
args TEXT,
preset TEXT,
request TEXT NOT NULL,
stats_group TEXT NOT NULL,
retry_of TEXT,
error TEXT,
final_stats TEXT,
job_output TEXT
);
CREATE TABLE watchers (
id TEXT PRIMARY KEY,
name TEXT NOT NULL COLLATE NOCASE UNIQUE,
path_a TEXT NOT NULL,
path_b TEXT NOT NULL,
paused INTEGER NOT NULL DEFAULT 0,
created_at INTEGER NOT NULL,
baselined INTEGER NOT NULL DEFAULT 0,
last_run_at INTEGER,
last_result TEXT NOT NULL DEFAULT '',
last_error TEXT NOT NULL DEFAULT '',
last_change_at INTEGER,
last_change_id TEXT NOT NULL DEFAULT '',
last_transfer_id TEXT NOT NULL DEFAULT '',
attention TEXT NOT NULL DEFAULT '',
deleted_side TEXT NOT NULL DEFAULT ''
);
CREATE INDEX transfers_created ON transfers(created_ms DESC, id DESC);
CREATE INDEX transfers_open ON transfers(state) WHERE state IN ('queued','running');
