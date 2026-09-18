//! Transfers as this app records them. rclone knows a job only while its daemon lives (and lists
//! files in flight, not jobs), so what ran, when and how it ended is written here, in
//! append-only files under `<data dir>/transfers/`, and that record is what every list reads.
//! rclone's API is asked for one thing only: the live numbers of a transfer that is running.
//!
//! [`ledger`] is the files; [`service`] is the server's side of them: it starts transfers,
//! watches them to the end and writes what happened.

pub mod ledger;
pub mod service;
pub mod status;

use crate::ctx::Ctx;

/// A host's transfers, running and past, newest first.
pub fn transfers_list(
    ctx: &Ctx,
    limit: Option<usize>,
) -> Result<Vec<ledger::Entry>, String> {
    let mut entries = ledger::list(&ctx.dirs, limit.unwrap_or(ledger::KEEP_ENTRIES));
    // A scheduled run that was killed outright left its transfer open, and its file has no
    // writer until the task runs again. The run lock is the truth about that: nobody holds it,
    // nothing is running. Read that way here; the runner writes it down on its next run.
    for entry in entries.iter_mut() {
        if !entry.tags.iter().any(|tag| tag == ledger::TAG_SCHEDULE) {
            continue;
        }
        let Some(task_id) = &entry.task_id else {
            continue;
        };
        if entry.state == ledger::State::Running
            && !crate::scheduler::history::is_running(&ctx.dirs, task_id)
        {
            entry.state = ledger::State::Interrupted;
        }
    }
    Ok(entries)
}

/// What a finished transfer left behind: rclone's last `job/status` and the files it moved.
pub fn transfers_detail(ctx: &Ctx, id: String) -> Result<Option<serde_json::Value>, String> {
    let id = crate::scheduler::sanitize_id(&id).map_err(|_| "invalid transfer id")?;
    Ok(ledger::read_details(&ctx.dirs, &id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ctx::Events;
    use crate::datadir::DataDir;
    use ledger::{Line, Started, State};

    fn run(id: &str, task: &str, tags: &[&str]) -> Line {
        Line::Started(Started {
            id: id.into(),
            ts: "2026-01-01T00:00:00.000Z".into(),
            jobid: 1,
            operation: "copy".into(),
            task_id: Some(task.into()),
            run_id: Some("r1".into()),
            tags: tags.iter().map(|tag| tag.to_string()).collect(),
            ..Started::default()
        })
    }

    /// A scheduled run that was killed left its transfer open. Nobody holds its run lock, so it
    /// reads as interrupted. What makes it a scheduled run is its tag; the task id only says
    /// which schedule to ask about.
    #[test]
    fn an_open_scheduled_run_nobody_holds_reads_as_interrupted() {
        let root = std::env::temp_dir().join(format!("rcloneui-list-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dirs = DataDir { root };
        let ctx = Ctx::new(dirs.clone(), Events::noop());
        ledger::append(
            &ledger::task_path(&dirs, "nightly"),
            &run("scheduled", "nightly", &[ledger::TAG_SCHEDULE]),
        )
        .unwrap();
        ledger::append(
            &ledger::task_path(&dirs, "other"),
            &run("untagged", "other", &[]),
        )
        .unwrap();

        let entries = transfers_list(&ctx, None).unwrap();
        let state = |id: &str| entries.iter().find(|entry| entry.id == id).unwrap().state;
        assert_eq!(state("scheduled"), State::Interrupted);
        assert_eq!(state("untagged"), State::Running);
        let _ = std::fs::remove_dir_all(&dirs.root);
    }
}
