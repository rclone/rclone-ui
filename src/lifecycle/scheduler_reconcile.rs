//! Startup reconciliation of scheduled tasks, run by the orchestrator once the daemon is up:
//! re-register every task the host document knows from its job file (heals a registration that
//! was lost, restored backups), unregister job files the document no longer lists, then sweep
//! the leftovers that have a registration but no job file. Tasks whose job file never got
//! written (a registration that failed in the page) stay the page's business: their request
//! serialization lives in TypeScript.

use crate::datadir::DataDir;
use crate::scheduler::{self, jobfile, storeread};

pub async fn reconcile(dirs: &DataDir) {
    let dirs = dirs.clone();
    let _ = tokio::task::spawn_blocking(move || reconcile_blocking(&dirs)).await;
}

fn reconcile_blocking(dirs: &DataDir) {
    let support = scheduler::supported(dirs);
    if !support.supported {
        log::info!(
            "[scheduler] unsupported, skipping reconcile: {}",
            support.reason.unwrap_or_default()
        );
        return;
    }

    // A fresh install has no host document yet: nothing to register, but strays still go.
    let host = if storeread::host_state_exists(dirs) {
        match storeread::read_host(dirs) {
            Ok(host) => host,
            Err(e) => {
                log::warn!("[scheduler] could not read the local host document: {}", e);
                return;
            }
        }
    } else {
        storeread::HostState::default()
    };

    let mut registered = 0;
    for spec in jobfile::list(dirs) {
        match host.scheduled_tasks.iter().find(|t| t.id == spec.task_id) {
            Some(task) => {
                let enabled = task.is_enabled.unwrap_or(true);
                let task_id = spec.task_id.clone();
                if let Err(e) = scheduler::register(dirs, spec, enabled) {
                    log::error!("[scheduler] failed to register task {}: {}", task_id, e);
                } else {
                    registered += 1;
                }
            }
            None => {
                log::info!("[scheduler] unregistering stray task {}", spec.task_id);
                if let Err(e) = scheduler::unregister(dirs, spec.task_id.clone()) {
                    log::warn!("[scheduler] stray unregister failed: {}", e);
                }
            }
        }
    }
    match scheduler::sweep(dirs) {
        Ok(swept) if swept > 0 => log::info!("[scheduler] swept orphaned artifacts: {}", swept),
        Ok(_) => {}
        Err(e) => log::warn!("[scheduler] orphan sweep failed: {}", e),
    }
    log::info!("[scheduler] reconciled {} task(s)", registered);
}
