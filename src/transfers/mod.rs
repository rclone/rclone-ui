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

use crate::datadir::DataDir;

/// Every transfer, running and past, newest first.
pub fn list(dirs: &DataDir, limit: Option<usize>) -> Vec<ledger::Entry> {
    ledger::list(dirs, limit.unwrap_or(ledger::KEEP_ENTRIES))
}

/// What a finished transfer left behind: rclone's last `job/status` and the files it moved.
pub fn detail(dirs: &DataDir, id: &str) -> Result<Option<serde_json::Value>, String> {
    let id = crate::scheduler::sanitize_id(id).map_err(|_| "invalid transfer id")?;
    Ok(ledger::read_details(dirs, &id))
}
