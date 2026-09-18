//! Self-update of the standalone server from the same `latest.json` manifest the desktop's
//! updater reads, under `server-<os>-<arch>` platform keys (published by the server release
//! workflow), with the same minisign signature check. The desktop shell installs its own
//! [`Updater`] (the Tauri updater plugin).

use std::sync::Mutex;
use std::time::Duration;

use crate::Sink;
use serde_json::{json, Value};

use crate::{UpdateInfo, Updater};

/// Written by release-server.yml: `platforms["server-<os>-<arch>"] = { url, signature }` for the
/// raw binaries, signed with the same minisign key as the desktop's installers.
const MANIFEST: &str =
    "https://github.com/rclone-ui/rclone-ui/releases/latest/download/server-latest.json";
/// tauri.conf.json `plugins.updater.pubkey` (base64 of the minisign public key file).
const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDIyNDFENEZGNjFDNTBGOEYKUldTUEQ4VmgvOVJCSWhVZmw0enhmcW1kWFk3TS9mMzBDRjVEZWdxKzQ5ZmRhTlYvT2gvdFNMbE8K";

#[derive(Clone)]
struct Pending {
    version: String,
    url: String,
    signature: String,
}

pub struct SelfUpdater;

static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

fn target() -> String {
    format!("server-{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())
}

/// Both trait methods run on the blocking pool, where waiting on the async client is fine.
fn block_on<F: std::future::Future>(fut: F) -> F::Output {
    crate::rt::block_on(fut)
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
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
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

impl Updater for SelfUpdater {
    fn check(&self) -> Result<Option<UpdateInfo>, String> {
        let http = client()?;
        let manifest: Value = block_on(async {
            http.get(MANIFEST)
                .header("accept", "application/json")
                .send()
                .await
                .map_err(|e| format!("could not fetch the update manifest: {}", e))?
                .json()
                .await
                .map_err(|e| format!("invalid update manifest: {}", e))
        })?;
        let current = env!("CARGO_PKG_VERSION");
        let version = manifest["version"]
            .as_str()
            .unwrap_or("")
            .trim_start_matches('v')
            .to_string();
        let platform = &manifest["platforms"][target()];
        if platform.is_null()
            || version.is_empty()
            || !crate::version::newer(&version, current)
        {
            *PENDING.lock().unwrap() = None;
            return Ok(None);
        }
        let (Some(url), Some(signature)) =
            (platform["url"].as_str(), platform["signature"].as_str())
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

    fn install(&self, progress: Sink<Value>) -> Result<(), String> {
        let pending = PENDING
            .lock()
            .unwrap()
            .clone()
            .ok_or("no update was checked")?;
        let http = client()?;
        let bytes = block_on(async {
            let mut response = http
                .get(&pending.url)
                .send()
                .await
                .map_err(|e| format!("download failed: {}", e))?;
            if !response.status().is_success() {
                return Err(format!("download failed (HTTP {})", response.status()));
            }
            let _ = progress.send(json!({ "event": "Started", "data": { "contentLength": response.content_length() } }));
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
                bytes.extend_from_slice(&chunk);
                let _ = progress
                    .send(json!({ "event": "Progress", "data": { "chunkLength": chunk.len() } }));
            }
            Ok::<Vec<u8>, String>(bytes)
        })?;
        verify(&bytes, &pending.signature)?;
        replace_current_exe(&bytes)?;
        log::info!(
            "installed rclone-ui-server {}; restart to run it",
            pending.version
        );
        let _ = progress.send(json!({ "event": "Finished" }));
        Ok(())
    }
}
