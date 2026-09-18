//! The app's persisted state, owned by the server. One JSON document per store:
//!
//! - `app`        → `<app_data>/state/app.json`        (zustand `usePersistedStore`, version 3)
//! - `hosts/<id>` → `<app_data>/state/hosts/<id>.json` (zustand `useHostStore`, version 2)
//!
//! Each file is `{ "version": n, "revision": r, "state": { ... } }`. `version` is the page's
//! zustand-persist schema version (only pages change it, when a migration runs); `revision` is
//! bumped by every write here and is what `PATCH` compares (`If-Match`) so a page never
//! overwrites a document from a stale snapshot. Rust writers (the lifecycle) patch individual
//! keys under the same lock. Every write publishes `state.changed {doc, revision, keys}` on the
//! bus, which is how open pages rehydrate.
//!
//! Older installs have tauri-plugin-store files (`store.json` with the state as a JSON *string*
//! under key `store`, `hosts/<id>/store.json` under `host-store`); those are migrated lazily the
//! first time a document is read, and the originals are left in place.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::ctx::Events;
use crate::datadir::DataDir;

pub const APP_DOC: &str = "app";
/// Current zustand-persist versions (store/persisted.ts, store/host.ts). New documents created
/// by Rust before any page ran are stamped with these so the page's migrations don't fire.
pub const APP_VERSION: u64 = 3;
pub const HOST_VERSION: u64 = 2;

/// The per-machine settings document. The `hosts/` segment and the `local` name are the shared
/// storage layout, kept as written; this server has one machine and never another.
pub const HOST_DOC: &str = "hosts/local";

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

pub struct StateStore {
    dirs: DataDir,
    events: Events,
    cache: Mutex<HashMap<String, StateDoc>>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && !id.contains("..")
}

fn write_doc(path: &Path, doc: &StateDoc) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(doc).map_err(|e| e.to_string())?;
    crate::fsutil::write_atomic(path, &body)
}

impl StateStore {
    pub fn new(dirs: DataDir, events: Events) -> Self {
        StateStore {
            dirs,
            events,
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn dirs(&self) -> &DataDir {
        &self.dirs
    }

    /// The zustand-persist version a document gets when Rust creates it first.
    pub fn default_version(&self, doc: &str) -> Result<u64, String> {
        self.locate(doc).map(|(_, version)| version)
    }

    /// `(path, default version)` for a document name.
    fn locate(&self, doc: &str) -> Result<(PathBuf, u64), String> {
        if doc == APP_DOC {
            return Ok((self.dirs.root.join("state").join("app.json"), APP_VERSION));
        }
        if let Some(id) = doc.strip_prefix("hosts/") {
            if valid_id(id) {
                return Ok((
                    self.dirs
                        .root
                        .join("state")
                        .join("hosts")
                        .join(format!("{}.json", id)),
                    HOST_VERSION,
                ));
            }
        }
        Err(format!("unknown state document '{}'", doc))
    }

    /// Loads a document into the cache; a missing file is a missing document.
    fn load(
        &self,
        cache: &mut HashMap<String, StateDoc>,
        doc: &str,
    ) -> Result<Option<StateDoc>, String> {
        if let Some(existing) = cache.get(doc) {
            return Ok(Some(existing.clone()));
        }
        let (path, _) = self.locate(doc)?;
        let loaded = match std::fs::read(&path) {
            Ok(raw) => Some(
                serde_json::from_slice::<StateDoc>(&raw)
                    .map_err(|e| format!("invalid state file {}: {}", path.display(), e))?,
            ),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("failed to read {}: {}", path.display(), e)),
        };
        if let Some(doc_value) = &loaded {
            cache.insert(doc.to_string(), doc_value.clone());
        }
        Ok(loaded)
    }

    fn changed(&self, doc: &str, revision: u64, keys: Vec<String>) {
        self.events.emit(
            "state.changed",
            json!({ "doc": doc, "revision": revision, "keys": keys }),
        );
    }

    /// `None` when the document was never written (the page then starts from its defaults).
    pub fn read(&self, doc: &str) -> Result<Option<StateDoc>, String> {
        let mut cache = self.cache.lock().unwrap();
        self.load(&mut cache, doc)
    }

    /// Replaces the whole document (the page's first write and its migrations). With
    /// `if_match`, the revision must be the one the page saw (0 for a document never written),
    /// so two pages creating the same document do not overwrite each other.
    pub fn put(
        &self,
        doc: &str,
        version: u64,
        state: Map<String, Value>,
        if_match: Option<u64>,
    ) -> Result<StateDoc, PatchError> {
        let mut cache = self.cache.lock().unwrap();
        let (path, default_version) = self.locate(doc)?;
        let previous = self.load(&mut cache, doc)?;
        if let Some(expected) = if_match {
            let current = previous.as_ref().map(|d| d.revision).unwrap_or(0);
            if current != expected {
                return Err(PatchError::Conflict(previous.unwrap_or(StateDoc {
                    version: default_version,
                    revision: 0,
                    state: Map::new(),
                })));
            }
        }
        let next = StateDoc {
            version,
            revision: previous.as_ref().map(|d| d.revision).unwrap_or(0) + 1,
            state,
        };
        write_doc(&path, &next)?;
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
        cache.insert(doc.to_string(), next.clone());
        drop(cache);
        self.changed(doc, next.revision, keys);
        Ok(next)
    }

    /// Sets the given top-level keys. With `if_match`, the document's revision must match.
    /// Applies a page's PATCH: `set` inserts or replaces keys, `unset` deletes them (a page clears
    /// a value by dropping the key). `if_match` is the revision the page last saw.
    pub fn patch(
        &self,
        doc: &str,
        set: Map<String, Value>,
        unset: Vec<String>,
        if_match: Option<u64>,
    ) -> Result<StateDoc, PatchError> {
        let mut cache = self.cache.lock().unwrap();
        let (path, default_version) = self.locate(doc)?;
        let current = self.load(&mut cache, doc)?;
        if let (Some(expected), Some(current)) = (if_match, &current) {
            if current.revision != expected {
                return Err(PatchError::Conflict(current.clone()));
            }
        }
        let mut next = current.unwrap_or(StateDoc {
            version: default_version,
            revision: 0,
            state: Map::new(),
        });
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
        write_doc(&path, &next)?;
        cache.insert(doc.to_string(), next.clone());
        drop(cache);
        self.changed(doc, next.revision, keys);
        Ok(next)
    }

    /// Rust-side read-modify-write of top-level keys (never conflicts: it runs under the lock).
    pub fn update(
        &self,
        doc: &str,
        f: impl FnOnce(&mut Map<String, Value>),
    ) -> Result<StateDoc, String> {
        let mut cache = self.cache.lock().unwrap();
        let (path, default_version) = self.locate(doc)?;
        let current = self.load(&mut cache, doc)?;
        let mut next = current.clone().unwrap_or(StateDoc {
            version: default_version,
            revision: 0,
            state: Map::new(),
        });
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
        write_doc(&path, &next)?;
        cache.insert(doc.to_string(), next.clone());
        drop(cache);
        self.changed(doc, next.revision, keys);
        Ok(next)
    }

    /// The state object of a document (empty when it doesn't exist yet).
    /// The document's state, or an error for a file that exists but cannot be read; a
    /// document never written is an empty map (a fresh install is not a failure).
    pub fn state_or_error(&self, doc: &str) -> Result<Map<String, Value>, String> {
        Ok(self.read(doc)?.map(|d| d.state).unwrap_or_default())
    }

    /// The document's state for display and best-effort reads: unreadable reads as empty.
    pub fn state_or_default(&self, doc: &str) -> Map<String, Value> {
        self.state_or_error(doc).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (StateStore, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "rcloneui-state-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let dirs = DataDir { root: root.clone() };
        (StateStore::new(dirs, Events::noop()), root)
    }

    #[test]
    fn patch_checks_revisions_and_update_creates_with_the_current_version() {
        let (store, root) = store();
        assert!(store.read(APP_DOC).unwrap().is_none());

        let created = store
            .update(APP_DOC, |s| {
                s.insert("rclonePath".into(), Value::from("/a"));
            })
            .unwrap();
        assert_eq!(created.version, APP_VERSION);
        assert_eq!(created.revision, 1);

        let mut set = Map::new();
        set.insert("licenseValid".into(), Value::Bool(true));
        let patched = store
            .patch(APP_DOC, set.clone(), vec![], Some(1))
            .unwrap_or_else(|_| panic!("patch"));
        assert_eq!(patched.revision, 2);
        assert_eq!(patched.state["rclonePath"], "/a");

        match store.patch(APP_DOC, set, vec![], Some(1)) {
            Err(PatchError::Conflict(current)) => assert_eq!(current.revision, 2),
            _ => panic!("expected a conflict"),
        }

        let mut state = Map::new();
        state.insert("hosts".into(), json!([]));
        let replaced = store.put(APP_DOC, 3, state, None).unwrap();
        assert_eq!(replaced.revision, 3);
        assert!(replaced.state.get("rclonePath").is_none());

        // Unchanged update is a no-op (no revision bump).
        let same = store.update(APP_DOC, |_| {}).unwrap();
        assert_eq!(same.revision, 3);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A page that clears a value (Settings → "Remove password", Proxy → "Clear") persists
    /// through zustand as a missing key, so PATCH must be able to delete keys, not only set them.
    #[test]
    fn patch_unsets_keys() {
        let (store, root) = store();
        let mut state = Map::new();
        state.insert("settingsPass".into(), Value::from("1234"));
        state.insert("hosts".into(), json!([]));
        let created = store.put(APP_DOC, APP_VERSION, state, None).unwrap();

        let mut set = Map::new();
        set.insert("licenseValid".into(), Value::Bool(true));
        let patched = store
            .patch(
                APP_DOC,
                set,
                vec!["settingsPass".into(), "neverThere".into()],
                Some(created.revision),
            )
            .unwrap_or_else(|_| panic!("patch"));
        assert_eq!(patched.revision, created.revision + 1);
        assert!(
            patched.state.get("settingsPass").is_none(),
            "the key is gone"
        );
        assert_eq!(patched.state["licenseValid"], true);
        assert_eq!(patched.state["hosts"], json!([]));

        let reread = store.read(APP_DOC).unwrap().unwrap();
        assert!(
            reread.state.get("settingsPass").is_none(),
            "and stays gone on disk"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
