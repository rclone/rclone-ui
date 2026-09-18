//! The files: one append-only JSONL per writer, and one detail document per finished transfer.
//!
//! ```text
//! transfers/hosts/<hostId>.jsonl    written by the server's transfers service
//! transfers/tasks/<taskId>.jsonl    written by `run-task`, under the task's run lock
//! transfers/details/<id>.json       the request from the start, the outcome at the end
//! ```
//!
//! One writer per file, the rule the scheduler's history lives by: compaction reads, trims and
//! rewrites, which a second appender would lose lines to. Everyone else only reads.

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::datadir::DataDir;
use crate::fsutil;

/// How many transfers a file keeps once it is compacted.
pub const KEEP_ENTRIES: usize = 500;
const COMPACT_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Running,
    Completed,
    Failed,
    /// Stopped from the app: the "context canceled" it ends with is not a failure.
    Stopped,
    /// Its daemon went away under it (a restart, a crash, the app quitting).
    Interrupted,
    /// It ended while nothing was watching and rclone no longer remembers how.
    Unknown,
}

/// The totals of a transfer, as `core/stats?group=job/N` reported them last.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Stats {
    pub bytes: u64,
    pub total_bytes: u64,
    pub transfers: u64,
    pub checks: u64,
    pub errors: u64,
    pub duration_ms: u64,
}

/// What ran. Self-contained on purpose: a schedule can be deleted and the transfer still lists
/// with its operation and paths.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub id: String,
    pub ts: String,
    /// rclone's name for the daemon process that took the job (`executeId`). Job ids start over
    /// with every daemon, so the pair names the job and the id alone does not.
    #[serde(default)]
    pub execute_id: String,
    pub jobid: i64,
    pub operation: String,
    #[serde(default)]
    pub sources: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
    #[serde(default)]
    pub is_dry_run: bool,
    /// What the page had set, for Reuse settings and Run again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<Value>,
    /// Set by the scheduled runner: the schedule that started it, its name then, and the run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// The transfer whose failures this one retries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_of: Option<String>,
    /// Where it came from ([`TAG_SCHEDULE`], [`TAG_OPERATION`], [`TAG_COMMANDER`]): what the
    /// Transfers list badges a row with, and what makes a row a scheduled run. The ids above
    /// say which schedule and which run; they do not say that it is one.
    #[serde(default)]
    pub tags: Vec<String>,
}

/// Started by a schedule: written by the scheduled runner and by nothing else.
pub const TAG_SCHEDULE: &str = "schedule";
/// Started from an operation's page (Copy, Move, Sync, …).
pub const TAG_OPERATION: &str = "operation";
/// Started from the Commander: a drop between its panels, a download.
pub const TAG_COMMANDER: &str = "commander";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finished {
    pub id: String,
    pub ts: String,
    pub state: State,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<Stats>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "lowercase")]
pub enum Line {
    Started(Started),
    Finished(Finished),
}

impl Line {
    /// The transfer a line is about.
    pub fn id(&self) -> &str {
        match self {
            Line::Started(started) => &started.id,
            Line::Finished(finished) => &finished.id,
        }
    }
}

/// A transfer as the pages read it: its `started` line and, once there is one, its `finished`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    #[serde(flatten)]
    pub started: Started,
    pub state: State,
    pub finished_at: Option<String>,
    pub error: Option<String>,
    pub stats: Option<Stats>,
}

/// An entry is its `started` line and more: what started it reads straight off it.
impl std::ops::Deref for Entry {
    type Target = Started;
    fn deref(&self) -> &Started {
        &self.started
    }
}

fn root(dirs: &DataDir) -> PathBuf {
    dirs.root.join("transfers")
}

/// The ledger's fixed path. The `hosts/` segment and the `local` name are the shared storage
/// layout, not a choice this product makes.
pub fn host_path(dirs: &DataDir) -> PathBuf {
    root(dirs)
        .join("hosts")
        .join(format!("{}.jsonl", crate::scheduler::jobfile::JOBS_DIR))
}

pub fn task_path(dirs: &DataDir, task_id: &str) -> PathBuf {
    root(dirs).join("tasks").join(format!("{}.jsonl", task_id))
}

pub fn details_path(dirs: &DataDir, id: &str) -> PathBuf {
    root(dirs).join("details").join(format!("{}.json", id))
}

/// Appends one line and syncs it: a transfer that already moved files must not lose its record
/// to a crash right after.
pub fn append(path: &Path, line: &Line) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {}", parent.display(), e))?;
    }
    // One buffer, one write: `writeln!` on a bare file may hand the line and its newline to the
    // OS separately, and a reader in between sees half of it.
    let mut bytes = serde_json::to_vec(line).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("{}: {}", path.display(), e))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("{}: {}", path.display(), e))
}

/// Every line of a file, oldest first. A line that does not parse is skipped.
pub fn read(path: &Path) -> Vec<Line> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    content
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

/// Pairs the lines into transfers, newest first. A `finished` whose `started` is gone (trimmed
/// away, or never written) names nothing and is dropped.
pub fn fold(lines: Vec<Line>) -> Vec<Entry> {
    let mut entries: Vec<Entry> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for line in lines {
        match line {
            Line::Started(started) => {
                index.insert(started.id.clone(), entries.len());
                entries.push(Entry {
                    started,
                    state: State::Running,
                    finished_at: None,
                    error: None,
                    stats: None,
                });
            }
            Line::Finished(finished) => {
                let Some(entry) = index.get(&finished.id).map(|&at| &mut entries[at]) else {
                    continue;
                };
                entry.state = finished.state;
                entry.finished_at = Some(finished.ts);
                entry.error = finished.error;
                entry.stats = finished.stats;
            }
        }
    }
    // Timestamps are RFC 3339 in UTC with fixed width, so they order as text.
    entries.sort_by(|a, b| b.ts.cmp(&a.ts));
    entries
}

/// The transfers of a file that have no `finished` line yet.
pub fn open(path: &Path) -> Vec<Started> {
    fold(read(path))
        .into_iter()
        .filter(|entry| entry.state == State::Running)
        .map(|entry| entry.started)
        .collect()
}

/// Writes how a transfer ended, and trims the file if that made it too long. The one way an
/// end is written, by either writer, each to its own file.
pub fn finish(dirs: &DataDir, path: &Path, finished: Finished) -> Result<(), String> {
    let result = append(path, &Line::Finished(finished));
    compact_if_large(dirs, path);
    result
}

/// Every host's file: what the server looks through for transfers a previous process left open.
pub fn host_files(dirs: &DataDir) -> Vec<PathBuf> {
    jsonl_in(root(dirs).join("hosts"))
}

fn jsonl_in(dir: PathBuf) -> Vec<PathBuf> {
    let Ok(files) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    files
        .flatten()
        .map(|file| file.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
        .collect()
}

/// A file's transfers as last parsed, and what the file looked like then.
struct Parsed {
    len: u64,
    modified: Option<SystemTime>,
    entries: Arc<Vec<Entry>>,
}

fn parsed() -> &'static Mutex<HashMap<PathBuf, Parsed>> {
    static PARSED: OnceLock<Mutex<HashMap<PathBuf, Parsed>>> = OnceLock::new();
    PARSED.get_or_init(Default::default)
}

/// A file's transfers, newest first, and whether they are the parse kept from before. The list
/// is asked for every few seconds by every open page; a file is read and parsed again only once
/// it has changed. Every write changes its length (an append grows it, a compaction shrinks
/// it), so a parse is never served for a file that has moved on. The look at the file comes
/// before the read: what is kept may be newer than what it is filed under, never older.
fn entries_of(path: &Path) -> (Arc<Vec<Entry>>, bool) {
    let Ok(meta) = std::fs::metadata(path) else {
        parsed().lock().unwrap().remove(path);
        return (Arc::default(), false);
    };
    let (len, modified) = (meta.len(), meta.modified().ok());
    if let Some(kept) = parsed().lock().unwrap().get(path) {
        if kept.len == len && kept.modified == modified {
            return (Arc::clone(&kept.entries), true);
        }
    }
    let entries = Arc::new(fold(read(path)));
    let kept = Parsed {
        len,
        modified,
        entries: Arc::clone(&entries),
    };
    parsed().lock().unwrap().insert(path.to_path_buf(), kept);
    (entries, false)
}

/// Rewrites a file that grew past its size down to its newest `keep` transfers (one still
/// running is always kept), and removes the details of the ones that went. Only the file's
/// writer may call this.
pub fn compact(dirs: &DataDir, path: &Path, keep: usize) -> Result<(), String> {
    let lines = read(path);
    let entries = fold(lines.clone());
    let kept: std::collections::HashSet<&str> = entries
        .iter()
        .enumerate()
        .filter(|(at, entry)| *at < keep || entry.state == State::Running)
        .map(|(_, entry)| entry.id.as_str())
        .collect();
    if kept.len() == entries.len() {
        return Ok(());
    }
    let mut body = Vec::new();
    for line in lines.iter().filter(|line| kept.contains(line.id())) {
        body.extend(serde_json::to_vec(line).map_err(|e| e.to_string())?);
        body.push(b'\n');
    }
    fsutil::write_atomic(path, &body)?;
    for entry in entries.iter().filter(|e| !kept.contains(e.id.as_str())) {
        let _ = std::fs::remove_file(details_path(dirs, &entry.id));
    }
    Ok(())
}

/// `compact` once the file has outgrown [`COMPACT_BYTES`]; what a writer calls after appending.
pub fn compact_if_large(dirs: &DataDir, path: &Path) {
    let large = std::fs::metadata(path)
        .map(|meta| meta.len() > COMPACT_BYTES)
        .unwrap_or(false);
    if large {
        if let Err(error) = compact(dirs, path, KEEP_ENTRIES) {
            log::warn!(
                "[transfers] could not compact {}: {}",
                path.display(),
                error
            );
        }
    }
}

/// What the Transfers list shows: the ledger and every scheduled task's file, newest first. A
/// transfer's lines are all in one file (one writer each), so the files fold on their own and
/// only what is listed is copied out.
pub fn list(dirs: &DataDir, limit: usize) -> Vec<Entry> {
    let tasks = root(dirs).join("tasks");
    let mut files = jsonl_in(tasks.clone());
    // A schedule that was deleted took its file with it: nothing will ask for it again.
    let mut kept = parsed().lock().unwrap();
    kept.retain(|path, _| !path.starts_with(&tasks) || files.contains(path));
    drop(kept);
    files.push(host_path(dirs));

    let parsed: Vec<Arc<Vec<Entry>>> = files.iter().map(|path| entries_of(path).0).collect();
    let mut entries: Vec<&Entry> = parsed.iter().flat_map(|file| file.iter()).collect();
    // Timestamps are RFC 3339 in UTC with fixed width, so they order as text.
    entries.sort_by(|a, b| b.ts.cmp(&a.ts));
    entries.into_iter().take(limit).cloned().collect()
}

pub fn write_details(dirs: &DataDir, id: &str, details: &Value) -> Result<(), String> {
    let path = details_path(dirs, id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {}", parent.display(), e))?;
    }
    let body = serde_json::to_vec(details).map_err(|e| e.to_string())?;
    fsutil::write_atomic(&path, &body)
}

pub fn read_details(dirs: &DataDir, id: &str) -> Option<Value> {
    let raw = std::fs::read(details_path(dirs, id)).ok()?;
    serde_json::from_slice(&raw).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dirs(name: &str) -> DataDir {
        let root =
            std::env::temp_dir().join(format!("rcloneui-ledger-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        DataDir { root }
    }

    fn started(id: &str, ts: &str) -> Line {
        Line::Started(Started {
            id: id.into(),
            ts: ts.into(),
            execute_id: "daemon-1".into(),
            jobid: 1,
            operation: "copy".into(),
            sources: vec!["/tmp/a".into()],
            destination: Some("remote:b".into()),
            ..Started::default()
        })
    }

    fn finished(id: &str, ts: &str, state: State) -> Line {
        Line::Finished(Finished {
            id: id.into(),
            ts: ts.into(),
            state,
            error: None,
            stats: Some(Stats {
                bytes: 10,
                total_bytes: 10,
                transfers: 2,
                ..Stats::default()
            }),
        })
    }

    /// The file is an event log; the list is its fold. A transfer with no `finished` line is
    /// running, and a `finished` line on its own names nothing.
    #[test]
    fn lines_fold_into_transfers_newest_first() {
        let dirs = dirs("fold");
        let path = host_path(&dirs);
        append(&path, &started("a", "2026-01-01T00:00:00.000Z")).unwrap();
        append(&path, &started("b", "2026-01-02T00:00:00.000Z")).unwrap();
        append(
            &path,
            &finished("a", "2026-01-01T00:05:00.000Z", State::Completed),
        )
        .unwrap();
        append(
            &path,
            &finished("ghost", "2026-01-03T00:00:00.000Z", State::Failed),
        )
        .unwrap();
        // A torn or foreign line costs that line and nothing else.
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"{not json\n")
            .unwrap();

        let entries = fold(read(&path));
        assert_eq!(
            entries.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["b", "a"]
        );
        assert_eq!(entries[0].state, State::Running);
        assert_eq!(entries[0].finished_at, None);
        assert_eq!(entries[1].state, State::Completed);
        assert_eq!(entries[1].stats.as_ref().unwrap().transfers, 2);
        assert_eq!(entries[1].destination.as_deref(), Some("remote:b"));
        // What is still open is what the fold says is running, as it was started.
        let still_open = open(&path);
        assert_eq!(still_open.len(), 1);
        assert_eq!(still_open[0], entries[0].started);
        assert_eq!(still_open[0].id, "b");

        // An entry goes to the pages as its `started` line with its end beside it: one shape,
        // so a field added to a transfer is added in one place.
        let wire = serde_json::to_value(&entries[1]).unwrap();
        assert_eq!(wire["id"], "a");
        assert_eq!(wire["ts"], "2026-01-01T00:00:00.000Z");
        assert_eq!(wire["executeId"], "daemon-1");
        assert_eq!(wire["state"], "completed");
        assert_eq!(wire["finishedAt"], "2026-01-01T00:05:00.000Z");
        assert_eq!(wire["tags"], json!([]), "always there to read");
        assert_eq!(wire["sources"], json!(["/tmp/a"]));
        assert!(wire.get("taskId").is_none(), "absent, not null");
        assert_eq!(
            serde_json::to_value(&entries[0]).unwrap()["finishedAt"],
            Value::Null
        );

        // The wire shape the pages and the other writer rely on.
        let line = serde_json::to_value(started("a", "t")).unwrap();
        assert_eq!(line["event"], "started");
        assert!(line.get("hostId").is_none(), "one machine, so no host to name");
        assert_eq!(line["executeId"], "daemon-1");
        assert!(line.get("taskId").is_none(), "absent, not null");
        assert!(line.get("retryOf").is_none(), "absent, not null");

        // A retry says which transfer's failures it retries, and the list hands that on.
        let Line::Started(mut retry) = started("c", "2026-01-04T00:00:00.000Z") else {
            unreachable!()
        };
        retry.retry_of = Some("a".into());
        append(&path, &Line::Started(retry)).unwrap();
        let entries = fold(read(&path));
        assert_eq!(entries[0].retry_of.as_deref(), Some("a"));
        assert_eq!(entries[1].retry_of, None);

        // Where a transfer came from is a tag of it, handed on as it is. None is none: a line
        // without the field reads, and one with nothing to say does not write it.
        let Line::Started(mut tagged) = started("d", "2026-01-05T00:00:00.000Z") else {
            unreachable!()
        };
        tagged.tags = vec![TAG_COMMANDER.into()];
        assert_eq!(
            serde_json::to_value(Line::Started(tagged.clone())).unwrap()["tags"],
            serde_json::json!(["commander"])
        );
        append(&path, &Line::Started(tagged)).unwrap();
        let entries = fold(read(&path));
        assert_eq!(entries[0].tags, ["commander"]);
        assert!(entries[1].tags.is_empty());
        // A line from before there were tags, or a daemon's name, still reads.
        let bare = r#"{"event":"started","id":"e","ts":"t","hostId":"local","jobid":1,"operation":"copy"}"#;
        let Line::Started(bare) = serde_json::from_str::<Line>(bare).unwrap() else {
            unreachable!()
        };
        assert!(bare.tags.is_empty() && bare.execute_id.is_empty() && bare.sources.is_empty());
        let _ = std::fs::remove_dir_all(&dirs.root);
    }

    /// Compaction is by transfer, not by line: the newest stay whole, the ones that go take
    /// their detail documents with them, and a transfer still running is never trimmed away.
    #[test]
    fn compaction_keeps_the_newest_transfers_and_drops_the_rest_with_their_details() {
        let dirs = dirs("compact");
        let path = host_path(&dirs);
        append(
            &path,
            &started("old-running", "2026-01-01T00:00:00.000Z"),
        )
        .unwrap();
        for day in 2..=6 {
            let id = format!("t{}", day);
            append(
                &path,
                &started(&id, &format!("2026-01-0{}T00:00:00.000Z", day)),
            )
            .unwrap();
            append(
                &path,
                &finished(
                    &id,
                    &format!("2026-01-0{}T00:01:00.000Z", day),
                    State::Completed,
                ),
            )
            .unwrap();
            write_details(&dirs, &id, &json!({ "transferred": [] })).unwrap();
        }

        compact(&dirs, &path, 2).unwrap();

        let ids: Vec<String> = fold(read(&path))
            .into_iter()
            .map(|e| e.started.id)
            .collect();
        assert_eq!(ids, ["t6", "t5", "old-running"]);
        assert!(read_details(&dirs, "t6").is_some());
        assert!(read_details(&dirs, "t2").is_none(), "its transfer is gone");
        let _ = std::fs::remove_dir_all(&dirs.root);
    }

    /// The list is asked for every few seconds by every open page, and used to read and parse
    /// every file each time. A file is parsed when it has changed and not otherwise; an append, a
    /// compaction and a removal are all changes, and none of them is ever served stale.
    #[test]
    fn a_file_is_parsed_again_only_once_it_has_changed() {
        let dirs = dirs("cache");
        let path = host_path(&dirs);
        append(&path, &started("a", "2026-01-01T00:00:00.000Z")).unwrap();

        let (first, was_cached) = entries_of(&path);
        assert!(!was_cached);
        let (again, was_cached) = entries_of(&path);
        assert!(was_cached);
        assert!(Arc::ptr_eq(&first, &again), "the same parse, not another");
        assert_eq!(again[0].state, State::Running);

        append(
            &path,
            &finished("a", "2026-01-01T00:05:00.000Z", State::Completed),
        )
        .unwrap();
        let (after, was_cached) = entries_of(&path);
        assert!(!was_cached, "an append is a change");
        assert_eq!(after[0].state, State::Completed);

        // A rewrite (what compaction does) is one too, even to something shorter.
        for day in 2..=4 {
            let id = format!("t{}", day);
            let ts = format!("2026-01-0{}T00:00:00.000Z", day);
            append(&path, &started(&id, &ts)).unwrap();
            append(&path, &finished(&id, &ts, State::Completed)).unwrap();
        }
        assert_eq!(list(&dirs, 50).len(), 4);
        compact(&dirs, &path, 1).unwrap();
        assert_eq!(list(&dirs, 50).len(), 1);

        // A file that is gone lists nothing, and is not remembered.
        std::fs::remove_file(&path).unwrap();
        assert!(list(&dirs, 50).is_empty());
        assert!(!entries_of(&path).1);
        let _ = std::fs::remove_dir_all(&dirs.root);
    }

    /// The list is the ledger plus every scheduled run's own file — several writers, several
    /// files, one list.
    #[test]
    fn the_list_merges_the_ledger_with_the_scheduled_runs() {
        let dirs = dirs("list");
        append(
            &host_path(&dirs),
            &started("manual", "2026-01-02T00:00:00.000Z"),
        )
        .unwrap();
        append(
            &task_path(&dirs, "nightly"),
            &started("scheduled", "2026-01-03T00:00:00.000Z"),
        )
        .unwrap();
        append(
            &task_path(&dirs, "weekly"),
            &started("also-scheduled", "2026-01-04T00:00:00.000Z"),
        )
        .unwrap();

        let ids: Vec<String> = list(&dirs, 50)
            .into_iter()
            .map(|e| e.started.id)
            .collect();
        // Newest first, across all three files.
        assert_eq!(ids, ["also-scheduled", "scheduled", "manual"]);
        assert_eq!(list(&dirs, 1).len(), 1);
        let _ = std::fs::remove_dir_all(&dirs.root);
    }
}
