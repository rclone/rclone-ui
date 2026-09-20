//! Mounting: a mount the page asks for (`mount_start`), and the remotes marked "mount on start"
//! once the daemon is up (`startup_mounts`), which replay the request the page built when the
//! setting was saved. The page builds every `mount/mount` body (`lib/rclone/mount.ts`
//! `buildMountRequest`): the source with its options serialized in, the mount point as rclone
//! wants it, the option groups keyed by rclone's Go field names. The server owns what comes
//! before the call (the mount point made ready) and what comes after a failure (the
//! notification), and never reads a path.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::datadir::DataDir;
use crate::notifications::notify;
use crate::rc::RcClient;
use crate::state::{Settings, StateStore};

/// rclone's `mount/mount` body, as the page builds it. Saved as-is for a mount at start; the
/// option groups are keyed by rclone's Go field names (its stable rc API), and a re-save
/// regenerates them.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountRequest {
    pub fs: String,
    pub mount_point: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mount_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mount_opt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vfs_opt: Option<String>,
    #[serde(default, rename = "_config", skip_serializing_if = "Option::is_none")]
    pub config: Option<String>,
    #[serde(default, rename = "_filter", skip_serializing_if = "Option::is_none")]
    pub filter: Option<String>,
}

// ---------------------------------------------------------------------------
// Whether this machine can mount
// ---------------------------------------------------------------------------

/// Whether this machine can mount: WinFsp on Windows, the FUSE device on Linux; macOS mounts
/// through the system NFS client and needs neither. When it cannot, why, and where installing
/// what is missing is explained. Installing it is the operator's: nothing is downloaded here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountSupport {
    pub supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docs: Option<&'static str>,
}

const WINFSP_DIRS: [&str; 2] = [
    "C:\\Program Files\\WinFsp",
    "C:\\Program Files (x86)\\WinFsp",
];

/// Looked at every time it matters (each daemon start, each ask from a page) and never kept:
/// WinFsp or the FUSE device can turn up while the server runs.
pub fn support() -> MountSupport {
    support_in(std::path::Path::new("/dev/fuse"))
}

/// [`support`] against a given FUSE device path, so the rule can be tested without the machine's
/// real one. Only the device's existence is checked: a container that has it but lacks
/// `SYS_ADMIN` still fails when it mounts, and rclone says so then.
fn support_in(dev_fuse: &std::path::Path) -> MountSupport {
    let (reason, docs) = if cfg!(target_os = "windows") {
        if WINFSP_DIRS
            .iter()
            .any(|dir| std::path::Path::new(dir).exists())
        {
            (None, None)
        } else {
            (
                Some("WinFsp is not installed."),
                Some("https://github.com/winfsp/winfsp"),
            )
        }
    } else if cfg!(target_os = "linux") && !dev_fuse.exists() {
        (
            Some(
                "There is no /dev/fuse: a container needs --device /dev/fuse --cap-add SYS_ADMIN.",
            ),
            Some("https://rclone.org/install/#docker"),
        )
    } else {
        (None, None)
    };
    MountSupport {
        supported: reason.is_none(),
        reason,
        docs,
    }
}

// ---------------------------------------------------------------------------
// One mount
// ---------------------------------------------------------------------------

/// A mount point as a local path for rclone's file calls: the local backend at the root (or at
/// the drive, on Windows), and the rest as the path under it.
fn split_local(mount_point: &str, windows: bool) -> (String, String) {
    let normalized = mount_point.replace('\\', "/");
    if windows {
        let bytes = normalized.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            let rest = normalized[2..].trim_matches('/');
            return (format!(":local:{}:/", &normalized[..1]), rest.to_string());
        }
    }
    (
        ":local:/".to_string(),
        normalized.trim_matches('/').to_string(),
    )
}

/// Where the mount goes must be a folder, and an empty one: rclone would mount over whatever is
/// there. A missing one is made (except on Windows, where the mount wants it absent: an empty
/// one there is removed).
async fn prepare_mount_point(client: &RcClient, mount_point: &str) -> Result<(), String> {
    let windows = cfg!(target_os = "windows");
    let (fs, remote) = split_local(mount_point, windows);
    let place = json!({ "fs": fs, "remote": remote });
    let exists = match client.call_retrying("/operations/stat", place.clone()).await {
        Ok(stat) => {
            if stat["item"].is_null() {
                Some(false)
            } else if !stat["item"]["IsDir"].as_bool().unwrap_or(false) {
                return Err("The selected directory is not a directory".to_string());
            } else {
                Some(true)
            }
        }
        Err(e) => {
            log::warn!("[mounts] could not stat {}: {}", mount_point, e);
            None
        }
    };
    if exists == Some(true) {
        let is_empty = match client.call_retrying("/operations/list", place.clone()).await {
            Ok(listing) => listing["list"]
                .as_array()
                .map(|l| l.is_empty())
                .unwrap_or(true),
            Err(e) => {
                log::warn!("[mounts] could not list {}: {}", mount_point, e);
                false
            }
        };
        if !is_empty {
            return Err("The selected directory must be empty to mount a remote.".to_string());
        }
        if windows {
            let _ = client.call_retrying("/operations/rmdir", place).await;
        }
    } else if !windows {
        client
            .call_retrying("/operations/mkdir", place)
            .await
            .map_err(|_| {
                "Failed to create mount directory. Try creating it manually first.".to_string()
            })?;
    }
    Ok(())
}

/// Starts a mount as the page asked: the mount point made ready, then rclone's `mount/mount`
/// with the request as it came. Resolves to the mount point (on Windows, `*` becomes the drive
/// letter rclone picked). A failure is notified (`mount.failed`) before it is returned.
pub async fn mount_start(
    client: &RcClient,
    dirs: &DataDir,
    request: &MountRequest,
) -> Result<String, String> {
    let outcome = async {
        if request.mount_point != "*" {
            prepare_mount_point(client, &request.mount_point).await?;
        }
        let body = serde_json::to_value(request).map_err(|e| e.to_string())?;
        let reply = client.call_retrying("/mount/mount", body).await?;
        Ok::<String, String>(
            reply["mountPoint"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| request.mount_point.clone()),
        )
    }
    .await;
    if let Err(error) = &outcome {
        notify(
            dirs,
            "mount.failed",
            "Mount failed",
            &format!("Failed to mount {}: {}", request.fs, error),
            json!({ "source": request.fs, "destination": request.mount_point, "error": error }),
        );
    }
    outcome
}

// ---------------------------------------------------------------------------
// The mounts at start
// ---------------------------------------------------------------------------

/// How many remotes are set to mount at start. The same two conditions the loop below applies
/// per remote, so a host that cannot mount stays quiet unless there was really something to skip.
fn asked_to_mount(settings: &Settings) -> usize {
    settings
        .remote_configs
        .values()
        .filter_map(|c| c.mount_on_start.as_ref())
        .filter(|m| m.enabled && !m.mount_point.is_empty())
        .count()
}

/// Whether the source is there and answers: its listing, and nothing of it kept.
async fn probe_source(client: &RcClient, fs: &str) -> Result<(), String> {
    client
        .call(
            "/operations/list",
            &json!({ "fs": fs, "remote": "", "opt": { "dirsOnly": true, "noModTime": true, "noMimeType": true } }),
        )
        .await
        .map(|_| ())
}

/// Mounts every remote whose "mount on start" is set, one after another, once the daemon is up:
/// each source probed (with backoff), then its saved request replayed.
///
/// A machine that cannot mount would fail each attempt the same way on every restart. That is a
/// fact about the deployment rather than an incident, so it is said once, in the log, and
/// nothing is notified.
pub async fn startup_mounts(dirs: &DataDir, store: &StateStore, client: &RcClient) {
    let settings = store.settings();
    if let Some(reason) = support().reason {
        let asked = asked_to_mount(&settings);
        if asked > 0 {
            log::info!(
                "[mounts] {} remote(s) ask to mount at start, but this machine cannot mount: {}",
                asked,
                reason
            );
        }
        return;
    }

    let remotes = match client.call("/config/listremotes", &json!({})).await {
        Ok(reply) => reply["remotes"]
            .as_array()
            .map(|r| {
                r.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        Err(e) => {
            log::warn!("[mounts] could not list remotes: {}", e);
            return;
        }
    };

    for remote in remotes {
        let Some(config) = settings
            .remote_configs
            .get(&remote)
            .and_then(|c| c.mount_on_start.clone())
        else {
            continue;
        };
        if !config.enabled || config.mount_point.is_empty() {
            continue;
        }
        let Some(request) = config.request else {
            log::warn!(
                "[mounts] {} is set to mount at start but was saved before its request was kept; open its Auto Mount settings and save it again",
                remote
            );
            continue;
        };

        // The same ladder the RC calls themselves climb (`call_retrying`): four attempts over
        // about seven seconds. A remote whose network is still coming up at boot gets its chance;
        // one that is simply unreachable does not hold up the remotes behind it.
        let probe = crate::rc::retry(
            3,
            Duration::from_secs(1),
            Duration::from_secs(8),
            |_| true,
            || probe_source(client, &request.fs),
        )
        .await;
        if let Err(error) = probe {
            let body = format!(
                "{} is not reachable, or is not there (a network or sign-in problem, or a Remote Path to fix in the remote's Auto Mount settings) — not mounting to avoid an empty folder at {}",
                request.fs, request.mount_point
            );
            log::warn!("[mounts] {}: {}", body, error);
            notify(
                dirs,
                "mount.failed",
                "Automount skipped",
                &body,
                json!({ "source": request.fs, "destination": request.mount_point, "error": error }),
            );
            continue;
        }

        log::info!("[mounts] mounting {} at {}", request.fs, request.mount_point);
        match mount_start(client, dirs, &request).await {
            Ok(at) => {
                if let Err(e) = probe_source(client, &request.fs).await {
                    // Log-only: the mount itself succeeded, so there is no mount.failed to report.
                    log::warn!(
                        "[mounts] {} mounted at {} but listing it failed ({}) — the folder may \
                         appear empty until the connection recovers",
                        request.fs,
                        at,
                        e
                    );
                }
            }
            // Notified by `mount_start` itself.
            Err(error) => log::error!("[mounts] failed to mount {}: {}", request.fs, error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{MountOnStart, RemoteConfig};

    #[test]
    fn a_mount_point_splits_into_the_local_root_and_the_path_under_it() {
        assert_eq!(
            split_local("/Users/me/mnt/", false),
            (":local:/".into(), "Users/me/mnt".into())
        );
        assert_eq!(split_local("/", false), (":local:/".into(), "".into()));
        assert_eq!(
            split_local("C:\\data\\mnt", true),
            (":local:C:/".into(), "data/mnt".into())
        );
        assert_eq!(split_local("D:", true), (":local:D:/".into(), "".into()));
        // A UNC-less relative path on Windows is under the root, as rclone reads it.
        assert_eq!(
            split_local("/mnt/x", true),
            (":local:/".into(), "mnt/x".into())
        );
    }

    /// The request goes to rclone as it came, once the mount point is ready: a missing folder is
    /// made first; a folder with something in it is refused before rclone is asked.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_mount_makes_its_folder_and_sends_the_request_as_it_came() {
        use axum::extract::{Path, State};
        use axum::routing::post;
        use axum::Json;
        use std::sync::{Arc, Mutex};

        type Calls = Arc<Mutex<Vec<(String, serde_json::Value)>>>;
        async fn rc(
            State(calls): State<Calls>,
            Path(path): Path<String>,
            Json(body): Json<serde_json::Value>,
        ) -> Json<serde_json::Value> {
            calls.lock().unwrap().push((path.clone(), body.clone()));
            Json(match path.as_str() {
                "operations/stat" => {
                    if body["remote"] == "tmp/full" {
                        json!({ "item": { "IsDir": true } })
                    } else {
                        json!({ "item": null })
                    }
                }
                "operations/list" => json!({ "list": [{ "Name": "something" }] }),
                "mount/mount" => json!({}),
                _ => json!({}),
            })
        }
        let calls: Calls = Arc::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = axum::Router::new()
            .route("/{*path}", post(rc))
            .with_state(Arc::clone(&calls));
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = RcClient::new(format!("http://{}", addr), None, None);
        let root = std::env::temp_dir().join(format!("rclone-cloud-mounts-{}", std::process::id()));
        let dirs = DataDir { root };

        let request = MountRequest {
            fs: "gdrive:photos/".into(),
            mount_point: "/tmp/empty/".into(),
            mount_type: Some("nfsmount".into()),
            mount_opt: None,
            vfs_opt: Some(r#"{"CacheMode":"full"}"#.into()),
            config: Some(r#"{"DryRun":false}"#.into()),
            filter: None,
        };
        assert_eq!(
            mount_start(&client, &dirs, &request).await.unwrap(),
            "/tmp/empty/"
        );
        let made: Vec<(String, serde_json::Value)> = calls.lock().unwrap().drain(..).collect();
        let names: Vec<&str> = made.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(names, ["operations/stat", "operations/mkdir", "mount/mount"]);
        assert_eq!(made[1].1, json!({ "fs": ":local:/", "remote": "tmp/empty" }));
        assert_eq!(
            made[2].1,
            json!({ "fs": "gdrive:photos/", "mountPoint": "/tmp/empty/", "mountType": "nfsmount", "vfsOpt": r#"{"CacheMode":"full"}"#, "_config": r#"{"DryRun":false}"# }),
            "nothing added, nothing renamed"
        );

        let full = MountRequest {
            mount_point: "/tmp/full".into(),
            ..request
        };
        let refused = mount_start(&client, &dirs, &full).await.unwrap_err();
        assert!(refused.contains("must be empty"));
        let names: Vec<String> = calls.lock().unwrap().iter().map(|(p, _)| p.clone()).collect();
        assert_eq!(names, ["operations/stat", "operations/list"], "rclone was not asked");
        let _ = std::fs::remove_dir_all(&dirs.root);
    }

    /// A host that cannot mount says so once, and only when a remote actually asked. The two
    /// conditions are the loop's own: switched on, and with somewhere to mount.
    #[test]
    fn only_remotes_that_really_asked_are_counted() {
        let remote = |enabled, mount_point: &str| RemoteConfig {
            mount_on_start: Some(MountOnStart {
                enabled,
                mount_point: mount_point.to_string(),
                ..Default::default()
            }),
        };
        let mut settings = Settings::default();
        assert_eq!(asked_to_mount(&settings), 0, "nothing configured");

        settings
            .remote_configs
            .insert("no-config".into(), RemoteConfig::default());
        settings
            .remote_configs
            .insert("switched-off".into(), remote(false, "/mnt/off"));
        settings
            .remote_configs
            .insert("nowhere-to-go".into(), remote(true, ""));
        assert_eq!(asked_to_mount(&settings), 0, "none of those would be mounted");

        settings
            .remote_configs
            .insert("wants-it".into(), remote(true, "/mnt/one"));
        settings
            .remote_configs
            .insert("wants-it-too".into(), remote(true, "/mnt/two"));
        assert_eq!(asked_to_mount(&settings), 2);
    }

    /// A container without the FUSE device cannot mount, and says why and where to read on. Linux
    /// only: macOS mounts over the system NFS client, Windows through WinFsp.
    #[test]
    #[cfg(target_os = "linux")]
    fn linux_needs_the_fuse_device_to_offer_mounting() {
        let dir = std::env::temp_dir().join(format!("rclone-cloud-fuse-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let absent = dir.join("absent");
        let present = dir.join("present");
        std::fs::write(&present, b"").unwrap();

        let without = support_in(&absent);
        assert!(!without.supported, "no device, no mounting");
        assert!(without.reason.is_some() && without.docs.is_some());
        assert_eq!(
            support_in(&present),
            MountSupport {
                supported: true,
                reason: None,
                docs: None
            },
            "the device is the whole check"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Everywhere else the device is beside the point and must not be looked at.
    #[test]
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    fn other_platforms_do_not_ask_about_fuse() {
        assert!(support_in(std::path::Path::new("/nowhere/near/a/real/device")).supported);
    }
}
