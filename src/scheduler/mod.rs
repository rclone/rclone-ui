//! Scheduled tasks, run by the server itself.
//!
//! A schedule is one file, `scheduler/tasks/<id>.json` ([`taskfile`]): the page's form and the
//! pre-serialized rclone requests a run submits. The server's own minute ticker ([`ticker`])
//! reads the files and hands a due one to the runner ([`runner`]), which puts its requests on
//! the daemon the server is already running, through the same transfer service as everything
//! else. Nothing is registered with the operating system and nothing is spawned: a task runs
//! whenever the server does, which is what a server is for. Every change to a task, and every
//! run's start and end, is `schedules.changed {id}` on the bus.

pub mod cron;
pub mod history;
pub mod runner;
pub mod taskfile;
pub mod ticker;

use serde::Serialize;
use serde_json::{json, Value};

use crate::bus::Bus;
use crate::datadir::DataDir;
use taskfile::TaskFile;

pub const NO_SUCH_TASK: &str = "There is no such schedule";

/// The bus event the pages reload their list from (`src/server/ws.ts` `EventPayloads`).
pub const CHANGED_EVENT: &str = "schedules.changed";

pub(crate) fn changed(bus: &Bus, id: &str) {
    bus.publish(CHANGED_EVENT, json!({ "id": id }));
}

/// Serializes every task mutation across the process: a save from a page and a toggle from
/// another must not interleave a read-modify-write. Runs are kept apart separately, by
/// [`runner::is_running`].
static MUTATION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn mutation_guard() -> std::sync::MutexGuard<'static, ()> {
    MUTATION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Task ids become file names — never trust them, even though the page generates UUIDs.
pub fn sanitize_id(task_id: &str) -> Result<String, String> {
    if task_id.is_empty() || task_id.len() > 64 {
        return Err("invalid task id".to_string());
    }
    if !task_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        || task_id.contains("..")
    {
        return Err("invalid task id".to_string());
    }
    Ok(task_id.to_string())
}

// ---------------------------------------------------------------------------
// What the RPCs call (rpc.rs); the ones that touch files run on the blocking pool there.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronValidation {
    pub valid: bool,
    pub error: Option<String>,
    /// The next few local fire times (RFC3339 with offset), computed by the SAME matcher the
    /// tick uses. This is the UI's preview source — JS cron libraries disagree with Vixie cron
    /// on the dom/dow star flag, so predicting fires anywhere else risks showing runs that will
    /// never happen. Empty when invalid (or nothing fires within 5 years).
    pub next_runs: Vec<String>,
}

pub fn validate_cron(cron: &str) -> CronValidation {
    match cron::parse(cron) {
        Ok(spec) => CronValidation {
            valid: true,
            error: None,
            next_runs: cron::next_fires(&spec, chrono::Local::now(), 10),
        },
        Err(error) => CronValidation {
            valid: false,
            error: Some(error),
            next_runs: Vec::new(),
        },
    }
}

/// One schedule as the page lists it: the file, and where it stands.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    pub id: String,
    pub enabled: bool,
    pub created_at: Option<u64>,
    pub task: Value,
    pub running: bool,
    pub last_finished: Option<Value>,
    /// The next local fire times, by the tick's own matcher.
    pub next_runs: Vec<String>,
}

fn listed(dirs: &DataDir, file: &TaskFile) -> Listed {
    let running = runner::is_running(&file.id);
    Listed {
        id: file.id.clone(),
        enabled: file.enabled,
        created_at: file.created_at,
        task: file.task.clone(),
        running,
        last_finished: last_finished(dirs, &file.id, running),
        next_runs: cron::parse(&file.spec.cron)
            .map(|spec| cron::next_fires(&spec, chrono::Local::now(), 3))
            .unwrap_or_default(),
    }
}

/// The latest attempt, as the history has it. Newest-first: the latest started/finished event
/// is the latest ATTEMPT. A started with no finished and no run going on is one that died
/// without writing its terminal record — the server was killed, or lost power, mid-run.
/// Surfacing the older success (or "Never") instead would hide the interruption.
fn last_finished(dirs: &DataDir, id: &str, running: bool) -> Option<Value> {
    let lines = history::read(dirs, id, 20);
    let event_of = |line: &Value| line.get("event").and_then(|e| e.as_str()).map(str::to_owned);
    let newest_attempt = lines.iter().find(|line| {
        matches!(
            event_of(line).as_deref(),
            Some("started") | Some("finished")
        )
    });
    match newest_attempt {
        Some(line) if event_of(line).as_deref() == Some("started") && !running => Some(json!({
            "runId": line.get("runId").cloned().unwrap_or_default(),
            "ts": line.get("ts").cloned().unwrap_or_default(),
            "success": false,
            "error": "The run was interrupted before it could finish (crash, forced shutdown, or power loss).",
            "durationMs": 0,
            "interrupted": true,
        })),
        _ => lines
            .iter()
            .find(|line| event_of(line).as_deref() == Some("finished"))
            .cloned(),
    }
}

pub fn list(dirs: &DataDir) -> Vec<Listed> {
    taskfile::list(dirs)
        .iter()
        .map(|file| listed(dirs, file))
        .collect()
}

/// Create and update are the same call: the page keeps generating the ids. A schedule the
/// ticker could never match, or one with nothing to run, is refused before anything is written.
pub fn save(dirs: &DataDir, bus: &Bus, mut file: TaskFile) -> Result<Listed, String> {
    sanitize_id(&file.id)?;
    if file.schema_version != taskfile::SCHEMA_VERSION {
        return Err(format!(
            "unsupported task schema version {}",
            file.schema_version
        ));
    }
    cron::parse(&file.spec.cron)?;
    if file.spec.requests.is_empty() {
        return Err("The task produced no rclone requests".to_string());
    }
    let _guard = mutation_guard();
    file.created_at = taskfile::load(dirs, &file.id)?
        .and_then(|existing| existing.created_at)
        .or_else(|| Some(now_ms()));
    taskfile::save(dirs, &file)?;
    changed(bus, &file.id);
    Ok(listed(dirs, &file))
}

pub fn remove(dirs: &DataDir, bus: &Bus, id: &str) -> Result<(), String> {
    let id = sanitize_id(id)?;
    let _guard = mutation_guard();
    taskfile::remove(dirs, &id);
    history::remove_all(dirs, &id);
    changed(bus, &id);
    Ok(())
}

pub fn set_enabled(dirs: &DataDir, bus: &Bus, id: &str, enabled: bool) -> Result<Listed, String> {
    let id = sanitize_id(id)?;
    let _guard = mutation_guard();
    let mut file = taskfile::load(dirs, &id)?.ok_or_else(|| NO_SUCH_TASK.to_string())?;
    file.enabled = enabled;
    taskfile::save(dirs, &file)?;
    changed(bus, &id);
    Ok(listed(dirs, &file))
}

/// A task that may be run outside its schedule, named. Starting the run is the server's (it
/// needs the transfer service), so this is the half that is the scheduler's: the id is real. A
/// disabled task still answers: running it by hand is a choice, not a fire.
pub fn runnable_now(dirs: &DataDir, id: &str) -> Result<String, String> {
    let id = sanitize_id(id)?;
    if taskfile::path(dirs, &id).is_file() {
        Ok(id)
    } else {
        Err(NO_SUCH_TASK.to_string())
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogContent {
    pub content: String,
    pub truncated: bool,
}

/// Tail of a task's log for the in-app viewer: what the runner itself had to say about each
/// run. There is no second log — rclone's own output belongs to the daemon the whole server
/// shares, and what a run moved is its transfer's, on the Transfers page.
pub fn read_log(dirs: &DataDir, id: String) -> Result<LogContent, String> {
    const MAX_TAIL_BYTES: usize = 64 * 1024;

    let id = sanitize_id(&id)?;
    let path = history::log_path(dirs, &id);

    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(LogContent {
            content: String::new(),
            truncated: false,
        });
    };

    let truncated = bytes.len() > MAX_TAIL_BYTES;
    let tail = if truncated {
        let cut = bytes.len() - MAX_TAIL_BYTES;
        // Align to the next line boundary so the viewer never starts mid-line.
        let aligned = bytes[cut..]
            .iter()
            .position(|&b| b == b'\n')
            .map(|i| cut + i + 1)
            .unwrap_or(cut);
        &bytes[aligned..]
    } else {
        &bytes[..]
    };

    Ok(LogContent {
        content: String::from_utf8_lossy(tail).into_owned(),
        truncated,
    })
}

pub fn read_history(dirs: &DataDir, id: String, limit: Option<usize>) -> Result<Vec<Value>, String> {
    let id = sanitize_id(&id)?;
    Ok(history::read(dirs, &id, limit.unwrap_or(50)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use taskfile::{JobSpec, RcRequest};

    fn scratch(name: &str) -> DataDir {
        let root = std::env::temp_dir().join(format!(
            "rclone-cloud-scheduler-{}-{}",
            name,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        DataDir { root }
    }

    fn task(id: &str, cron: &str, requests: usize) -> TaskFile {
        TaskFile {
            schema_version: taskfile::SCHEMA_VERSION,
            id: id.into(),
            enabled: true,
            created_at: None,
            task: json!({ "name": "nightly", "operation": "copy", "cron": cron }),
            spec: JobSpec {
                name: "nightly".into(),
                operation: "copy".into(),
                cron: cron.into(),
                max_run_seconds: 60,
                sources: vec!["/src".into()],
                destination: Some("dst:".into()),
                requests: (0..requests)
                    .map(|_| RcRequest {
                        endpoint: "/job/batch".into(),
                        body: json!({}),
                    })
                    .collect(),
            },
        }
    }

    /// A save is a file, listed oldest first with its form kept whole; a remove takes the file
    /// and the history with it.
    #[test]
    fn a_task_file_round_trips_and_lists_in_the_order_it_was_made() {
        let dirs = scratch("roundtrip");
        let bus = Bus::new();
        let first = save(&dirs, &bus, task("first", "0 2 * * *", 1)).unwrap();
        assert!(first.created_at.is_some());
        assert_eq!(first.task["name"], "nightly");
        assert_eq!(first.next_runs.len(), 3);
        // Later, and it says so; a re-save keeps the first date.
        std::thread::sleep(std::time::Duration::from_millis(2));
        let second = save(&dirs, &bus, task("second", "*/5 * * * *", 1)).unwrap();
        let first_again = save(&dirs, &bus, task("first", "0 3 * * *", 1)).unwrap();
        assert_eq!(first_again.created_at, first.created_at);
        assert!(second.created_at > first.created_at);
        let ids: Vec<String> = list(&dirs).into_iter().map(|t| t.id).collect();
        assert_eq!(ids, vec!["first", "second"]);
        assert_eq!(
            taskfile::load(&dirs, "first").unwrap().unwrap().spec.cron,
            "0 3 * * *"
        );

        assert!(!set_enabled(&dirs, &bus, "first", false).unwrap().enabled);
        assert_eq!(
            set_enabled(&dirs, &bus, "nowhere", true).unwrap_err(),
            NO_SUCH_TASK
        );
        assert_eq!(runnable_now(&dirs, "first").unwrap(), "first");
        assert_eq!(runnable_now(&dirs, "nowhere").unwrap_err(), NO_SUCH_TASK);

        history::append(
            &dirs,
            "first",
            &history::HistoryLine::Skipped {
                ts: "t".into(),
                reason: "test".into(),
            },
        );
        remove(&dirs, &bus, "first").unwrap();
        assert!(taskfile::load(&dirs, "first").unwrap().is_none());
        assert!(history::read(&dirs, "first", 5).is_empty());
        let _ = std::fs::remove_dir_all(&dirs.root);
    }

    /// Refused before anything is written: a cron the tick could never match, no requests, an
    /// id that is not a file name.
    #[test]
    fn a_save_that_could_never_run_is_refused() {
        let dirs = scratch("refused");
        let bus = Bus::new();
        assert!(save(&dirs, &bus, task("bad-cron", "@daily", 1))
            .unwrap_err()
            .contains("5-field"));
        assert!(save(&dirs, &bus, task("empty", "0 2 * * *", 0))
            .unwrap_err()
            .contains("no rclone requests"));
        assert!(save(&dirs, &bus, task("../escape", "0 2 * * *", 1)).is_err());
        assert!(list(&dirs).is_empty());
        let _ = std::fs::remove_dir_all(&dirs.root);
    }

    /// A started with no finished, and no run going, was interrupted: the list says so instead
    /// of showing the older success.
    #[test]
    fn an_interrupted_run_is_listed_as_one() {
        let dirs = scratch("interrupted");
        let bus = Bus::new();
        save(&dirs, &bus, task("t", "0 2 * * *", 1)).unwrap();
        history::append(
            &dirs,
            "t",
            &history::HistoryLine::Finished {
                run_id: "r1".into(),
                ts: "2026-01-01T00:00:00Z".into(),
                success: true,
                error: None,
                duration_ms: 5,
                jobids: None,
                stats: None,
            },
        );
        history::append(
            &dirs,
            "t",
            &history::HistoryLine::Started {
                run_id: "r2".into(),
                ts: "2026-01-02T00:00:00Z".into(),
            },
        );
        let last = list(&dirs).remove(0).last_finished.unwrap();
        assert_eq!(last["runId"], "r2");
        assert_eq!(last["interrupted"], true);
        assert_eq!(last["success"], false);
        let _ = std::fs::remove_dir_all(&dirs.root);
    }

    /// The pages reload their list from this event: an emitted name the page never subscribed
    /// to leaves the list stale after every save.
    #[test]
    fn the_changed_event_is_declared_in_ws_ts() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/frontend/src/server/ws.ts");
        let ws = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {}", path, e));
        assert!(
            ws.contains(&format!("'{}':", CHANGED_EVENT)),
            "{} is emitted but not declared in src/server/ws.ts",
            CHANGED_EVENT
        );
    }
}
