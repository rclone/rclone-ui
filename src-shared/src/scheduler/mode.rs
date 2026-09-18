//! Which scheduler drives the tasks: the OS one (the desktop app: crontab / launchd / Task
//! Scheduler) or the in-process ticker (the server, which is a long-running daemon and may run
//! in a container with no cron at all). Chosen once per process; the server sets it explicitly
//! and passes it to its `run-task` children through the environment so their orphan self-heal
//! targets the same backend.

use std::sync::OnceLock;

pub const ENV: &str = "RCLONE_UI_SCHEDULER_MODE";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Native,
    Ticker,
}

static MODE: OnceLock<Mode> = OnceLock::new();

pub fn set(mode: Mode) {
    let _ = MODE.set(mode);
}

pub fn get() -> Mode {
    *MODE.get_or_init(|| {
        if std::env::var(ENV).map(|v| v == "ticker").unwrap_or(false) {
            Mode::Ticker
        } else {
            Mode::Native
        }
    })
}
