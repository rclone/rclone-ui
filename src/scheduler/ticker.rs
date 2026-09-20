//! The server's own minute ticker: at the top of every minute, every enabled task whose cron
//! matches the clock is handed to the runner. The server is already running when a task comes
//! due, so nothing has to be registered with the operating system, and nothing has to be
//! started either: the run happens here ([`super::runner::run`]).

use std::sync::Arc;
use std::time::Duration;

use super::{cron, runner, taskfile};
use crate::bus::Bus;
use crate::datadir::DataDir;
use crate::transfers::service::TransferService;

/// Runs due tasks at the top of every minute. A task whose previous run is still going is
/// skipped by the runner itself; missed minutes are not caught up — a server that was down was
/// not going to run them anyway.
pub async fn run_ticker(dirs: DataDir, bus: Bus, transfers: Arc<TransferService>) {
    use chrono::{Datelike, Timelike};
    loop {
        let now = chrono::Local::now();
        let wait = 60 - now.second() as u64;
        tokio::time::sleep(Duration::from_secs(wait) + Duration::from_millis(500)).await;

        let now = chrono::Local::now();
        let (minute, hour, dom, month, dow) = (
            now.minute() as u16,
            now.hour() as u16,
            now.day() as u16,
            now.month() as u16,
            now.weekday().num_days_from_sunday() as u16,
        );
        for file in taskfile::list(&dirs) {
            if !file.enabled {
                continue;
            }
            let Ok(spec) = cron::parse(&file.spec.cron) else {
                continue;
            };
            if !cron::matches(&spec, minute, hour, dom, month, dow) {
                continue;
            }
            log::info!("[ticker] firing {} ({})", file.spec.name, file.id);
            // Off the loop: a run lasts as long as its transfers do, and the next minute must
            // arrive on time regardless.
            tokio::spawn(runner::run(
                dirs.clone(),
                bus.clone(),
                Arc::clone(&transfers),
                file.id.clone(),
            ));
        }
    }
}
