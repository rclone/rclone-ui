//! What a scheduled run is: the task file's requests, handed one after another to the rclone
//! daemon the server is already running, and recorded as the ordinary transfers they are.
//!
//! There is no second process and no second daemon. If the server is up then the daemon and the
//! ticker are up, and if it is down nothing fires at all — so a run is a task on the server's own
//! runtime, from the tick that fired it to the history line that says how it went. The transfers
//! it makes are watched by the same [`TransferService`] that watches a page's and end the same
//! way, which is what lets the Transfers page show a run's progress, stop it and retry it.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tokio::sync::broadcast::{error::RecvError, Receiver};

use super::history::{self, HistoryLine, RunLog};
use super::taskfile::{self, JobSpec};
use crate::bus::Bus;
use crate::datadir::DataDir;
use crate::notifications::webhooks;
use crate::transfers::ledger::{self, State};
use crate::transfers::service::{Ended, Scheduled, StartRequest, TransferService};

/// The tasks with a run going on. One run of a task at a time, and the whole of that rule is a
/// set in memory: the server is the only thing that fires a schedule, so there is no other
/// process to keep out — no lock file, no pid, nothing to prove alive.
fn running() -> &'static Mutex<HashSet<String>> {
    static RUNNING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

/// Whether a run of this task is going on right now. A `started` history line with no `finished`
/// and no run here is one the server was killed in the middle of (`super::list` says so).
pub fn is_running(task_id: &str) -> bool {
    running().lock().unwrap().contains(task_id)
}

/// Holds a task for the length of its run. The `Drop` covers every way out, panics included.
struct RunGuard(String);

impl RunGuard {
    fn claim(task_id: &str) -> Option<Self> {
        running()
            .lock()
            .unwrap()
            .insert(task_id.to_string())
            .then(|| RunGuard(task_id.to_string()))
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        running().lock().unwrap().remove(&self.0);
    }
}

fn skipped(dirs: &DataDir, task_id: &str, reason: &str) {
    history::append(
        dirs,
        task_id,
        &HistoryLine::Skipped {
            ts: crate::time::now_iso(),
            reason: reason.to_string(),
        },
    );
}

/// One run of one task, start to finish.
pub async fn run(dirs: DataDir, bus: Bus, transfers: Arc<TransferService>, task_id: String) {
    let Ok(task_id) = super::sanitize_id(&task_id) else {
        log::warn!("[scheduler] refusing to run an invalid task id");
        return;
    };

    // Taken before anything is read: two fires of one task must not both get as far as looking.
    let Some(guard) = RunGuard::claim(&task_id) else {
        log::info!("[scheduler] {} is still running; fire skipped", task_id);
        skipped(&dirs, &task_id, "already-running");
        return;
    };

    let mut log = RunLog::open(&dirs, &task_id);

    // The file is the schedule: gone (removed between the fire and now), there is nothing to
    // run; unreadable, nothing can be.
    let spec = match taskfile::load(&dirs, &task_id) {
        Ok(Some(file)) => file.spec,
        Ok(None) => {
            log.line("task file missing: the schedule was removed; skipped");
            return;
        }
        Err(e) => {
            log.line(&format!("task file unusable: {}; skipped", e));
            return;
        }
    };

    // Nothing to submit to. Said as a skip, not a failure: the run never began, and the next
    // fire is the next thing on the schedule.
    if !transfers.daemon_ready() {
        log.line("skipped: the rclone daemon is not running");
        skipped(&dirs, &task_id, "the rclone daemon was not running");
        return;
    }

    let run_id = format!(
        "{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        &crate::rc::random_token()[..6]
    );
    let started_at = Instant::now();
    // The user-facing "max run time" covers the WHOLE run — webhook delivery included — not
    // just the transfers.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(spec.max_run_seconds);
    log.line(&format!("run {} of {}", run_id, task_id));
    history::append(
        &dirs,
        &task_id,
        &HistoryLine::Started {
            run_id: run_id.clone(),
            ts: crate::time::now_iso(),
        },
    );
    super::changed(&bus, &task_id);

    let task_label = if spec.name.is_empty() {
        spec.operation.clone()
    } else {
        spec.name.clone()
    };
    for line in dispatch(
        &dirs,
        "schedule.started",
        "Scheduled task started",
        format!("{} started", task_label),
        json!({ "scheduleId": task_id, "operation": spec.operation, "cron": spec.cron }),
    )
    .await
    {
        log.line(&line);
    }

    // No environment hint on a failure any more: a run goes to the same daemon a page's
    // transfer does, so whatever it could not reach, nothing else could have either — rclone's
    // own words are the whole story.
    let outcome = execute(
        &dirs, &transfers, &spec, &task_id, &run_id, deadline, &mut log,
    )
    .await;
    let error = outcome.error;

    let duration_ms = started_at.elapsed().as_millis() as u64;
    history::append(
        &dirs,
        &task_id,
        &HistoryLine::Finished {
            run_id,
            ts: crate::time::now_iso(),
            success: error.is_none(),
            error: error.clone(),
            duration_ms,
            jobids: (!outcome.jobids.is_empty()).then_some(outcome.jobids),
            stats: outcome.stats,
        },
    );
    super::changed(&bus, &task_id);

    // Released BEFORE the completion webhooks: the run's work is done, and holding the task
    // through up-to-minutes of sequential delivery would make the next fire skip as
    // "already-running".
    drop(guard);

    let (event, title, body) = match &error {
        None => (
            "schedule.completed",
            "Scheduled task completed",
            format!("{} completed successfully", task_label),
        ),
        Some(error) => (
            "schedule.failed",
            "Scheduled task failed",
            format!("{} failed: {}", task_label, error),
        ),
    };
    let mut data =
        json!({ "scheduleId": task_id, "operation": spec.operation, "durationMs": duration_ms });
    if let Some(error) = &error {
        data["error"] = Value::String(error.clone());
    }
    for line in dispatch(&dirs, event, title, body, data).await {
        log.line(&line);
    }

    log.line(&format!(
        "finished: {} ({} ms)",
        error.as_deref().unwrap_or("success"),
        duration_ms
    ));
}

#[derive(Default)]
struct RunOutcome {
    error: Option<String>,
    jobids: Vec<i64>,
    stats: Option<Value>,
}

/// The requests, in order, each one waited out before the next is sent. The first that does not
/// complete ends the run: a task whose copy failed must not go on to the sync that follows it.
#[allow(clippy::too_many_arguments)]
async fn execute(
    dirs: &DataDir,
    transfers: &Arc<TransferService>,
    spec: &JobSpec,
    task_id: &str,
    run_id: &str,
    deadline: tokio::time::Instant,
    log: &mut RunLog,
) -> RunOutcome {
    let mut outcome = RunOutcome::default();

    for request in &spec.requests {
        // Subscribed before the start: `start` looks at a fresh transfer itself and writes its
        // end there if it is already over, and that end must not be missed.
        let mut ends = transfers.ends();
        let start = transfers
            .start(StartRequest {
                operation: spec.operation.clone(),
                sources: spec.sources.clone(),
                destination: spec.destination.clone(),
                is_dry_run: false,
                preset: None,
                retry_of: None,
                tags: Vec::new(),
                request: request.clone(),
                scheduled: Some(Scheduled {
                    task_id: task_id.to_string(),
                    task_name: Some(spec.name.clone()).filter(|name| !name.is_empty()),
                    run_id: run_id.to_string(),
                }),
            })
            .await;

        let reply = match start {
            Ok(reply) => reply,
            Err(e) => {
                outcome.error = Some(format!("failed to start {}: {}", request.endpoint, e));
                return outcome;
            }
        };
        outcome.jobids.push(reply.jobid);
        log.line(&format!(
            "submitted {} as transfer {} (job {})",
            request.endpoint, reply.id, reply.jobid
        ));

        match wait_for_end(dirs, &mut ends, &reply.id, deadline).await {
            Waited::TimedOut => {
                // Stop it before saying so: an rclone still writing files is not a run that ended.
                if let Err(e) = transfers.stop(&reply.id).await {
                    log.line(&format!("could not stop {}: {}", reply.id, e));
                }
                outcome.error = Some(format!("timed out after {} seconds", spec.max_run_seconds));
                return outcome;
            }
            Waited::Ended(end) => {
                outcome.stats = recorded(dirs, &reply.id)
                    .and_then(|entry| entry.stats)
                    .and_then(|stats| serde_json::to_value(stats).ok());
                if end.state != State::Completed {
                    outcome.error = Some(why(&end));
                    return outcome;
                }
                log.line(&format!("transfer {} completed", reply.id));
            }
        }
    }

    outcome
}

/// How an end that was not a completion is worded for the run's history and its webhook.
fn why(end: &Ended) -> String {
    if let Some(error) = &end.error {
        return error.clone();
    }
    match end.state {
        State::Stopped => "the transfer was stopped".to_string(),
        State::Interrupted => "the rclone daemon went away mid-transfer".to_string(),
        State::Unknown => "the transfer ended while nothing was watching".to_string(),
        _ => "the transfer failed".to_string(),
    }
}

enum Waited {
    Ended(Ended),
    TimedOut,
}

/// Waits out one transfer. The service says when something ended; the ledger is asked whenever
/// that word could have been dropped, because it is the record that is true.
async fn wait_for_end(
    dirs: &DataDir,
    ends: &mut Receiver<Ended>,
    id: &str,
    deadline: tokio::time::Instant,
) -> Waited {
    loop {
        match tokio::time::timeout_at(deadline, ends.recv()).await {
            Err(_) => return Waited::TimedOut,
            Ok(Ok(end)) if end.id == id => return Waited::Ended(end),
            Ok(Ok(_)) => continue,
            // More ends at once than the channel holds; ours may have been among them.
            Ok(Err(RecvError::Lagged(_))) => {
                if let Some(end) = recorded_end(dirs, id) {
                    return Waited::Ended(end);
                }
            }
            // The service is gone, which happens only with the server itself.
            Ok(Err(RecvError::Closed)) => {
                return Waited::Ended(recorded_end(dirs, id).unwrap_or(Ended {
                    id: id.to_string(),
                    state: State::Interrupted,
                    error: None,
                }))
            }
        }
    }
}

fn recorded(dirs: &DataDir, id: &str) -> Option<ledger::Entry> {
    ledger::fold(ledger::read(&ledger::path(dirs)))
        .into_iter()
        .find(|entry| entry.id == id)
}

fn recorded_end(dirs: &DataDir, id: &str) -> Option<Ended> {
    recorded(dirs, id)
        .filter(|entry| entry.state != State::Running)
        .map(|entry| Ended {
            id: entry.id.clone(),
            state: entry.state,
            error: entry.error.clone(),
        })
}

async fn dispatch(
    dirs: &DataDir,
    event: &str,
    title: &str,
    body: String,
    data: Value,
) -> Vec<String> {
    webhooks::dispatch(dirs, event, title, &body, data).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_task_runs_once_at_a_time() {
        let first = RunGuard::claim("t1").expect("the first run claims the task");
        assert!(is_running("t1"));
        assert!(
            RunGuard::claim("t1").is_none(),
            "a second fire finds the task taken"
        );
        assert!(
            RunGuard::claim("t2").is_some(),
            "another task is not held up by it"
        );
        drop(first);
        assert!(!is_running("t1"));
        assert!(RunGuard::claim("t1").is_some(), "and can run again after");
    }

    #[test]
    fn an_end_with_nothing_said_is_worded_from_its_state() {
        let end = |state, error: Option<&str>| Ended {
            id: "t".into(),
            state,
            error: error.map(str::to_string),
        };
        assert_eq!(
            why(&end(State::Failed, Some("directory not found"))),
            "directory not found",
            "rclone's own words when there are any"
        );
        assert_eq!(why(&end(State::Stopped, None)), "the transfer was stopped");
        assert_eq!(
            why(&end(State::Interrupted, None)),
            "the rclone daemon went away mid-transfer"
        );
    }
}
