use machine_uid;
use sentry;
use std::fs;
use sysinfo::System;
use tauri::{AppHandle, Manager};
use tauri_plugin_sentry;
use tinyfiledialogs as tfd;

#[path = "../common/shortcut.rs"]
mod shortcut;

#[path = "../common/window.rs"]
mod window;

#[cfg(target_os = "linux")]
mod jenky;
mod local_fs;
mod media;
mod notifications;
mod rc_session;
mod scheduler;
mod zookeeper;

/// Entry point for the headless `run-task` mode (see main.rs). Never touches tauri::Builder.
pub fn run_scheduled_task(
    task_id: &str,
    host_id: &str,
    forced: bool,
    data_dir: Option<&str>,
    local_data_dir: Option<&str>,
) -> i32 {
    scheduler::runner::run(task_id, host_id, forced, data_dir, local_data_dir)
}

use shortcut::{
    ensure_toolbar_window, set_toolbar_shortcut, show_toolbar_window, DEFAULT_TOOLBAR_SHORTCUT,
};

use window::{lock_windows, open_full_window, open_small_window, open_window, unlock_windows};

#[tauri::command]
fn update_toolbar_shortcut(app_handle: AppHandle, shortcut: Option<String>) -> Result<(), String> {
    set_toolbar_shortcut(&app_handle, shortcut.as_deref())
}

#[tauri::command]
fn show_toolbar(app_handle: AppHandle) -> Result<(), String> {
    show_toolbar_window(&app_handle).map_err(|e| e.to_string())
}

#[tauri::command]
fn is_flatpak() -> bool {
    std::path::Path::new("/.flatpak-info").exists() || std::env::var_os("FLATPAK_ID").is_some()
}

#[tauri::command]
fn is_linux_mint() -> bool {
    #[cfg(not(target_os = "linux"))]
    {
        false
    }

    #[cfg(target_os = "linux")]
    {
        let paths: &[&str] = if is_flatpak() {
            &["/run/host/os-release", "/etc/os-release", "/usr/lib/os-release"]
        } else {
            &["/etc/os-release", "/usr/lib/os-release"]
        };

        for path in paths {
            if let Ok(contents) = std::fs::read_to_string(path) {
                return contents.lines().any(|line| {
                    let line = line.trim();
                    line == "ID=linuxmint" || line == "ID=\"linuxmint\""
                });
            }
        }

        false
    }
}

/// The single Flatpak permission gate: the app quits at startup unless it holds BOTH writable
/// host filesystem access (rclone needs it) AND host-spawn access (the scheduler needs it). This
/// all-or-nothing check is why no other Flatpak permission checks exist elsewhere — any running
/// instance is guaranteed to have full permissions.
#[tauri::command]
fn has_flatpak_permissions() -> bool {
    if !is_flatpak() {
        return true;
    }
    has_host_filesystem() && flatpak_can_spawn_host()
}

fn has_host_filesystem() -> bool {
    let Ok(contents) = std::fs::read_to_string("/.flatpak-info") else {
        return false;
    };

    let mut in_context = false;

    for line in contents.lines() {
        let line = line.trim();

        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        if line.starts_with('[') && line.ends_with(']') {
            in_context = line == "[Context]";
            continue;
        }

        if !in_context {
            continue;
        }

        let Some((key, value)) = line.split_once('=') else {
            continue;
        };

        if key.trim() != "filesystems" {
            continue;
        }

        for raw in value.split(';') {
            let item = raw.trim();

            if item.is_empty() {
                continue;
            }

            // Explicit negative override, e.g. !host
            if item == "!host" || item.starts_with("!host:") {
                return false;
            }

            // Writable host access
            if item == "host" || item == "host:rw" || item == "host:create" {
                return true;
            }

            // Read-only host access is not enough for full rclone filesystem usage
            if item == "host:ro" {
                return false;
            }
        }
    }

    false
}

/// Whether the sandbox can spawn processes on the host (`flatpak-spawn --host`), which the
/// scheduler needs to register OS cron jobs. Always true off Flatpak. Granted by
/// `--talk-name=org.freedesktop.Flatpak`, which appears in /.flatpak-info under
/// `[Session Bus Policy]` as `org.freedesktop.Flatpak=talk` (or `own`).
pub(crate) fn flatpak_can_spawn_host() -> bool {
    if !is_flatpak() {
        return true;
    }
    let Ok(contents) = std::fs::read_to_string("/.flatpak-info") else {
        return false;
    };
    flatpak_info_grants_host_spawn(&contents)
}

/// True when the parsed /.flatpak-info grants `org.freedesktop.Flatpak` in `[Session Bus Policy]`.
fn flatpak_info_grants_host_spawn(contents: &str) -> bool {
    let mut in_session_bus = false;
    for line in contents.lines() {
        let line = line.trim();

        if line.starts_with('[') && line.ends_with(']') {
            in_session_bus = line == "[Session Bus Policy]";
            continue;
        }

        if !in_session_bus {
            continue;
        }

        if let Some((key, value)) = line.split_once('=') {
            if key.trim() == "org.freedesktop.Flatpak" {
                let policy = value.trim();
                return policy == "talk" || policy == "own";
            }
        }
    }

    false
}

#[cfg(test)]
mod flatpak_tests {
    use super::flatpak_info_grants_host_spawn;

    #[test]
    fn detects_granted_talk_permission() {
        let info = "[Application]\nname=com.rcloneui.RcloneUI\n\n[Session Bus Policy]\norg.freedesktop.Flatpak=talk\norg.freedesktop.Notifications=talk\n";
        assert!(flatpak_info_grants_host_spawn(info));
    }

    #[test]
    fn own_policy_also_counts() {
        let info = "[Session Bus Policy]\norg.freedesktop.Flatpak=own\n";
        assert!(flatpak_info_grants_host_spawn(info));
    }

    #[test]
    fn absent_or_other_sections_do_not_count() {
        // Permission not listed at all.
        let info = "[Session Bus Policy]\norg.freedesktop.Notifications=talk\n";
        assert!(!flatpak_info_grants_host_spawn(info));
        // Same key but in a different section must not match.
        let wrong_section = "[System Bus Policy]\norg.freedesktop.Flatpak=talk\n";
        assert!(!flatpak_info_grants_host_spawn(wrong_section));
        // Explicit 'none' policy.
        let none = "[Session Bus Policy]\norg.freedesktop.Flatpak=none\n";
        assert!(!flatpak_info_grants_host_spawn(none));
    }
}

pub(crate) async fn kill_pid(pid: u32, timeout_ms: Option<u64>) -> Result<(), String> {
    let timeout = timeout_ms.unwrap_or(5000);

    #[cfg(any(
        target_os = "macos",
        target_os = "linux",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd"
    ))]
    {
        use std::time::{Duration, Instant};

        let pid_str = pid.to_string();

        // Try graceful termination first
        let _ = std::process::Command::new("kill")
            .args(&["-TERM", &pid_str])
            .status();

        let deadline = Instant::now() + Duration::from_millis(timeout);
        while Instant::now() < deadline {
            // Check if process still exists: kill -0 <pid>
            let alive = std::process::Command::new("kill")
                .args(&["-0", &pid_str])
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if !alive {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        // Force kill
        let _ = std::process::Command::new("kill")
            .args(&["-KILL", &pid_str])
            .status();

        // Final check (best effort)
        let alive = std::process::Command::new("kill")
            .args(&["-0", &pid_str])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if alive {
            return Err("Failed to terminate process".to_string());
        }

        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        use std::time::{Duration, Instant};

        let pid_str = pid.to_string();

        let _ = std::process::Command::new("taskkill")
            .args(&["/PID", &pid_str, "/F", "/T"])
            .status();

        let output = std::process::Command::new("tasklist")
            .args(&["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
            .output()
            .map_err(|e| e.to_string())?;
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        if !stdout.trim().is_empty()
            && stdout.contains(&pid_str)
            && !stdout.contains("No tasks are running")
        {
            return Err("Failed to terminate process".to_string());
        }

        return Ok(());
    }

    #[cfg(not(any(
        target_os = "macos",
        target_os = "linux",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd",
        target_os = "windows"
    )))]
    {
        Err("Unsupported platform".to_string())
    }
}

#[tauri::command]
fn get_arch() -> String {
    let arch = std::env::consts::ARCH;

    match arch {
        "aarch64" => "arm64".to_string(),
        "x86_64" => "amd64".to_string(),
        "i386" => "386".to_string(),
        _ => "unknown".to_string(),
    }
}

#[tauri::command]
fn get_uid() -> String {
    return machine_uid::get().unwrap();
}

#[tauri::command]
fn is_rclone_running(port: Option<u16>) -> bool {
    if let Some(port) = port {
        use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
        use std::time::Duration;

        let timeout = Duration::from_millis(200);
        let addrs = [
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
            SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port),
        ];

        for addr in addrs.iter() {
            if let Ok(stream) = TcpStream::connect_timeout(addr, timeout) {
                drop(stream);
                return true;
            }
        }

        return false;
    }

    let system = System::new_all();
    for (_pid, process) in system.processes() {
        let name = process.name();
        let lower = name.to_ascii_lowercase();
        if lower == "rclone" || lower == "rclone.exe" {
            return true;
        }
    }
    false
}

#[tauri::command]
async fn stop_rclone_processes(timeout_ms: Option<u64>) -> Result<u32, String> {
    let timeout = timeout_ms.unwrap_or(5000);

    let system = System::new_all();

    // Collect PIDs first to avoid holding references across await points
    let mut pids: Vec<u32> = Vec::new();
    for (pid, process) in system.processes() {
        let name_lower = process.name().to_ascii_lowercase();
        if name_lower == "rclone" || name_lower == "rclone.exe" {
            pids.push(pid.as_u32());
        }
    }

    let mut stopped: u32 = 0;
    for pid in pids {
        match kill_pid(pid, Some(timeout)).await {
            Ok(()) => stopped += 1,
            Err(_e) => {}
        }
    }

    Ok(stopped)
}

async fn prompt_text(
    title: String,
    message: String,
    default: Option<String>,
    sensitive: Option<bool>,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;

        let default_value = default.unwrap_or_default();
        let is_sensitive = sensitive.unwrap_or(false);

        // AppleScript string literals can't contain a raw newline, so a multi-line message (e.g. a
        // numbered choice list) must have its newlines turned into the `\n` escape sequence. Escape
        // backslashes and quotes first so the conversions don't collide.
        let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
        let esc_message = esc(&message)
            .replace("\r\n", "\\n")
            .replace('\n', "\\n")
            .replace('\r', "\\n");
        let esc_title = esc(&title);
        let esc_default = esc(&default_value);

        let script = if is_sensitive {
            format!(
                r#"display dialog "{}" with title "{}" default answer "{}" with hidden answer"#,
                esc_message, esc_title, esc_default,
            )
        } else {
            format!(
                r#"display dialog "{}" with title "{}" default answer "{}""#,
                esc_message, esc_title, esc_default,
            )
        };

        let output = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .map_err(|e| e.to_string())?;

        let pid = std::process::id();
        let _ = Command::new("osascript")
            .arg("-e")
            .arg(format!(
                "tell application \"System Events\" to set frontmost of (first process whose unix id is {}) to true",
                pid
            ))
            .output();

        if output.status.success() {
            let result = String::from_utf8_lossy(&output.stdout);
            // Parse AppleScript result: "text returned:VALUE, button returned:OK"
            if let Some(text_part) = result.split("text returned:").nth(1) {
                if let Some(value) = text_part.split(", button returned:").next() {
                    return Ok(Some(value.trim().to_string()));
                }
            }
        }

        return Ok(None);
    }

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;

        let default_value = default.unwrap_or_default();
        let is_sensitive = sensitive.unwrap_or(false);

        // Use PowerShell to create a simple text input dialog. PowerShell single-quoted strings keep
        // literal newlines, so a multi-line message (e.g. a numbered choice list) renders across
        // lines in the label — we just have to grow the label/form to fit its line count.
        let ps_default = default_value.replace('\'', "''");
        let ps_title = title.replace('\'', "''");
        let ps_message = message.replace('\'', "''");
        let ps_password_flag = if is_sensitive { "$true" } else { "$false" };

        let line_count = message.lines().count().max(1) as i32;
        let label_height = (line_count * 18 + 8).clamp(40, 380);
        let textbox_y = 15 + label_height + 8;
        let button_y = textbox_y + 34;
        let form_height = button_y + 70;

        let powershell_script = format!(
            r#"
            Add-Type -AssemblyName System.Windows.Forms
            Add-Type -AssemblyName System.Drawing

            $form = New-Object System.Windows.Forms.Form
            $form.Text = '{title}'
            $form.Size = New-Object System.Drawing.Size(350, {form_height})
            $form.StartPosition = 'CenterScreen'
            $form.FormBorderStyle = 'FixedDialog'
            $form.MaximizeBox = $false
            $form.MinimizeBox = $false
            $form.TopMost = $true

            $label = New-Object System.Windows.Forms.Label
            $label.Location = New-Object System.Drawing.Point(10, 15)
            $label.Size = New-Object System.Drawing.Size(320, {label_height})
            $label.Text = '{message}'
            $form.Controls.Add($label)

            $textBox = New-Object System.Windows.Forms.TextBox
            $textBox.Location = New-Object System.Drawing.Point(10, {textbox_y})
            $textBox.Size = New-Object System.Drawing.Size(320, 20)
            $textBox.Text = '{default}'
            $textBox.UseSystemPasswordChar = {password}
            $form.Controls.Add($textBox)

            $okButton = New-Object System.Windows.Forms.Button
            $okButton.Location = New-Object System.Drawing.Point(175, {button_y})
            $okButton.Size = New-Object System.Drawing.Size(75, 23)
            $okButton.Text = 'OK'
            $okButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
            $form.AcceptButton = $okButton
            $form.Controls.Add($okButton)

            $cancelButton = New-Object System.Windows.Forms.Button
            $cancelButton.Location = New-Object System.Drawing.Point(255, {button_y})
            $cancelButton.Size = New-Object System.Drawing.Size(75, 23)
            $cancelButton.Text = 'Cancel'
            $cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
            $form.CancelButton = $cancelButton
            $form.Controls.Add($cancelButton)

            $form.Add_Shown({{$textBox.Select()}})
            $result = $form.ShowDialog()

            if ($result -eq [System.Windows.Forms.DialogResult]::OK) {{
                $textBox.Text
            }}
            "#,
            title = ps_title,
            message = ps_message,
            default = ps_default,
            password = ps_password_flag,
            form_height = form_height,
            label_height = label_height,
            textbox_y = textbox_y,
            button_y = button_y,
        );

        let output = Command::new("powershell")
            .args(&[
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &powershell_script,
            ])
            .output()
            .map_err(|e| e.to_string())?;

        if output.status.success() {
            let result = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !result.is_empty() || !default_value.is_empty() {
                return Ok(Some(result));
            }
        }

        return Ok(None);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("Text input not supported on this platform".to_string())
    }
}

async fn tiny_prompt_text(
    title: String,
    message: String,
    default: Option<String>,
    sensitive: Option<bool>,
) -> Result<Option<String>, String> {
    let is_sensitive = sensitive.unwrap_or(false);
    let default_value = default.unwrap_or_default();
    let title_clone = title.clone();
    let message_clone = message.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        if is_sensitive {
            tfd::password_box(&title_clone, &message_clone)
        } else {
            tfd::input_box(&title_clone, &message_clone, &default_value)
        }
    })
    .await
    .map_err(|error| error.to_string())?;

    Ok(result)
}

#[tauri::command]
async fn prompt(
    title: String,
    message: String,
    default: Option<String>,
    sensitive: Option<bool>,
) -> Result<Option<String>, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        prompt_text(title, message, default, sensitive).await
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        tiny_prompt_text(title, message, default, sensitive).await
    }
}

#[tauri::command]
async fn start_cloudflared_tunnel(app: tauri::AppHandle) -> Result<(u32, String), String> {
    use std::io::{BufRead, BufReader};
    use std::process::{Command as SysCommand, Stdio};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    // Get the binary path
    let app_local_data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to get app local data directory: {}", e))?;

    #[cfg(target_os = "windows")]
    let binary_name = "cloudflared.exe";
    #[cfg(not(target_os = "windows"))]
    let binary_name = "cloudflared";

    let cloudflared_path = app_local_data_dir.join(binary_name);

    if !cloudflared_path.exists() {
        return Err("Cloudflared binary not found".to_string());
    }

    // Start cloudflared tunnel
    let mut child = SysCommand::new(&cloudflared_path)
        // keep in sync with RC_PORT in lib/hosts.ts
        .args(&["tunnel", "--url", "http://localhost:5572"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start cloudflared: {}", e))?;

    let pid = child.id();
    let tunnel_url = Arc::new(Mutex::new(String::new()));
    let tunnel_url_clone = Arc::clone(&tunnel_url);

    // Read stdout to extract tunnel URL
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                if line.contains("trycloudflare.com") {
                    // Extract the URL from the line
                    if let Some(start) = line.find("https://") {
                        if let Some(end) = line[start..].find(char::is_whitespace) {
                            let url = &line[start..start + end];
                            let mut tunnel_url = tunnel_url_clone.lock().unwrap();
                            *tunnel_url = url.to_string();
                        } else {
                            let url = &line[start..];
                            let mut tunnel_url = tunnel_url_clone.lock().unwrap();
                            *tunnel_url = url.to_string();
                        }
                    }
                }
            }
        });
    }

    // Wait for tunnel URL (max 15 seconds)
    for _ in 0..150 {
        thread::sleep(Duration::from_millis(100));
        let url = tunnel_url.lock().unwrap();
        if !url.is_empty() {
            return Ok((pid, url.clone()));
        }
    }

    // If we didn't get a URL, kill the process and return error
    let _ = kill_pid(pid, Some(2000)).await;
    Err("Failed to get tunnel URL from cloudflared".to_string())
}

#[tauri::command]
async fn stop_cloudflared_tunnel(pid: u32) -> Result<(), String> {
    use std::time::Duration;

    // Cloudflared takes ~5s to gracefully shut down, so give it enough time
    match kill_pid(pid, Some(6000)).await {
        Ok(()) => Ok(()),
        Err(e) => {
            // Wait a bit for the process to fully terminate
            std::thread::sleep(Duration::from_millis(200));

            // Even if we get an error, the process might have stopped
            // Check one more time if the process is actually gone
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            {
                let alive = std::process::Command::new("kill")
                    .args(&["-0", &pid.to_string()])
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);

                if !alive {
                    // Process is gone, consider it a success
                    return Ok(());
                }
            }

            #[cfg(target_os = "windows")]
            {
                let output = std::process::Command::new("tasklist")
                    .args(&["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
                    .output();

                if let Ok(output) = output {
                    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                    if stdout.trim().is_empty()
                        || stdout.contains("No tasks are running")
                        || !stdout.contains(&pid.to_string())
                    {
                        // Process is gone, consider it a success
                        return Ok(());
                    }
                }
            }

            // As a last resort, check if a process with this PID is still a cloudflared process
            let system = System::new_all();
            let mut cloudflared_still_running = false;
            for (p, process) in system.processes() {
                if p.as_u32() == pid {
                    let name = process.name().to_string_lossy().to_lowercase();
                    if name.contains("cloudflared") {
                        cloudflared_still_running = true;
                    }
                    break;
                }
            }

            if !cloudflared_still_running {
                // PID either gone or reused by another process; treat as successfully stopped
                return Ok(());
            }

            Err(e)
        }
    }
}

#[tauri::command]
fn extract_tgz(tgz_path: &str, output_folder: &str) -> Result<(), String> {
    use flate2::read::GzDecoder;
    use std::fs::File;
    use tar::Archive;

    let file = File::open(tgz_path).map_err(|e| e.to_string())?;
    let tar = GzDecoder::new(file);
    let mut archive = Archive::new(tar);

    fs::create_dir_all(output_folder).map_err(|e| e.to_string())?;

    archive.set_preserve_permissions(true);
    archive.unpack(output_folder).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn test_proxy_connection(proxy_url: String) -> Result<String, String> {
    use std::time::Duration;

    // Validate
    let proxy_url = proxy_url.trim();
    if proxy_url.is_empty() {
        return Err("Proxy URL cannot be empty".to_string());
    }

    // Build client with proxy
    let proxy = reqwest::Proxy::all(proxy_url).map_err(|e| format!("Invalid proxy URL: {}", e))?;
    let client = reqwest::Client::builder()
        .proxy(proxy)
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    // Multiple fallback endpoints
    let candidates = [
        "https://httpbin.org/ip",
        "https://www.cloudflare.com/cdn-cgi/trace",
        "https://ifconfig.me/ip",
        "https://1.1.1.1/cdn-cgi/trace",
    ];

    let mut last_error: Option<String> = None;
    for url in candidates.iter() {
        match client.get(*url).send().await {
            Ok(resp) => {
                if resp.status().is_success() {
                    match resp.text().await {
                        Ok(body) => {
                            return Ok(format!(
                                "Connected via proxy. Endpoint: {}. Snippet: {}",
                                url,
                                body.chars().take(200).collect::<String>()
                            ))
                        }
                        Err(e) => {
                            last_error =
                                Some(format!("Failed to read response from {}: {}", url, e));
                            continue;
                        }
                    }
                } else {
                    last_error = Some(format!("{} responded with status {}", url, resp.status()));
                    continue;
                }
            }
            Err(e) => {
                last_error = Some(format!("Request to {} failed: {}", url, e));
                continue;
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "All proxy tests failed".to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let client = sentry::init((
        "https://7c7c55918ff850112780d2b2b29121a6@o4508503751983104.ingest.de.sentry.io/4508739164110928",
        sentry::ClientOptions {
            release: sentry::release_name!(),
            ..Default::default()
        },
    ));

    let _guard = tauri_plugin_sentry::minidump::init(&client);

    let mut builder = tauri::Builder::default();

    if !is_flatpak() {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                let _ = shortcut::show_toolbar_window(app);
            }));
    }

    #[cfg(target_os = "linux")]
    {
        builder = builder.plugin(jenky::init());
    }

    let mut app = builder
        .manage(local_fs::LocalFsState::default())
        .manage(rc_session::RcSession::new())
        .manage(media::MediaServer::default())
        .manage::<zookeeper::SharedDaemonState>(std::sync::Mutex::new(
            zookeeper::DaemonState::default(),
        ))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_sentry::init_with_no_injection(&client))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_prevent_default::debug())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_arch,
            get_uid,
            is_rclone_running,
            stop_rclone_processes,
            prompt,
            update_toolbar_shortcut,
            show_toolbar,
            test_proxy_connection,
            is_flatpak,
            is_linux_mint,
            has_flatpak_permissions,
            local_fs::list_local_directory,
            local_fs::cancel_local_directory,
            open_full_window,
            open_window,
            open_small_window,
            lock_windows,
            unlock_windows,
			start_cloudflared_tunnel,
			stop_cloudflared_tunnel,
			extract_tgz,
            zookeeper::exec_rclone,
            zookeeper::spawn_rclone,
            rc_session::rc_session,
            media::media_register,
            media::media_release,
            zookeeper::kill_rclone_daemon,
            zookeeper::validate_rclone_binary,
            zookeeper::rclone_config_path,
            zookeeper::find_system_rclone,
            zookeeper::classify_rclone_path,
            zookeeper::list_downloaded_rclone_versions,
            zookeeper::delete_rclone_version,
            zookeeper::adopt_legacy_rclone,
            zookeeper::managed_version_path,
            zookeeper::download_rclone_version,
            zookeeper::update_path_pointer,
            zookeeper::get_rclone_path_integration,
            zookeeper::set_rclone_path_integration,
            zookeeper::get_config_sync_status,
            zookeeper::set_config_sync,
            scheduler::scheduler_supported,
            scheduler::scheduler_validate_cron,
            scheduler::scheduler_register,
            scheduler::scheduler_unregister,
            scheduler::scheduler_set_enabled,
            scheduler::scheduler_run_now,
            scheduler::scheduler_status,
            scheduler::scheduler_read_history,
            scheduler::scheduler_read_log,
            scheduler::scheduler_unregister_all,
            scheduler::scheduler_sweep_orphans,
            notifications::notifications_catalog,
            notifications::notifications_list_targets,
            notifications::notifications_add_target,
            notifications::notifications_update_target,
            notifications::notifications_remove_target,
            notifications::notifications_dispatch,
            notifications::notifications_send_test
        ])
        .setup(|app| {
            #[cfg(target_os = "linux")]
            {
                // The quirk decided before the log plugin was live; restate it into the log file.
                log::info!("jenky: {}", jenky::summary());

                // Flatpak/Flathub sandbox typically cannot write to system desktop/mime locations.
                // Deep-link registration is best-effort; never fail app startup.
                if is_flatpak() {
                    log::info!("skipping deep-link registration in Flatpak/Flathub");
                } else {
					use tauri_plugin_deep_link::DeepLinkExt;
                    if let Err(err) = app.deep_link().register_all() {
                        log::warn!("deep-link registration failed (continuing): {}", err);
                    }
                }

                let cache_dir = app.path().cache_dir()?;
                let package_info = app.package_info();
                let app_name = package_info.name.as_str();
                let app_cache = cache_dir.join(app_name);
                if app_cache.exists() {
                    let _ = fs::remove_dir_all(&app_cache);
                }
            }

            #[cfg(windows)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(err) = app.deep_link().register_all() {
                    log::warn!("deep-link registration failed (continuing): {}", err);
                }
            }

            // Reclaim leftover .tmp-* download staging dirs from an interrupted download. Runs
            // once here (before any webview) so it can never race a live download.
            zookeeper::sweep_versions_tmp(app.handle());

            if let Err(err) = ensure_toolbar_window(&app.handle()) {
                log::warn!("failed to prepare toolbar window: {}", err);
            }
            if let Err(err) = set_toolbar_shortcut(&app.handle(), Some(DEFAULT_TOOLBAR_SHORTCUT)) {
                log::error!("failed to update default toolbar shortcut: {}", err);
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            zookeeper::kill_rclone_daemon_on_exit(app);
        }
    })
}
