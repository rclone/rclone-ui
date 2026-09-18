//! The current host at boot (main.ts `checkHostReachability` + `checkRclone`): a remote host
//! that can't be reached is retried or replaced by the local one; a reachable one gets its
//! `os`/`cliVersion` refreshed in the app document.

use serde_json::{json, Value};

use crate::ctx::Ctx;
use crate::rc::RcClient;
use crate::scheduler::storeread;
use crate::state_files::{StateStore, APP_DOC};

use super::interaction::{ask, Decision, Question, SharedInteraction};

async fn probe(entry: &storeread::HostEntry) -> Result<(String, String), String> {
    let client = RcClient::new(
        entry.url.clone(),
        entry.auth_user.clone().filter(|u| !u.is_empty()),
        entry.auth_password.clone(),
    );
    let version = client.call("/core/version", &json!({})).await?;
    let os = match version["os"].as_str().unwrap_or("") {
        "windows" => "windows",
        "darwin" => "macos",
        _ => "linux",
    };
    let cli = version["version"]
        .as_str()
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();
    Ok((os.to_string(), cli))
}

fn switch_to_local(store: &StateStore) {
    let os = match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    };
    let _ = store.update(APP_DOC, |s| {
        let hosts = s.entry("hosts").or_insert_with(|| Value::Array(Vec::new()));
        if let Some(list) = hosts.as_array_mut() {
            if !list
                .iter()
                .any(|h| h.get("id").and_then(Value::as_str) == Some("local"))
            {
                list.push(json!({
                    "id": "local",
                    "name": "Local Machine",
                    "url": "http://localhost:5572",
                    "os": os,
                    "cliVersion": "unknown",
                }));
            }
        }
        s.insert("currentHostId".into(), Value::String("local".into()));
    });
}

/// Returns once the current host is settled (local, or a reachable remote).
pub async fn check_current_host(ctx: &Ctx, store: &StateStore, interaction: &SharedInteraction) {
    let root = storeread::read_root(&ctx.dirs).unwrap_or_default();
    let Some(current) = root.current_host_id.clone().filter(|id| id != "local") else {
        return;
    };
    let Some(entry) = root.hosts.iter().find(|h| h.id == current).cloned() else {
        log::warn!(
            "[hosts] current host {} is unknown; using the local host",
            current
        );
        switch_to_local(store);
        return;
    };
    loop {
        let name = entry.name.clone().unwrap_or_else(|| entry.id.clone());
        match probe(&entry).await {
            Ok((os, cli_version)) => {
                let id = entry.id.clone();
                let _ = store.update(APP_DOC, |s| {
                    if let Some(list) = s.get_mut("hosts").and_then(Value::as_array_mut) {
                        for host in list.iter_mut() {
                            if host.get("id").and_then(Value::as_str) == Some(&id) {
                                host["os"] = Value::String(os.clone());
                                host["cliVersion"] = Value::String(cli_version.clone());
                            }
                        }
                    }
                });
                return;
            }
            Err(error) => {
                log::warn!("[hosts] {} ({}) unreachable: {}", name, entry.url, error);
                let decision = ask(
                    interaction,
                    Question::HostUnreachable {
                        name: name.clone(),
                        url: entry.url.clone(),
                        error,
                    },
                )
                .await;
                match decision {
                    Decision::Retry => continue,
                    _ => {
                        switch_to_local(store);
                        return;
                    }
                }
            }
        }
    }
}
