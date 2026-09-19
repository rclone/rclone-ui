//! A small async client for rclone's RC API, plus the ephemeral-port and credential helpers
//! the lifecycle uses to raise the daemon.

use std::time::Duration;
use std::time::SystemTime;

use serde_json::{json, Value};

/// A free local port for a daemon to listen on.
pub fn pick_port() -> Result<u16, String> {
    for _ in 0..10 {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
            .map_err(|e| format!("failed to allocate a port: {}", e))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        drop(listener);
        // Never collide with rclone's own default RC port: a daemon somebody else started is
        // listening there, and it is not ours to talk to.
        if port != 5572 {
            return Ok(port);
        }
    }
    Err("could not allocate a local port".to_string())
}

/// A throwaway credential: the daemon is on loopback, and this is what keeps anything else on
/// the machine from driving it.
pub fn random_token(salt: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(format!(
        "{:?}-{}-{}",
        SystemTime::now(),
        std::process::id(),
        salt
    ));
    hasher
        .finalize()
        .iter()
        .take(12)
        .map(|b| format!("{:02x}", b))
        .collect()
}

#[derive(Clone, Debug)]
pub struct RcClient {
    pub base: String,
    pub user: Option<String>,
    pub pass: Option<String>,
    client: reqwest::Client,
}

impl RcClient {
    pub fn new(base: impl Into<String>, user: Option<String>, pass: Option<String>) -> Self {
        RcClient {
            base: base.into().trim_end_matches('/').to_string(),
            user,
            pass,
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                // Listing a slow remote can legitimately take a while; rclone's own async
                // endpoints return immediately.
                .timeout(Duration::from_secs(300))
                .build()
                .unwrap_or_default(),
        }
    }

    /// POSTs `body` to `endpoint` (e.g. `/core/version`) and returns the JSON reply. rclone puts
    /// its error message in `error` with a non-2xx status.
    pub async fn call(&self, endpoint: &str, body: &Value) -> Result<Value, String> {
        self.call_with_timeout(endpoint, body, None).await
    }

    /// `call` with this one request bounded by `timeout` (readiness probes); `None` keeps the
    /// client's general 300 s.
    pub async fn call_with_timeout(
        &self,
        endpoint: &str,
        body: &Value,
        timeout: Option<Duration>,
    ) -> Result<Value, String> {
        let mut request = self
            .client
            .post(format!("{}{}", self.base, endpoint))
            .json(body);
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        if let Some(user) = &self.user {
            request = request.basic_auth(user, self.pass.as_deref());
        }
        let response = request.send().await.map_err(|e| e.to_string())?;
        let status = response.status();
        let text = response.text().await.map_err(|e| e.to_string())?;
        let value: Value = if text.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&text).map_err(|e| format!("invalid JSON from rclone: {}", e))?
        };
        if !status.is_success() {
            let message = value
                .get("error")
                .and_then(|e| e.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("status {}", status));
            return Err(message);
        }
        Ok(value)
    }

    /// Polls `/rc/noop` every 250 ms until the daemon answers, `is_dead` reports the process
    /// gone, or `timeout` passes.
    pub async fn wait_ready(
        &self,
        timeout: Duration,
        mut is_dead: impl FnMut() -> Option<String>,
    ) -> Result<(), String> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            if let Some(reason) = is_dead() {
                return Err(reason);
            }
            // Each probe is bounded by what is left of the budget: a process that accepts the
            // connection and stalls must not hold the loop for the general request timeout.
            let remaining = deadline
                .saturating_duration_since(std::time::Instant::now())
                .min(Duration::from_secs(5))
                .max(Duration::from_millis(100));
            if self
                .call_with_timeout("/rc/noop", &json!({}), Some(remaining))
                .await
                .is_ok()
            {
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                return Err(format!(
                    "rclone daemon did not become ready within {}s",
                    timeout.as_secs()
                ));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A daemon that accepts the connection and never answers must not hold readiness past its
    /// deadline (the general request timeout is 300 s).
    #[test]
    fn readiness_gives_up_on_a_stalled_daemon() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let mut held = Vec::new();
            for stream in listener.incoming().flatten() {
                held.push(stream);
            }
        });
        let client = RcClient::new(format!("http://{}", addr), None, None);
        let started = std::time::Instant::now();
        let result = crate::rt::block_on(client.wait_ready(Duration::from_secs(1), || None));
        assert!(result.is_err());
        assert!(
            started.elapsed() < Duration::from_secs(6),
            "readiness took {:?}",
            started.elapsed()
        );
    }
}
