//! Self-update from the `cloud-latest.json` manifest the release workflow publishes, under
//! `cloud-<os>-<arch>` platform keys, with a minisign signature check.

use std::sync::Mutex;
use std::time::Duration;

use crate::bus::Bus;
use serde_json::{json, Value};

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub body: Option<String>,
    pub date: Option<String>,
}

/// Written by release.yml: `platforms["cloud-<os>-<arch>"] = { url, signature }` for the
/// raw binaries, each signed with minisign. Read from the rolling `cloud-latest` release and not
/// from `releases/latest`, which in this repository is the desktop app's.
const MANIFEST: &str =
    "https://github.com/rclone-ui/rclone-ui/releases/download/cloud-latest/cloud-latest.json";
/// Base64 of the minisign public key file.
const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDIyNDFENEZGNjFDNTBGOEYKUldTUEQ4VmgvOVJCSWhVZmw0enhmcW1kWFk3TS9mMzBDRjVEZWdxKzQ5ZmRhTlYvT2gvdFNMbE8K";

#[derive(Clone)]
struct Pending {
    version: String,
    url: String,
    signature: String,
}

static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

fn target() -> String {
    format!("cloud-{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

fn client() -> reqwest::Client {
    crate::http::client(Duration::from_secs(600))
}

fn verify(data: &[u8], signature_b64: &str) -> Result<(), String> {
    use base64::Engine;
    let engine = base64::engine::general_purpose::STANDARD;
    let pubkey_text = String::from_utf8(engine.decode(PUBKEY).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let sig_text = String::from_utf8(engine.decode(signature_b64).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let public_key = minisign_verify::PublicKey::decode(&pubkey_text)
        .map_err(|e| format!("bad public key: {}", e))?;
    let signature = minisign_verify::Signature::decode(&sig_text)
        .map_err(|e| format!("bad signature: {}", e))?;
    public_key
        .verify(data, &signature, false)
        .map_err(|e| format!("the update's signature did not verify: {}", e))
}

fn replace_current_exe(bytes: &[u8]) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let staged = exe.with_extension("update-new");
    let old = exe.with_extension("update-old");
    std::fs::write(&staged, bytes).map_err(|e| format!("could not write the update: {}", e))?;
    crate::fsutil::set_executable(&staged)?;
    let _ = std::fs::remove_file(&old);
    // A running executable can be renamed on every platform; the new file takes its path.
    std::fs::rename(&exe, &old)
        .map_err(|e| format!("could not move the current binary aside: {}", e))?;
    if let Err(e) = std::fs::rename(&staged, &exe) {
        let _ = std::fs::rename(&old, &exe);
        return Err(format!("could not install the update: {}", e));
    }
    let _ = std::fs::remove_file(&old);
    Ok(())
}

/// `None` = up to date.
pub async fn check() -> Result<Option<UpdateInfo>, String> {
    let manifest: Value = client()
        .get(MANIFEST)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("could not fetch the update manifest: {}", e))?
        .json()
        .await
        .map_err(|e| format!("invalid update manifest: {}", e))?;
    let current = env!("CARGO_PKG_VERSION");
    let version = manifest["version"]
        .as_str()
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();
    let platform = &manifest["platforms"][target()];
    if platform.is_null() || version.is_empty() || !crate::version::newer(&version, current) {
        *PENDING.lock().unwrap() = None;
        return Ok(None);
    }
    let (Some(url), Some(signature)) = (platform["url"].as_str(), platform["signature"].as_str())
    else {
        return Ok(None);
    };
    *PENDING.lock().unwrap() = Some(Pending {
        version: version.clone(),
        url: url.to_string(),
        signature: signature.to_string(),
    });
    Ok(Some(UpdateInfo {
        version,
        current_version: current.to_string(),
        body: manifest["notes"].as_str().map(|s| s.to_string()),
        date: manifest["pub_date"].as_str().map(|s| s.to_string()),
    }))
}

/// The bus event the page draws the download from: `{event:'Started'|'Progress'|'Finished', data}`.
/// An install is the server's, so every page may watch it.
pub const PROGRESS_EVENT: &str = "app.update.progress";

pub async fn install(bus: &Bus) -> Result<(), String> {
    let pending = PENDING
        .lock()
        .unwrap()
        .clone()
        .ok_or("no update was checked")?;
    let mut response = client()
        .get(&pending.url)
        .send()
        .await
        .map_err(|e| format!("download failed: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("download failed (HTTP {})", response.status()));
    }
    bus.publish(
        PROGRESS_EVENT,
        json!({ "event": "Started", "data": { "contentLength": response.content_length() } }),
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        bytes.extend_from_slice(&chunk);
        bus.publish(
            PROGRESS_EVENT,
            json!({ "event": "Progress", "data": { "chunkLength": chunk.len() } }),
        );
    }
    verify(&bytes, &pending.signature)?;
    replace_current_exe(&bytes)?;
    log::info!(
        "installed rclone-cloud {}; restart to run it",
        pending.version
    );
    bus.publish(PROGRESS_EVENT, json!({ "event": "Finished" }));
    Ok(())
}
