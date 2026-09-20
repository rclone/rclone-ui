//! The HTTP clients this server builds, in one place: a timeout for one-shot requests to known
//! hosts, and the proxy of Settings › Rclone for what leaves through it. rclone's own client is
//! `rc.rs`; the streaming reverse proxy to the daemon is `rc_proxy.rs`.

use std::time::Duration;

use crate::state::ProxySettings;

const CONNECT: Duration = Duration::from_secs(10);

/// For requests whose whole exchange must be over within `timeout`.
pub fn client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(CONNECT)
        .timeout(timeout)
        .build()
        .unwrap_or_default()
}

/// For requests that take as long as they take (a reply the caller streams).
pub fn plain() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .unwrap_or_default()
}

/// [`client`] through the proxy of Settings › Rclone when one is set, its ignored hosts left alone.
pub fn proxied(proxy: Option<&ProxySettings>, timeout: Duration) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(CONNECT)
        .timeout(timeout);
    if let Some(proxy) = proxy.filter(|p| !p.url.trim().is_empty()) {
        let ignored = reqwest::NoProxy::from_string(&proxy.ignored_hosts.join(","));
        let proxy = reqwest::Proxy::all(proxy.url.trim())
            .map_err(|e| format!("invalid proxy: {}", e))?
            .no_proxy(ignored);
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|e| e.to_string())
}

/// One request through `proxy_url`, to say whether it works. One endpoint: every extra fallback
/// is another 10 s a broken proxy costs the caller.
pub async fn test_proxy_connection(proxy_url: &str) -> Result<String, String> {
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
