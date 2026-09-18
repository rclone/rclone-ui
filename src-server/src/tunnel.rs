//! The mobile-pairing tunnel: a `cloudflared` quick tunnel in front of the managed daemon. The
//! daemon is authenticated, so the pairing payload (`tunnel_start`'s reply, rendered as a QR
//! code by the Mobile section) carries the RC credentials the mobile app must send as Basic
//! auth. Owned by the server so quit tears it down and every page sees the same state.

use std::path::PathBuf;

use rclone_ui_shared::commands::misc;
use rclone_ui_shared::rt;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::Shared;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    pub url: String,
    pub user: Option<String>,
    pub pass: Option<String>,
    #[serde(skip)]
    pub pid: u32,
    /// The daemon this tunnel forwards to; a restarted daemon has another address.
    #[serde(skip)]
    pub daemon: String,
}

/// Whether the tunnel still points at the daemon that is running.
pub fn is_stale(info: &TunnelInfo, daemon_base_url: &str) -> bool {
    info.daemon != daemon_base_url
}

#[derive(Default)]
pub struct Tunnel {
    inner: std::sync::Mutex<Option<TunnelInfo>>,
    /// Serializes start/stop so two pages can't race two cloudflared processes.
    lock: Mutex<()>,
}

pub fn binary_path(local_data: &std::path::Path) -> PathBuf {
    local_data.join(if cfg!(windows) {
        "cloudflared.exe"
    } else {
        "cloudflared"
    })
}

impl Tunnel {
    pub fn status(&self) -> Value {
        self.inner
            .lock()
            .unwrap()
            .as_ref()
            .map(|t| serde_json::to_value(t).unwrap_or(Value::Null))
            .unwrap_or(Value::Null)
    }

    fn set(&self, st: &Shared, info: Option<TunnelInfo>) {
        *self.inner.lock().unwrap() = info;
        st.ctx.events.emit("tunnel.changed", self.status());
    }

    pub async fn start(&self, st: &Shared) -> Result<TunnelInfo, String> {
        let _guard = self.lock.lock().await;
        if let Some(existing) = self.inner.lock().unwrap().clone() {
            return Ok(existing);
        }
        let daemon = st
            .local_daemon()
            .ok_or("the rclone daemon is not running yet")?;
        let ctx = st.ctx.clone();
        let base_url = daemon.base_url.clone();
        let target = base_url.clone();
        let (pid, url) = rt::spawn_blocking(move || misc::start_cloudflared_tunnel(&ctx, &target))
            .await
            .map_err(|e| e.to_string())??;
        let info = TunnelInfo {
            url,
            user: daemon.user,
            pass: daemon.pass,
            pid,
            daemon: base_url,
        };
        self.set(st, Some(info.clone()));
        Ok(info)
    }

    pub async fn stop_with(&self, st: &Shared) {
        let _guard = self.lock.lock().await;
        let current = self.inner.lock().unwrap().take();
        if let Some(info) = current {
            let ctx = st.ctx.clone();
            let _ = rt::spawn_blocking(move || misc::stop_cloudflared_tunnel(&ctx, info.pid)).await;
            self.set(st, None);
        }
    }

    /// After a managed daemon restart (a new port and credentials): a tunnel still pointing at
    /// the old daemon is torn down and started again, so the pairing the Mobile section shows
    /// is one that works.
    pub async fn rebuild_if_stale(&self, st: &Shared) {
        let Some(daemon) = st.local_daemon() else {
            return;
        };
        let stale = self
            .inner
            .lock()
            .unwrap()
            .as_ref()
            .map(|info| is_stale(info, &daemon.base_url))
            .unwrap_or(false);
        if !stale {
            return;
        }
        log::info!(
            "[tunnel] the daemon moved to {}; rebuilding the pairing tunnel",
            daemon.base_url
        );
        self.stop_with(st).await;
        if let Err(e) = self.start(st).await {
            log::warn!("[tunnel] rebuild after the daemon restart failed: {}", e);
        }
    }

    /// Best-effort teardown without a state handle (server shutdown).
    pub async fn stop(&self) {
        let _guard = self.lock.lock().await;
        let current = self.inner.lock().unwrap().take();
        if let Some(info) = current {
            let _ =
                rt::spawn_blocking(move || rclone_ui_shared::kill_pid(info.pid, Some(6000))).await;
        }
    }
}

/// Downloads the current cloudflared release into the app's local data dir.
pub async fn provision(st: &Shared) -> Result<bool, String> {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        "x86" => "386",
        other => return Err(format!("unsupported architecture {}", other)),
    };
    let base = "https://github.com/cloudflare/cloudflared/releases/latest/download";
    let (url, tgz) = match std::env::consts::OS {
        "macos" => (format!("{}/cloudflared-darwin-{}.tgz", base, arch), true),
        "windows" => (format!("{}/cloudflared-windows-{}.exe", base, arch), false),
        _ => (format!("{}/cloudflared-linux-{}", base, arch), false),
    };
    let target = binary_path(&st.ctx.dirs.root);
    let staging =
        std::env::temp_dir().join(format!("rclone-ui-cloudflared-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let downloaded = staging.join(if tgz {
        "cloudflared.tgz"
    } else {
        "cloudflared.bin"
    });
    crate::fs::download_to(&st.http, &url, &downloaded).await?;
    let binary = if tgz {
        let extracted = staging.join("extracted");
        let ctx = st.ctx.clone();
        let tgz_path = downloaded.to_string_lossy().into_owned();
        let out = extracted.to_string_lossy().into_owned();
        rt::spawn_blocking(move || misc::extract_tgz(&ctx, tgz_path, out))
            .await
            .map_err(|e| e.to_string())??;
        extracted.join("cloudflared")
    } else {
        downloaded
    };
    if !binary.is_file() {
        return Err("could not find the cloudflared binary in the download".to_string());
    }
    std::fs::create_dir_all(&st.ctx.dirs.root).map_err(|e| e.to_string())?;
    std::fs::copy(&binary, &target).map_err(|e| format!("could not install cloudflared: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
    }
    let _ = std::fs::remove_dir_all(&staging);
    let _ = json!({});
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tunnel_is_stale_once_the_daemon_moved() {
        let info = TunnelInfo {
            url: "https://x.trycloudflare.com".into(),
            user: None,
            pass: None,
            pid: 1,
            daemon: "http://127.0.0.1:50001".into(),
        };
        assert!(!is_stale(&info, "http://127.0.0.1:50001"));
        assert!(is_stale(&info, "http://127.0.0.1:50002"));
    }
}
