//! License validation at boot (main.ts `validateInstance` + lib/license.ts `validateLicense`)
//! and the free-tier cap on notification targets (lib/notifications.ts
//! `reconcileNotificationTargets`). Same endpoint and machine id as the desktop.

use std::time::Duration;

use serde_json::{json, Value};

use crate::commands::misc;
use crate::ctx::Ctx;
use crate::notifications::targets;
use crate::rt;
use crate::scheduler::storeread;
use crate::state_files::{StateStore, APP_DOC};

const FREE_MAX_TARGETS: usize = 5;

fn persist_valid(store: &StateStore, valid: bool) {
    if let Err(e) = store.update(APP_DOC, |s| {
        s.insert("licenseValid".into(), Value::Bool(valid));
    }) {
        log::warn!("[license] could not persist licenseValid: {}", e);
    }
}

pub async fn validate(ctx: &Ctx, license_key: &str) -> Result<bool, String> {
    let id = misc::get_uid(ctx)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let response: Value = client
        .post("https://rcloneui.com/api/v2/validate")
        .json(&json!({ "licenseKey": license_key, "id": id, "platform": std::env::consts::OS }))
        .send()
        .await
        .map_err(|e| format!("failed to validate license: {}", e))?
        .json()
        .await
        .map_err(|e| format!("failed to validate license: {}", e))?;
    if let Some(error) = response["error"].as_str().filter(|e| !e.is_empty()) {
        return Err(error.to_string());
    }
    Ok(response["valid"].as_bool().unwrap_or(false))
}

/// lib/license.ts `revokeMachineLicense`: frees this machine's seat.
pub async fn revoke(ctx: &Ctx, license_key: &str) -> Result<bool, String> {
    let id = misc::get_uid(ctx)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let response: Value = client
        .post("https://rcloneui.com/api/v1/revoke")
        .json(&json!({ "licenseKey": license_key, "id": id }))
        .send()
        .await
        .map_err(|e| format!("failed to revoke license: {}", e))?
        .json()
        .await
        .map_err(|e| format!("failed to revoke license: {}", e))?;
    if let Some(error) = response["error"].as_str().filter(|e| !e.is_empty()) {
        return Err(error.to_string());
    }
    Ok(response["revoked"].as_bool().unwrap_or(false))
}

/// Persists the outcome of a page-initiated validation (the License section).
pub fn persist(store: &StateStore, license_key: Option<&str>, valid: bool) {
    if let Err(e) = store.update(APP_DOC, |s| {
        s.insert(
            "licenseKey".into(),
            license_key
                .map(|k| Value::String(k.to_string()))
                .unwrap_or(Value::Null),
        );
        s.insert("licenseValid".into(), Value::Bool(valid));
    }) {
        log::warn!("[license] could not persist the license: {}", e);
    }
}

pub async fn validate_and_reconcile(ctx: &Ctx, store: &StateStore) {
    let root = storeread::read_root(&ctx.dirs).unwrap_or_default();
    let valid = match root.license_key.as_deref().filter(|k| !k.is_empty()) {
        None => false,
        Some(key) => match validate(ctx, key).await {
            Ok(valid) => valid,
            Err(e) => {
                // Offline or the API is down: keep whatever was known, like the desktop did.
                log::warn!("[license] validation skipped: {}", e);
                root.license_valid
            }
        },
    };
    if valid != root.license_valid {
        persist_valid(store, valid);
    }
    if valid {
        return;
    }
    // Free tier: only the first FREE_MAX_TARGETS enabled targets stay enabled (never re-enables).
    let dirs = ctx.dirs.clone();
    let _ = rt::spawn_blocking(move || {
        let mut enabled: Vec<targets::NotificationTarget> = match targets::load(&dirs) {
            Ok(all) => all.into_iter().filter(|t| t.is_enabled).collect(),
            Err(e) => {
                log::warn!("[license] could not load notification targets: {}", e);
                return;
            }
        };
        enabled.sort_by_key(|t| t.created_at);
        for target in enabled.into_iter().skip(FREE_MAX_TARGETS) {
            let patch = targets::TargetPatch {
                is_enabled: Some(false),
                ..Default::default()
            };
            if let Err(e) = targets::update(&dirs, &target.id, patch) {
                log::warn!("[license] could not disable target {}: {}", target.id, e);
            }
        }
    })
    .await;
}
