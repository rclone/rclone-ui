//! The data directory's layout version (`storage.json` at its root), and the place migrations go.
//!
//! Every process that owns the directory brings it to [`VERSION`] at startup, before anything
//! reads or creates files under it, so nothing else ever has to ask what version the directory is
//! at. Readers everywhere else know only the current layout: there are no lazy conversions and no
//! fallbacks to what an older version wrote.
//!
//! There are no migrations. This product has only ever written one layout and has never run
//! anywhere that could hold an older one, so a fresh directory is at [`VERSION`] by definition and
//! all this does is stamp the marker. [`apply_steps`] is where the first migration goes.

use std::path::Path;

use serde_json::{json, Value};

use crate::fsutil;

/// The layout this build writes and reads.
pub const VERSION: u32 = 1;

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

/// Brings `root` to [`VERSION`]. A marker above it is an error: the directory was written by a
/// newer build and is not touched. Idempotent: at the current version nothing is read or
/// written and the report says `from == to`.
pub fn migrate(root: &Path) -> Result<Report, String> {
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
    apply_steps(root, from, &mut report)?;
    // The marker is the only thing that says a directory is current, so it is written whether a
    // step ran or not: a fresh directory needs stamping too.
    write_marker(root, VERSION)?;
    report.to = VERSION;
    Ok(report)
}

/// Where layout migrations go. There are none yet.
///
/// A step brings the directory from version `n - 1` to `n`. To add the first one: run it only
/// when `from < n`, make it idempotent, call [`write_marker`] with `n` as soon as it succeeds so
/// a crash resumes rather than repeats, push anything it could not finish onto `report.notes`,
/// and bump [`VERSION`] to `n`. Keep old layouts referenced here and nowhere else.
fn apply_steps(_root: &Path, _from: u32, _report: &mut Report) -> Result<(), String> {
    Ok(())
}

fn write_marker(root: &Path, version: u32) -> Result<(), String> {
    let body =
        serde_json::to_vec_pretty(&json!({ "version": version })).map_err(|e| e.to_string())?;
    fsutil::write_atomic(&root.join(MARKER), &body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rclone-cloud-storage-{}-{}",
            name,
            std::process::id()
        ));
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

    #[test]
    fn a_fresh_root_gets_the_marker_and_nothing_else() {
        let dir = scratch("fresh");
        let root = dir.join("root");
        let report = migrate(&root).unwrap();
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
        let again = migrate(&root).unwrap();
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

    /// A directory that already holds data is stamped, not rearranged: with no steps to run, the
    /// marker is the only thing that changes.
    #[test]
    fn an_existing_directory_keeps_what_is_in_it() {
        let dir = scratch("existing");
        let root = dir.join("root");
        write(&root.join("state/app.json"), r#"{"version":1}"#);
        write(&root.join("transfers/ledger.jsonl"), "{}\n");
        let report = migrate(&root).unwrap();
        assert_eq!(report.from, 0);
        assert_eq!(report.to, VERSION);
        assert!(report.notes.is_empty());
        assert_eq!(
            entries(&root),
            vec![
                "state".to_string(),
                MARKER.to_string(),
                "transfers".to_string()
            ]
        );
        assert_eq!(
            std::fs::read_to_string(root.join("state/app.json")).unwrap(),
            r#"{"version":1}"#
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_newer_or_unreadable_marker_is_an_error() {
        let dir = scratch("marker");
        let root = dir.join("root");
        write(&root.join(MARKER), r#"{"version": 99}"#);
        let err = migrate(&root).unwrap_err();
        assert!(err.contains("newer"), "{}", err);
        write(&root.join(MARKER), "not json");
        assert!(version(&root).is_err());
        assert!(migrate(&root).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
