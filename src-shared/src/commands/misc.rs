//! Portable one-off commands that used to live in src-tauri's lib.rs: machine facts, control of
//! stray rclone processes, archive extraction and proxy probing.

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

