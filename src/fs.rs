//! The one thing written to this machine's disk outside the data directory: the WinFsp
//! installer download. Every file the pages touch lives where the daemon runs and goes
//! through rclone (`lib/rclone/daemon-fs.ts`).

use std::io::Write;
use std::path::Path;

use crate::rt;

fn io(e: std::io::Error, what: &str, path: &Path) -> String {
    format!("{} {}: {}", what, path.display(), e)
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    rt::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn write_all(p: &Path, bytes: &[u8], append: bool) -> Result<(), String> {
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| io(e, "failed to create", parent))?;
        }
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true);
    if append {
        opts.append(true);
    } else {
        opts.truncate(true);
    }
    let mut file = opts.open(p).map_err(|e| io(e, "failed to open", p))?;
    file.write_all(bytes)
        .map_err(|e| io(e, "failed to write", p))
}

pub async fn download_to(http: &reqwest::Client, url: &str, path: &Path) -> Result<(), String> {
    let response = http
        .get(url)
        .send()
        .await
        .map_err(|e| format!("download failed: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("download failed (HTTP {})", response.status()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("download failed: {}", e))?;
    let path = path.to_path_buf();
    blocking(move || write_all(&path, &bytes, false)).await
}
