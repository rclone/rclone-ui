//! The desktop's self-update: the Tauri updater plugin behind the server's `Updater` hook (the
//! Settings page's "Check for updates"), plus the boot-time policy from `rcloneui.com/latest`
//! (a required minimum version forces the update; an "ok" version merely offers it).

use std::sync::Mutex;

use rclone_ui_server::{UpdateInfo, Updater};
use rclone_ui_shared::rt;
use rclone_ui_shared::version::compare as compare_versions;
use rclone_ui_shared::Sink;
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_dialog::MessageDialogKind;
use tauri_plugin_updater::UpdaterExt;

use super::interaction::DesktopInteraction;
use super::SharedShell;

pub struct TauriUpdater {
    pub app: AppHandle,
    pending: Mutex<Option<tauri_plugin_updater::Update>>,
}

impl TauriUpdater {
    pub fn new(app: AppHandle) -> Self {
        TauriUpdater {
            app,
            pending: Mutex::new(None),
        }
    }

    fn fetch(
        &self,
        allow_downgrades: bool,
    ) -> Result<Option<tauri_plugin_updater::Update>, String> {
        let app = self.app.clone();
        rt::block_on(async move {
            let mut builder = app
                .updater_builder()
                .timeout(std::time::Duration::from_secs(30));
            if allow_downgrades {
                builder = builder.version_comparator(|current, release| release.version != current);
            }
            let updater = builder.build().map_err(|e| e.to_string())?;
            updater.check().await.map_err(|e| e.to_string())
        })
    }

    fn install_update(
        &self,
        update: &tauri_plugin_updater::Update,
        progress: &Sink<Value>,
    ) -> Result<(), String> {
        rt::block_on(async {
            let _ = progress
                .send(json!({ "event": "Started", "data": { "contentLength": Value::Null } }));
            update
                .download_and_install(
                    |chunk, total| {
                        let _ = progress.send(json!({ "event": "Progress", "data": { "chunkLength": chunk, "contentLength": total } }));
                    },
                    || {
                        let _ = progress.send(json!({ "event": "Finished" }));
                    },
                )
                .await
                .map_err(|e| e.to_string())
        })
    }
}

impl Updater for TauriUpdater {
    fn check(&self) -> Result<Option<UpdateInfo>, String> {
        let update = self.fetch(true)?;
        let info = update.as_ref().map(|u| UpdateInfo {
            version: u.version.clone(),
            current_version: u.current_version.clone(),
            body: u.body.clone(),
            date: u.date.map(|d| d.to_string()),
        });
        *self.pending.lock().unwrap() = update;
        Ok(info)
    }

    fn install(&self, progress: Sink<Value>) -> Result<(), String> {
        let update = self
            .pending
            .lock()
            .unwrap()
            .take()
            .ok_or("no update was checked")?;
        self.install_update(&update, &progress)
    }
}

#[derive(serde::Deserialize)]
struct LatestMeta {
    #[serde(rename = "minimumVersion")]
    minimum_version: String,
    #[serde(rename = "okVersion")]
    ok_version: String,
}

/// main.ts `checkVersion`: runs before the lifecycle so an outdated app never starts a daemon.
pub async fn check_at_boot(shell: &SharedShell) {
    let current = shell.app.package_info().version.to_string();
    let meta: LatestMeta = match reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
    {
        Ok(client) => match client.get("https://rcloneui.com/latest").send().await {
            Ok(response) => match response.json().await {
                Ok(meta) => meta,
                Err(e) => {
                    log::warn!("[updater] invalid latest.json: {}", e);
                    return;
                }
            },
            Err(e) => {
                log::warn!("[updater] could not fetch latest.json: {}", e);
                return;
            }
        },
        Err(e) => {
            log::warn!("[updater] {}", e);
            return;
        }
    };

    let below_minimum =
        compare_versions(&current, &meta.minimum_version) == std::cmp::Ordering::Less;
    let below_ok = compare_versions(&current, &meta.ok_version) == std::cmp::Ordering::Less;
    if !below_minimum && !below_ok {
        log::info!("[updater] {} is up to date", current);
        return;
    }

    let updater = TauriUpdater::new(shell.app.clone());
    let update = match rt::spawn_blocking(move || updater.fetch(true).map(|u| (updater, u))).await {
        Ok(Ok((updater, Some(update)))) => (updater, update),
        Ok(Ok((_, None))) => {
            log::info!("[updater] no update found");
            return;
        }
        Ok(Err(e)) => {
            log::warn!("[updater] check failed: {}", e);
            return;
        }
        Err(e) => {
            log::warn!("[updater] check failed: {}", e);
            return;
        }
    };
    let (updater, update) = update;

    rclone_ui_shared::lifecycle::notify(
        &shell.state().ctx,
        "app.update-available",
        "Rclone UI update available",
        &format!(
            "Version {} is available (current: {})",
            update.version, current
        ),
        json!({
            "currentVersion": current,
            "latestVersion": update.version,
            "minimumVersion": meta.minimum_version,
            "okVersion": meta.ok_version,
        }),
    );

    let required = below_minimum;
    let shell = shell.clone();
    let _ = rt::spawn_blocking(move || {
        let ui = DesktopInteraction {
            app: shell.app.clone(),
        };
        let title = if required { "Update Required" } else { "Update Available" };
        let confirmed = shell
            .app
            .dialog()
            .message("You are running an outdated version of Rclone UI. Please update to the latest version.")
            .title(title)
            .kind(MessageDialogKind::Info)
            .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                "Update".into(),
                if required { "Exit".into() } else { "Cancel".into() },
            ))
            .blocking_show();
        if !confirmed {
            if required {
                shell.mark_quitting();
                shell.app.exit(0);
            }
            return;
        }
        if rclone_ui_shared::is_flatpak() {
            ui.message(
                title,
                "A Flatpak version cannot update itself. Please update Rclone UI through your software manager.",
                MessageDialogKind::Info,
                if required { "Exit" } else { "OK" },
            );
            if required {
                shell.mark_quitting();
                shell.app.exit(0);
            }
            return;
        }
        match updater.install_update(&update, &Sink::discard()) {
            Ok(()) => {
                ui.message(
                    "Update Complete",
                    "Rclone UI has been updated. Please restart the application.",
                    MessageDialogKind::Info,
                    "Restart",
                );
                shell.mark_quitting();
                shell.app.restart();
            }
            Err(e) => {
                log::error!("[updater] install failed: {}", e);
                ui.message("Update Error", &format!("The update could not be installed: {}", e), MessageDialogKind::Error, "OK");
                if required {
                    shell.mark_quitting();
                    shell.app.exit(0);
                }
            }
        }
    })
    .await;
}

use tauri_plugin_dialog::DialogExt;
