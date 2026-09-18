//! Startup reconciliation of scheduled tasks (lib/scheduler.ts `reconcile`, now in Rust and
//! run by the orchestrator once the daemon is up): re-register every task the host document
//! knows from its job file (heals exe-path drift, deleted OS artifacts, restored backups),
//! unregister job files the document no longer lists, then sweep artifact-only leftovers.
//! Tasks whose job file never got written (a registration that failed in the page) stay the
//! page's business: their request serialization lives in TypeScript.

use crate::ctx::Ctx;
use crate::rt;
use crate::scheduler::{self, jobfile, storeread};

pub async fn reconcile(ctx: &Ctx) {
    let ctx = ctx.clone();
    let _ = rt::spawn_blocking(move || reconcile_blocking(&ctx)).await;
}

fn reconcile_blocking(ctx: &Ctx) {
    match scheduler::scheduler_supported(ctx) {
        Ok(support) if support.supported => {}
        Ok(support) => {
            log::info!(
                "[scheduler] unsupported, skipping reconcile: {}",
                support.reason.unwrap_or_default()
            );
            return;
        }
        Err(e) => {
            log::warn!("[scheduler] support check failed: {}", e);
            return;
        }
    }

    let root = storeread::read_root(&ctx.dirs).unwrap_or_default();
    // Never reconcile against a remote host: the stray sweep would treat every real local
    // registration as unknown and destroy it.
    if root.current_host_id.as_deref().unwrap_or("local") != "local" {
        log::info!("[scheduler] current host is remote, skipping reconcile");
        return;
    }
    // A fresh install has no host document yet: nothing to register, but strays still go.
    let host = if storeread::host_state_exists(&ctx.dirs, "local") {
        match storeread::read_host(&ctx.dirs, "local") {
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
    for spec in jobfile::list(&ctx.dirs, "local") {
        match host.scheduled_tasks.iter().find(|t| t.id == spec.task_id) {
            Some(task) => {
                let enabled = task.is_enabled.unwrap_or(true);
                let task_id = spec.task_id.clone();
                if let Err(e) = scheduler::scheduler_register(ctx, spec, enabled) {
                    log::error!("[scheduler] failed to register task {}: {}", task_id, e);
                } else {
                    registered += 1;
                }
            }
            None => {
                log::info!("[scheduler] unregistering stray task {}", spec.task_id);
                if let Err(e) =
                    scheduler::scheduler_unregister(ctx, spec.task_id.clone(), "local".into())
                {
                    log::warn!("[scheduler] stray unregister failed: {}", e);
                }
            }
        }
    }
    match scheduler::scheduler_sweep_orphans(ctx) {
        Ok(swept) if swept > 0 => log::info!("[scheduler] swept orphaned artifacts: {}", swept),
        Ok(_) => {}
        Err(e) => log::warn!("[scheduler] orphan sweep failed: {}", e),
    }
    log::info!("[scheduler] reconciled {} task(s)", registered);
}
