//! rclone binary manager: spawning, versioned downloads, and PATH integration.
//!
//! rclone is executed by absolute path from here (via `std::process`), replacing the
//! old `tauri-plugin-shell` named-command approach that could only run two fixed paths.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;

use crate::ctx::Ctx;
use crate::datadir::DataDir;
use crate::sink::Sink;

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedVersion {
    pub version: String,
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Serialize)]
pub struct RcloneClassification {
    pub kind: String, // "system" | "managed" | "custom"
    pub version: Option<String>,
}

#[derive(Serialize)]
pub struct PathStatus {
    pub enabled: bool,
    pub target: Option<String>,
    pub warning: Option<String>,
}

/// Status of the system-config symlink. `managed` = the system path is a symlink we created;
/// `enabled` = it (or the circular direct-use case) currently points at the given app config.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSyncStatus {
    pub enabled: bool,
    pub managed: bool,
    pub system_path: String,
    pub backup_path: Option<String>,
    /// True when the file just moved aside was the app's own default config, so the caller can
    /// re-point `defaultConfigPath` at `backup_path` instead of orphaning it.
    pub default_backed_up: bool,
    pub warning: Option<String>,
}

/// Tracks the currently-running daemon so kills can be marked intentional (suppressing
/// the crash dialog) and so a webview reload cannot orphan the process.
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

fn data_root(dirs: &DataDir) -> Result<PathBuf, String> {
    Ok(dirs.root.clone())
}

fn versions_dir(dirs: &DataDir) -> Result<PathBuf, String> {
    Ok(data_root(dirs)?.join("rclone-versions"))
}

/// Legacy single-slot binary path used before the versioned layout.
/// Stable pointer used for PATH integration (independent of the active version).
fn path_pointer(dirs: &DataDir) -> Result<PathBuf, String> {
    Ok(data_root(dirs)?.join("bin").join(bin_name()))
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

pub fn exec_rclone(
    _ctx: &Ctx,
    path: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    stdin_lines: Option<Vec<String>>,
    timeout_ms: Option<u64>,
) -> Result<ExecResult, String> {
    exec_blocking(path, args, env, stdin_lines, timeout_ms)
}

fn parse_rclone_version(stdout: &str) -> Option<String> {
    let first = stdout.lines().next()?;
    // e.g. "rclone v1.74.3" or "rclone v1.74.0-beta.9673.d0c469c3c"
    let token = first.split_whitespace().nth(1)?;
    Some(token.trim_start_matches('v').to_string())
}

/// Runs `<path> version`, returning the parsed version. Adds a Gatekeeper-specific hint on macOS.
pub fn validate_rclone_binary(_ctx: &Ctx, path: String) -> Result<String, String> {
    probe_rclone_version(Path::new(&path))
}

/// Runs `<path> version` and returns the version it reports; the storage migration and the
/// resolver's validation both use it.
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

/// Runs `<path> config paths` and returns the native config-file path.
pub fn rclone_config_path(_ctx: &Ctx, path: String) -> Result<String, String> {
    let res = exec_blocking(
        path,
        vec!["config".to_string(), "paths".to_string()],
        HashMap::new(),
        None,
        Some(8000),
    )?;
    if res.code != Some(0) {
        return Err(format!("rclone config paths failed: {}", res.stderr.trim()));
    }
    for line in res.stdout.lines() {
        if let Some(rest) = line.strip_prefix("Config file:") {
            return Ok(rest.trim().to_string());
        }
    }
    Err("Could not find config file path in output".to_string())
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

/// The `spawn_rclone` command as the pages call it: the same spawn, with the close event
/// serialized onto the caller's stream.
pub fn spawn_rclone(
    ctx: &Ctx,
    path: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    on_event: Sink<RcloneEvent>,
) -> Result<u32, String> {
    spawn_rclone_with(
        ctx,
        path,
        args,
        env,
        Box::new(move |event| {
            let _ = on_event.send(event);
        }),
    )
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
// System-rclone discovery & classification
// ---------------------------------------------------------------------------

/// Walks PATH for an rclone executable, skipping any candidate under the app data dir
/// (so our own PATH-integration pointer is never mistaken for a "system" install).
pub fn find_system_rclone(ctx: &Ctx) -> Result<Option<String>, String> {
    Ok(find_system_rclone_in(&ctx.dirs))
}

fn find_system_rclone_in(dirs: &DataDir) -> Option<String> {
    let exe = bin_name();
    let path_var = std::env::var_os("PATH")?;
    let own_root = data_root(dirs).ok().map(|p| canonical(&p));

    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(exe);
        if !candidate.is_file() {
            continue;
        }
        let canon = canonical(&candidate);
        if let Some(ad) = &own_root {
            if canon.starts_with(ad) {
                continue;
            }
        }
        return Some(candidate.to_string_lossy().to_string());
    }
    None
}

/// Classifies a path as system / managed / custom (with canonical comparisons, so case-insensitive
/// filesystems and symlinked PATH entries don't misclassify).
pub fn classify_rclone_path(ctx: &Ctx, path: String) -> Result<RcloneClassification, String> {
    Ok(classify_rclone_path_in(&ctx.dirs, &path))
}

fn classify_rclone_path_in(dirs: &DataDir, path: &str) -> RcloneClassification {
    let canon = canonical(Path::new(path));

    if let Ok(vdir) = versions_dir(dirs) {
        let vdir_canon = canonical(&vdir);
        if canon.starts_with(&vdir_canon) {
            // .../rclone-versions/v1.74.3/rclone -> "1.74.3"
            let version = canon
                .strip_prefix(&vdir_canon)
                .ok()
                .and_then(|rest| rest.components().next())
                .map(|c| {
                    c.as_os_str()
                        .to_string_lossy()
                        .trim_start_matches('v')
                        .to_string()
                });
            return RcloneClassification {
                kind: "managed".to_string(),
                version,
            };
        }
    }

    if let Some(sys) = find_system_rclone_in(dirs) {
        if canonical(Path::new(&sys)) == canon {
            return RcloneClassification {
                kind: "system".to_string(),
                version: None,
            };
        }
    }

    RcloneClassification {
        kind: "custom".to_string(),
        version: None,
    }
}

// ---------------------------------------------------------------------------
// Versioned library: list / delete / adopt / self-heal
// ---------------------------------------------------------------------------

pub fn list_downloaded_rclone_versions(ctx: &Ctx) -> Result<Vec<DownloadedVersion>, String> {
    let base = versions_dir(&ctx.dirs)?;
    let mut out = Vec::new();
    if !base.exists() {
        return Ok(out);
    }
    let entries = std::fs::read_dir(&base).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with('v') || name.starts_with(".tmp") {
            continue;
        }
        let bin = entry.path().join(bin_name());
        if !bin.is_file() {
            continue;
        }
        let size = std::fs::metadata(&bin).map(|m| m.len()).unwrap_or(0);
        out.push(DownloadedVersion {
            version: name.trim_start_matches('v').to_string(),
            path: bin.to_string_lossy().to_string(),
            size_bytes: size,
        });
    }
    // Newest first.
    out.sort_by(|a, b| crate::version::compare(&b.version, &a.version));
    Ok(out)
}

/// Refuses to delete the version whose binary is the currently active one.
pub fn delete_rclone_version(
    ctx: &Ctx,
    version: String,
    active_path: Option<String>,
) -> Result<(), String> {
    let dir = versions_dir(&ctx.dirs)?.join(format!("v{}", version));
    if !dir.exists() {
        return Ok(());
    }
    if let Some(active) = active_path {
        let active_canon = canonical(Path::new(&active));
        if active_canon.starts_with(canonical(&dir)) {
            return Err("Cannot delete the active rclone version".to_string());
        }
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

/// Returns the on-disk path for a managed version if present (used to self-heal a stale
/// absolute `rclonePath` after a home-dir move/rename before falling down the ladder).
pub fn managed_version_path(ctx: &Ctx, version: String) -> Result<Option<String>, String> {
    let bin = versions_dir(&ctx.dirs)?
        .join(format!("v{}", version))
        .join(bin_name());
    Ok(if bin.is_file() {
        Some(bin.to_string_lossy().to_string())
    } else {
        None
    })
}

/// Removes stale `.tmp-*` staging dirs from an interrupted download. Called once at startup
/// (before any webview) so it can never race a live download; failures are non-fatal.
pub fn sweep_versions_tmp(dirs: &DataDir) {
    let Ok(base) = versions_dir(dirs) else {
        return;
    };
    if !base.exists() {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(&base) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(".tmp") {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
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

/// Bus event names the pages subscribe to (`lib/api/events.ts` `EventPayloads`).
pub const DOWNLOAD_PROGRESS_EVENT: &str = "rclone.download-progress";
pub const DOWNLOAD_FINISHED_EVENT: &str = "rclone.download-finished";

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

pub async fn download_rclone_version(
    ctx: &Ctx,
    version: String,
    proxy_url: Option<String>,
) -> Result<String, String> {
    let arch = rclone_arch();
    if arch == "unknown" {
        return Err("Unsupported architecture".to_string());
    }
    let os = rclone_os();
    let zip_name = format!("rclone-v{}-{}-{}.zip", version, os, arch);
    let zip_url = format!("https://downloads.rclone.org/v{}/{}", version, zip_name);
    let sums_url = format!("https://downloads.rclone.org/v{}/SHA256SUMS", version);

    let base = versions_dir(&ctx.dirs)?;
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let tmp = base.join(format!(".tmp-{}", version));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;

    // Wrap the work so we always clean up the tmp dir on failure.
    let result = download_and_install(
        ctx, &version, &zip_name, &zip_url, &sums_url, proxy_url, &tmp, &base,
    )
    .await;
    let _ = std::fs::remove_dir_all(&tmp);

    let installed_path = result?;

    ctx.events.emit(
        DOWNLOAD_FINISHED_EVENT,
        DownloadProgress {
            version,
            downloaded: 0,
            total: None,
        },
    );
    Ok(installed_path)
}

async fn download_and_install(
    ctx: &Ctx,
    version: &str,
    zip_name: &str,
    zip_url: &str,
    sums_url: &str,
    proxy_url: Option<String>,
    tmp: &Path,
    base: &Path,
) -> Result<String, String> {
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

    let binary = find_binary(&extract_dir)
        .ok_or_else(|| "rclone binary not found in archive".to_string())?;
    set_executable(&binary);

    // 4. Atomically publish into rclone-versions/v{version}/.
    let staging = tmp.join(format!("v{}", version));
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let staged_bin = staging.join(bin_name());
    std::fs::rename(&binary, &staged_bin)
        .or_else(|_| std::fs::copy(&binary, &staged_bin).map(|_| ()))
        .map_err(|e| e.to_string())?;
    set_executable(&staged_bin);

    let dest = base.join(format!("v{}", version));
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::rename(&staging, &dest).map_err(|e| e.to_string())?;

    Ok(dest.join(bin_name()).to_string_lossy().to_string())
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

// ---------------------------------------------------------------------------
// PATH integration
// ---------------------------------------------------------------------------

/// Refreshes the stable PATH pointer to aim at `target_path` (symlink on unix, copy on windows).
pub fn update_path_pointer(ctx: &Ctx, target_path: String) -> Result<(), String> {
    let pointer = path_pointer(&ctx.dirs)?;
    if let Some(parent) = pointer.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let _ = std::fs::remove_file(&pointer);
        symlink(Path::new(&target_path), &pointer).map_err(|e| e.to_string())?;
    }

    #[cfg(windows)]
    {
        // Copy (Windows can't reliably symlink without privilege). Retry for transient locks.
        let mut last_err = None;
        for _ in 0..3 {
            match std::fs::copy(&target_path, &pointer) {
                Ok(_) => {
                    last_err = None;
                    break;
                }
                Err(e) => {
                    last_err = Some(e.to_string());
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
            }
        }
        if let Some(e) = last_err {
            return Err(format!(
                "Failed to update PATH pointer (close terminals using rclone and retry): {}",
                e
            ));
        }
    }

    Ok(())
}

/// True if the effective PATH resolves `rclone` to something other than our pointer.
fn path_shadow_warning(dirs: &DataDir) -> Option<String> {
    let pointer_canon = path_pointer(dirs).ok().map(|p| canonical(&p))?;
    let exe = bin_name();
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(exe);
        if candidate.is_file() {
            let canon = canonical(&candidate);
            if canon == pointer_canon {
                return None; // ours wins
            }
            return Some(format!(
                "Another rclone at {} takes precedence in your shell; the app's binary won't be used there.",
                candidate.to_string_lossy()
            ));
        }
    }
    None
}

#[cfg(target_os = "macos")]
const MACOS_LINK: &str = "/usr/local/bin/rclone";

pub fn get_rclone_path_integration(ctx: &Ctx) -> Result<PathStatus, String> {
    let pointer = path_pointer(&ctx.dirs)?;
    let pointer_canon = canonical(&pointer);

    #[cfg(target_os = "macos")]
    {
        let link = Path::new(MACOS_LINK);
        let enabled = std::fs::read_link(link)
            .map(|t| canonical(&t) == pointer_canon)
            .unwrap_or(false);
        return Ok(PathStatus {
            enabled,
            target: Some(MACOS_LINK.to_string()),
            warning: if enabled {
                path_shadow_warning(&ctx.dirs)
            } else {
                None
            },
        });
    }

    #[cfg(target_os = "linux")]
    {
        let link = linux_link()?;
        let enabled = std::fs::read_link(&link)
            .map(|t| canonical(&t) == pointer_canon)
            .unwrap_or(false);
        let mut warning = if enabled {
            path_shadow_warning(&ctx.dirs)
        } else {
            None
        };
        if enabled && warning.is_none() && !dir_on_path(link.parent()) {
            warning = Some(format!(
                "{} is not on your PATH; add it or open a new login shell.",
                link.parent()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default()
            ));
        }
        return Ok(PathStatus {
            enabled,
            target: Some(link.to_string_lossy().to_string()),
            warning,
        });
    }

    #[cfg(target_os = "windows")]
    {
        let bin_dir = pointer.parent().map(|p| p.to_string_lossy().to_string());
        let enabled = bin_dir
            .as_ref()
            .map(|d| windows_path_contains(d))
            .unwrap_or(false);
        return Ok(PathStatus {
            enabled,
            target: bin_dir,
            warning: if enabled {
                path_shadow_warning(&ctx.dirs)
            } else {
                None
            },
        });
    }

    #[allow(unreachable_code)]
    Ok(PathStatus {
        enabled: false,
        target: None,
        warning: None,
    })
}

pub fn set_rclone_path_integration(
    ctx: &Ctx,
    enable: bool,
    target_path: String,
) -> Result<PathStatus, String> {
    // Keep the pointer fresh before wiring anything to it.
    update_path_pointer(ctx, target_path)?;
    let pointer = path_pointer(&ctx.dirs)?;
    let pointer_str = pointer.to_string_lossy().to_string();

    #[cfg(target_os = "macos")]
    {
        macos_set_link(enable, &pointer_str)?;
    }

    #[cfg(target_os = "linux")]
    {
        linux_set_link(enable, &pointer)?;
    }

    #[cfg(target_os = "windows")]
    {
        let bin_dir = pointer
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .ok_or_else(|| "Invalid pointer path".to_string())?;
        windows_set_path(enable, &bin_dir)?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = (enable, pointer_str);
        return Err("PATH integration not supported on this platform".to_string());
    }

    get_rclone_path_integration(ctx)
}

// ---------------------------------------------------------------------------
// Config sync
// ---------------------------------------------------------------------------
//
// Symlinks the system rclone config path -> the app's active config file so `rclone` invoked from
// a terminal shares the app's remotes. rclone follows this symlink for both read and write and
// preserves it (verified live). Mirrors the PATH-integration commands above.

/// The effective `XDG_CONFIG_HOME` for locating the terminal rclone's config. Honors the app
/// process's own environment (a GUI launched from a session that exported it — login file, systemd
/// user env, launchd — inherits it), and under Flatpak the host value Flatpak re-exports as
/// `HOST_XDG_CONFIG_HOME` (the sandbox's own XDG_CONFIG_HOME points at the per-app dir the host
/// terminal never reads). Returns None (→ `~/.config`) otherwise. We deliberately do NOT shell out to
/// discover a value set only in an interactive rc file: that is a rare niche, and if `~/.config` is
/// wrong the only effect is the terminal doesn't share the config — visible, no data loss.
fn resolved_xdg_config_home() -> Option<PathBuf> {
    let var = if crate::is_flatpak() {
        "HOST_XDG_CONFIG_HOME"
    } else {
        "XDG_CONFIG_HOME"
    };
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// Where rclone looks for its config by default: `$XDG_CONFIG_HOME/rclone/rclone.conf` when that is
/// set (see `resolved_xdg_config_home`), else `$HOME/.config/rclone/rclone.conf`. Mirrors rclone's
/// own `makeConfigPath` — it deliberately ignores the legacy `~/.rclone.conf` and the exe-adjacent
/// file, and uses `~/.config` on every platform (including macOS and Windows).
fn system_config_path() -> Result<PathBuf, String> {
    let base = match resolved_xdg_config_home() {
        Some(v) => v,
        None => dirs::home_dir()
            .ok_or_else(|| "Could not resolve home directory".to_string())?
            .join(".config"),
    };
    Ok(base.join("rclone").join("rclone.conf"))
}

/// True if two config paths denote the same file *without following a final-component symlink*:
/// same file name in the same directory (parents canonicalized, so parent symlinks and `.`/`..`
/// still resolve). Used for the "circular" test — `canonical()` alone would follow our own link to
/// its target and wrongly report every healthy link as circular.
fn same_location(a: &Path, b: &Path) -> bool {
    match (a.parent(), b.parent(), a.file_name(), b.file_name()) {
        (Some(pa), Some(pb), Some(na), Some(nb)) => na == nb && canonical(pa) == canonical(pb),
        _ => canonical(a) == canonical(b),
    }
}

/// True if the active config `path` IS, or resolves through a symlink to, the system `target`'s
/// location. This is the "circular / direct-use" test: installing system -> active when active
/// already resolves to system would close a loop (active -> system -> active) whose reads fail with
/// ELOOP. Canonicalizes the ACTIVE path (following its chain to the real file) and compares that by
/// LOCATION to the system path — NOT following the system path's own final symlink, so our own
/// healthy link system -> active is never mistaken for circular. canonicalize handles multi-hop and
/// its own ELOOP guard; the realistic cases are hop 0 (active IS the system file) and a single
/// dotfile symlink to it.
fn resolves_to_location(path: &Path, target: &Path) -> bool {
    same_location(&canonical(path), target)
}

/// True if `link` is the config-sync symlink WE created, proven by a positive ownership marker: its
/// target equals the exact path we recorded when we last installed it (`syncConfigLinkTarget`,
/// persisted per host). Target *location* is not proof of ownership — a user's own symlink to an app
/// config must never be misattributed to us — so a link matches only against what we actually wrote.
/// A now-dangling target still matches (both sides fall back to the same lexical path), so our own
/// link to a since-deleted config is still reclaimed. No marker recorded → we own nothing.
fn config_link_is_ours(link: &Path, owned_link_target: Option<&str>) -> bool {
    let (Ok(target), Some(owned)) = (std::fs::read_link(link), owned_link_target) else {
        return false;
    };
    canonical(&target) == canonical(Path::new(owned))
}

/// `<path>.backup`, or the first free `<path>.backup.N`, so an existing backup is never clobbered.
/// Uses `symlink_metadata` so a broken backup symlink still counts as occupied.
fn next_backup_path(path: &Path) -> PathBuf {
    let mut base = path.as_os_str().to_os_string();
    base.push(".backup");
    let base = PathBuf::from(base);
    if std::fs::symlink_metadata(&base).is_err() {
        return base;
    }
    let mut n = 1;
    loop {
        let mut s = path.as_os_str().to_os_string();
        s.push(format!(".backup.{}", n));
        let candidate = PathBuf::from(s);
        if std::fs::symlink_metadata(&candidate).is_err() {
            return candidate;
        }
        n += 1;
    }
}

/// Creates a file symlink `link` -> `target`. Uses a real symlink on every platform (no copy
/// fallback); on Windows this needs Developer Mode or elevation, surfaced as an actionable error.
fn create_config_symlink(target: &Path, link: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        symlink(target, link).map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::symlink_file;
        symlink_file(target, link).map_err(|e| {
            // ERROR_PRIVILEGE_NOT_HELD (1314): creating symlinks is privileged on Windows.
            if e.raw_os_error() == Some(1314) {
                "Creating the config symlink needs permission on Windows. Enable Developer Mode \
                 (Settings → Privacy & security → For developers) or run as administrator, then \
                 try again."
                    .to_string()
            } else {
                e.to_string()
            }
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, link);
        Err("Config sync is not supported on this platform".to_string())
    }
}

/// Moves `from` to `to`, falling back to copy+remove across filesystems (rename gives EXDEV between
/// the system config dir and app-local-data). For a same-dir move (the foreign `.backup`) rename
/// always succeeds, preserving a symlink as-is. Used for the foreign backup and for restoring either
/// kind of moved-aside entry on rollback. Callers ensure `to`'s parent exists and `to` is free.
fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to).map_err(|e| e.to_string())?;
    std::fs::remove_file(from).map_err(|e| e.to_string())?;
    Ok(())
}

/// Copies a config's *content* to `to`, leaving the source in place. `std::fs::copy` follows a
/// symlink, so the result is always a real file: a relative-target symlink is never reproduced in a
/// new directory (where its target would resolve differently, i.e. dangle), and a valid config is
/// never converted into a broken link. Used to displace the app's own default off the system path —
/// the relocated default must always be a usable file. The original is left for the caller's atomic
/// swap to replace, so the system path is never momentarily empty.
fn materialize_copy(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::copy(from, to).map_err(|e| e.to_string())?;
    Ok(())
}

/// Copies the existing system entry aside to `to` WITHOUT removing the original, preserving its exact
/// nature: a symlink is recreated as a symlink (a foreign link stays a link), a real file is copied.
/// `to` is a same-directory sibling (`next_backup_path`), so even a relative symlink target still
/// resolves after recreation. Leaving the original in place lets the atomic swap replace it with no
/// empty-path window and makes rollback a simple discard of this copy.
fn copy_aside(from: &Path, to: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(from) {
        Ok(m) if m.file_type().is_symlink() => {
            let target = std::fs::read_link(from).map_err(|e| e.to_string())?;
            create_config_symlink(&target, to)
        }
        _ => {
            std::fs::copy(from, to).map_err(|e| e.to_string())?;
            Ok(())
        }
    }
}

/// A free app-private home for a default config displaced off the system path. Unlike a raw
/// `<file>.backup`, this keeps the `<dir>/rclone.conf` shape the rest of the app assumes when it
/// derives a config's folder — re-pinning `defaultConfigPath` here must never break config loading.
fn relocated_default_path(base: &Path) -> PathBuf {
    let configs = base.join("configs");
    let mut candidate = configs.join("default-synced").join("rclone.conf");
    let mut n = 1;
    // lexists (symlink_metadata), NOT exists(): exists() follows symlinks, so a *dangling* symlink at
    // the candidate would look free and materialize_copy's std::fs::copy would then follow it and
    // write through to the link's (out-of-app-data) target. symlink_metadata treats any existing
    // entry — including a broken link — as occupied. Mirrors next_backup_path.
    while std::fs::symlink_metadata(&candidate).is_ok() {
        candidate = configs
            .join(format!("default-synced.{}", n))
            .join("rclone.conf");
        n += 1;
    }
    candidate
}

/// Installs `link` -> `target`, replacing whatever is at `link` atomically: the new link is built at
/// a sibling temp path and renamed over `link`, so a create failure leaves the prior link intact
/// (no empty-config-path window). On Windows, `rename` cannot overwrite, so we remove-then-rename
/// the already-built temp link (a small window, acceptable for that secondary platform).
///
/// A fixed sibling temp name is safe: set_config_sync's process-wide Mutex means swaps never run
/// concurrently, and the pre-create remove clears any leftover from a crashed prior run.
fn atomic_symlink_swap(target: &Path, link: &Path) -> Result<(), String> {
    let mut tmp_os = link.as_os_str().to_os_string();
    tmp_os.push(".tmp-link");
    let tmp = PathBuf::from(tmp_os);
    let _ = std::fs::remove_file(&tmp); // clear any leftover from a crashed prior run
    create_config_symlink(target, &tmp)?;
    if std::fs::rename(&tmp, link).is_ok() {
        return Ok(());
    }
    // Windows: destination must not exist for rename. The old link is only removed once our own
    // replacement is already built, so we never end up with nothing.
    let _ = std::fs::remove_file(link);
    if let Err(e) = std::fs::rename(&tmp, link) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

pub fn get_config_sync_status(
    _ctx: &Ctx,
    app_config_path: String,
    owned_link_target: Option<String>,
) -> Result<ConfigSyncStatus, String> {
    let system = system_config_path()?;
    config_sync_status(&system, &app_config_path, owned_link_target.as_deref())
}

/// Core of `get_config_sync_status`, parameterized on the system-config path so it can be driven
/// against a scratch filesystem in tests. `owned_link_target` is our persisted ownership marker.
fn config_sync_status(
    system: &Path,
    app_config_path: &str,
    owned_link_target: Option<&str>,
) -> Result<ConfigSyncStatus, String> {
    let system_path = system.to_string_lossy().to_string();
    let app_path = Path::new(app_config_path);
    let app_canon = canonical(app_path);

    // Circular: the app's active config IS the system config file — either at the same location (it
    // adopted the system rclone's native config) or via a symlink chain that resolves to it. It writes
    // that file directly, so a terminal already shares it and there is no link to manage; installing
    // one would only create a loop. Walks the ACTIVE config's chain (not the system path's own final
    // symlink), so a healthy managed link system -> active is never mistaken for this case.
    if resolves_to_location(app_path, system) {
        return Ok(ConfigSyncStatus {
            enabled: true,
            managed: false,
            system_path,
            backup_path: None,
            default_backed_up: false,
            warning: None,
        });
    }

    let is_symlink = std::fs::symlink_metadata(system)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);

    if !is_symlink {
        // A plain file (foreign config) or nothing at all — not synced, nothing we manage.
        return Ok(ConfigSyncStatus {
            enabled: false,
            managed: false,
            system_path,
            backup_path: None,
            default_backed_up: false,
            warning: None,
        });
    }

    let managed = config_link_is_ours(system, owned_link_target);
    let target = std::fs::read_link(system).ok();
    // Require the target to actually exist: canonical() falls back to the lexical path for a missing
    // file, so a dangling link to a since-deleted active config would otherwise compare equal to the
    // (also-lexical) active path and be reported as healthy, suppressing the missing-file warning.
    let enabled = managed
        && target
            .as_ref()
            .map(|t| t.exists() && canonical(t) == app_canon)
            .unwrap_or(false);

    // A managed link that no longer points at the active config (its config was deleted, or the
    // active config changed out-of-band) — flag it; the next reconcile/switch/restart re-points it.
    let warning = if managed && !enabled {
        match target.as_ref() {
            Some(t) if !t.exists() => Some(format!(
                "The synced config link points at a missing file ({}). It will be re-pointed to the active config on the next switch or restart.",
                t.to_string_lossy()
            )),
            Some(_) => Some(
                "The terminal config link points at a different config than the active one; it will be re-pointed on the next switch or restart."
                    .to_string(),
            ),
            None => None,
        }
    } else {
        None
    };

    Ok(ConfigSyncStatus {
        enabled,
        managed,
        system_path,
        backup_path: None,
        default_backed_up: false,
        warning,
    })
}

pub fn set_config_sync(
    ctx: &Ctx,
    enable: bool,
    app_config_path: String,
    owned_link_target: Option<String>,
    default_config_path: Option<String>,
) -> Result<ConfigSyncStatus, String> {
    // Serialize all mutations: concurrent reconciles (a startup heal racing a settings action) would
    // otherwise both try to swap the single system path. A poisoned lock still yields the guard — we
    // only guard filesystem ordering, and a panic mid-swap leaves recoverable on-disk state.
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let system = system_config_path()?;
    let base = data_root(&ctx.dirs)?;
    apply_config_sync(
        &system,
        &base,
        enable,
        &app_config_path,
        owned_link_target.as_deref(),
        default_config_path.as_deref(),
    )
}

/// Core of `set_config_sync`, parameterized on the system-config path and app-local-data dir so it
/// can be driven against a scratch filesystem in tests. `owned_link_target` is our persisted
/// ownership marker (the target we last installed) — the sole proof that a link is ours.
fn apply_config_sync(
    system: &Path,
    base: &Path,
    enable: bool,
    app_config_path: &str,
    owned_link_target: Option<&str>,
    default_config_path: Option<&str>,
) -> Result<ConfigSyncStatus, String> {
    let app_path = Path::new(app_config_path);
    let mut backup_path: Option<String> = None;
    let mut default_backed_up = false;

    if enable {
        // Circular case needs no link — the app config already IS (or resolves through a symlink
        // chain to) the system file. Uses the same resolves_to_location walk as config_sync_status,
        // so an active config that is a symlink to the system path is skipped here instead of getting
        // a link installed on top of it (system -> active -> system would ELOOP). Kept consistent
        // with the status call site; a plain same_location check would miss the symlink-chain case.
        if !resolves_to_location(app_path, system) {
            // Validate the target is a usable regular FILE (metadata follows symlinks): a dangling
            // symlink or a directory would pass a bare symlink_metadata check yet install a
            // broken/unusable link after moving a valid system config aside.
            match std::fs::metadata(app_path) {
                Ok(m) if m.is_file() => {}
                _ => {
                    return Err(format!(
                        "The selected config file does not exist or is not a file: {}",
                        app_config_path
                    ))
                }
            }
            if let Some(parent) = system.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }

            let occupied = std::fs::symlink_metadata(system).is_ok();
            let ours = occupied && config_link_is_ours(system, owned_link_target);

            // Already our link pointing at the active config — nothing to do (avoids churning a
            // healthy link on every startup/switch reconcile).
            if ours {
                if let Ok(target) = std::fs::read_link(system) {
                    if canonical(&target) == canonical(app_path) {
                        return config_sync_status(system, app_config_path, Some(app_config_path));
                    }
                }
            } else if occupied {
                // A foreign real file or symlink sits here. Preserve it — never destroy user data.
                // If it is the app's OWN default config, relocate it into app-local-data under a
                // valid `<dir>/rclone.conf` name and flag it so the caller re-points defaultConfigPath
                // there (a raw `.backup` name would break the app's folder-derivation). Otherwise
                // move it aside to rclone.conf.backup.
                let is_default = default_config_path
                    .map(|dc| same_location(system, Path::new(dc)))
                    .unwrap_or(false);
                let dest = if is_default {
                    default_backed_up = true;
                    relocated_default_path(base)
                } else {
                    next_backup_path(system)
                };
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                // Back the existing entry up by COPYING it aside, leaving the original in place: the
                // atomic swap below replaces it via rename, so the system path is never momentarily
                // empty. That closes a crash window (a crash between a move-aside and the swap would
                // strand the system config in an unpersisted backup, leaving the path empty) and
                // shrinks the external-writer race — a terminal `rclone` cannot drop a fresh config
                // into an empty gap that no longer exists. The default is materialized to a real file
                // (a relative symlink must not move cross-dir); a foreign entry is preserved exactly.
                if is_default {
                    materialize_copy(system, &dest)?;
                } else {
                    copy_aside(system, &dest)?;
                }
                backup_path = Some(dest.to_string_lossy().to_string());
            }

            // Install atomically over whatever is still at `system` (our own stale link, the
            // preserved original, or nothing). On failure, undo: if the swap already removed the
            // original (only its Windows fallback does) restore it from the backup copy; otherwise
            // the original is untouched, so just discard the stray copy.
            if let Err(e) = atomic_symlink_swap(app_path, system) {
                if let Some(b) = backup_path.take() {
                    let b = Path::new(&b);
                    if std::fs::symlink_metadata(system).is_err() {
                        let _ = move_file(b, system);
                    } else {
                        let _ = std::fs::remove_file(b);
                    }
                }
                return Err(e);
            }
        }
    } else {
        // Disable: only remove a link we created (marker-proven); never touch foreign/user files,
        // never restore backups.
        if std::fs::symlink_metadata(system).is_ok()
            && config_link_is_ours(system, owned_link_target)
        {
            std::fs::remove_file(system).map_err(|e| e.to_string())?;
        }
    }

    // Report post-operation ownership: on enable we now own a link to app_path; on disable we own
    // nothing. This mirrors the marker the caller persists (syncConfigLinkTarget), so the returned
    // status is immediately accurate without waiting for that write to round-trip.
    let effective_marker = if enable { Some(app_config_path) } else { None };
    let mut status = config_sync_status(system, app_config_path, effective_marker)?;
    // Carry the freshly-made backup + relocation flag through — config_sync_status can't know.
    if backup_path.is_some() {
        status.backup_path = backup_path;
    }
    status.default_backed_up = default_backed_up;
    Ok(status)
}

// ---- macOS PATH helpers ----

#[cfg(target_os = "macos")]
fn macos_set_link(enable: bool, pointer: &str) -> Result<(), String> {
    let link = Path::new(MACOS_LINK);

    if enable {
        // Never clobber a foreign rclone (e.g. Homebrew).
        if link.exists() {
            let ours = std::fs::read_link(link)
                .map(|t| canonical(&t) == canonical(Path::new(pointer)))
                .unwrap_or(false);
            if !ours {
                return Err(format!(
                    "An rclone already exists at {}. Remove it first to let Rclone UI manage it.",
                    MACOS_LINK
                ));
            }
            return Ok(()); // already ours
        }
        let cmd = format!(
            "mkdir -p /usr/local/bin && ln -sfn {} {}",
            sh_quote(pointer),
            sh_quote(MACOS_LINK)
        );
        run_osascript_admin(&cmd, "Rclone UI wants to add rclone to your PATH.")
    } else {
        // Only remove if it is our symlink.
        let ours = std::fs::read_link(link)
            .map(|t| canonical(&t) == canonical(Path::new(pointer)))
            .unwrap_or(false);
        if !ours {
            return Ok(());
        }
        let cmd = format!("rm -f {}", sh_quote(MACOS_LINK));
        run_osascript_admin(&cmd, "Rclone UI wants to remove rclone from your PATH.")
    }
}

/// POSIX single-quote a value for embedding in a shell command.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(target_os = "macos")]
fn run_osascript_admin(shell_cmd: &str, prompt: &str) -> Result<(), String> {
    // Escape for embedding inside an AppleScript string literal.
    let applescript_cmd = shell_cmd.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "do shell script \"{}\" with administrator privileges with prompt \"{}\"",
        applescript_cmd,
        prompt.replace('"', "\\\"")
    );
    let status = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Authorization was cancelled or failed.".to_string())
    }
}

// ---- Linux PATH helpers ----

#[cfg(target_os = "linux")]
fn linux_link() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME not set".to_string())?;
    Ok(PathBuf::from(home)
        .join(".local")
        .join("bin")
        .join("rclone"))
}

#[cfg(target_os = "linux")]
fn linux_set_link(enable: bool, pointer: &Path) -> Result<(), String> {
    use std::os::unix::fs::symlink;
    let link = linux_link()?;
    if enable {
        if let Some(parent) = link.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // symlink_metadata (unlike exists()) is also true for a broken symlink, so a dead link
        // no longer falls through to symlink() and fails EEXIST ("File exists") forever.
        if std::fs::symlink_metadata(&link).is_ok() {
            let target = std::fs::read_link(&link).ok();
            let ours = target
                .as_ref()
                .map(|t| canonical(t) == canonical(pointer))
                .unwrap_or(false);
            if ours {
                return Ok(());
            }
            // A dead symlink (its target no longer exists) is safe to replace; a live foreign
            // entry or a real file is not.
            let dead = target
                .as_ref()
                .map(|t| {
                    let resolved = if t.is_absolute() {
                        t.clone()
                    } else {
                        link.parent()
                            .map(|p| p.join(t))
                            .unwrap_or_else(|| t.clone())
                    };
                    !resolved.exists()
                })
                .unwrap_or(false);
            if !dead {
                return Err(format!(
                    "An rclone already exists at {}. Remove it first.",
                    link.to_string_lossy()
                ));
            }
            let _ = std::fs::remove_file(&link);
        }
        symlink(pointer, &link).map_err(|e| e.to_string())
    } else {
        let ours = std::fs::read_link(&link)
            .map(|t| canonical(&t) == canonical(pointer))
            .unwrap_or(false);
        // Also clear a dangling symlink regardless of ownership — otherwise it silently blocks
        // re-enabling PATH integration until a manual rm.
        let broken = std::fs::symlink_metadata(&link).is_ok() && !link.exists();
        if ours || broken {
            let _ = std::fs::remove_file(&link);
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn dir_on_path(dir: Option<&Path>) -> bool {
    let Some(dir) = dir else { return false };
    let Some(path_var) = std::env::var_os("PATH") else {
        return false;
    };
    let dir_canon = canonical(dir);
    std::env::split_paths(&path_var).any(|p| canonical(&p) == dir_canon)
}

// ---- Windows PATH helpers ----

#[cfg(target_os = "windows")]
fn windows_path_contains(dir: &str) -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let env = match hkcu.open_subkey("Environment") {
        Ok(k) => k,
        Err(_) => return false,
    };
    let current: String = env.get_value("Path").unwrap_or_default();
    let dir_lc = dir.to_ascii_lowercase();
    current.split(';').any(|seg| {
        seg.trim().trim_end_matches('\\').to_ascii_lowercase() == dir_lc.trim_end_matches('\\')
    })
}

#[cfg(target_os = "windows")]
fn windows_set_path(enable: bool, dir: &str) -> Result<(), String> {
    use winreg::enums::{RegType, HKEY_CURRENT_USER};
    use winreg::{RegKey, RegValue};

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (env, _) = hkcu
        .create_subkey("Environment")
        .map_err(|e| e.to_string())?;
    let current: String = env.get_value("Path").unwrap_or_default();

    let dir_norm = dir.trim_end_matches('\\').to_ascii_lowercase();
    let mut segments: Vec<String> = current
        .split(';')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();

    let already = segments
        .iter()
        .any(|s| s.trim_end_matches('\\').to_ascii_lowercase() == dir_norm);

    if enable {
        if !already {
            segments.push(dir.to_string());
        }
    } else {
        segments.retain(|s| s.trim_end_matches('\\').to_ascii_lowercase() != dir_norm);
    }

    let new_value = segments.join(";");
    // Preserve REG_EXPAND_SZ (PATH commonly contains %USERPROFILE% etc.).
    let bytes: Vec<u8> = new_value
        .encode_utf16()
        .chain(std::iter::once(0u16))
        .flat_map(|u| u.to_le_bytes())
        .collect();
    env.set_raw_value(
        "Path",
        &RegValue {
            bytes,
            vtype: RegType::REG_EXPAND_SZ,
        },
    )
    .map_err(|e| e.to_string())?;

    windows_broadcast_env_change();
    Ok(())
}

#[cfg(target_os = "windows")]
fn windows_broadcast_env_change() {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };
    let param: Vec<u16> = std::ffi::OsStr::new("Environment")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let mut result: usize = 0;
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            param.as_ptr() as isize,
            SMTO_ABORTIFHUNG,
            5000,
            &mut result,
        );
    }
}

#[cfg(test)]
mod download_event_tests {
    use super::*;

    /// The Binary settings page renders the download bar from these events: an emitted name the
    /// page never subscribed to leaves the bar indeterminate for the whole download.
    #[test]
    fn download_events_are_declared_in_events_ts() {
        let events_ts = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src-frontend/lib/api/events.ts"
        ))
        .expect("src-frontend/lib/api/events.ts");
        for name in [DOWNLOAD_PROGRESS_EVENT, DOWNLOAD_FINISHED_EVENT] {
            assert!(
                events_ts.contains(&format!("'{}':", name)),
                "{} is emitted but not declared in src-frontend/lib/api/events.ts",
                name
            );
        }
    }
}

// Config-sync truth-model tests. They drive the real `apply_config_sync`/`config_sync_status`
// against a fully isolated scratch filesystem (system + app-local-data paths are passed in, so the
// user's real ~/.config is never touched).
#[cfg(all(test, unix))]
mod config_sync_tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("stray_cs_{}_{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    fn is_symlink(p: &Path) -> bool {
        std::fs::symlink_metadata(p)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
    }

    // A healthy managed link must report managed+enabled (NOT circular), so the UI does not disable
    // the checkbox — and disable must then remove it. Ownership is proven by the marker.
    #[test]
    fn healthy_link_is_managed_not_circular() {
        let root = scratch("healthy");
        let base = root.join("appdata");
        std::fs::create_dir_all(&base).unwrap();
        let system = root.join("system/rclone/rclone.conf");
        let app_cfg = base.join("configs/default/rclone.conf");
        write(&app_cfg, "[appremote]\n");
        let app = app_cfg.to_str().unwrap();

        // First enable: no prior marker.
        let st = apply_config_sync(&system, &base, true, app, None, None).unwrap();
        assert!(is_symlink(&system));
        assert!(st.managed, "healthy link must be managed");
        assert!(st.enabled);
        assert!(st.backup_path.is_none());
        assert_eq!(std::fs::read_to_string(&system).unwrap(), "[appremote]\n");

        // Status with the marker we now hold.
        let st2 = config_sync_status(&system, app, Some(app)).unwrap();
        assert!(st2.managed && st2.enabled);

        let st3 = apply_config_sync(&system, &base, false, app, Some(app), None).unwrap();
        assert!(!is_symlink(&system), "disable must remove the link");
        assert!(!st3.managed && !st3.enabled);
    }

    // The genuine circular case (app config IS the system file) stays enabled+unmanaged and enable
    // is a no-op that leaves the real file untouched.
    #[test]
    fn circular_direct_use() {
        let root = scratch("circular");
        let base = root.join("appdata");
        std::fs::create_dir_all(&base).unwrap();
        let system = root.join("system/rclone/rclone.conf");
        write(&system, "[native]\n");
        let app = system.to_str().unwrap();

        let st = config_sync_status(&system, app, None).unwrap();
        assert!(st.enabled && !st.managed);

        let st2 = apply_config_sync(&system, &base, true, app, None, None).unwrap();
        assert!(!is_symlink(&system));
        assert_eq!(std::fs::read_to_string(&system).unwrap(), "[native]\n");
        assert!(st2.enabled && !st2.managed && st2.backup_path.is_none());
    }

    // When the app's own default config lives at the system path, syncing a DIFFERENT config must
    // preserve it (relocate) and flag default_backed_up so the caller re-points default.
    #[test]
    fn default_at_system_path_is_relocated() {
        let root = scratch("default_reloc");
        let base = root.join("appdata");
        std::fs::create_dir_all(&base).unwrap();
        let system = root.join("system/rclone/rclone.conf");
        write(&system, "[defaultremote]\n");
        let work = base.join("configs/work/rclone.conf");
        write(&work, "[workremote]\n");

        let st = apply_config_sync(
            &system,
            &base,
            true,
            work.to_str().unwrap(),
            None,
            Some(system.to_str().unwrap()),
        )
        .unwrap();

        assert!(st.default_backed_up, "must flag that the default was moved");
        let relocated = st
            .backup_path
            .clone()
            .expect("the default must be relocated");
        // Invariant: the relocated default keeps a `<dir>/rclone.conf` name (NOT `.backup`) and
        // lives under app-local-data, so re-pinning defaultConfigPath there never breaks loading.
        assert!(
            relocated.ends_with("rclone.conf"),
            "relocated default must keep the rclone.conf filename, got {relocated}"
        );
        assert!(!relocated.ends_with(".backup"));
        assert!(Path::new(&relocated).starts_with(&base));
        assert!(
            !is_symlink(Path::new(&relocated)),
            "relocated default must be a real file"
        );
        assert_eq!(
            std::fs::read_to_string(&relocated).unwrap(),
            "[defaultremote]\n"
        );
        assert!(is_symlink(&system));
        assert_eq!(std::fs::read_to_string(&system).unwrap(), "[workremote]\n");
        assert!(st.managed && st.enabled);

        // Re-pin default at the relocated path, reconcile with default active (marker = the link we
        // hold, → work): it must NOT relocate again and must re-point the system link at default.
        let st2 = apply_config_sync(
            &system,
            &base,
            true,
            &relocated,
            Some(work.to_str().unwrap()),
            Some(&relocated),
        )
        .unwrap();
        assert!(
            !st2.default_backed_up,
            "must not relocate an already-relocated default"
        );
        assert!(st2.backup_path.is_none());
        assert!(st2.managed && st2.enabled);
        assert_eq!(
            std::fs::read_to_string(&system).unwrap(),
            "[defaultremote]\n"
        );
    }

    // Relocating a default that is a RELATIVE symlink must materialize its content into a
    // real file (moving the symlink would leave a relative target resolving against the wrong dir).
    #[test]
    fn relative_symlink_default_is_materialized() {
        let root = scratch("rel_default");
        let base = root.join("appdata");
        std::fs::create_dir_all(&base).unwrap();
        let system = root.join("system/rclone/rclone.conf");
        let actual = system.parent().unwrap().join("actual.conf");
        write(&actual, "[realdefault]\n");
        // system -> "actual.conf" (relative to the system dir).
        std::fs::create_dir_all(system.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink("actual.conf", &system).unwrap();
        let work = base.join("configs/work/rclone.conf");
        write(&work, "[work]\n");

        let st = apply_config_sync(
            &system,
            &base,
            true,
            work.to_str().unwrap(),
            None,
            Some(system.to_str().unwrap()),
        )
        .unwrap();
        assert!(st.default_backed_up);
        let relocated = st.backup_path.expect("relocated");
        assert!(
            !is_symlink(Path::new(&relocated)),
            "relocated default must be a real file, not a moved symlink"
        );
        assert_eq!(
            std::fs::read_to_string(&relocated).unwrap(),
            "[realdefault]\n"
        );
        assert!(is_symlink(&system));
        assert_eq!(std::fs::read_to_string(&system).unwrap(), "[work]\n");
    }

    // An external-folder target (outside app-local-data) is owned via the marker: a re-point does
    // not spuriously back up our own link, and disable removes it.
    #[test]
    fn external_sync_target_ownership() {
        let root = scratch("external");
        let base = root.join("appdata");
        std::fs::create_dir_all(&base).unwrap();
        let system = root.join("system/rclone/rclone.conf");
        let ext = root.join("external/rclone.conf");
        write(&ext, "[extremote]\n");
        let app_priv = base.join("configs/other/rclone.conf");
        write(&app_priv, "[otherremote]\n");
        let ext_s = ext.to_str().unwrap();
        let priv_s = app_priv.to_str().unwrap();

        let st = apply_config_sync(&system, &base, true, ext_s, None, None).unwrap();
        assert!(
            st.managed,
            "external target link must be recognized as ours"
        );
        assert!(st.enabled && st.backup_path.is_none());

        // Re-point to an app-private config; marker is the link we hold (→ext) → removed, not backed up.
        let st2 = apply_config_sync(&system, &base, true, priv_s, Some(ext_s), None).unwrap();
        assert!(
            st2.backup_path.is_none(),
            "re-point must not back up our own link"
        );
        assert!(st2.managed && st2.enabled);
        assert_eq!(std::fs::read_to_string(&system).unwrap(), "[otherremote]\n");

        // Point back to external (marker now →app_priv), then disable (marker →ext): removed.
        apply_config_sync(&system, &base, true, ext_s, Some(priv_s), None).unwrap();
        let st3 = apply_config_sync(&system, &base, false, ext_s, Some(ext_s), None).unwrap();
        assert!(
            !is_symlink(&system),
            "disable must remove the external-target link"
        );
        assert!(!st3.managed);
    }

    // Enabling for a missing / dangling / directory target must fail WITHOUT disturbing a
    // good system config (no move-aside, no broken link, no backup).
    #[test]
    fn unusable_target_does_not_touch_system() {
        let root = scratch("unusable_target");
        let base = root.join("appdata");
        std::fs::create_dir_all(&base).unwrap();
        let system = root.join("system/rclone/rclone.conf");
        write(&system, "[existing]\n");

        let assert_untouched = || {
            assert!(!is_symlink(&system));
            assert_eq!(std::fs::read_to_string(&system).unwrap(), "[existing]\n");
            assert!(!system.with_file_name("rclone.conf.backup").exists());
        };

        // (a) missing file
        let ghost = base.join("configs/ghost/rclone.conf");
        assert!(
            apply_config_sync(&system, &base, true, ghost.to_str().unwrap(), None, None).is_err()
        );
        assert_untouched();

        // (b) dangling symlink target
        let dangling = base.join("configs/dangling/rclone.conf");
        std::fs::create_dir_all(dangling.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(base.join("nope/rclone.conf"), &dangling).unwrap();
        assert!(
            apply_config_sync(&system, &base, true, dangling.to_str().unwrap(), None, None)
                .is_err(),
            "a dangling symlink target must be rejected"
        );
        assert_untouched();

        // (c) directory at the target path
        let dir_target = base.join("configs/dir/rclone.conf");
        std::fs::create_dir_all(&dir_target).unwrap();
        assert!(
            apply_config_sync(
                &system,
                &base,
                true,
                dir_target.to_str().unwrap(),
                None,
                None
            )
            .is_err(),
            "a directory target must be rejected"
        );
        assert_untouched();
    }

    // Deleting the active synced config leaves a dangling link. On the next reconcile it must be
    // reclaimed as ours via the marker (removed / re-pointed) — NOT treated as foreign and backed up
    // — even when the app-local-data path traverses a symlink (macOS /var -> /private/var), which
    // makes canonical() fall back to a lexical path for the now-missing target.
    #[test]
    fn dangling_link_to_deleted_config_is_reclaimed() {
        let root = scratch("dangling");
        let base = root.join("appdata");
        std::fs::create_dir_all(root.join("real_base")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("real_base"), &base).unwrap();
        std::fs::create_dir_all(&base).ok();

        let system = root.join("system/rclone/rclone.conf");
        let deleted = base.join("configs/gone/rclone.conf");
        write(&deleted, "[gone]\n");
        let default_cfg = base.join("configs/default/rclone.conf");
        write(&default_cfg, "[default]\n");
        let gone_s = deleted.to_str().unwrap().to_string();

        // Enable while 'gone' is active (marker →gone), then delete its directory (dangling link).
        apply_config_sync(&system, &base, true, &gone_s, None, None).unwrap();
        std::fs::remove_dir_all(base.join("configs/gone")).unwrap();
        assert!(is_symlink(&system));

        // The dangling link is still ours (marker →gone): managed + not enabled + warning.
        let st = config_sync_status(&system, default_cfg.to_str().unwrap(), Some(&gone_s)).unwrap();
        assert!(
            st.managed,
            "dangling own link must still be recognized as ours"
        );
        assert!(!st.enabled);
        assert!(
            st.warning.is_some(),
            "a missing-target warning should be surfaced"
        );

        // Reconcile onto default: our link is reclaimed and re-pointed, NOT backed up.
        let st2 = apply_config_sync(
            &system,
            &base,
            true,
            default_cfg.to_str().unwrap(),
            Some(&gone_s),
            None,
        )
        .unwrap();
        assert!(
            st2.backup_path.is_none(),
            "reclaiming our dangling link must not create a backup"
        );
        assert!(st2.managed && st2.enabled);
        assert_eq!(std::fs::read_to_string(&system).unwrap(), "[default]\n");
    }

    // A dangling link whose target IS the (now-deleted) active config must not report as healthy.
    #[test]
    fn dangling_link_to_deleted_active_is_not_healthy() {
        let root = scratch("dangling_active");
        let base = root.join("appdata");
        std::fs::create_dir_all(&base).unwrap();
        let system = root.join("system/rclone/rclone.conf");
        let active = base.join("configs/work/rclone.conf");
        write(&active, "[work]\n");
        let active_s = active.to_str().unwrap().to_string();

        apply_config_sync(&system, &base, true, &active_s, None, None).unwrap();
        std::fs::remove_dir_all(base.join("configs/work")).unwrap();

        let st = config_sync_status(&system, &active_s, Some(&active_s)).unwrap();
        assert!(st.managed, "still our link");
        assert!(
            !st.enabled,
            "a dangling link to the deleted active config must not report enabled"
        );
        assert!(
            st.warning.is_some(),
            "the missing-file warning must be surfaced"
        );
    }

    // A user's OWN symlink at the system path — even one pointing at an app config — must
    // never be misattributed to us (no marker, or a marker for a different target) and so is
    // preserved (backed up), never silently replaced or removed.
    #[test]
    fn user_symlink_is_not_ours_and_is_preserved() {
        let root = scratch("user_link");
        let base = root.join("appdata");
        std::fs::create_dir_all(&base).unwrap();
        let system = root.join("system/rclone/rclone.conf");
        // The user manually symlinked the system path at ONE OF THE APP'S OWN config files.
        let app_work = base.join("configs/work/rclone.conf");
        write(&app_work, "[work]\n");
        std::fs::create_dir_all(system.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&app_work, &system).unwrap();

        let active = base.join("configs/default/rclone.conf");
        write(&active, "[default]\n");
        let active_s = active.to_str().unwrap();

        // No marker: the user's link is not ours even though its target is an app config.
        let st = config_sync_status(&system, active_s, None).unwrap();
        assert!(
            !st.managed,
            "a user's own symlink must NOT be classified as ours"
        );

        // Enabling for a different config must BACK UP the user's link, not silently replace it.
        let st2 = apply_config_sync(&system, &base, true, active_s, None, None).unwrap();
        let backup = st2
            .backup_path
            .expect("user's symlink must be backed up, not replaced");
        assert!(
            is_symlink(Path::new(&backup)),
            "the backed-up entry is the user's symlink, preserved"
        );
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "[work]\n");
        assert!(is_symlink(&system));
        assert_eq!(std::fs::read_to_string(&system).unwrap(), "[default]\n");

        // Disable against a marker for a DIFFERENT target must not remove a user's link.
        let root2 = scratch("user_link2");
        let base2 = root2.join("appdata");
        std::fs::create_dir_all(&base2).unwrap();
        let system2 = root2.join("system/rclone/rclone.conf");
        let user_target = root2.join("mine/rclone.conf");
        write(&user_target, "[mine]\n");
        std::fs::create_dir_all(system2.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&user_target, &system2).unwrap();
        apply_config_sync(
            &system2,
            &base2,
            false,
            "/x/rclone.conf",
            Some("/y/rclone.conf"),
            None,
        )
        .unwrap();
        assert!(
            is_symlink(&system2),
            "disable must not remove a link that isn't ours"
        );
        assert_eq!(std::fs::read_to_string(&system2).unwrap(), "[mine]\n");
    }

    // A foreign real file at the system path (not the default) is preserved via backup on enable.
    #[test]
    fn foreign_file_backed_up() {
        let root = scratch("foreign");
        let base = root.join("appdata");
        std::fs::create_dir_all(&base).unwrap();
        let system = root.join("system/rclone/rclone.conf");
        write(&system, "[foreign]\n");
        let app_cfg = base.join("configs/default/rclone.conf");
        write(&app_cfg, "[app]\n");

        let st = apply_config_sync(
            &system,
            &base,
            true,
            app_cfg.to_str().unwrap(),
            None,
            Some("/some/other/path/rclone.conf"),
        )
        .unwrap();
        let backup = st.backup_path.expect("foreign file backed up");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "[foreign]\n");
        assert!(
            !st.default_backed_up,
            "not the default → no relocation flag"
        );
        assert!(is_symlink(&system));
        assert_eq!(std::fs::read_to_string(&system).unwrap(), "[app]\n");
    }

    // Ownership is proven by the target marker. A link whose target equals our recorded
    // marker is treated as ours even if a user hand-made an identical link — because removing it on
    // disable is exactly the requested end state (no link at the system path), the outcome is correct
    // either way. (Contrast user_symlink_*: a link to a DIFFERENT target, or with no marker, is never
    // ours and is preserved.)
    #[test]
    fn link_matching_marker_is_ours() {
        let root = scratch("marker_owns");
        let base = root.join("appdata");
        std::fs::create_dir_all(&base).unwrap();
        let system = root.join("system/rclone/rclone.conf");
        let app_cfg = base.join("configs/default/rclone.conf");
        write(&app_cfg, "[app]\n");
        let app = app_cfg.to_str().unwrap();
        // A link at the system path pointing exactly at our marker target, created out-of-band.
        std::fs::create_dir_all(system.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&app_cfg, &system).unwrap();

        // With the marker == that target, it is ours (managed + enabled)...
        let st = config_sync_status(&system, app, Some(app)).unwrap();
        assert!(
            st.managed && st.enabled,
            "a link to our exact marker target is ours"
        );
        // ...and disable removes it — the requested end state (no link), regardless of who made it.
        let st2 = apply_config_sync(&system, &base, false, app, Some(app), None).unwrap();
        assert!(
            !is_symlink(&system) && !st2.managed,
            "disable clears a link matching our marker"
        );
    }

    // A DANGLING symlink sitting at the first relocation candidate must be treated as
    // occupied. exists() follows the link (missing target → "free"), which would make materialize_copy
    // std::fs::copy THROUGH it and write outside app-data; symlink_metadata (lexists) counts it as
    // taken, so relocation picks the next free slot and writes a real file instead.
    #[test]
    fn relocation_skips_dangling_candidate() {
        let root = scratch("reloc_dangling");
        let base = root.join("appdata");
        std::fs::create_dir_all(&base).unwrap();
        let candidate = base.join("configs/default-synced/rclone.conf");
        std::fs::create_dir_all(candidate.parent().unwrap()).unwrap();
        let orphan_target = base.join("missing/elsewhere.conf");
        std::os::unix::fs::symlink(&orphan_target, &candidate).unwrap();

        let system = root.join("system/rclone/rclone.conf");
        write(&system, "[defaultremote]\n");
        let work = base.join("configs/work/rclone.conf");
        write(&work, "[work]\n");

        let st = apply_config_sync(
            &system,
            &base,
            true,
            work.to_str().unwrap(),
            None,
            Some(system.to_str().unwrap()),
        )
        .unwrap();
        let relocated = st.backup_path.expect("relocated");
        assert_ne!(
            Path::new(&relocated),
            candidate.as_path(),
            "must not reuse the dangling candidate"
        );
        assert!(
            relocated.contains("default-synced.1"),
            "should skip to the next free slot, got {relocated}"
        );
        assert!(
            !is_symlink(Path::new(&relocated)),
            "relocated default must be a real file"
        );
        assert_eq!(
            std::fs::read_to_string(&relocated).unwrap(),
            "[defaultremote]\n"
        );
        // The dangling candidate and its (never-existent) target are untouched — nothing written through it.
        assert!(
            is_symlink(&candidate),
            "the dangling candidate link is left as-is"
        );
        assert!(
            !orphan_target.exists(),
            "must not have created the dangling link's target"
        );
    }

    // An active config that is itself a symlink resolving to the system path must be treated as
    // CIRCULAR on enable (not a manageable link). Installing system -> active would close a two-link
    // cycle (active -> system -> active) whose reads fail with ELOOP, breaking both the terminal and
    // the app. So enable is a no-op that leaves the real system file untouched. This can arise from a
    // dotfile setup (an adopted default config symlinked to ~/.config/rclone/rclone.conf), not only
    // deliberate sabotage.
    #[test]
    fn active_symlink_resolving_to_system_is_circular() {
        let root = scratch("active_symlink_cycle");
        let base = root.join("appdata");
        std::fs::create_dir_all(&base).unwrap();
        let system = root.join("system/rclone/rclone.conf");
        write(&system, "[native]\n");
        // An app config that is a symlink pointing at the system path.
        let app_cfg = base.join("configs/aliased/rclone.conf");
        std::fs::create_dir_all(app_cfg.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&system, &app_cfg).unwrap();
        let app = app_cfg.to_str().unwrap();

        // Status: circular (enabled, unmanaged) — the walk reaches the system location.
        let st = config_sync_status(&system, app, None).unwrap();
        assert!(
            st.enabled && !st.managed,
            "an active symlink resolving to system is circular"
        );

        // Enable is a no-op: no link installed (would ELOOP), real system file untouched, no backup.
        let st2 = apply_config_sync(&system, &base, true, app, None, None).unwrap();
        assert!(
            !is_symlink(&system),
            "must NOT install a link over the system file (would ELOOP)"
        );
        assert_eq!(std::fs::read_to_string(&system).unwrap(), "[native]\n");
        assert!(st2.backup_path.is_none());
        assert!(st2.enabled && !st2.managed);
    }
}

// The supervisor decides restarts and crash backoff from the daemon's close event, so it takes
// that event as a typed value. These tests pin the typed delivery; the page-facing JSON sink is
// covered end-to-end by the streaming-command test.
#[cfg(all(test, unix))]
mod daemon_spawn_tests {
    use super::*;
    use crate::ctx::Events;
    use std::sync::mpsc;
    use std::time::Duration;

    fn ctx() -> Ctx {
        let root = std::env::temp_dir().join(format!("rcloneui-daemon-{}", std::process::id()));
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
