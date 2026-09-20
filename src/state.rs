//! The app's persisted state, owned by the server: one JSON document,
//! `<data dir>/state/app.json`, the page's `usePersistedStore` (`store/persisted.ts`), served
//! as `/api/state/app`.
//!
//! The file is `{ "version": n, "revision": r, "state": { ... } }`. `version` is the page's
//! zustand-persist schema version; `revision` is bumped by every write here and is what `PATCH`
//! compares (`If-Match`) so a page never overwrites the document from a stale snapshot. Rust
//! writers (the lifecycle, `daemon_settings_set`) patch individual keys under the same lock and
//! read what they need typed ([`StateStore::settings`]). Every write publishes
//! `state.changed {doc, revision, keys}` on the bus, which is how open pages rehydrate.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::bus::Bus;
use crate::datadir::DataDir;

/// The document's name on the wire (`/api/state/app`).
pub const APP_DOC: &str = "app";
/// The zustand-persist version (store/persisted.ts) a document created by Rust before any page
/// ran is stamped with.
pub const APP_VERSION: u64 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StateDoc {
    pub version: u64,
    pub revision: u64,
    pub state: Map<String, Value>,
}

#[derive(Debug)]
pub enum PatchError {
    /// `If-Match` did not match; carries the current document.
    Conflict(StateDoc),
    Other(String),
}

impl From<String> for PatchError {
    fn from(message: String) -> Self {
        PatchError::Other(message)
    }
}

// --- what Rust reads of the document -------------------------------------------------------

/// The keys Rust reads, typed. Every field defaults, so a document never written, or one from a
/// page that has not saved that setting yet, reads as the page's own defaults; the other keys
/// are the page's business and pass through untouched.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Settings › Rclone's custom binary. Only `rclone_set_custom` and `rclone_install` write it.
    pub rclone_path: Option<String>,
    /// `None` until the page ever saved it: on, as the page's default is.
    pub auto_update_rclone: Option<bool>,
    pub last_notified_rclone_version: Option<String>,
    pub proxy: Option<ProxySettings>,
    pub limits: Limits,
    pub remote_configs: HashMap<String, RemoteConfig>,
}

impl Settings {
    pub fn auto_update(&self) -> bool {
        self.auto_update_rclone.unwrap_or(true)
    }

    /// The proxy of Settings › Rclone when one is set: the road downloads and the daemon take.
    pub fn active_proxy(&self) -> Option<&ProxySettings> {
        self.proxy.as_ref().filter(|p| !p.url.trim().is_empty())
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProxySettings {
    pub url: String,
    pub ignored_hosts: Vec<String>,
}

/// The budgets one rclone process shares across every transfer. Empty and zero mean "not set".
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Limits {
    pub bw_limit: String,
    pub tps_limit: f64,
    pub tps_limit_burst: u32,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteConfig {
    pub mount_on_start: Option<MountOnStart>,
}

/// store/persisted.ts `RemoteConfig['mountOnStart']`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MountOnStart {
    pub enabled: bool,
    pub remote_path: String,
    pub mount_point: String,
    pub mount_options: Map<String, Value>,
    pub vfs_options: Map<String, Value>,
    pub filter_options: Map<String, Value>,
    pub config_options: Map<String, Value>,
    pub metadata_options: Map<String, Value>,
}

// --- the store -----------------------------------------------------------------------------

pub struct StateStore {
    path: PathBuf,
    bus: Bus,
    cache: Mutex<Option<StateDoc>>,
}

fn empty() -> StateDoc {
    StateDoc {
        version: APP_VERSION,
        revision: 0,
        state: Map::new(),
    }
}

impl StateStore {
    pub fn new(dirs: DataDir, bus: Bus) -> Self {
        StateStore {
            path: dirs.root.join("state").join("app.json"),
            bus,
            cache: Mutex::new(None),
        }
    }

    /// Loads the document into the cache; a missing file is a missing document.
    fn load(&self, cache: &mut Option<StateDoc>) -> Result<Option<StateDoc>, String> {
        if let Some(existing) = cache {
            return Ok(Some(existing.clone()));
        }
        let loaded = match std::fs::read(&self.path) {
            Ok(raw) => Some(serde_json::from_slice::<StateDoc>(&raw).map_err(|e| {
                format!("invalid state file {}: {}", self.path.display(), e)
            })?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                return Err(format!("failed to read {}: {}", self.path.display(), e));
            }
        };
        *cache = loaded.clone();
        Ok(loaded)
    }

    fn write(&self, cache: &mut Option<StateDoc>, next: &StateDoc) -> Result<(), String> {
        let body = serde_json::to_vec_pretty(next).map_err(|e| e.to_string())?;
        crate::fsutil::write_atomic(&self.path, &body)?;
        *cache = Some(next.clone());
        Ok(())
    }

    fn changed(&self, revision: u64, keys: Vec<String>) {
        self.bus.publish(
            "state.changed",
            json!({ "doc": APP_DOC, "revision": revision, "keys": keys }),
        );
    }

    /// `None` when the document was never written (the page then starts from its defaults).
    pub fn read(&self) -> Result<Option<StateDoc>, String> {
        let mut cache = self.cache.lock().unwrap();
        self.load(&mut cache)
    }

    /// What Rust reads of the document, typed. A document never written is the defaults; one
    /// that cannot be read is too, and the log says so.
    pub fn settings(&self) -> Settings {
        let state = match self.read() {
            Ok(doc) => doc.map(|d| d.state).unwrap_or_default(),
            Err(e) => {
                log::warn!("[state] {}", e);
                return Settings::default();
            }
        };
        serde_json::from_value(Value::Object(state)).unwrap_or_else(|e| {
            log::warn!("[state] the document does not read as settings: {}", e);
            Settings::default()
        })
    }

    /// Replaces the whole document (the page's first write). With `if_match`, the revision must
    /// be the one the page saw (0 for a document never written), so two pages creating it do
    /// not overwrite each other.
    pub fn put(
        &self,
        version: u64,
        state: Map<String, Value>,
        if_match: Option<u64>,
    ) -> Result<StateDoc, PatchError> {
        let mut cache = self.cache.lock().unwrap();
        let previous = self.load(&mut cache)?;
        if let Some(expected) = if_match {
            let current = previous.as_ref().map(|d| d.revision).unwrap_or(0);
            if current != expected {
                return Err(PatchError::Conflict(previous.unwrap_or_else(empty)));
            }
        }
        let next = StateDoc {
            version,
            revision: previous.as_ref().map(|d| d.revision).unwrap_or(0) + 1,
            state,
        };
        self.write(&mut cache, &next)?;
        let mut keys: Vec<String> = next.state.keys().cloned().collect();
        if let Some(previous) = &previous {
            keys.extend(
                previous
                    .state
                    .keys()
                    .filter(|k| !next.state.contains_key(*k))
                    .cloned(),
            );
        }
        drop(cache);
        self.changed(next.revision, keys);
        Ok(next)
    }

    /// Applies a page's PATCH: `set` inserts or replaces keys, `unset` deletes them (a page
    /// clears a value by dropping the key). `if_match` is the revision the page last saw.
    pub fn patch(
        &self,
        set: Map<String, Value>,
        unset: Vec<String>,
        if_match: Option<u64>,
    ) -> Result<StateDoc, PatchError> {
        let mut cache = self.cache.lock().unwrap();
        let current = self.load(&mut cache)?;
        if let (Some(expected), Some(current)) = (if_match, &current) {
            if current.revision != expected {
                return Err(PatchError::Conflict(current.clone()));
            }
        }
        let mut next = current.unwrap_or_else(empty);
        let mut keys: Vec<String> = set.keys().cloned().collect();
        for (key, value) in set {
            next.state.insert(key, value);
        }
        for key in unset {
            if next.state.remove(&key).is_some() {
                keys.push(key);
            }
        }
        next.revision += 1;
        self.write(&mut cache, &next)?;
        drop(cache);
        self.changed(next.revision, keys);
        Ok(next)
    }

    /// Rust-side read-modify-write of top-level keys (never conflicts: it runs under the lock).
    pub fn update(&self, f: impl FnOnce(&mut Map<String, Value>)) -> Result<StateDoc, String> {
        let mut cache = self.cache.lock().unwrap();
        let current = self.load(&mut cache)?;
        let mut next = current.clone().unwrap_or_else(empty);
        let before = next.state.clone();
        f(&mut next.state);
        let keys: Vec<String> = next
            .state
            .iter()
            .filter(|(k, v)| before.get(*k) != Some(v))
            .map(|(k, _)| k.clone())
            .chain(
                before
                    .keys()
                    .filter(|k| !next.state.contains_key(*k))
                    .cloned(),
            )
            .collect();
        if keys.is_empty() && current.is_some() {
            return Ok(next);
        }
        next.revision += 1;
        self.write(&mut cache, &next)?;
        drop(cache);
        self.changed(next.revision, keys);
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (StateStore, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "rclone-cloud-state-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let dirs = DataDir { root: root.clone() };
        (StateStore::new(dirs, Bus::new()), root)
    }

    #[test]
    fn patch_checks_revisions_and_update_creates_with_the_current_version() {
        let (store, root) = store();
        assert!(store.read().unwrap().is_none());

        let created = store
            .update(|s| {
                s.insert("rclonePath".into(), Value::from("/a"));
            })
            .unwrap();
        assert_eq!(created.version, APP_VERSION);
        assert_eq!(created.revision, 1);

        let mut set = Map::new();
        set.insert("autoUpdateRclone".into(), Value::Bool(true));
        let patched = store
            .patch(set.clone(), vec![], Some(1))
            .unwrap_or_else(|_| panic!("patch"));
        assert_eq!(patched.revision, 2);
        assert_eq!(patched.state["rclonePath"], "/a");

        match store.patch(set, vec![], Some(1)) {
            Err(PatchError::Conflict(current)) => assert_eq!(current.revision, 2),
            _ => panic!("expected a conflict"),
        }

        let mut state = Map::new();
        state.insert("templates".into(), json!([]));
        let replaced = store.put(APP_VERSION, state, None).unwrap();
        assert_eq!(replaced.revision, 3);
        assert!(replaced.state.get("rclonePath").is_none());

        // Unchanged update is a no-op (no revision bump).
        let same = store.update(|_| {}).unwrap();
        assert_eq!(same.revision, 3);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A page that clears a value (Proxy → "Clear") persists through zustand as a missing key,
    /// so PATCH must be able to delete keys, not only set them.
    #[test]
    fn patch_unsets_keys() {
        let (store, root) = store();
        let mut state = Map::new();
        state.insert("proxy".into(), Value::from("http://proxy:3128"));
        state.insert("templates".into(), json!([]));
        let created = store.put(APP_VERSION, state, None).unwrap();

        let mut set = Map::new();
        set.insert("autoUpdateRclone".into(), Value::Bool(true));
        let patched = store
            .patch(
                set,
                vec!["proxy".into(), "neverThere".into()],
                Some(created.revision),
            )
            .unwrap_or_else(|_| panic!("patch"));
        assert_eq!(patched.revision, created.revision + 1);
        assert!(patched.state.get("proxy").is_none(), "the key is gone");
        assert_eq!(patched.state["autoUpdateRclone"], true);
        assert_eq!(patched.state["templates"], json!([]));

        let reread = store.read().unwrap().unwrap();
        assert!(
            reread.state.get("proxy").is_none(),
            "and stays gone on disk"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The typed view: a document never written is the defaults (auto-update on), a written
    /// one reads through its unknown keys, and a setting the page never saved is its default.
    #[test]
    fn settings_read_typed_with_defaults_for_what_is_missing() {
        let (store, root) = store();
        let fresh = store.settings();
        assert!(fresh.rclone_path.is_none());
        assert!(fresh.auto_update(), "on until the page says otherwise");
        assert!(fresh.active_proxy().is_none());

        store
            .update(|s| {
                s.insert("rclonePath".into(), json!("/usr/local/bin/rclone"));
                s.insert("autoUpdateRclone".into(), json!(false));
                s.insert("proxy".into(), json!({ "url": "  ", "ignoredHosts": [] }));
                s.insert("limits".into(), json!({ "bwLimit": "1M" }));
                s.insert("templates".into(), json!([{ "id": "t", "name": "n" }]));
                s.insert("unknownField".into(), json!(123));
            })
            .unwrap();
        let settings = store.settings();
        assert_eq!(settings.rclone_path.as_deref(), Some("/usr/local/bin/rclone"));
        assert!(!settings.auto_update());
        assert!(settings.active_proxy().is_none(), "a blank URL is no proxy");
        assert_eq!(settings.limits.bw_limit, "1M");
        assert_eq!(settings.limits.tps_limit, 0.0);
        let _ = std::fs::remove_dir_all(&root);
    }
}
