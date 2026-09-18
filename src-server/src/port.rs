//! The embedded server's port. Web storage (the react-query cache, zustand's non-persisted
//! bits, the theme guard) is keyed by origin, so the port has to be stable across launches:
//! it is derived from the data directory, with `127.0.0.1:0` as the fallback when something
//! else holds it (costing only a cold cache).

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::path::Path;
use std::time::Duration;

use tokio::net::TcpListener;

const RANGE_START: u16 = 20000;
const RANGE_SIZE: u32 = 20000;

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// `20000 + hash(data dir) % 20000`.
pub fn deterministic_port(root: &Path) -> u16 {
    let hash = fnv1a(root.to_string_lossy().as_bytes());
    RANGE_START + (hash % RANGE_SIZE as u64) as u16
}

/// Binds the deterministic port for the data directory, retrying briefly (a relaunch's
/// predecessor may still hold it), then falls back to an ephemeral loopback port.
pub async fn bind_for(root: &Path) -> Result<TcpListener, String> {
    let preferred = SocketAddr::V4(SocketAddrV4::new(
        Ipv4Addr::LOCALHOST,
        deterministic_port(root),
    ));
    match bind_with_retry(preferred, 10, Duration::from_millis(300)).await {
        Ok(listener) => Ok(listener),
        Err(e) => {
            log::warn!(
                "port {} unavailable ({}); using an ephemeral port",
                preferred,
                e
            );
            TcpListener::bind(SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)))
                .await
                .map_err(|e| format!("failed to bind a loopback port: {}", e))
        }
    }
}

/// Binds `addr`, retrying on `AddrInUse` (the previous process of a relaunch).
pub async fn bind_with_retry(
    addr: SocketAddr,
    attempts: u32,
    delay: Duration,
) -> Result<TcpListener, String> {
    let mut attempt = 0;
    loop {
        match TcpListener::bind(addr).await {
            Ok(listener) => return Ok(listener),
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && attempt < attempts => {
                attempt += 1;
                tokio::time::sleep(delay).await;
            }
            Err(e) => return Err(format!("failed to bind {}: {}", addr, e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_is_stable_and_in_range() {
        let a = deterministic_port(Path::new("/home/user/.local/share/com.rclone.ui"));
        let b = deterministic_port(Path::new("/home/user/.local/share/com.rclone.ui"));
        assert_eq!(a, b);
        assert!(a >= RANGE_START);
        assert!((a as u32) < RANGE_START as u32 + RANGE_SIZE);
        assert_ne!(a, deterministic_port(Path::new("/tmp/other")));
    }
}
