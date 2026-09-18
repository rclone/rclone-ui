//! What the pages still read from the host's own disk: the log tail (`fs_read_tail`), plus the
//! installer download the mount-plugin flow asks for. Every other file the pages touch lives
//! where the daemon runs and goes through rclone (`lib/rclone/daemon-fs.ts`).

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use rclone_ui_shared::rt;
use serde_json::Value;

fn io(e: std::io::Error, what: &str, path: &Path) -> String {
    format!("{} {}: {}", what, path.display(), e)
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    rt::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn path_arg(args: &Value, key: &str) -> Result<PathBuf, String> {
    args[key]
        .as_str()
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| format!("missing '{}'", key))
}

/// The most lines a caller may ask for: enough for any log view, small enough to allocate.
const MAX_TAIL_LINES: u64 = 10_000;

pub async fn read_tail(args: &Value) -> Result<Value, String> {
    let p = path_arg(args, "path")?;
    let lines = args["lines"].as_u64().unwrap_or(200).min(MAX_TAIL_LINES) as usize;
    if lines == 0 {
        return Ok(Value::Array(Vec::new()));
    }
    blocking(move || {
        let file = std::fs::File::open(&p).map_err(|e| io(e, "failed to open", &p))?;
        let reader = std::io::BufReader::new(file);
        let mut ring: std::collections::VecDeque<String> =
            std::collections::VecDeque::with_capacity(lines + 1);
        for line in reader.lines() {
            let line = line.map_err(|e| io(e, "failed to read", &p))?;
            if ring.len() == lines {
                ring.pop_front();
            }
            ring.push_back(line);
        }
        Ok(Value::Array(ring.into_iter().map(Value::String).collect()))
    })
    .await
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_tail_is_bounded() {
        let dir = std::env::temp_dir().join(format!("rcloneui-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("app.log");
        std::fs::write(&file, "one\ntwo\nthree\n").unwrap();
        let path = file.to_string_lossy().into_owned();
        let tail = |lines: Value| {
            rclone_ui_shared::rt::block_on(read_tail(&json!({ "path": path, "lines": lines })))
                .unwrap()
        };
        assert_eq!(tail(json!(2)), json!(["two", "three"]));
        assert_eq!(tail(json!(0)), json!([]));
        // A count beyond any log is clamped, not allocated.
        assert_eq!(tail(json!(u64::MAX)), json!(["one", "two", "three"]));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
