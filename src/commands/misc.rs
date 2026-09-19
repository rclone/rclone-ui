//! Proxy probing.

use crate::ctx::Ctx;

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

