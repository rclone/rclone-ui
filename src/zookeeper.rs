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

    #[cfg(target_os = "macos")]
    {
        let pointer_canon = canonical(&pointer);
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
        let pointer_canon = canonical(&pointer);
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

    #[cfg(target_os = "macos")]
    {
        macos_set_link(enable, &pointer.to_string_lossy())?;
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
        let _ = (enable, &pointer);
        return Err("PATH integration not supported on this platform".to_string());
    }

    get_rclone_path_integration(ctx)
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
#[cfg(target_os = "macos")]
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

    /// Where the pages keep their event catalog, whichever way round the tree is: the desktop
    /// keeps the frontend at the repo root (this crate is `src-server/`), the server keeps it in
    /// `frontend/` (this crate is the root). Tried in order, and a miss is a failure rather than
    /// a skip — quietly finding nothing to check is how an undeclared event would get through.
    fn events_ts() -> String {
        const CANDIDATES: [&str; 3] = [
            "/frontend/lib/api/events.ts",
            "/../lib/api/events.ts",
            "/lib/api/events.ts",
        ];
        let root = env!("CARGO_MANIFEST_DIR");
        for relative in CANDIDATES {
            if let Ok(text) = std::fs::read_to_string(format!("{}{}", root, relative)) {
                return text;
            }
        }
        panic!(
            "lib/api/events.ts not found from {} — tried {:?}. The frontend has moved; teach this \
             test where it went rather than deleting it.",
            root, CANDIDATES
        );
    }

    /// The Binary settings page renders the download bar from these events: an emitted name the
    /// page never subscribed to leaves the bar indeterminate for the whole download.
    #[test]
    fn download_events_are_declared_in_events_ts() {
        let events_ts = events_ts();
        for name in [DOWNLOAD_PROGRESS_EVENT, DOWNLOAD_FINISHED_EVENT] {
            assert!(
                events_ts.contains(&format!("'{}':", name)),
                "{} is emitted but not declared in lib/api/events.ts",
                name
            );
        }
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
