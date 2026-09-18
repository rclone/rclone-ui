//! Binding the listener. After a relaunch the previous process can still hold the port for a
//! moment, so the bind is retried before it is called a failure.

use std::net::SocketAddr;
use std::time::Duration;

use tokio::net::TcpListener;

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
