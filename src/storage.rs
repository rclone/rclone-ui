//! The storage migration engine: the data directory's layout has a version (`storage.json` at
//! its root), and every process that owns the directory (the desktop shell, the server) brings it
//! to [`VERSION`] at startup, before anything reads or creates files under it. Steps run in order
//! from the stored version, each idempotent, the marker written after each. Readers everywhere
//! else know only the current layout: there are no lazy conversions and no fallbacks to what an
//! older version wrote. The scheduled runner never migrates; it checks the version and stops.
//!
//! Where an old layout is referenced, it is here and nowhere else.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::datadir::APP_IDENTIFIER;
use crate::fsutil;

/// The layout this build writes and reads.
pub const VERSION: u32 = 4;

const MARKER: &str = "storage.json";

/// What a migration did: the versions it went between and anything it could not finish (a
/// file it left where it was, a binary it could not probe), for the host to log.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub from: u32,
    pub to: u32,
    pub notes: Vec<String>,
}

/// The stored layout version: 0 when the marker is missing (a fresh directory or one written
/// before versions existed), an error when the marker cannot be read.
pub fn version(root: &Path) -> Result<u32, String> {
    let path = root.join(MARKER);
    let raw = match std::fs::read(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(format!("failed to read {}: {}", path.display(), e)),
    };
    let value: Value = serde_json::from_slice(&raw)
        .map_err(|e| format!("invalid storage marker {}: {}", path.display(), e))?;
    value["version"]
        .as_u64()
        .map(|v| v as u32)
        .ok_or_else(|| format!("invalid storage marker {}: no version", path.display()))
}

/// The check a process that does not own the directory (the scheduled runner) makes before
/// reading anything: the layout is the one this build reads. Otherwise the owning app has an
/// update to apply first; nothing is read or written meanwhile.
pub fn require_current(root: &Path) -> Result<(), String> {
    match version(root)? {
        v if v == VERSION => Ok(()),
        v => Err(format!(
            "{} is at storage version {} and this build reads {}; open Rclone UI once to bring it up to date",
            root.display(),
            v,
            VERSION
        )),
    }
}

/// Brings `root` to [`VERSION`]. A marker above it is an error: the directory was written by a
/// newer build and is not touched. Idempotent: at the current version nothing is read or
/// written and the report says `from == to`.
pub fn migrate(root: &Path) -> Result<Report, String> {
    migrate_with(root, &legacy_for(root), probe_rclone)
}

/// The old layouts' locations, for this root. Only the platform's default directory has an
/// older sibling to fold in: an overridden root (`--data-dir`, tests, containers, development)
/// is on its own and never pulls anything from elsewhere. And the sibling is recognised by
/// what the old app wrote there; any other directory under that name is left alone.
fn legacy_for(root: &Path) -> Legacy {
    let is_default_root = crate::DataDir::resolve()
        .map(|default| same_dir(&default.root, root))
        .unwrap_or(false);
    let old = if is_default_root {
        dirs::data_dir()
            .map(|d| d.join(APP_IDENTIFIER))
            .filter(|old| !same_dir(old, root) && looks_like_old_data_root(old))
    } else {
        None
    };
    Legacy { data_dir: old }
}

/// The released app always left at least one of these in its roaming root.
fn looks_like_old_data_root(dir: &Path) -> bool {
    dir.is_dir()
        && ["state", "store.json", "hosts", "scheduler", "notifications"]
            .iter()
            .any(|name| dir.join(name).exists())
}

/// `a` and `b` name the same directory (on macOS and Linux the old data root and the local one
/// resolve to one directory, so there is nothing to fold).
fn same_dir(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

fn probe_rclone(path: &Path) -> Result<String, String> {
    crate::zookeeper::probe_rclone_version(path)
}

/// What the previous layouts put where, for the steps that fold them in. The public
/// [`migrate`] resolves these from the platform; tests hand them in.
#[derive(Debug, Clone, Default)]
pub struct Legacy {
    /// The old roaming data root (`dirs::data_dir()/<identifier>`, what Tauri's `app_data_dir`
    /// resolved to). Differs from the root only on Windows.
    pub data_dir: Option<PathBuf>,
}

/// Probes an rclone binary for its version (`rclone version`).
pub type Probe = fn(&Path) -> Result<String, String>;

/// A step brings the layout from `number - 1` to `number`.
struct Step {
    number: u32,
    run: fn(&Path, &Legacy, Probe, &mut Report) -> Result<(), String>,
}

const STEPS: &[Step] = &[
    Step {
        number: 1,
        run: fold_old_data_root,
    },
    Step {
        number: 2,
        run: plugin_store_files_to_documents,
    },
    Step {
        number: 3,
        run: slot_binary_to_library,
    },
    Step {
        number: 4,
        run: drop_recent_jobs,
    },
];

fn migrate_with(
    root: &Path,
    legacy: &Legacy,
    probe: Probe,
) -> Result<Report, String> {
    let from = version(root)?;
    if from > VERSION {
        return Err(format!(
            "{} was written by a newer version of Rclone UI (storage version {}, this build reads {})",
            root.display(),
            from,
            VERSION
        ));
    }
    let mut report = Report {
        from,
        to: from,
        notes: vec![],
    };
    if from == VERSION {
        return Ok(report);
    }
    std::fs::create_dir_all(root)
        .map_err(|e| format!("failed to create {}: {}", root.display(), e))?;
    for step in STEPS.iter().filter(|s| s.number > from) {
        (step.run)(root, legacy, probe, &mut report)
            .map_err(|e| format!("storage migration {} failed: {}", step.number, e))?;
        write_marker(root, step.number)?;
        report.to = step.number;
    }
    Ok(report)
}

fn write_marker(root: &Path, version: u32) -> Result<(), String> {
    let body =
        serde_json::to_vec_pretty(&json!({ "version": version })).map_err(|e| e.to_string())?;
    fsutil::write_atomic(&root.join(MARKER), &body)
}

// --- 1 · one root -----------------------------------------------------------------------------
//
// The released desktop app kept state documents, schedules and notification targets in the
// platform's roaming data directory and everything else in the local one. They are the same
// directory except on Windows; there the roaming half is folded into the local root here.

fn fold_old_data_root(
    root: &Path,
    legacy: &Legacy,
    _probe: Probe,
    report: &mut Report,
) -> Result<(), String> {
    let Some(old) = legacy.data_dir.as_deref() else {
        return Ok(());
    };
    if !old.is_dir() || same_dir(old, root) {
        return Ok(());
    }
    merge_into(old, root, report)?;
    if is_empty_dir(old) {
        std::fs::remove_dir(old)
            .map_err(|e| format!("failed to remove {}: {}", old.display(), e))?;
    }
    Ok(())
}

/// Moves everything under `from` into `to`: directories merge, a file that already exists in
/// `to` is kept (the source copy stays and is reported), a source directory goes once emptied.
fn merge_into(from: &Path, to: &Path, report: &mut Report) -> Result<(), String> {
    for entry in std::fs::read_dir(from).map_err(|e| format!("{}: {}", from.display(), e))? {
        let entry = entry.map_err(|e| format!("{}: {}", from.display(), e))?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_dir() && target.is_dir() {
            merge_into(&source, &target, report)?;
            if is_empty_dir(&source) {
                std::fs::remove_dir(&source)
                    .map_err(|e| format!("failed to remove {}: {}", source.display(), e))?;
            }
        } else if target.exists() {
            report.notes.push(format!(
                "kept {} and left {} in place",
                target.display(),
                source.display()
            ));
        } else {
            fsutil::move_entry(&source, &target)?;
        }
    }
    Ok(())
}

fn is_empty_dir(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false)
}

// --- 2 · plugin-store files become state documents ---------------------------------------------
//
// tauri-plugin-store kept each zustand store as a JSON string inside a JSON file: `store.json`
// (key `store`) for the app document and `hosts/<id>/store.json` (key `host-store`) per host.
// The server's documents are `{version, revision, state}` under `state/`.

fn plugin_store_files_to_documents(
    root: &Path,
    _legacy: &Legacy,
    _probe: Probe,
    report: &mut Report,
) -> Result<(), String> {
    convert_store_file(
        &root.join("store.json"),
        "store",
        &root.join("state").join("app.json"),
        report,
    )?;
    let hosts = root.join("hosts");
    if hosts.is_dir() {
        for entry in std::fs::read_dir(&hosts).map_err(|e| format!("{}: {}", hosts.display(), e))? {
            let entry = entry.map_err(|e| format!("{}: {}", hosts.display(), e))?;
            let id = entry.file_name().to_string_lossy().into_owned();
            let legacy_file = entry.path().join("store.json");
            if !legacy_file.is_file() {
                continue;
            }
            let target = root
                .join("state")
                .join("hosts")
                .join(format!("{}.json", id));
            convert_store_file(&legacy_file, "host-store", &target, report)?;
            if is_empty_dir(&entry.path()) {
                let _ = std::fs::remove_dir(entry.path());
            }
        }
        if is_empty_dir(&hosts) {
            let _ = std::fs::remove_dir(&hosts);
        }
    }
    Ok(())
}

fn convert_store_file(
    legacy_file: &Path,
    key: &str,
    target: &Path,
    report: &mut Report,
) -> Result<(), String> {
    if !legacy_file.is_file() {
        return Ok(());
    }
    if target.is_file() {
        // The document exists (written after a partial earlier conversion); the newer wins.
        std::fs::remove_file(legacy_file)
            .map_err(|e| format!("failed to remove {}: {}", legacy_file.display(), e))?;
        return Ok(());
    }
    let Some((version, state)) = decode_plugin_store(legacy_file, key) else {
        report.notes.push(format!(
            "{} could not be decoded and was left in place",
            legacy_file.display()
        ));
        return Ok(());
    };
    let doc = json!({ "version": version, "revision": 1, "state": state });
    let body = serde_json::to_vec_pretty(&doc).map_err(|e| e.to_string())?;
    fsutil::write_atomic(target, &body)?;
    std::fs::remove_file(legacy_file)
        .map_err(|e| format!("failed to remove {}: {}", legacy_file.display(), e))?;
    Ok(())
}

fn decode_plugin_store(path: &Path, key: &str) -> Option<(u64, Map<String, Value>)> {
    let raw = std::fs::read_to_string(path).ok()?;
    let outer: Value = serde_json::from_str(&raw).ok()?;
    let inner = outer.get(key)?.as_str()?;
    let wrapper: Value = serde_json::from_str(inner).ok()?;
    let state = wrapper.get("state")?.as_object()?.clone();
    let version = wrapper.get("version").and_then(Value::as_u64).unwrap_or(0);
    Some((version, state))
}

// --- 3 · the single-slot binary joins the versioned library ----------------------------------
//
// Before versions were kept side by side, the downloaded rclone sat as `<root>/rclone`. It is
// one of `rclone-versions/v<version>/` now, where the binary resolver finds it.

fn slot_binary_to_library(
    root: &Path,
    _legacy: &Legacy,
    probe: Probe,
    report: &mut Report,
) -> Result<(), String> {
    let name = if cfg!(windows) {
        "rclone.exe"
    } else {
        "rclone"
    };
    let slot = root.join(name);
    if !slot.is_file() {
        return Ok(());
    }
    let version = match probe(&slot) {
        Ok(version) => version,
        Err(e) => {
            report.notes.push(format!(
                "{} is not a usable rclone binary ({}) and was left in place",
                slot.display(),
                e
            ));
            return Ok(());
        }
    };
    let dest = root
        .join("rclone-versions")
        .join(format!("v{}", version))
        .join(name);
    if dest.exists() {
        std::fs::remove_file(&slot)
            .map_err(|e| format!("failed to remove {}: {}", slot.display(), e))?;
    } else {
        fsutil::move_entry(&slot, &dest)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
        }
    }
    Ok(())
}

// --- 4 · transfers are recorded on their own ---------------------------------------------------
//
// Layout 3 kept what each job was started with in the host document (`recentJobs`, keyed by the
// daemon's pid and rclone's job id) so the job drawer could offer its settings again. Transfers
// are recorded under `transfers/` now, settings included, and the list has no reader left.

fn drop_recent_jobs(
    root: &Path,
    _legacy: &Legacy,
    _probe: Probe,
    report: &mut Report,
) -> Result<(), String> {
    let hosts = root.join("state").join("hosts");
    let Ok(documents) = std::fs::read_dir(&hosts) else {
        return Ok(());
    };
    for document in documents.flatten() {
        let path = document.path();
        if !path.extension().is_some_and(|ext| ext == "json") {
            continue;
        }
        let parsed = std::fs::read(&path)
            .ok()
            .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok());
        let Some(mut doc) = parsed else {
            report.notes.push(format!(
                "{} could not be read and was left as it is",
                path.display()
            ));
            continue;
        };
        let removed = doc
            .get_mut("state")
            .and_then(Value::as_object_mut)
            .and_then(|state| state.remove("recentJobs"));
        if removed.is_none() {
            continue;
        }
        doc["revision"] = json!(doc["revision"].as_u64().unwrap_or(0) + 1);
        let body = serde_json::to_vec_pretty(&doc).map_err(|e| e.to_string())?;
        fsutil::write_atomic(&path, &body)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("rclone-ui-storage-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn no_probe(_: &Path) -> Result<String, String> {
        Err("no binary expected".to_string())
    }

    fn probe_ok(_: &Path) -> Result<String, String> {
        Ok("1.68.2".to_string())
    }

    fn run(root: &Path, legacy: &Legacy, probe: Probe) -> Report {
        migrate_with(root, legacy, probe).unwrap()
    }

    #[test]
    fn a_fresh_root_gets_the_marker_and_nothing_else() {
        let dir = scratch("fresh");
        let root = dir.join("root");
        let report = run(&root, &Legacy::default(), no_probe);
        assert_eq!(
            report,
            Report {
                from: 0,
                to: VERSION,
                notes: vec![]
            }
        );
        assert_eq!(entries(&root), vec![MARKER.to_string()]);
        assert_eq!(version(&root).unwrap(), VERSION);
        // A second run reads the marker and touches nothing.
        let again = run(&root, &Legacy::default(), no_probe);
        assert_eq!(
            again,
            Report {
                from: VERSION,
                to: VERSION,
                notes: vec![]
            }
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn require_current_accepts_only_the_current_version() {
        let dir = scratch("require");
        let root = dir.join("root");
        assert!(require_current(&root).is_err(), "no marker");
        write(&root.join(MARKER), r#"{"version": 2}"#);
        assert!(require_current(&root).is_err(), "older");
        write(
            &root.join(MARKER),
            &format!(r#"{{"version": {}}}"#, VERSION),
        );
        assert!(require_current(&root).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_overridden_root_never_folds_another_directory() {
        // The platform's own old root may well exist on the machine running this test; a root
        // elsewhere (tests, --data-dir, containers) must not see it.
        let dir = scratch("override");
        let root = dir.join("root");
        assert!(legacy_for(&root).data_dir.is_none());
        // And a directory that carries nothing the old app wrote is not an old root either.
        let stranger = dir.join("stranger");
        write(&stranger.join("notes.txt"), "mine");
        assert!(!looks_like_old_data_root(&stranger));
        write(&stranger.join("state/app.json"), "{}");
        assert!(looks_like_old_data_root(&stranger));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_newer_or_unreadable_marker_is_an_error() {
        let dir = scratch("marker");
        let root = dir.join("root");
        write(&root.join(MARKER), r#"{"version": 99}"#);
        let err = migrate(&root, Environment::Server).unwrap_err();
        assert!(err.contains("newer"), "{}", err);
        write(&root.join(MARKER), "not json");
        assert!(version(&root).is_err());
        assert!(migrate(&root, Environment::Server).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn step_one_folds_the_old_data_root_into_the_root() {
        let dir = scratch("fold");
        let root = dir.join("local");
        let old = dir.join("roaming");
        // What the released desktop kept in Roaming …
        write(
            &old.join("state/app.json"),
            r#"{"version":3,"revision":4,"state":{}}"#,
        );
        write(
            &old.join("state/hosts/local.json"),
            r#"{"version":2,"revision":1,"state":{}}"#,
        );
        write(&old.join("scheduler/jobs/local/abc.json"), "{}");
        write(&old.join("notifications/targets.json"), "[]");
        // … and in Local, with a directory both had.
        write(&root.join("configs/default/rclone.conf"), "[r]\n");
        write(&root.join("logs/rclone-ui-server.log"), "local\n");
        write(&old.join("logs/rclone-ui-server.log"), "roaming\n");
        write(&old.join("logs/other.log"), "x\n");

        let legacy = Legacy {
            data_dir: Some(old.clone()),
        };
        let report = run(&root, &legacy, no_probe);
        assert_eq!(report.from, 0);
        assert_eq!(report.to, VERSION);
        assert!(root.join("state/app.json").is_file());
        assert!(root.join("state/hosts/local.json").is_file());
        assert!(root.join("scheduler/jobs/local/abc.json").is_file());
        assert!(root.join("notifications/targets.json").is_file());
        assert!(root.join("configs/default/rclone.conf").is_file());
        // Directories merged; the existing file won and the source copy stayed, reported.
        assert_eq!(
            std::fs::read_to_string(root.join("logs/rclone-ui-server.log")).unwrap(),
            "local\n"
        );
        assert!(root.join("logs/other.log").is_file());
        assert!(old.join("logs/rclone-ui-server.log").is_file());
        assert!(!old.join("state").exists());
        assert!(!old.join("scheduler").exists());
        assert!(old.exists(), "not empty, so it stays");
        assert!(
            report
                .notes
                .iter()
                .any(|n| n.contains("rclone-ui-server.log")),
            "{:?}",
            report.notes
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn step_one_removes_the_old_root_once_it_is_empty() {
        let dir = scratch("fold-empty");
        let root = dir.join("local");
        let old = dir.join("roaming");
        write(&old.join("state/app.json"), "{}");
        let legacy = Legacy {
            data_dir: Some(old.clone()),
        };
        let report = run(&root, &legacy, no_probe);
        assert!(root.join("state/app.json").is_file());
        assert!(!old.exists());
        assert!(report.notes.is_empty(), "{:?}", report.notes);
        // The same directory as the root, or a missing one, is nothing to fold.
        let same = Legacy {
            data_dir: Some(root.clone()),
        };
        write(&root.join(MARKER), r#"{"version": 0}"#);
        assert!(run(&root, &same, no_probe).notes.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn step_two_turns_plugin_store_files_into_state_documents() {
        let dir = scratch("docs");
        let root = dir.join("root");
        let inner = r#"{"state":{"rclonePath":"/usr/bin/rclone","hosts":[]},"version":3}"#;
        write(
            &root.join("store.json"),
            &json!({ "store": inner }).to_string(),
        );
        let host_inner = r#"{"state":{"activeConfigId":"default"},"version":2}"#;
        write(
            &root.join("hosts/local/store.json"),
            &json!({ "host-store": host_inner }).to_string(),
        );
        // A host document that already exists wins; its legacy file still goes.
        write(
            &root.join("hosts/other/store.json"),
            &json!({ "host-store": host_inner }).to_string(),
        );
        write(
            &root.join("state/hosts/other.json"),
            r#"{"version":2,"revision":7,"state":{"activeConfigId":"kept"}}"#,
        );
        // An undecodable legacy file is left where it is and reported.
        write(&root.join("hosts/broken/store.json"), "not json");

        let report = run(&root, &Legacy::default(), no_probe);
        let app: Value =
            serde_json::from_slice(&std::fs::read(root.join("state/app.json")).unwrap()).unwrap();
        assert_eq!(app["version"], 3);
        assert_eq!(app["revision"], 1);
        assert_eq!(app["state"]["rclonePath"], "/usr/bin/rclone");
        let host: Value =
            serde_json::from_slice(&std::fs::read(root.join("state/hosts/local.json")).unwrap())
                .unwrap();
        assert_eq!(host["version"], 2);
        assert_eq!(host["revision"], 1);
        assert_eq!(host["state"]["activeConfigId"], "default");
        let other: Value =
            serde_json::from_slice(&std::fs::read(root.join("state/hosts/other.json")).unwrap())
                .unwrap();
        assert_eq!(other["revision"], 7);
        assert_eq!(other["state"]["activeConfigId"], "kept");
        assert!(!root.join("store.json").exists());
        assert!(!root.join("hosts/local").exists());
        assert!(!root.join("hosts/other").exists());
        assert!(root.join("hosts/broken/store.json").is_file());
        assert!(
            report.notes.iter().any(|n| n.contains("broken")),
            "{:?}",
            report.notes
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Layout 3 kept what each job was started with in the host document (`recentJobs`), keyed
    /// by a daemon pid and a job id that mean nothing once that daemon is gone. Transfers are
    /// recorded under `transfers/` now; the list goes, everything else in the document stays.
    #[test]
    fn step_four_drops_the_recent_jobs_of_every_host_document() {
        let dir = scratch("recent-jobs");
        let root = dir.join("root");
        write(&root.join("storage.json"), r#"{"version": 3}"#);
        write(
            &root.join("state").join("hosts").join("local.json"),
            r#"{"version":2,"revision":7,"state":{"favoritePaths":["/a"],"recentJobs":[{"jobid":1,"pid":5}]}}"#,
        );
        write(
            &root.join("state").join("hosts").join("nas.json"),
            r#"{"version":2,"revision":1,"state":{"favoritePaths":[]}}"#,
        );

        let report = run(&root, &Legacy::default(), no_probe);

        assert_eq!((report.from, report.to), (3, 4));
        let local: Value = serde_json::from_str(
            &std::fs::read_to_string(root.join("state/hosts/local.json")).unwrap(),
        )
        .unwrap();
        assert!(local["state"].get("recentJobs").is_none());
        assert_eq!(local["state"]["favoritePaths"], json!(["/a"]));
        assert_eq!(local["version"], 2);
        assert_eq!(local["revision"], 8, "a changed document is a new revision");
        let nas: Value = serde_json::from_str(
            &std::fs::read_to_string(root.join("state/hosts/nas.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            nas["revision"], 1,
            "a document without the key is not rewritten"
        );
    }

    #[test]
    fn step_three_moves_the_slot_binary_into_the_versioned_library() {
        let dir = scratch("binary");
        let root = dir.join("root");
        let slot = root.join(if cfg!(windows) {
            "rclone.exe"
        } else {
            "rclone"
        });
        write(&slot, "#!/bin/sh\necho rclone v1.68.2\n");
        let report = run(&root, &Legacy::default(), probe_ok);
        let dest = root
            .join("rclone-versions")
            .join("v1.68.2")
            .join(if cfg!(windows) {
                "rclone.exe"
            } else {
                "rclone"
            });
        assert!(dest.is_file());
        assert!(!slot.exists());
        assert!(report.notes.is_empty(), "{:?}", report.notes);

        // A binary the probe rejects stays where it is, reported.
        let dir2 = scratch("binary-bad");
        let root2 = dir2.join("root");
        let slot2 = root2.join(if cfg!(windows) {
            "rclone.exe"
        } else {
            "rclone"
        });
        write(&slot2, "garbage");
        let report = run(&root2, &Legacy::default(), no_probe);
        assert!(slot2.is_file());
        assert!(
            report.notes.iter().any(|n| n.contains("rclone")),
            "{:?}",
            report.notes
        );
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    #[test]
    fn steps_resume_from_the_stored_version() {
        let dir = scratch("resume");
        let root = dir.join("root");
        // At version 2 the plugin-store files are no longer looked at …
        write(&root.join(MARKER), r#"{"version": 2}"#);
        let inner = r#"{"state":{"rclonePath":"/x"},"version":3}"#;
        write(
            &root.join("store.json"),
            &json!({ "store": inner }).to_string(),
        );
        let slot = root.join(if cfg!(windows) {
            "rclone.exe"
        } else {
            "rclone"
        });
        write(&slot, "bin");
        let report = run(&root, &Legacy::default(), probe_ok);
        assert_eq!((report.from, report.to), (2, VERSION));
        assert!(root.join("store.json").is_file());
        assert!(!root.join("state/app.json").exists());
        // … but the binary step still runs.
        assert!(!slot.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
