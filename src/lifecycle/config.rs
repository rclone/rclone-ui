//! Which config file the daemon runs with, and the environment that pins it — the server
//! flavor of the config half of lib/rclone/init.ts `initRclone` plus `ensureDefaultConfig`
//! (lib/rclone/common.ts). Reads the host store, materializes the default config, normalizes
//! the config list, and builds the env with `storeread::build_run_env`; where the desktop
//! would prompt for a password it reports `NeedsPassword`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::ctx::Ctx;
use crate::scheduler::storeread::{self, ConfigFileEntry, HostState};
use crate::state_files::{host_doc, StateStore};
use crate::zookeeper;

use super::interaction::{Decision, Interaction, Question};

pub enum ConfigError {
    NeedsPassword { config_id: String, label: String },
    Other(String),
}

impl From<String> for ConfigError {
    fn from(message: String) -> Self {
        ConfigError::Other(message)
    }
}

pub struct ResolvedConfig {
    pub config_path: PathBuf,
    pub config_dir: PathBuf,
    pub entry: ConfigFileEntry,
    pub env: HashMap<String, String>,
}

fn read_host(ctx: &Ctx) -> Result<HostState, String> {
    if !storeread::host_state_exists(&ctx.dirs, "local") {
        return Ok(HostState::default());
    }
    storeread::read_host(&ctx.dirs, "local")
}

fn update_host(
    store: &StateStore,
    f: impl FnOnce(&mut serde_json::Map<String, Value>),
) -> Result<(), String> {
    store.update(&host_doc("local"), f).map(|_| ())
}

fn app_private_default(ctx: &Ctx) -> PathBuf {
    ctx.dirs
        .root
        .join("configs")
        .join("default")
        .join("rclone.conf")
}

/// Mirrors lib/rclone/common.ts `resolveDefaultConfigPath`: an app-private config that already
/// holds remotes wins; otherwise a system rclone's native config; otherwise the app-private path.
fn resolve_default_config_path(ctx: &Ctx) -> String {
    let app_private = app_private_default(ctx);
    if let Ok(content) = std::fs::read_to_string(&app_private) {
        let has_section = content.lines().any(|l| l.trim_start().starts_with('['));
        if has_section || content.contains("RCLONE_ENCRYPT_V0:") {
            return app_private.to_string_lossy().into_owned();
        }
    }
    if let Ok(Some(system)) = zookeeper::find_system_rclone(ctx) {
        match zookeeper::rclone_config_path(ctx, system) {
            Ok(native) if !native.is_empty() => return native.replace("\\\\", "\\"),
            Ok(_) => {}
            Err(e) => log::warn!("[lifecycle] could not read the native config path: {}", e),
        }
    }
    app_private.to_string_lossy().into_owned()
}

/// Mirrors `createConfigFile`: write-first, create the parent on failure and retry.
fn create_config_file(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    const EMPTY: &str = "# Empty config file\n";
    if std::fs::write(path, EMPTY).is_ok() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create {}: {}", parent.display(), e))?;
    }
    std::fs::write(path, EMPTY).map_err(|e| format!("failed to create {}: {}", path.display(), e))
}

fn canonical_default() -> ConfigFileEntry {
    ConfigFileEntry {
        id: Some("default".into()),
        label: Some("Default config".into()),
        sync: None,
        is_encrypted: false,
        pass: None,
        pass_command: None,
    }
}

/// Blocking (may prompt through `interaction`); run it on the blocking pool.
pub fn resolve(
    ctx: &Ctx,
    store: &StateStore,
    interaction: &dyn Interaction,
    rclone_path: &str,
) -> Result<ResolvedConfig, ConfigError> {
    let mut host = read_host(ctx)?;

    // 1. The default config's location, resolved once and persisted (so switching binaries
    //    never relocates the user's remotes), then materialized.
    let default_path = match host
        .default_config_path
        .as_deref()
        .filter(|p| !p.is_empty())
    {
        Some(p) => p.to_string(),
        None => {
            let resolved = resolve_default_config_path(ctx);
            log::info!("[lifecycle] default config at {}", resolved);
            let persisted = resolved.clone();
            update_host(store, |s| {
                s.insert("defaultConfigPath".into(), Value::String(persisted));
            })?;
            host.default_config_path = Some(resolved.clone());
            resolved
        }
    };
    create_config_file(Path::new(&default_path))?;

    // 2. The config list always starts with the canonical default entry.
    let mut files: Vec<ConfigFileEntry> = host
        .config_files
        .iter()
        .filter(|c| c.id.as_deref() != Some("default"))
        .cloned()
        .collect();
    let existing_default = host
        .config_files
        .iter()
        .find(|c| c.id.as_deref() == Some("default"))
        .cloned();
    files.insert(0, existing_default.unwrap_or_else(canonical_default));
    let unchanged = host.config_files.len() == files.len()
        && host.config_files.first().and_then(|c| c.id.as_deref()) == Some("default");
    if !unchanged {
        let json = serde_json::to_value(&files).map_err(|e| e.to_string())?;
        update_host(store, |s| {
            s.insert("configFiles".into(), json);
        })?;
    }
    host.config_files = files;

    // 3. The active config, falling back to the default.
    let active_id = host
        .active_config_id
        .clone()
        .filter(|id| {
            host.config_files
                .iter()
                .any(|c| c.id.as_deref() == Some(id))
        })
        .unwrap_or_else(|| "default".to_string());
    if host.active_config_id.as_deref() != Some(&active_id) {
        let id = active_id.clone();
        update_host(store, |s| {
            s.insert("activeConfigId".into(), Value::String(id));
        })?;
        host.active_config_id = Some(active_id.clone());
    }
    let mut entry = storeread::find_config(&host, &active_id)
        .cloned()
        .unwrap_or_else(canonical_default);

    // 4. Its file: a synced (external-folder) config, or configs/<id>/rclone.conf, by the one
    // resolver the scheduled runner uses too.
    let mut config_path = storeread::resolve_config_path(&ctx.dirs, &host, &active_id);
    if entry.sync.is_some() && !config_path.is_file() {
        log::warn!(
            "[lifecycle] synced config {} is missing",
            config_path.display()
        );
        let decision = interaction.decide(Question::SyncedConfigMissing {
            label: entry.label.clone().unwrap_or_else(|| active_id.clone()),
            path: config_path.to_string_lossy().into_owned(),
        });
        if decision != Decision::Yes {
            return Err(ConfigError::Other(format!(
                "synced config file {} is missing",
                config_path.display()
            )));
        }
        log::info!("[lifecycle] switching to the default config");
        update_host(store, |s| {
            s.insert("activeConfigId".into(), Value::String("default".into()));
        })?;
        entry = host.config_files[0].clone();
        config_path = storeread::resolve_config_path(&ctx.dirs, &host, "default");
    }
    let config_dir = config_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    // 5. Reconcile the stored encryption flag with the file.
    let content = std::fs::read_to_string(&config_path).map_err(|e| {
        format!(
            "could not read config file {}: {}",
            config_path.display(),
            e
        )
    })?;
    let is_encrypted = content.contains("RCLONE_ENCRYPT_V0:");
    if entry.is_encrypted != is_encrypted {
        let id = entry.id.clone().unwrap_or_default();
        update_host(store, |s| {
            if let Some(list) = s.get_mut("configFiles").and_then(Value::as_array_mut) {
                for item in list.iter_mut() {
                    if item.get("id").and_then(Value::as_str) == Some(&id) {
                        item["isEncrypted"] = Value::Bool(is_encrypted);
                    }
                }
            }
        })?;
        entry.is_encrypted = is_encrypted;
    }

    // 6. The env — an encrypted config with nothing stored needs a password; the desktop asks
    //    natively, the server reports `NeedsPassword` for the page to answer.
    let env = match storeread::build_run_env(&host, Some(&entry), &config_path) {
        Ok(env) => env,
        Err(_) if is_encrypted => {
            match prompt_for_password(
                ctx,
                store,
                interaction,
                rclone_path,
                &host,
                &entry,
                &config_path,
            )? {
                Some(env) => env,
                None => {
                    return Err(ConfigError::NeedsPassword {
                        config_id: entry.id.clone().unwrap_or_default(),
                        label: entry
                            .label
                            .clone()
                            .unwrap_or_else(|| "Default config".into()),
                    })
                }
            }
        }
        Err(e) => return Err(ConfigError::Other(e)),
    };

    Ok(ResolvedConfig {
        config_path,
        config_dir,
        entry,
        env,
    })
}

const PASSWORD_ATTEMPTS: u32 = 3;

/// Asks for the config password (up to three attempts), verifies it with `rclone config dump`,
/// persists it on the config entry and returns the run env. `None` when the interaction
/// declined (the standalone server) or every attempt failed.
fn prompt_for_password(
    ctx: &Ctx,
    store: &StateStore,
    interaction: &dyn Interaction,
    rclone_path: &str,
    host: &HostState,
    entry: &ConfigFileEntry,
    config_path: &Path,
) -> Result<Option<HashMap<String, String>>, ConfigError> {
    let config_id = entry.id.clone().unwrap_or_default();
    let label = entry
        .label
        .clone()
        .unwrap_or_else(|| "Default config".into());

    for attempt in 1..=PASSWORD_ATTEMPTS {
        let decision = interaction.decide(Question::ConfigPassword {
            config_id: config_id.clone(),
            label: label.clone(),
            attempt,
        });
        let password = match decision {
            Decision::Text(text) if !text.is_empty() => text,
            _ => return Ok(None),
        };

        let mut candidate = entry.clone();
        candidate.pass = Some(password.clone());
        candidate.is_encrypted = true;
        let env = storeread::build_run_env(host, Some(&candidate), config_path)?;

        let verified = zookeeper::exec_rclone(
            ctx,
            rclone_path.to_string(),
            vec!["config".into(), "dump".into()],
            env.clone(),
            None,
            Some(15_000),
        )
        .map(|result| result.code == Some(0))
        .unwrap_or(false);
        if !verified {
            log::warn!(
                "[lifecycle] config password for '{}' rejected (attempt {}/{})",
                label,
                attempt,
                PASSWORD_ATTEMPTS
            );
            continue;
        }

        let id = config_id.clone();
        update_host(store, |s| {
            if let Some(list) = s.get_mut("configFiles").and_then(Value::as_array_mut) {
                for item in list.iter_mut() {
                    if item.get("id").and_then(Value::as_str) == Some(&id) {
                        item["pass"] = Value::String(password.clone());
                        item["isEncrypted"] = Value::Bool(true);
                    }
                }
            }
        })?;
        return Ok(Some(env));
    }
    Ok(None)
}
