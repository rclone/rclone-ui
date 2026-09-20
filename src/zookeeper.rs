//! rclone binary manager: spawning, versioned downloads, and PATH integration.
//!
//! rclone is executed by absolute path from here (via `std::process`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;

use crate::ctx::Ctx;

// ---------------------------------------------------------------------------
// Shared types & state
// ---------------------------------------------------------------------------

/// Result of a one-shot rclone invocation.
#[derive(Serialize)]
pub struct ExecResult {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Event streamed from the long-lived daemon to the frontend over a Channel.
/// Only `close` is emitted — stdout/stderr are discarded (nothing consumes them;
/// readiness is RC-port polling on the JS side).
#[derive(Serialize, serde::Deserialize, Clone, Debug)]
pub struct RcloneEvent {
    pub kind: String, // "close"
    pub code: Option<i32>,
    pub intentional: bool,
}

/// Told exactly once, when the daemon exits. The supervisor reads the event typed to decide
/// restarts and crash backoff; only the page's command needs it as JSON.
pub type OnDaemonClose = Box<dyn FnOnce(RcloneEvent) + Send>;

/// Tracks the currently-running daemon so a kill can be marked intentional rather than a crash.
#[derive(Default)]
pub struct DaemonState {
    pub pid: Option<u32>,
    pub intentional: Option<Arc<AtomicBool>>,
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

fn bin_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "rclone.exe"
    } else {
        "rclone"
    }
}

fn canonical(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

fn rclone_os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "osx",
        other => other,
    }
}

fn rclone_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        "i386" | "x86" => "386",
        _ => "unknown",
    }
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ---------------------------------------------------------------------------
// One-shot execution
// ---------------------------------------------------------------------------

fn exec_blocking(
    path: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    stdin_lines: Option<Vec<String>>,
    timeout_ms: Option<u64>,
) -> Result<ExecResult, String> {
    use std::io::{Read, Write};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let mut cmd = Command::new(&path);
    cmd.args(&args);
    for (k, v) in &env {
        cmd.env(k, v);
    }
    cmd.stdin(if stdin_lines.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run {}: {}", path, e))?;

    // Feed stdin lines (paced) then close stdin.
    if let Some(lines) = stdin_lines {
        if let Some(mut stdin) = child.stdin.take() {
            for line in lines {
                let _ = stdin.write_all(line.as_bytes());
                let _ = stdin.write_all(b"\n");
                let _ = stdin.flush();
                std::thread::sleep(Duration::from_millis(100));
            }
            // stdin dropped here -> EOF
        }
    }

    // Drain stdout/stderr on threads so the pipes can't fill and deadlock the wait.
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let out_handle = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(ref mut o) = out {
            let _ = o.read_to_string(&mut s);
        }
        s
    });
    let err_handle = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(ref mut e) = err {
            let _ = e.read_to_string(&mut s);
        }
        s
    });

    let code = if let Some(t) = timeout_ms {
        let deadline = Instant::now() + Duration::from_millis(t);
        loop {
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(status) => break status.code(),
                None => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        break None; // timed out
                    }
                    std::thread::sleep(Duration::from_millis(40));
                }
            }
        }
    } else {
        child.wait().map_err(|e| e.to_string())?.code()
    };

    let stdout = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();

    Ok(ExecResult {
        code,
        stdout,
        stderr,
    })
}

fn parse_rclone_version(stdout: &str) -> Option<String> {
    let first = stdout.lines().next()?;
    // e.g. "rclone v1.74.3" or "rclone v1.74.0-beta.9673.d0c469c3c"
    let token = first.split_whitespace().nth(1)?;
    Some(token.trim_start_matches('v').to_string())
}

/// Runs `<path> version` and returns the version it reports, with a Gatekeeper hint on macOS.
pub fn probe_rclone_version(path: &Path) -> Result<String, String> {
    let path = path.to_string_lossy().into_owned();
    let result = exec_blocking(
        path.clone(),
        vec!["version".to_string()],
        HashMap::new(),
        None,
        Some(5000),
    );

    match result {
        Ok(res) if res.code == Some(0) => parse_rclone_version(&res.stdout)
            .ok_or_else(|| "Could not parse rclone version output".to_string()),
        Ok(res) => {
            #[cfg(target_os = "macos")]
            {
                // Detect quarantine (Gatekeeper) which SIGKILLs unsigned binaries.
                let quarantined = std::process::Command::new("xattr")
                    .args(["-p", "com.apple.quarantine", &path])
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);
                if quarantined {
                    return Err(format!(
                        "macOS blocked this binary (Gatekeeper/quarantine). Run: xattr -d com.apple.quarantine \"{}\"",
                        path
                    ));
                }
            }
            let msg = res.stderr.trim();
            Err(if msg.is_empty() {
                format!("rclone exited with code {:?}", res.code)
            } else {
                msg.to_string()
            })
        }
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

/// Spawns the long-lived daemon and hands exactly one `close` event to `on_close` when it exits.
/// Refuses to start a second daemon while one is tracked.
pub fn spawn_rclone_with(
    ctx: &Ctx,
    path: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    on_close: OnDaemonClose,
) -> Result<u32, String> {
    use std::process::{Command, Stdio};

    let daemon = Arc::clone(&ctx.daemon);

    // Reject a second daemon instead of orphaning the first. A restart that reaches here after a
    // swallowed kill failure gets the clean spawn-failure dialog rather than a crash dialog.
    {
        let s = daemon.lock().unwrap();
        if s.pid.is_some() {
            return Err("an rclone daemon is already running".to_string());
        }
    }

    let mut cmd = Command::new(&path);
    cmd.args(&args);
    // The rc port is this server's own channel to the daemon; an inherited RCLONE_RC_* would
    // reconfigure it behind our back (RCLONE_RC_ADDR is a list: it adds a listener).
    let theirs: Vec<String> = std::env::vars()
        .map(|(key, _)| key)
        .filter(|key| key.starts_with("RCLONE_RC_"))
        .collect();
    if !theirs.is_empty() {
        log::warn!(
            "[rclone] ignoring {} from the environment",
            theirs.join(", ")
        );
        for key in &theirs {
            cmd.env_remove(key);
        }
    }
    for (k, v) in &env {
        cmd.env(k, v);
    }
    // Nothing consumes daemon stdio; null it to avoid pipe-fill and extra threads.
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn rclone daemon: {}", e))?;
    let pid = child.id();

    let intentional = Arc::new(AtomicBool::new(false));
    {
        let mut s = daemon.lock().unwrap();
        s.pid = Some(pid);
        s.intentional = Some(intentional.clone());
    }

    std::thread::spawn(move || {
        let status = child.wait();
        let was_intentional = intentional.load(Ordering::SeqCst);
        let code = status.ok().and_then(|s| s.code());

        // Clear state only if we are still the current daemon.
        {
            let mut s = daemon.lock().unwrap();
            if s.pid == Some(pid) {
                s.pid = None;
                s.intentional = None;
            }
        }

        on_close(RcloneEvent {
            kind: "close".to_string(),
            code,
            intentional: was_intentional,
        });
    });

    Ok(pid)
}

/// Terminates the running daemon. Marks it intentional so its close event is ignored by the UI.
/// Returns whether a daemon was actually killed (false when nothing was tracked). Rust state is
/// authoritative — no caller-supplied pid to SIGKILL a possibly-reused OS pid.
pub fn kill_rclone_daemon(ctx: &Ctx, timeout_ms: Option<u64>) -> Result<bool, String> {
    let target = {
        let s = ctx.daemon.lock().unwrap();
        if s.pid.is_some() {
            if let Some(flag) = &s.intentional {
                flag.store(true, Ordering::SeqCst);
            }
        }
        s.pid
    };

    if let Some(pid) = target {
        crate::kill_pid(pid, Some(timeout_ms.unwrap_or(5000)))?;
        Ok(true)
    } else {
        Ok(false)
    }
}

// ---------------------------------------------------------------------------
// Which rclone, how old it may be, and where one is installed
// ---------------------------------------------------------------------------

/// The oldest rclone whose RC API has everything the pages call: Serve uses
/// /serve/start|list|stop|stopall (1.70), and every OAuth login reads its sign-in link from
/// /config/oauthstatus and stops through /config/oauthstop (1.75).
pub const MIN_RCLONE_VERSION: &str = "1.75.0";

/// `origin` is what the message names: a path, or the external daemon.
pub fn check_minimum(version: &str, origin: &str) -> Result<(), String> {
    if crate::version::compare(version, MIN_RCLONE_VERSION) != std::cmp::Ordering::Less {
        return Ok(());
    }
    Err(format!(
        "rclone {} ({}) is older than {}, which this server needs. Update it with `rclone selfupdate` (or reinstall: https://rclone.org/install/).",
        version, origin, MIN_RCLONE_VERSION
    ))
}

/// Where an rclone this server installs goes: the directory the machine keeps its binaries in,
/// so it is on everybody's PATH.
pub fn default_target() -> PathBuf {
    #[cfg(windows)]
    {
        // User-writable and on PATH by default.
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\"));
        base.join("Microsoft").join("WindowsApps").join(bin_name())
    }
    #[cfg(not(windows))]
    {
        PathBuf::from("/usr/local/bin").join(bin_name())
    }
}

/// What to tell somebody whose machine has no rclone and whose server may not install one.
pub fn install_hint() -> &'static str {
    if cfg!(windows) {
        "winget install Rclone.Rclone"
    } else {
        "sudo -v ; curl https://rclone.org/install.sh | sudo bash"
    }
}

/// The first rclone on `path_var`. Taken as an argument so tests need not touch the process's.
pub fn find_on_path(path_var: &std::ffi::OsStr) -> Option<PathBuf> {
    std::env::split_paths(path_var)
        .map(|dir| dir.join(bin_name()))
        .find(|candidate| candidate.is_file())
}

/// The rclone this server runs when nothing names another: the one on PATH, else the one where
/// it installs (a systemd unit or a Windows service may not have that directory on its PATH).
pub fn system_rclone() -> Option<PathBuf> {
    std::env::var_os("PATH")
        .and_then(|path_var| find_on_path(&path_var))
        .or_else(|| Some(default_target()).filter(|target| target.is_file()))
}

/// Whether this process may create or replace a file in `dir`, or in the nearest ancestor that
/// exists. Touches nothing.
pub fn may_write(dir: &Path) -> bool {
    let Some(existing) = dir.ancestors().find(|ancestor| ancestor.is_dir()) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let Ok(path) = std::ffi::CString::new(existing.as_os_str().as_bytes()) else {
            return false;
        };
        // SAFETY: `path` is a NUL-terminated string that outlives the call.
        unsafe { libc::access(path.as_ptr(), libc::W_OK | libc::X_OK) == 0 }
    }
    #[cfg(not(unix))]
    {
        // The install itself gives the real answer.
        let _ = existing;
        true
    }
}

/// Where an install goes: the rclone on PATH, in place, or `default` when there is none. A custom
/// binary is not looked at: this is what runs once that setting is cleared, and nothing is ever
/// written where a custom binary lives. `Err` is the reason there is nowhere to install.
pub fn install_target_for(
    pinned: Option<&Path>,
    system: Option<&Path>,
    default: &Path,
) -> Result<PathBuf, String> {
    let target = system.unwrap_or(default).to_path_buf();
    if pinned.is_some_and(|pinned| pinned != target) {
        return Err("rclone is pinned by --rclone-path.".to_string());
    }
    // Never resolved: Homebrew, snap, nix and the desktop app link into trees of their own.
    let is_link = target
        .symlink_metadata()
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false);
    if is_link {
        return Err(format!(
            "{} is a link into another installation, and this server does not write through it.",
            target.display()
        ));
    }
    let dir = target.parent().unwrap_or(Path::new("/"));
    if !may_write(dir) {
        return Err(format!("This server may not write to {}.", dir.display()));
    }
    Ok(target)
}

pub fn install_target(pinned: Option<&Path>) -> Result<PathBuf, String> {
    install_target_for(pinned, system_rclone().as_deref(), &default_target())
}

fn set_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/// The bus event the pages draw the download bar from (`lib/api/events.ts` `EventPayloads`).
pub const DOWNLOAD_PROGRESS_EVENT: &str = "rclone.download-progress";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    version: String,
    downloaded: u64,
    total: Option<u64>,
}

fn build_http_client(proxy_url: Option<String>) -> Result<reqwest::Client, String> {
    use std::time::Duration;
    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(600));
    if let Some(p) = proxy_url {
        let p = p.trim().to_string();
        if !p.is_empty() {
            let proxy = reqwest::Proxy::all(&p).map_err(|e| format!("Invalid proxy: {}", e))?;
            builder = builder.proxy(proxy);
        }
    }
    builder.build().map_err(|e| e.to_string())
}

/// Parses a (PGP-signed) SHA256SUMS body for the expected hash of `file_name`.
fn expected_sha256(sums: &str, file_name: &str) -> Option<String> {
    // SHA256SUMS is PGP-signed: skip the header/footer and blank lines, match "<hash>  <file>".
    for line in sums.lines() {
        let mut it = line.split_whitespace();
        let Some(hash) = it.next() else {
            continue;
        };
        let name = it.last().unwrap_or("");
        if name == file_name && hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(hash.to_ascii_lowercase());
        }
    }
    None
}

static INSTALLING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Downloads `version`, checks it against rclone's SHA256SUMS and puts it at `target`, replacing
/// what is there. The daemon is not stopped first: a rename under a running binary is safe, and
/// a download that fails then leaves rclone running.
pub async fn install_rclone(
    ctx: &Ctx,
    version: &str,
    target: &Path,
    proxy_url: Option<String>,
) -> Result<(), String> {
    let _one = INSTALLING
        .try_lock()
        .map_err(|_| "another rclone install is still running".to_string())?;
    // It goes into a URL and into a folder that is removed: digits and dots only.
    if version.is_empty() || !version.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return Err(format!("not an rclone version: {}", version));
    }
    if crate::version::compare(version, MIN_RCLONE_VERSION) == std::cmp::Ordering::Less {
        return Err(format!(
            "rclone {} is older than {}, which this server needs.",
            version, MIN_RCLONE_VERSION
        ));
    }
    let arch = rclone_arch();
    if arch == "unknown" {
        return Err("Unsupported architecture".to_string());
    }
    let zip_name = format!("rclone-v{}-{}-{}.zip", version, rclone_os(), arch);
    let zip_url = format!("https://downloads.rclone.org/v{}/{}", version, zip_name);
    let sums_url = format!("https://downloads.rclone.org/v{}/SHA256SUMS", version);

    let tmp = ctx
        .dirs
        .root
        .join("tmp")
        .join(format!("rclone-{}", version));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let result = match download_verified(
        ctx, version, &zip_name, &zip_url, &sums_url, proxy_url, &tmp,
    )
    .await
    {
        Ok(binary) => place(&binary, target),
        Err(e) => Err(e),
    };
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

/// Puts `staged` where `target` is, by rename. A running rclone keeps the file it started from,
/// and the old file is never written into: macOS kills a signed binary that changed under it.
pub fn place(staged: &Path, target: &Path) -> Result<(), String> {
    let dir = target
        .parent()
        .ok_or_else(|| format!("{} has no folder", target.display()))?;
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("could not create {}: {}", dir.display(), e))?;
    let new = dir.join(format!(".{}.new", bin_name()));
    let _ = std::fs::remove_file(&new);
    std::fs::copy(staged, &new)
        .map_err(|e| format!("could not write to {}: {}", dir.display(), e))?;
    set_executable(&new);
    // Probed where it will live: the staging folder may sit on a noexec mount.
    if let Err(e) = probe_rclone_version(&new) {
        let _ = std::fs::remove_file(&new);
        return Err(format!("the downloaded rclone does not run: {}", e));
    }
    #[cfg(windows)]
    {
        // A running exe cannot be replaced, but it can be moved aside.
        let old = dir.join("rclone.old.exe");
        let _ = std::fs::remove_file(&old);
        if target.exists() {
            std::fs::rename(target, &old)
                .map_err(|e| format!("could not move {} aside: {}", target.display(), e))?;
        }
    }
    std::fs::rename(&new, target).map_err(|e| {
        let _ = std::fs::remove_file(&new);
        format!("could not replace {}: {}", target.display(), e)
    })
}

/// The verified, unpacked binary inside `tmp`.
async fn download_verified(
    ctx: &Ctx,
    version: &str,
    zip_name: &str,
    zip_url: &str,
    sums_url: &str,
    proxy_url: Option<String>,
    tmp: &Path,
) -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    use std::io::Write;

    let client = build_http_client(proxy_url)?;

    // 1. Expected checksum (hard requirement).
    let sums = client
        .get(sums_url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch checksums: {}", e))?;
    if !sums.status().is_success() {
        return Err(format!("Checksums unavailable (HTTP {})", sums.status()));
    }
    let sums_body = sums.text().await.map_err(|e| e.to_string())?;
    let expected = expected_sha256(&sums_body, zip_name)
        .ok_or_else(|| format!("No checksum found for {}", zip_name))?;

    // 2. Stream the zip to disk while hashing + reporting progress.
    let zip_path = tmp.join("dl.zip");
    let mut file = std::fs::File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();

    let mut resp = client
        .get(zip_url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed (HTTP {})", resp.status()));
    }
    let total = resp.content_length();
    let mut downloaded: u64 = 0;
    let mut since_emit: u64 = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        since_emit += chunk.len() as u64;
        if since_emit >= 262_144 {
            since_emit = 0;
            ctx.events.emit(
                DOWNLOAD_PROGRESS_EVENT,
                DownloadProgress {
                    version: version.to_string(),
                    downloaded,
                    total,
                },
            );
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);

    let actual = format!("{:x}", hasher.finalize());
    if actual != expected {
        return Err(format!(
            "Checksum mismatch for {} (expected {}, got {})",
            zip_name, expected, actual
        ));
    }

    // 3. Extract (zip-slip hardened) and locate the binary.
    let extract_dir = tmp.join("x");
    std::fs::create_dir_all(&extract_dir).map_err(|e| e.to_string())?;
    unzip_hardened(&zip_path, &extract_dir)?;

    find_binary(&extract_dir).ok_or_else(|| "rclone binary not found in archive".to_string())
}

fn find_binary(dir: &Path) -> Option<PathBuf> {
    let target = bin_name();
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_binary(&path) {
                return Some(found);
            }
        } else if entry.file_name().to_string_lossy() == target {
            return Some(path);
        }
    }
    None
}

fn unzip_hardened(zip_path: &Path, out_dir: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let out_canon = canonical(out_dir);

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        // Reject absolute paths / traversal.
        let name = entry
            .enclosed_name()
            .ok_or_else(|| "Unsafe path in archive".to_string())?;
        let outpath = out_dir.join(&name);

        if entry.name().ends_with('/') || entry.name().ends_with('\\') {
            std::fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = outpath.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // Defence in depth: ensure the resolved parent stays inside out_dir.
        if let Some(parent) = outpath.parent() {
            if !canonical(parent).starts_with(&out_canon) {
                return Err("Archive entry escapes output directory".to_string());
            }
        }
        let mut outfile = std::fs::File::create(&outpath).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = entry.unix_mode() {
                let _ = std::fs::set_permissions(&outpath, std::fs::Permissions::from_mode(mode));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod download_event_tests {
    use super::*;

    fn events_ts() -> String {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/frontend/lib/api/events.ts");
        std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {}", path, e))
    }

    /// The Rclone settings section renders the download bar from this event: an emitted name the
    /// page never subscribed to leaves the bar indeterminate for the whole download.
    #[test]
    fn download_events_are_declared_in_events_ts() {
        assert!(
            events_ts().contains(&format!("'{}':", DOWNLOAD_PROGRESS_EVENT)),
            "{} is emitted but not declared in lib/api/events.ts",
            DOWNLOAD_PROGRESS_EVENT
        );
    }
}

#[cfg(test)]
mod minimum_tests {
    use super::*;

    #[test]
    fn an_older_rclone_is_told_to_update_itself() {
        assert!(check_minimum("1.75.0", "/usr/bin/rclone").is_ok());
        assert!(check_minimum("1.75.1", "/usr/bin/rclone").is_ok());
        // A beta or a developer build of a new enough release is new enough.
        assert!(check_minimum("1.76.0-beta.10370.b93b73bcb", "x").is_ok());
        assert!(check_minimum("1.76.0-DEV", "x").is_ok());
        let error = check_minimum("1.60.0", "/usr/bin/rclone").unwrap_err();
        assert!(error.contains("1.60.0") && error.contains("/usr/bin/rclone"));
        assert!(error.contains("rclone selfupdate") && error.contains(MIN_RCLONE_VERSION));
    }
}

// A binary is a script here: `rclone version` is all that is ever asked of it.
#[cfg(all(test, unix))]
mod install_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("rclone-cloud-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fake_rclone(path: &Path, version: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, format!("#!/bin/sh\necho 'rclone v{}'\n", version)).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn the_first_rclone_on_path_is_the_one() {
        let dir = scratch("path");
        fake_rclone(&dir.join("second/rclone"), "1.75.0");
        fake_rclone(&dir.join("first/rclone"), "1.76.0");
        std::fs::create_dir_all(dir.join("empty")).unwrap();
        let path_var =
            std::env::join_paths([dir.join("empty"), dir.join("first"), dir.join("second")])
                .unwrap();
        assert_eq!(find_on_path(&path_var), Some(dir.join("first/rclone")));
        assert_eq!(find_on_path(std::ffi::OsStr::new("")), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_new_rclone_takes_the_place_of_the_old_one() {
        let dir = scratch("place");
        let staged = dir.join("staging/rclone");
        let target = dir.join("bin/rclone");
        fake_rclone(&staged, "1.76.0");
        fake_rclone(&target, "1.75.0");
        place(&staged, &target).unwrap();
        assert_eq!(probe_rclone_version(&target).unwrap(), "1.76.0");
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
        assert!(!dir.join("bin/.rclone.new").exists());
        // One that does not run is never put in place.
        std::fs::write(&staged, "not a program").unwrap();
        assert!(place(&staged, &target)
            .unwrap_err()
            .contains("does not run"));
        assert_eq!(probe_rclone_version(&target).unwrap(), "1.76.0");
        assert!(!dir.join("bin/.rclone.new").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_install_goes_where_the_servers_own_rclone_lives() {
        let dir = scratch("target");
        let default = dir.join("usr-local-bin/rclone");
        let system = dir.join("opt/rclone");
        fake_rclone(&system, "1.75.0");
        // The rclone on PATH, in place; with none, the machine's bin folder.
        assert_eq!(
            install_target_for(None, Some(&system), &default),
            Ok(system.clone())
        );
        assert_eq!(
            install_target_for(None, None, &default),
            Ok(default.clone())
        );
        // Pinned there (the Docker image) is fine; pinned anywhere else leaves nothing to install.
        assert_eq!(
            install_target_for(Some(&system), Some(&system), &default),
            Ok(system.clone())
        );
        let pinned =
            install_target_for(Some(&dir.join("elsewhere/rclone")), Some(&system), &default);
        assert!(pinned.unwrap_err().contains("--rclone-path"));
        // A link into somebody else's installation is never written through.
        let link = dir.join("brew/rclone");
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&system, &link).unwrap();
        assert!(install_target_for(None, Some(&link), &default)
            .unwrap_err()
            .contains("link"));
        // Nor is a folder this process may not write to.
        let locked = dir.join("locked");
        std::fs::create_dir_all(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
        let refused = install_target_for(None, None, &locked.join("rclone"));
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        // Root may write anywhere, so this holds for everybody else.
        if unsafe { libc::geteuid() } != 0 {
            assert!(refused.unwrap_err().contains("may not write"));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// The supervisor decides restarts and crash backoff from the daemon's close event, so it takes
// that event as a typed value. These tests pin the typed delivery; the page-facing JSON sink is
// covered end-to-end by the streaming-command test.
#[cfg(all(test, unix))]
mod daemon_spawn_tests {
    use super::*;
    use crate::ctx::Events;
    use crate::datadir::DataDir;
    use std::sync::mpsc;
    use std::time::Duration;

    fn ctx() -> Ctx {
        let root = std::env::temp_dir().join(format!("rclone-cloud-daemon-{}", std::process::id()));
        Ctx::new(DataDir { root }, Events::noop())
    }

    #[test]
    fn the_close_event_reaches_a_typed_listener() {
        let ctx = ctx();
        let (tx, rx) = mpsc::channel::<RcloneEvent>();

        let pid = spawn_rclone_with(
            &ctx,
            "/bin/sh".to_string(),
            vec!["-c".to_string(), "exit 7".to_string()],
            HashMap::new(),
            Box::new(move |event| {
                let _ = tx.send(event);
            }),
        )
        .expect("the daemon spawns");
        assert!(pid > 0);

        let event = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the close event arrives");
        assert_eq!(event.kind, "close");
        assert_eq!(event.code, Some(7));
        assert!(
            !event.intentional,
            "an exit nobody asked for is not intentional"
        );
        // The slot is cleared before the event goes out, so the next spawn is not refused.
        assert!(ctx.daemon.lock().unwrap().pid.is_none());
    }

    #[test]
    fn a_second_daemon_is_refused_while_one_runs() {
        let ctx = ctx();
        let (tx, rx) = mpsc::channel::<RcloneEvent>();
        spawn_rclone_with(
            &ctx,
            "/bin/sh".to_string(),
            vec!["-c".to_string(), "sleep 30".to_string()],
            HashMap::new(),
            Box::new(move |event| {
                let _ = tx.send(event);
            }),
        )
        .expect("the first daemon spawns");

        let second = spawn_rclone_with(
            &ctx,
            "/bin/sh".to_string(),
            vec!["-c".to_string(), "exit 0".to_string()],
            HashMap::new(),
            Box::new(|_| {}),
        );
        assert!(second.is_err(), "a second daemon must be refused");

        assert!(kill_rclone_daemon(&ctx, Some(5000)).unwrap());
        let event = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the close event arrives");
        assert!(event.intentional, "a kill we asked for is intentional");
    }
}
