//! How rclone's replies about a job read. Pure, and the one reading: what the service makes of
//! a tick and what the START button says on a failed launch both come from here.

use std::collections::HashMap;

use serde_json::Value;

use super::ledger::{State, Stats};

/// A batch's inputs that failed, each by what it names (its file; a folder, which has none of
/// its own, by where it is read from) and its error. Empty for anything that is not a batch:
/// a batch succeeds as a job while some of its inputs failed, which is where those live.
pub fn failures_of(status: &Value) -> Vec<(String, String)> {
    let results = status["output"]["results"].as_array();
    results
        .into_iter()
        .flatten()
        .filter_map(|result| {
            let error = result["error"].as_str().filter(|e| !e.is_empty())?;
            let label = ["srcRemote", "dstRemote", "remote", "srcFs", "fs"]
                .iter()
                .find_map(|key| result["input"][*key].as_str().filter(|v| !v.is_empty()))
                .unwrap_or("unknown");
            Some((label.to_string(), error.to_string()))
        })
        .collect()
}

fn inputs(status: &Value) -> usize {
    status["output"]["results"].as_array().map_or(0, Vec::len)
}

fn job_error(status: &Value) -> Option<String> {
    status["error"]
        .as_str()
        .filter(|e| !e.is_empty())
        .map(str::to_string)
}

/// `None` while the job runs; how it ended otherwise.
pub fn outcome_of(status: &Value) -> Option<(State, Option<String>)> {
    if !status["finished"].as_bool().unwrap_or(false) {
        return None;
    }
    let failed = failures_of(status).len();
    let error = job_error(status).or_else(|| {
        (failed > 0).then(|| format!("{} of {} operations failed", failed, inputs(status)))
    });
    Some(match error {
        Some(error) => (State::Failed, Some(error)),
        None => (State::Completed, None),
    })
}

/// The error a START button shows when the transfer died within the launch grace: rclone's own
/// message, or for a batch with nothing left standing, each input's.
pub fn launch_error(status: &Value) -> Option<String> {
    let failures = failures_of(status);
    job_error(status).or_else(|| {
        (!failures.is_empty() && failures.len() == inputs(status)).then(|| lines(&failures, "\n"))
    })
}

/// What a scheduled run reports: stricter than the launch check, since a run with some of its
/// inputs failed must not read as a success, and it says which.
pub fn run_error(status: &Value) -> Option<String> {
    let failures = failures_of(status);
    job_error(status).or_else(|| {
        (!failures.is_empty()).then(|| {
            format!(
                "{} of {} operations failed — {}",
                failures.len(),
                inputs(status),
                lines(&failures, "; ")
            )
        })
    })
}

fn lines(failures: &[(String, String)], between: &str) -> String {
    let lines: Vec<String> = failures
        .iter()
        .map(|(label, error)| format!("{}: {}", label, error))
        .collect();
    lines.join(between)
}

pub fn stats_of(stats: &Value, status: &Value) -> Stats {
    let number = |key: &str| stats[key].as_u64().unwrap_or(0);
    Stats {
        bytes: number("bytes"),
        total_bytes: number("totalBytes"),
        transfers: number("transfers"),
        checks: number("checks"),
        errors: number("errors"),
        duration_ms: (status["duration"].as_f64().unwrap_or(0.0) * 1000.0).round() as u64,
    }
}

/// How many failed files a transfer keeps. A run where everything fails (a destination that
/// turned read-only) would otherwise leave a details file of tens of megabytes.
pub const MAX_FAILED: usize = 1000;

/// The files of a transfer that failed, collected while it runs: rclone only remembers a job's
/// last 100 completed files, so a long transfer's early failures are gone from
/// `core/transferred` by the time it ends.
#[derive(Default, Debug)]
pub struct Failed {
    items: Vec<Value>,
    index: HashMap<String, usize>,
}

/// What a transfer leaves behind, set on its details: beside the request, when there is one.
pub fn keep_outcome(details: &mut Value, status: &Value, transferred: &Value, failed: &Failed) {
    details["status"] = status.clone();
    details["transferred"] = transferred.clone();
    details["failed"] = Value::Array(failed.items.clone());
}

/// Folds one `core/transferred` snapshot into what is known to have failed.
pub fn merge_failed(failed: &mut Failed, transferred: &Value) {
    let Some(items) = transferred.as_array() else {
        return;
    };
    for item in items {
        if item["error"].as_str().map_or(true, str::is_empty) {
            continue;
        }
        // The same name under another source is another file.
        let key = format!(
            "{}\n{}",
            item["srcFs"].as_str().unwrap_or_default(),
            item["name"].as_str().unwrap_or_default()
        );
        match failed.index.get(&key) {
            // Seen before: what rclone says of it now.
            Some(&at) => failed.items[at] = item.clone(),
            None if failed.items.len() < MAX_FAILED => {
                failed.index.insert(key, failed.items.len());
                failed.items.push(item.clone());
            }
            // Past the cap: not kept.
            None => {}
        }
    }
}

/// What one look at a watched transfer's `job/status` says.
#[derive(Debug, PartialEq)]
pub enum Verdict {
    Running,
    Ended {
        state: State,
        error: Option<String>,
        status: Value,
    },
    /// The daemon answering is not the one that started it. Job ids start over with every
    /// daemon, so what it says of this id is about some other job: the transfer went down with
    /// its daemon.
    AnotherDaemon,
    /// The daemon does not hold the job (any more).
    Gone,
    Unreachable(String),
}

/// Reads a `job/status` reply for a transfer started under `execute_id`, rclone's name for one
/// daemon process (a pid would do worse: in a container it is the same after every restart).
/// Checked on every look, not once: a daemon can be replaced at any time. An id missing on
/// either side proves nothing, and the reply is believed.
pub fn verdict(execute_id: &str, reply: Result<Value, String>) -> Verdict {
    let status = match reply {
        Ok(status) => status,
        Err(error) if error.contains("job not found") => return Verdict::Gone,
        Err(error) => return Verdict::Unreachable(error),
    };
    if is_another_daemon(execute_id, &status) {
        return Verdict::AnotherDaemon;
    }
    match outcome_of(&status) {
        Some((state, error)) => Verdict::Ended {
            state,
            error,
            status,
        },
        None => Verdict::Running,
    }
}

/// Whether a reply that carries rclone's `executeId` comes from another process than `ours`.
pub fn is_another_daemon(ours: &str, reply: &Value) -> bool {
    let theirs = reply["executeId"].as_str().unwrap_or_default();
    !ours.is_empty() && !theirs.is_empty() && ours != theirs
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn batch(results: Value) -> Value {
        json!({ "finished": true, "error": "", "output": { "results": results } })
    }

    #[test]
    fn a_job_status_reads_as_an_outcome() {
        assert_eq!(outcome_of(&json!({ "finished": false })), None);
        assert_eq!(
            outcome_of(&json!({ "finished": true, "success": true, "error": "" })),
            Some((State::Completed, None))
        );
        assert_eq!(
            outcome_of(&json!({ "finished": true, "error": "directory not found" })),
            Some((State::Failed, Some("directory not found".into())))
        );
        // A batch succeeds as a job while some of its inputs failed.
        let partial = batch(json!([
            { "error": "" },
            { "error": "object not found", "input": { "srcRemote": "a.txt" } }
        ]));
        assert_eq!(
            outcome_of(&partial),
            Some((State::Failed, Some("1 of 2 operations failed".into())))
        );
        // …which is not a failed launch: only a batch with nothing left standing is.
        assert_eq!(launch_error(&partial), None);
        // …but is a failed run, which says which.
        assert_eq!(
            run_error(&partial),
            Some("1 of 2 operations failed — a.txt: object not found".into())
        );
        let all =
            batch(json!([{ "error": "object not found", "input": { "srcRemote": "a.txt" } }]));
        assert_eq!(launch_error(&all), Some("a.txt: object not found".into()));
        assert_eq!(
            launch_error(&json!({ "finished": true, "error": "couldn't find remote" })),
            Some("couldn't find remote".into())
        );
        assert_eq!(
            launch_error(&json!({ "finished": false, "error": "" })),
            None
        );
        assert_eq!(run_error(&json!({ "finished": true, "error": "" })), None);
    }

    /// A folder has no file of its own to name: it is named by where it copies from, in every
    /// message.
    #[test]
    fn a_failed_input_is_named_by_its_file_or_else_by_its_folder() {
        let folder = batch(json!([
            { "error": "directory not found", "input": { "srcFs": "gdrive:photos", "dstFs": "/b" } }
        ]));
        assert_eq!(
            failures_of(&folder),
            [(
                "gdrive:photos".to_string(),
                "directory not found".to_string()
            )]
        );
        assert_eq!(
            launch_error(&folder),
            Some("gdrive:photos: directory not found".into())
        );
        assert_eq!(
            run_error(&folder),
            Some("1 of 1 operations failed — gdrive:photos: directory not found".into())
        );
        // A download names its file through `remote`.
        let url = batch(json!([{ "error": "404", "input": { "fs": "/tmp", "remote": "a.zip" } }]));
        assert_eq!(failures_of(&url)[0].0, "a.zip");
        assert!(failures_of(&json!({ "finished": true })).is_empty());
    }

    /// Job ids start over with every daemon: `job 7` on the daemon that replaced ours is some
    /// other job, and must never be read as this transfer's outcome.
    #[test]
    fn a_reply_from_another_daemon_is_not_about_this_transfer() {
        let done = |id: &str| json!({ "finished": true, "error": "", "executeId": id });
        assert_eq!(
            verdict("ours", Ok(done("ours"))),
            Verdict::Ended {
                state: State::Completed,
                error: None,
                status: done("ours")
            }
        );
        assert_eq!(verdict("ours", Ok(done("theirs"))), Verdict::AnotherDaemon);
        assert_eq!(
            verdict(
                "ours",
                Ok(json!({ "finished": false, "executeId": "theirs" }))
            ),
            Verdict::AnotherDaemon
        );
        assert_eq!(
            verdict(
                "ours",
                Ok(json!({ "finished": false, "executeId": "ours" }))
            ),
            Verdict::Running
        );
        // An id missing on either side proves nothing: the reply is believed.
        assert_eq!(
            verdict("", Ok(json!({ "finished": false, "executeId": "x" }))),
            Verdict::Running
        );
        assert_eq!(
            verdict("ours", Ok(json!({ "finished": false }))),
            Verdict::Running
        );

        assert_eq!(verdict("ours", Err("job not found".into())), Verdict::Gone);
        assert_eq!(
            verdict("ours", Err("connection refused".into())),
            Verdict::Unreachable("connection refused".into())
        );
    }

    #[test]
    fn totals_come_from_the_jobs_stats_group_and_its_duration() {
        let stats = stats_of(
            &json!({ "bytes": 5, "totalBytes": 9, "transfers": 2, "checks": 3, "errors": 1 }),
            &json!({ "duration": 1.5 }),
        );
        assert_eq!(
            stats,
            Stats {
                bytes: 5,
                total_bytes: 9,
                transfers: 2,
                checks: 3,
                errors: 1,
                duration_ms: 1500
            }
        );
    }

    /// rclone forgets all but a job's last 100 files, so failures are gathered as they go by.
    #[test]
    fn failures_are_kept_after_rclone_has_forgotten_them() {
        let item =
            |name: &str, error: &str| json!({ "name": name, "error": error, "srcFs": "/src" });
        let mut failed = Failed::default();
        merge_failed(
            &mut failed,
            &json!([item("a.txt", "permission denied"), item("fine.txt", "")]),
        );
        // A later snapshot: `a.txt` has fallen out of rclone's window, another file failed, and
        // one seen before is listed again with what rclone says of it now.
        merge_failed(&mut failed, &json!([item("b.txt", "quota exceeded")]));
        merge_failed(
            &mut failed,
            &json!([item("b.txt", "quota exceeded (again)")]),
        );
        merge_failed(&mut failed, &Value::Null);

        let names: Vec<&str> = failed
            .items
            .iter()
            .map(|f| f["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            ["a.txt", "b.txt"],
            "in the order they failed, successes left out"
        );
        assert_eq!(failed.items[1]["error"], "quota exceeded (again)");

        // The same name under another source is another file.
        merge_failed(
            &mut failed,
            &json!([{ "name": "a.txt", "error": "x", "srcFs": "/other" }]),
        );
        assert_eq!(failed.items.len(), 3);

        let many: Vec<Value> = (0..MAX_FAILED + 5)
            .map(|n| item(&format!("f{}", n), "no"))
            .collect();
        merge_failed(&mut failed, &Value::Array(many));
        assert_eq!(failed.items.len(), MAX_FAILED);
    }
}
