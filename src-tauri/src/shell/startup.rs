//! The Startup window driver (main.ts `showStartup`): opened while a managed rclone is being
//! downloaded or updated, and once the daemon is ready unless the user hid it. The page reads
//! the phase itself (`lifecycle.phase`); this only decides when the window exists.

use std::sync::atomic::{AtomicBool, Ordering};

use rclone_ui_shared::lifecycle::Phase;
use serde_json::Value;

use super::SharedShell;
use crate::window;

static DISPLAYED: AtomicBool = AtomicBool::new(false);

/// A deep link at boot replaces the splash (the old orchestrator did the same).
pub fn suppress() {
    DISPLAYED.store(true, Ordering::SeqCst);
}

fn hide_startup(shell: &SharedShell) -> bool {
    shell
        .app_state()
        .get("hideStartup")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn show(shell: &SharedShell) {
    if DISPLAYED.swap(true, Ordering::SeqCst) {
        return;
    }
    let shell = shell.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) =
            window::open_small_window(&shell.app, &shell, "Startup".into(), "/startup".into())
        {
            log::warn!("[startup] could not open the startup window: {}", e);
        }
        // Linux: the splash is shown once, then hidden for good (main.ts did the same).
        if !cfg!(any(target_os = "windows", target_os = "macos")) {
            let _ = shell
                .store()
                .update(rclone_ui_shared::state_files::APP_DOC, |s| {
                    s.insert("hideStartup".into(), Value::Bool(true));
                });
        }
    });
}

pub async fn drive(shell: SharedShell) {
    let Some(supervisor) = shell.state().supervisor() else {
        return;
    };
    let mut phases = supervisor.subscribe();
    loop {
        let phase = phases.borrow_and_update().clone();
        match phase {
            Phase::Downloading { .. } | Phase::Updating { .. } => show(&shell),
            Phase::Ready { .. } => {
                if !hide_startup(&shell) {
                    show(&shell);
                }
                return;
            }
            Phase::NeedsPassword { .. } | Phase::Failed { .. } => {
                show(&shell);
                return;
            }
            _ => {}
        }
        if phases.changed().await.is_err() {
            return;
        }
    }
}
