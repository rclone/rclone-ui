//! The standalone server's log file. The desktop's log plugin writes `<log dir>/Rclone UI.log`;
//! the server has no plugin, so it keeps the same contract itself: every record goes to stderr
//! (containers, journals) and to `<log dir>/rclone-cloud.log`, which starts over once it
//! reaches 10 MB (the desktop plugin's `KeepOne`: the full file is deleted, no `.old` copy), so
//! the About page's "last lines" and bug reports always have something recent to read.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const FILE_NAME: &str = "rclone-cloud.log";
/// The same cap as the desktop's log plugin (`src-tauri/src/lib.rs`).
pub const MAX_BYTES: u64 = 10 * 1024 * 1024;

struct Tee {
    path: PathBuf,
    file: Option<File>,
    written: u64,
    max_bytes: u64,
}

impl Tee {
    fn new(path: &Path, max_bytes: u64) -> Tee {
        let (file, written) = Tee::open(path);
        Tee {
            path: path.to_path_buf(),
            file,
            written,
            max_bytes,
        }
    }

    fn open(path: &Path) -> (Option<File>, u64) {
        match OpenOptions::new().create(true).append(true).open(path) {
            Ok(file) => {
                let size = file.metadata().map(|m| m.len()).unwrap_or(0);
                (Some(file), size)
            }
            Err(e) => {
                eprintln!(
                    "rclone-cloud: cannot open the log file {}: {}",
                    path.display(),
                    e
                );
                (None, 0)
            }
        }
    }

    /// Starts the file over, like the desktop's log plugin: the full one is deleted, nothing is
    /// kept aside.
    fn rotate(&mut self) {
        self.file = None;
        let _ = std::fs::remove_file(&self.path);
        let (file, size) = Tee::open(&self.path);
        self.file = file;
        self.written = size;
    }
}

impl Write for Tee {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let _ = std::io::stderr().write_all(buf);
        if self.written + buf.len() as u64 > self.max_bytes {
            self.rotate();
        }
        if let Some(file) = self.file.as_mut() {
            if file.write_all(buf).is_ok() {
                self.written += buf.len() as u64;
            }
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let _ = std::io::stderr().flush();
        if let Some(file) = self.file.as_mut() {
            let _ = file.flush();
        }
        Ok(())
    }
}

/// A `Write` shared by the logger across threads.
struct Shared(Mutex<Tee>);

impl Write for Shared {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0.lock().unwrap().flush()
    }
}

/// Installs the logger. `RUST_LOG` overrides the default filter (`info`, with the pages'
/// forwarded console at `trace` so bug reports include what the tab saw).
pub fn init(log_dir: &Path) -> PathBuf {
    if let Err(e) = std::fs::create_dir_all(log_dir) {
        eprintln!(
            "rclone-cloud: cannot create the log directory {}: {}",
            log_dir.display(),
            e
        );
    }
    let path = log_dir.join(FILE_NAME);
    let tee = Shared(Mutex::new(Tee::new(&path, MAX_BYTES)));
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info,webview=trace"),
    )
    .target(env_logger::Target::Pipe(Box::new(tee)))
    .init();
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_starts_over_at_the_limit_and_keeps_no_old_copy() {
        let dir = std::env::temp_dir().join(format!("rcloneui-logging-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);
        // Eight-byte lines against a 75-byte cap: nine fit, the tenth would cross it, so the
        // file starts over with the tenth.
        let mut tee = Tee::new(&path, 75);
        for i in 0..10 {
            tee.write_all(format!("line {:02}\n", i).as_bytes())
                .unwrap();
        }
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "line 09\n");
        assert!(!path.with_extension("old.log").exists());
        // Reopening picks up the current size, so the next rotation is counted from it.
        let reopened = Tee::new(&path, 75);
        assert_eq!(reopened.written, 8);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
