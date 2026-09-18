//! Portable one-off commands that used to live in src-tauri's lib.rs: machine facts, control of
//! stray rclone processes, archive extraction, proxy probing, and the cloudflared tunnel.

use sysinfo::System;

use crate::ctx::Ctx;
use crate::platform::{self, kill_pid};

pub fn get_arch(_ctx: &Ctx) -> Result<String, String> {
    Ok(match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        "i386" => "386",
        _ => "unknown",
    }
    .to_string())
}

pub fn is_flatpak(_ctx: &Ctx) -> Result<bool, String> {
    Ok(platform::is_flatpak())
}

pub fn is_linux_mint(_ctx: &Ctx) -> Result<bool, String> {
    Ok(platform::is_linux_mint())
}

pub fn has_flatpak_permissions(_ctx: &Ctx) -> Result<bool, String> {
    Ok(platform::has_flatpak_permissions())
}

/// With a port: is anything listening on it (v4 or v6 loopback)? Without: is any process named
/// rclone running?
pub fn is_rclone_running(_ctx: &Ctx, port: Option<u16>) -> Result<bool, String> {
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
                return Ok(true);
            }
        }

        return Ok(false);
    }

    let system = System::new_all();
    for (_pid, process) in system.processes() {
        let lower = process.name().to_ascii_lowercase();
        if lower == "rclone" || lower == "rclone.exe" {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Terminates every process named rclone on the machine; returns how many were stopped.
pub fn stop_rclone_processes(_ctx: &Ctx, timeout_ms: Option<u64>) -> Result<u32, String> {
    let timeout = timeout_ms.unwrap_or(5000);

    let system = System::new_all();
    let mut pids: Vec<u32> = Vec::new();
    for (pid, process) in system.processes() {
        let name_lower = process.name().to_ascii_lowercase();
        if name_lower == "rclone" || name_lower == "rclone.exe" {
            pids.push(pid.as_u32());
        }
    }

    let mut stopped: u32 = 0;
    for pid in pids {
        if kill_pid(pid, Some(timeout)).is_ok() {
            stopped += 1;
        }
    }

    Ok(stopped)
}

pub fn extract_tgz(_ctx: &Ctx, tgz_path: String, output_folder: String) -> Result<(), String> {
    use flate2::read::GzDecoder;
    use std::fs::File;
    use tar::Archive;

    let file = File::open(&tgz_path).map_err(|e| e.to_string())?;
    let tar = GzDecoder::new(file);
    let mut archive = Archive::new(tar);

    std::fs::create_dir_all(&output_folder).map_err(|e| e.to_string())?;

    archive.set_preserve_permissions(true);
    archive.unpack(&output_folder).map_err(|e| e.to_string())?;

    Ok(())
}

pub async fn test_proxy_connection(_ctx: &Ctx, proxy_url: String) -> Result<String, String> {
    use std::time::Duration;

    let proxy_url = proxy_url.trim();
    if proxy_url.is_empty() {
        return Err("Proxy URL cannot be empty".to_string());
    }

    let proxy = reqwest::Proxy::all(proxy_url).map_err(|e| format!("Invalid proxy URL: {}", e))?;
    let client = reqwest::Client::builder()
        .proxy(proxy)
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    // One endpoint: every extra fallback is another 10 s a broken proxy costs the caller.
    const PROBE_URL: &str = "https://www.cloudflare.com/cdn-cgi/trace";
    let response = client
        .get(PROBE_URL)
        .send()
        .await
        .map_err(|e| format!("Request to {} failed: {}", PROBE_URL, e))?;
    if !response.status().is_success() {
        return Err(format!(
            "{} responded with status {}",
            PROBE_URL,
            response.status()
        ));
    }
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response from {}: {}", PROBE_URL, e))?;
    Ok(format!(
        "Connected via proxy. Endpoint: {}. Snippet: {}",
        PROBE_URL,
        body.chars().take(200).collect::<String>()
    ))
}

/// Starts a `cloudflared` quick tunnel to the local RC port and returns `(pid, public url)`.
/// Blocks up to 15 s waiting for the URL to appear on cloudflared's stderr.
/// `target_url` is the RC daemon to expose (the managed daemon's loopback address).
pub fn start_cloudflared_tunnel(ctx: &Ctx, target_url: &str) -> Result<(u32, String), String> {
    use std::io::{BufRead, BufReader};
    use std::process::{Command as SysCommand, Stdio};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    #[cfg(target_os = "windows")]
    let binary_name = "cloudflared.exe";
    #[cfg(not(target_os = "windows"))]
    let binary_name = "cloudflared";

    let cloudflared_path = ctx.dirs.root.join(binary_name);

    if !cloudflared_path.exists() {
        return Err("Cloudflared binary not found".to_string());
    }

    let mut child = SysCommand::new(&cloudflared_path)
        // keep in sync with RC_PORT in lib/hosts.ts
        .args(["tunnel", "--url", target_url])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start cloudflared: {}", e))?;

    let pid = child.id();
    let tunnel_url = Arc::new(Mutex::new(String::new()));
    let tunnel_url_clone = Arc::clone(&tunnel_url);

    // cloudflared prints the public URL on stderr.
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                if line.contains("trycloudflare.com") {
                    if let Some(start) = line.find("https://") {
                        let url = match line[start..].find(char::is_whitespace) {
                            Some(end) => &line[start..start + end],
                            None => &line[start..],
                        };
                        let mut tunnel_url = tunnel_url_clone.lock().unwrap();
                        *tunnel_url = url.to_string();
                    }
                }
            }
        });
    }

    for _ in 0..150 {
        thread::sleep(Duration::from_millis(100));
        let url = tunnel_url.lock().unwrap();
        if !url.is_empty() {
            return Ok((pid, url.clone()));
        }
    }

    let _ = kill_pid(pid, Some(2000));
    Err("Failed to get tunnel URL from cloudflared".to_string())
}

pub fn stop_cloudflared_tunnel(_ctx: &Ctx, pid: u32) -> Result<(), String> {
    use std::time::Duration;

    // Cloudflared takes ~5s to gracefully shut down, so give it enough time
    match kill_pid(pid, Some(6000)) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Wait a bit for the process to fully terminate
            std::thread::sleep(Duration::from_millis(200));

            // Even if we get an error, the process might have stopped
            // Check one more time if the process is actually gone
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            {
                let alive = std::process::Command::new("kill")
                    .args(["-0", &pid.to_string()])
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);

                if !alive {
                    return Ok(());
                }
            }

            #[cfg(target_os = "windows")]
            {
                let output = std::process::Command::new("tasklist")
                    .args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
                    .output();

                if let Ok(output) = output {
                    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                    if stdout.trim().is_empty()
                        || stdout.contains("No tasks are running")
                        || !stdout.contains(&pid.to_string())
                    {
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
