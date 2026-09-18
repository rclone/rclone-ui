//! Read-only access to the app's persisted stores for the headless runner and the scheduler
//! commands.
//!
//! Store files are written by tauri-plugin-store + zustand persist: each file is a JSON object
//! whose single key holds a JSON *string* containing `{"state": {...}, "version": n}` — so the
//! value must be parsed twice. Only the fields the scheduler needs are modeled; unknown fields
//! are ignored so unrelated store changes never break the runner.
//!
//! Path resolution lives in `datadir.rs` (and its note on why Flatpak paths are never rewritten).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

pub use crate::datadir::DataDir;

/// Headless resolution of the data roots (see `DataDir::resolve`).
pub fn app_dirs() -> Result<DataDir, String> {
    DataDir::resolve()
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RootState {
    pub current_host_id: Option<String>,
    pub hide_startup: bool,
    pub rclone_path: Option<String>,
    /// Configured hosts (local + remote rclone RC daemons); only the url is modeled.
    pub hosts: Vec<HostEntry>,
    pub auto_update_rclone: bool,
    pub last_notified_rclone_version: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HostEntry {
    pub id: String,
    pub url: String,
    pub name: Option<String>,
    pub auth_user: Option<String>,
    pub auth_password: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HostState {
    pub proxy: Option<ProxyCfg>,
    pub config_files: Vec<ConfigFileEntry>,
    pub default_config_path: Option<String>,
    pub active_config_id: Option<String>,
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
    /// The Metadata section; absent on documents written before it existed.
    pub metadata_options: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProxyCfg {
    pub url: String,
    pub ignored_hosts: Vec<String>,
}

/// Mirrors types/config.d.ts `ConfigFile` (every field, so a rewrite never drops one).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConfigFileEntry {
    pub id: Option<String>,
    pub label: Option<String>,
    /// External folder the config is synced from (its `rclone.conf` is the file to use).
    pub sync: Option<String>,
    pub is_encrypted: bool,
    pub pass: Option<String>,
    pub pass_command: Option<String>,
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

pub fn host_doc_path(dirs: &DataDir, host_id: &str) -> PathBuf {
    dirs.root
        .join("state")
        .join("hosts")
        .join(format!("{}.json", host_id))
}

/// Reads the app document; a missing one is the default (a fresh install).
pub fn read_root(dirs: &DataDir) -> Result<RootState, String> {
    Ok(read_state_doc(&app_doc_path(dirs))?.unwrap_or_default())
}

/// Whether a host document exists (a fresh install has none).
pub fn host_state_exists(dirs: &DataDir, host_id: &str) -> bool {
    host_doc_path(dirs, host_id).is_file()
}

pub fn read_host(dirs: &DataDir, host_id: &str) -> Result<HostState, String> {
    let path = host_doc_path(dirs, host_id);
    read_state_doc(&path)?.ok_or_else(|| format!("no host document at {}", path.display()))
}

/// Where a config entry's file is, for the lifecycle and the scheduled runner alike: a config
/// synced from an external folder is that folder's `rclone.conf`; otherwise
/// `configs/<id>/rclone.conf` under AppLocalData (lib/rclone/common.ts getConfigPath), except
/// config id 'default' uses the host store's defaultConfigPath when set (so switching binaries
/// never relocates the user's remotes).
pub fn resolve_config_path(dirs: &DataDir, host: &HostState, config_id: &str) -> PathBuf {
    if let Some(sync) = find_config(host, config_id)
        .and_then(|c| c.sync.as_deref())
        .filter(|s| !s.is_empty())
    {
        return Path::new(sync).join("rclone.conf");
    }
    if config_id == "default" {
        if let Some(p) = host.default_config_path.as_deref() {
            if !p.is_empty() {
                return PathBuf::from(p);
            }
        }
    }
    dirs.root
        .join("configs")
        .join(config_id)
        .join("rclone.conf")
}

pub fn find_config<'a>(host: &'a HostState, config_id: &str) -> Option<&'a ConfigFileEntry> {
    host.config_files
        .iter()
        .find(|c| c.id.as_deref() == Some(config_id))
}

/// Mirrors lib/rclone/cli.ts buildRcloneEnv: proxy vars, config pinning, and encrypted-config
/// credentials. Errors when the config is encrypted with nothing stored — the headless runner
/// has no UI to prompt with.
pub fn build_run_env(
    host: &HostState,
    config: Option<&ConfigFileEntry>,
    config_path: &Path,
) -> Result<HashMap<String, String>, String> {
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

    let config_dir = config_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    env.insert(
        "RCLONE_CONFIG_DIR".to_string(),
        config_dir.to_string_lossy().into_owned(),
    );
    env.insert(
        "RCLONE_CONFIG".to_string(),
        config_path.to_string_lossy().into_owned(),
    );

    if let Some(cfg) = config {
        if cfg.is_encrypted {
            env.insert("RCLONE_ASK_PASSWORD".to_string(), "false".to_string());
            if let Some(cmd) = cfg.pass_command.as_deref().filter(|s| !s.is_empty()) {
                env.insert("RCLONE_CONFIG_PASS_COMMAND".to_string(), cmd.to_string());
            } else if let Some(pass) = cfg.pass.as_deref().filter(|s| !s.is_empty()) {
                env.insert("RCLONE_CONFIG_PASS".to_string(), pass.to_string());
            } else {
                let label = cfg.label.clone().unwrap_or_else(|| "default".to_string());
                return Err(format!(
                    "Config '{}' is encrypted and no password is stored. Open Rclone UI and save the config password to enable scheduled runs.",
                    label
                ));
            }
        }
    }

    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_state_document_reads_with_unknown_fields_and_a_missing_one_is_the_default() {
        let dir = std::env::temp_dir().join(format!("rcloneui-storetest-{}", std::process::id()));
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
        assert!(!host_state_exists(&dirs, "local"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A config created through "Sync Config" keeps its file in the external folder; a schedule
    /// on it must run against that file, as the app does.
    #[test]
    fn a_synced_config_resolves_to_its_folder() {
        let dirs = DataDir {
            root: PathBuf::from("/tmp/rcui-data"),
        };
        let mut host = HostState::default();
        host.config_files.push(ConfigFileEntry {
            id: Some("synced".into()),
            sync: Some("/ext/folder".into()),
            ..Default::default()
        });
        assert_eq!(
            resolve_config_path(&dirs, &host, "synced"),
            PathBuf::from("/ext/folder/rclone.conf")
        );
        assert_eq!(
            resolve_config_path(&dirs, &host, "other"),
            PathBuf::from("/tmp/rcui-data/configs/other/rclone.conf")
        );
    }

    #[test]
    fn encrypted_config_without_pass_errors() {
        let host = HostState::default();
        let cfg = ConfigFileEntry {
            id: Some("default".into()),
            label: Some("Default config".into()),
            is_encrypted: true,
            ..Default::default()
        };
        let err = build_run_env(&host, Some(&cfg), Path::new("/tmp/rclone.conf")).unwrap_err();
        assert!(err.contains("encrypted"));
    }
}
