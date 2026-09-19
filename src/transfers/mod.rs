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
    // Every transfer is the service's now, a scheduled run included, so what the record says
    // is what is true: nothing here has to second-guess a row's state.
    Ok(ledger::list(
        &ctx.dirs,
        limit.unwrap_or(ledger::KEEP_ENTRIES),
    ))
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

    /// A scheduled run used to be a process of its own, with a ledger file of its own. Those
    /// files have no writer left, so whatever one still holds open ended when that process did:
    /// the server closes them once, on the first start after the upgrade, and from then on the
    /// list only reports what the record says.
    #[test]
    fn a_run_left_open_by_the_old_runner_is_closed_at_startup() {
        let root = std::env::temp_dir().join(format!("rcloneui-list-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dirs = DataDir { root };
        let ctx = Ctx::new(dirs.clone(), Events::noop());
        ledger::append(
            &ledger::task_path(&dirs, "nightly"),
            &run("scheduled", "nightly", &[ledger::TAG_SCHEDULE]),
        )
        .unwrap();

        let state = |id: &str| {
            transfers_list(&ctx, None)
                .unwrap()
                .into_iter()
                .find(|entry| entry.id == id)
                .unwrap()
                .state
        };
        assert_eq!(
            state("scheduled"),
            State::Running,
            "as the file has it, until the server has looked"
        );

        super::service::TransferService::new(ctx.clone(), true).recover();

        assert_eq!(state("scheduled"), State::Interrupted);
        let _ = std::fs::remove_dir_all(&dirs.root);
    }
}
