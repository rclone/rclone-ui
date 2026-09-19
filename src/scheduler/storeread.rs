//! Read-only access to the app's persisted stores for the scheduler commands and the lifecycle:
//! the documents as they are on disk, without going through the state store.
//!
//! A document is `{version, revision, state}` on disk, written by the state store. Only the
//! fields the scheduler and the lifecycle need are modeled; unknown fields
//! are ignored so unrelated store changes never break the runner.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Deserialize;

pub use crate::datadir::DataDir;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RootState {
    pub rclone_path: Option<String>,
    pub auto_update_rclone: bool,
    pub last_notified_rclone_version: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HostState {
    pub proxy: Option<ProxyCfg>,
    pub limits: Limits,
    pub remote_configs: HashMap<String, RemoteConfig>,
    /// Only what the boot reconcile needs; the task bodies stay opaque to Rust.
    pub scheduled_tasks: Vec<ScheduledTaskEntry>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScheduledTaskEntry {
    pub id: String,
    pub is_enabled: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteConfig {
    pub mount_on_start: Option<MountOnStart>,
}

/// Mirrors store/host.ts `RemoteConfig['mountOnStart']`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MountOnStart {
    pub enabled: bool,
    pub remote_path: String,
    pub mount_point: String,
    pub mount_options: serde_json::Map<String, serde_json::Value>,
    pub vfs_options: serde_json::Map<String, serde_json::Value>,
    pub filter_options: serde_json::Map<String, serde_json::Value>,
    pub config_options: serde_json::Map<String, serde_json::Value>,
    pub metadata_options: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProxyCfg {
    pub url: String,
    pub ignored_hosts: Vec<String>,
}

/// Mirrors store/host.ts `limits`: the budgets one rclone process shares across every transfer.
/// Empty and zero mean "not set here".
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Limits {
    pub bw_limit: String,
    pub tps_limit: f64,
    pub tps_limit_burst: u32,
}

/// The server's state documents (`state_files.rs`): `{version, revision, state}`.
fn read_state_doc<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    let raw = match std::fs::read(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("failed to read {}: {}", path.display(), e)),
    };
    let doc: serde_json::Value = serde_json::from_slice(&raw)
        .map_err(|e| format!("invalid state file {}: {}", path.display(), e))?;
    let state = doc
        .get("state")
        .cloned()
        .ok_or_else(|| format!("state file {} has no state", path.display()))?;
    serde_json::from_value(state)
        .map(Some)
        .map_err(|e| format!("invalid state in {}: {}", path.display(), e))
}

pub fn app_doc_path(dirs: &DataDir) -> PathBuf {
    dirs.root.join("state").join("app.json")
}

pub fn host_doc_path(dirs: &DataDir) -> PathBuf {
    dirs.root.join("state").join("host.json")
}

/// Reads the app document; a missing one is the default (a fresh install).
pub fn read_root(dirs: &DataDir) -> Result<RootState, String> {
    Ok(read_state_doc(&app_doc_path(dirs))?.unwrap_or_default())
}

/// Whether the host document exists (a fresh install has none).
pub fn host_state_exists(dirs: &DataDir) -> bool {
    host_doc_path(dirs).is_file()
}

pub fn read_host(dirs: &DataDir) -> Result<HostState, String> {
    let path = host_doc_path(dirs);
    read_state_doc(&path)?.ok_or_else(|| format!("no host document at {}", path.display()))
}

/// The environment the daemon is started with, on top of the one this process already has.
///
/// The proxy and the limits belong here. Nothing about rclone's configuration file does: the server does
/// not decide where that lives, so `RCLONE_CONFIG` and friends are left exactly as the operator
/// set them and rclone resolves its own config (see `lifecycle/mod.rs`).
pub fn build_run_env(host: &HostState) -> HashMap<String, String> {
    let mut env = HashMap::new();

    if let Some(proxy) = &host.proxy {
        if !proxy.url.is_empty() {
            for key in ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"] {
                env.insert(key.to_string(), proxy.url.clone());
            }
            if !proxy.ignored_hosts.is_empty() {
                let joined = proxy.ignored_hosts.join(",");
                env.insert("no_proxy".to_string(), joined.clone());
                env.insert("NO_PROXY".to_string(), joined);
            }
        }
    }

    // Only what is set here: left out, the operator's own RCLONE_BWLIMIT / RCLONE_TPSLIMIT
    // still reach the daemon. `--tpslimit` is read once, at start, which is why it is here.
    let limits = &host.limits;
    if !limits.bw_limit.trim().is_empty() {
        env.insert(
            "RCLONE_BWLIMIT".to_string(),
            limits.bw_limit.trim().to_string(),
        );
    }
    if limits.tps_limit.is_finite() && limits.tps_limit > 0.0 {
        env.insert("RCLONE_TPSLIMIT".to_string(), limits.tps_limit.to_string());
        if limits.tps_limit_burst > 0 {
            env.insert(
                "RCLONE_TPSLIMIT_BURST".to_string(),
                limits.tps_limit_burst.to_string(),
            );
        }
    }

    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_state_document_reads_with_unknown_fields_and_a_missing_one_is_the_default() {
        let dir =
            std::env::temp_dir().join(format!("rclone-cloud-storetest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let dirs = DataDir { root: dir.clone() };
        assert!(read_root(&dirs).unwrap().rclone_path.is_none());
        let path = app_doc_path(&dirs);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // notificationTargets moved to notifications/targets.json — here it's just one more
        // unknown field that must not break the decode.
        std::fs::write(
            &path,
            r#"{"version":3,"revision":2,"state":{"rclonePath":"/usr/local/bin/rclone","notificationTargets":[{"provider":"slack"}],"unknownField":123}}"#,
        )
        .unwrap();
        let state = read_root(&dirs).unwrap();
        assert_eq!(state.rclone_path.as_deref(), Some("/usr/local/bin/rclone"));
        assert!(!host_state_exists(&dirs));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn limits_reach_the_daemon_only_when_they_are_set() {
        let unset = build_run_env(&HostState::default());
        for key in ["RCLONE_BWLIMIT", "RCLONE_TPSLIMIT", "RCLONE_TPSLIMIT_BURST"] {
            assert!(
                !unset.contains_key(key),
                "{} is the operator's when unset",
                key
            );
        }
        let host = HostState {
            limits: Limits {
                bw_limit: " 10M:5M ".into(),
                tps_limit: 2.5,
                tps_limit_burst: 4,
            },
            ..Default::default()
        };
        let env = build_run_env(&host);
        assert_eq!(env["RCLONE_BWLIMIT"], "10M:5M");
        assert_eq!(env["RCLONE_TPSLIMIT"], "2.5");
        assert_eq!(env["RCLONE_TPSLIMIT_BURST"], "4");
        // A burst means nothing without a limit.
        let burst_only = build_run_env(&HostState {
            limits: Limits {
                tps_limit_burst: 4,
                ..Default::default()
            },
            ..Default::default()
        });
        assert!(!burst_only.contains_key("RCLONE_TPSLIMIT_BURST"));
    }

    /// The daemon's environment says nothing about rclone's config file. Setting any of these
    /// would override what the operator put in the environment we are inherited from, which is
    /// the one thing this design must never do.
    #[test]
    fn the_daemon_environment_says_nothing_about_the_config_file() {
        let host = HostState {
            proxy: Some(ProxyCfg {
                url: "http://proxy:8080".into(),
                ignored_hosts: vec!["localhost".into()],
            }),
            ..Default::default()
        };
        let env = build_run_env(&host);
        assert_eq!(
            env.get("http_proxy").map(String::as_str),
            Some("http://proxy:8080")
        );
        assert_eq!(env.get("no_proxy").map(String::as_str), Some("localhost"));
        for key in [
            "RCLONE_CONFIG",
            "RCLONE_CONFIG_DIR",
            "RCLONE_ASK_PASSWORD",
            "RCLONE_CONFIG_PASS",
            "RCLONE_CONFIG_PASS_COMMAND",
        ] {
            assert!(
                !env.contains_key(key),
                "{} must be left to the operator",
                key
            );
        }
    }
}
