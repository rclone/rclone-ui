use chrono::{DateTime, Utc};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, State};

const CANCELLED: &str = "Local directory listing cancelled";
const MAX_SCAN_DIRECTORIES: usize = 10_000;
const MAX_SCAN_ENTRIES: usize = 100_000;
const MAX_SCAN_DURATION: Duration = Duration::from_millis(3_500);

#[derive(Default)]
pub struct LocalFsState {
    requests: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    name: String,
    full_path: String,
    is_dir: bool,
    size: Option<u64>,
    mod_time: Option<String>,
}

#[derive(Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LocalListingEvent {
    Entries {
        entries: Vec<LocalEntry>,
    },
    Size {
        full_path: String,
        size: Option<u64>,
    },
    Error {
        message: String,
    },
    Complete,
}

#[derive(Debug)]
enum ScanError {
    BudgetExceeded,
    Cancelled,
    Incomplete,
}

#[cfg(unix)]
type DirectoryIdentity = (u64, u64);
#[cfg(unix)]
type DeviceIdentity = u64;

#[cfg(unix)]
fn directory_info(path: &Path) -> std::io::Result<(DirectoryIdentity, DeviceIdentity)> {
    use std::os::unix::fs::MetadataExt;

    let metadata = fs::metadata(path)?;
    Ok(((metadata.dev(), metadata.ino()), metadata.dev()))
}

#[cfg(windows)]
type DirectoryIdentity = PathBuf;
#[cfg(windows)]
type DeviceIdentity = std::ffi::OsString;

#[cfg(windows)]
fn directory_info(path: &Path) -> std::io::Result<(DirectoryIdentity, DeviceIdentity)> {
    use std::io::{Error, ErrorKind};

    let canonical = fs::canonicalize(path)?;
    let device = canonical
        .components()
        .next()
        .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "path has no volume prefix"))?
        .as_os_str()
        .to_os_string();
    Ok((canonical, device))
}

#[cfg(not(any(unix, windows)))]
type DirectoryIdentity = PathBuf;
#[cfg(not(any(unix, windows)))]
type DeviceIdentity = ();

#[cfg(not(any(unix, windows)))]
fn directory_info(path: &Path) -> std::io::Result<(DirectoryIdentity, DeviceIdentity)> {
    fs::canonicalize(path).map(|path| (path, ()))
}

struct ScanBudget {
    started: Instant,
    directories: usize,
    entries: usize,
}

impl ScanBudget {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            directories: 0,
            entries: 0,
        }
    }

    fn visit_directory(&mut self) -> Result<(), ScanError> {
        if self.started.elapsed() >= MAX_SCAN_DURATION || self.directories >= MAX_SCAN_DIRECTORIES {
            return Err(ScanError::BudgetExceeded);
        }
        self.directories += 1;
        Ok(())
    }

    fn visit_entry(&mut self) -> Result<(), ScanError> {
        if self.started.elapsed() >= MAX_SCAN_DURATION || self.entries >= MAX_SCAN_ENTRIES {
            return Err(ScanError::BudgetExceeded);
        }
        self.entries += 1;
        Ok(())
    }
}

fn directory_size(
    path: &Path,
    allowed_device: &DeviceIdentity,
    cancelled: &AtomicBool,
    budget: &mut ScanBudget,
) -> Result<u64, ScanError> {
    let mut total = 0_u64;
    let mut pending = vec![path.to_path_buf()];
    let mut visited = HashSet::new();

    while let Some(directory) = pending.pop() {
        if cancelled.load(Ordering::Relaxed) {
            return Err(ScanError::Cancelled);
        }
        budget.visit_directory()?;

        let (identity, device) = directory_info(&directory).map_err(|_| ScanError::Incomplete)?;
        if &device != allowed_device {
            if directory == path {
                return Err(ScanError::Incomplete);
            }
            continue;
        }
        if !visited.insert(identity) {
            continue;
        }

        let entries = fs::read_dir(directory).map_err(|_| ScanError::Incomplete)?;
        for entry in entries {
            if cancelled.load(Ordering::Relaxed) {
                return Err(ScanError::Cancelled);
            }
            budget.visit_entry()?;

            let entry = entry.map_err(|_| ScanError::Incomplete)?;
            let file_type = entry.file_type().map_err(|_| ScanError::Incomplete)?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if file_type.is_file() {
                let size = entry.metadata().map_err(|_| ScanError::Incomplete)?.len();
                total = total.checked_add(size).ok_or(ScanError::Incomplete)?;
            }
        }
    }

    Ok(total)
}

fn list_local_entries(
    path: &Path,
    show_hidden: bool,
    cancelled: &AtomicBool,
) -> Result<(Vec<LocalEntry>, Vec<PathBuf>), String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(CANCELLED.to_string());
    }

    let entries = fs::read_dir(path)
        .map_err(|error| format!("Failed to read {}: {}", path.display(), error))?;
    let mut result = Vec::new();
    let mut directories = Vec::new();

    for entry in entries {
        if cancelled.load(Ordering::Relaxed) {
            return Err(CANCELLED.to_string());
        }

        let Ok(entry) = entry else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }

        let full_path = entry.path();
        let metadata = entry.metadata().ok();
        let is_dir = file_type.is_dir();
        let size = if file_type.is_file() {
            metadata.as_ref().map(fs::Metadata::len)
        } else {
            None
        };
        if is_dir {
            directories.push(full_path.clone());
        }
        let mod_time = metadata
            .and_then(|metadata| metadata.modified().ok())
            .map(|time| DateTime::<Utc>::from(time).to_rfc3339());

        result.push(LocalEntry {
            name,
            full_path: full_path.to_string_lossy().into_owned(),
            is_dir,
            size,
            mod_time,
        });
    }

    directories.sort();
    Ok((result, directories))
}

#[tauri::command]
pub fn list_local_directory(
    state: State<'_, LocalFsState>,
    path: String,
    request_id: String,
    show_hidden: Option<bool>,
    on_event: Channel<LocalListingEvent>,
) -> Result<(), String> {
    let show_hidden = show_hidden.unwrap_or(false);
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut requests = state.requests.lock().map_err(|error| error.to_string())?;
        if let Some(previous) = requests.insert(request_id.clone(), Arc::clone(&cancelled)) {
            previous.store(true, Ordering::Relaxed);
        }
    }

    let requests = Arc::clone(&state.requests);
    let scan_cancelled = Arc::clone(&cancelled);
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let allowed_device = directory_info(Path::new(&path))
            .ok()
            .map(|(_, device)| device);
        match list_local_entries(Path::new(&path), show_hidden, &scan_cancelled) {
            Ok((entries, directories)) => {
                if on_event
                    .send(LocalListingEvent::Entries { entries })
                    .is_ok()
                {
                    let mut budget = ScanBudget::new();
                    for directory in directories {
                        let size = match allowed_device.as_ref() {
                            Some(device) => {
                                match directory_size(
                                    &directory,
                                    device,
                                    &scan_cancelled,
                                    &mut budget,
                                ) {
                                    Ok(size) => Some(size),
                                    Err(ScanError::BudgetExceeded | ScanError::Incomplete) => None,
                                    Err(ScanError::Cancelled) => break,
                                }
                            }
                            None => None,
                        };
                        if on_event
                            .send(LocalListingEvent::Size {
                                full_path: directory.to_string_lossy().into_owned(),
                                size,
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
            Err(message) if message != CANCELLED => {
                let _ = on_event.send(LocalListingEvent::Error { message });
            }
            Err(_) => {}
        }

        let _ = on_event.send(LocalListingEvent::Complete);

        if let Ok(mut requests) = requests.lock() {
            if requests
                .get(&request_id)
                .is_some_and(|active| Arc::ptr_eq(active, &cancelled))
            {
                requests.remove(&request_id);
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn cancel_local_directory(state: State<'_, LocalFsState>, request_id: String) {
    if let Ok(requests) = state.requests.lock() {
        if let Some(cancelled) = requests.get(&request_id) {
            cancelled.store(true, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        directory_info, directory_size, list_local_entries, LocalListingEvent, ScanBudget,
        ScanError, CANCELLED, MAX_SCAN_DIRECTORIES,
    };
    use std::fs;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(0);

    fn test_directory() -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let id = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "s-tray-local-fs-{}-{suffix}-{id}",
            std::process::id()
        ))
    }

    #[test]
    fn lists_file_and_recursive_folder_sizes() {
        let root = test_directory();
        fs::create_dir_all(root.join("folder/nested")).unwrap();
        fs::create_dir(root.join("empty")).unwrap();
        fs::write(root.join("file.txt"), b"12345").unwrap();
        fs::write(root.join("folder/one.bin"), b"123").unwrap();
        fs::write(root.join("folder/nested/two.bin"), b"1234567").unwrap();

        let cancelled = AtomicBool::new(false);
        let allowed_device = directory_info(&root).unwrap().1;
        let (entries, _) = list_local_entries(&root, false, &cancelled).unwrap();
        let mut budget = ScanBudget::new();
        assert_eq!(
            entries
                .iter()
                .find(|entry| entry.name == "file.txt")
                .unwrap()
                .size,
            Some(5)
        );
        assert_eq!(
            directory_size(
                &root.join("folder"),
                &allowed_device,
                &cancelled,
                &mut budget,
            )
            .unwrap(),
            10
        );
        assert_eq!(
            directory_size(
                &root.join("empty"),
                &allowed_device,
                &cancelled,
                &mut budget,
            )
            .unwrap(),
            0
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stops_before_scanning_when_cancelled() {
        let root = test_directory();
        fs::create_dir(&root).unwrap();
        let cancelled = AtomicBool::new(true);

        let result = list_local_entries(&root, false, &cancelled);
        assert!(matches!(result, Err(error) if error == CANCELLED));

        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn serializes_channel_events_for_the_frontend() {
        let event = serde_json::to_value(LocalListingEvent::Size {
            full_path: "/tmp/folder".to_string(),
            size: Some(42),
        })
        .unwrap();

        assert_eq!(event["event"], "size");
        assert_eq!(event["fullPath"], "/tmp/folder");
        assert_eq!(event["size"], 42);
    }

    #[test]
    fn stops_when_the_scan_budget_is_exhausted() {
        let mut budget = ScanBudget {
            started: std::time::Instant::now(),
            directories: MAX_SCAN_DIRECTORIES,
            entries: 0,
        };

        assert!(matches!(
            budget.visit_directory(),
            Err(ScanError::BudgetExceeded)
        ));
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn rejects_a_directory_on_another_device() {
        let root = test_directory();
        fs::create_dir(&root).unwrap();
        #[cfg(unix)]
        let device = directory_info(&root).unwrap().1.wrapping_add(1);
        #[cfg(windows)]
        let device = {
            let mut device = directory_info(&root).unwrap().1;
            device.push("-other");
            device
        };
        let result = directory_size(
            &root,
            &device,
            &AtomicBool::new(false),
            &mut ScanBudget::new(),
        );

        assert!(matches!(result, Err(ScanError::Incomplete)));

        fs::remove_dir(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn excludes_symlinks_from_folder_sizes() {
        use std::os::unix::fs::symlink;

        let root = test_directory();
        fs::create_dir_all(root.join("folder")).unwrap();
        fs::write(root.join("folder/file.bin"), b"123").unwrap();
        symlink(&root, root.join("folder/loop")).unwrap();

        let cancelled = AtomicBool::new(false);
        let allowed_device = directory_info(&root).unwrap().1;
        let _ = list_local_entries(&root, false, &cancelled).unwrap();
        let mut budget = ScanBudget::new();
        assert_eq!(
            directory_size(
                &root.join("folder"),
                &allowed_device,
                &cancelled,
                &mut budget,
            )
            .unwrap(),
            3
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn respects_show_hidden_when_listing_local_entries() {
        let root = test_directory();
        fs::create_dir_all(root.join(".appdata")).unwrap();
        fs::write(root.join(".env"), b"secret").unwrap();
        fs::write(root.join("visible.txt"), b"ok").unwrap();

        let cancelled = AtomicBool::new(false);

        let (hidden_off, dirs_off) = list_local_entries(&root, false, &cancelled).unwrap();
        assert_eq!(hidden_off.len(), 1);
        assert_eq!(hidden_off[0].name, "visible.txt");
        assert!(dirs_off.is_empty());

        let (hidden_on, dirs_on) = list_local_entries(&root, true, &cancelled).unwrap();
        let names: Vec<&str> = hidden_on.iter().map(|entry| entry.name.as_str()).collect();
        assert!(names.contains(&".appdata"));
        assert!(names.contains(&".env"));
        assert!(names.contains(&"visible.txt"));
        assert_eq!(dirs_on, vec![root.join(".appdata")]);

        fs::remove_dir_all(root).unwrap();
    }
}
