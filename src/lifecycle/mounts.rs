//! Startup mounts — main.ts `startupMounts` + lib/rclone/api.ts `startMountInner` +
//! lib/rclone/mount.ts `probeMountSource`, ported so a headless host mounts the remotes the
//! user marked "mount on start". Same RC calls, same option rekeying, same retry policy.

use std::collections::HashMap;
use std::future::Future;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::ctx::Ctx;
use crate::rc::RcClient;
use crate::scheduler::storeread::{self, MountOnStart};

use super::notify;

/// An OS toast, shown by the host (the server's `os_notify` hook) if it can.
fn toast(ctx: &Ctx, title: &str, body: &str) {
    ctx.events
        .emit("os.toast", json!({ "title": title, "body": body }));
}

// ---------------------------------------------------------------------------
// lib/paths.ts + lib/format.ts getFsInfo + lib/rclone/requests.ts serializeOptions
// ---------------------------------------------------------------------------

pub struct FsInfo {
    pub root: String,
    pub file_path: String,
    pub dir_path: String,
    pub full_dir_path: String,
    pub remote_name: String,
    pub is_folder: bool,
}

fn windows_drive(s: &str) -> Option<(String, &str)> {
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        let rest = &s[2..];
        let rest = rest.strip_prefix('/').unwrap_or(rest);
        Some((s[..2].to_string(), rest))
    } else {
        None
    }
}

/// rclone's own rule for a remote name (`fs/fspath/path.go`): letters, digits, `_ . + @`, with
/// spaces and dashes only inside; never starting with a dash or a space, never ending with one.
fn is_remote_name(name: &str) -> bool {
    let name = name.strip_prefix(':').unwrap_or(name);
    if name.is_empty() || name.starts_with(['-', ' ']) || name.ends_with(' ') {
        return false;
    }
    name.chars()
        .all(|c| c.is_alphanumeric() || matches!(c, '_' | '.' | '+' | '@' | ' ' | '-'))
}

/// Where the connection-string parameters starting at `from` (a `,`) end: the index of the
/// `:` that ends them, quotes honoured; None when they never end.
fn params_end(path: &str, from: usize) -> Option<usize> {
    let mut quote: Option<char> = None;
    for (i, c) in path.char_indices().skip_while(|(i, _)| *i <= from) {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c == ':' => return Some(i),
            None => {}
        }
    }
    None
}

/// The one grammar (`lib/paths.ts`, rclone's `fspath.Parse`): the remote's name with any
/// connection-string parameters, and the verbatim path after the colon; None for a local path
/// and for what rclone would refuse. On a Windows host a single-letter name is a drive.
fn split_remote(path: &str, windows: bool) -> Option<(String, String)> {
    if !path.contains(':') {
        return None;
    }
    for (i, c) in path.char_indices() {
        if i == 0 && c == ':' {
            continue;
        }
        if c == '/' || c == '\\' {
            return None;
        }
        if c != ':' && c != ',' {
            continue;
        }
        let name = &path[..i];
        if !is_remote_name(name) {
            return None;
        }
        if c == ':' {
            if windows && name.len() == 1 && name.as_bytes()[0].is_ascii_alphabetic() {
                return None;
            }
            return Some((name.to_string(), path[i + 1..].to_string()));
        }
        let end = params_end(path, i)?;
        return Some((path[..end].to_string(), path[end + 1..].to_string()));
    }
    None
}

fn trim_separators(s: &str) -> &str {
    s.trim_matches(|c| c == '/' || c == '\\')
}

/// The split every request makes of a path. The fs `root` carries a leading slash the user
/// typed (`gdrive:/`: absolute on sftp and on the local backend, trimmed by the rest), the
/// local root is always explicit (`:local:/`, `:local:C:/`), a bare root is a folder, and the
/// path under the root is relative to it. The same as the frontend's `getFsInfo`.
pub fn fs_info(path: &str) -> FsInfo {
    fs_info_on(path, cfg!(windows))
}

fn fs_info_on(path: &str, windows: bool) -> FsInfo {
    let (root, remote_name, rest) = match split_remote(path, windows) {
        Some((prefix, rest)) => {
            let rest = rest.replace('\\', "/");
            let name = prefix.split(',').next().unwrap_or("").to_string();
            let slash = if rest.starts_with('/') { "/" } else { "" };
            (format!("{}:{}", prefix, slash), name, rest)
        }
        None => {
            let mut local = path.replace('\\', "/");
            if let Some(stripped) = local.strip_prefix(":local:") {
                local = stripped.to_string();
            }
            match windows_drive(&local) {
                Some((drive, rest)) => (
                    format!(":local:{}/", drive),
                    ":local".to_string(),
                    rest.to_string(),
                ),
                None => (":local:/".to_string(), ":local".to_string(), local),
            }
        }
    };
    let file_path = trim_separators(&rest).to_string();
    let is_folder = file_path.is_empty() || rest.ends_with('/');
    let dir_path = if file_path.is_empty() {
        String::new()
    } else {
        format!("{}/", file_path)
    };
    FsInfo {
        full_dir_path: format!("{}{}", root, dir_path),
        remote_name,
        root,
        file_path,
        dir_path,
        is_folder,
    }
}

/// `serializeOptions(path, {})`: the fs string for a path with no inlined options — its root
/// (which carries whatever slash the user gave) and the path under it.
pub fn serialize_path(path: &str) -> String {
    let info = fs_info(path);
    format!(
        "{}{}",
        info.root,
        if info.is_folder {
            &info.dir_path
        } else {
            &info.file_path
        }
    )
}

// ---------------------------------------------------------------------------
// lib/rclone/requests.ts toFilterParam / toConfigParam
// ---------------------------------------------------------------------------

fn normalize_option_name(name: &str) -> String {
    name.strip_prefix("--").unwrap_or(name).replace('-', "_")
}

fn is_blank(value: &Value) -> bool {
    value.as_str().map(|s| s.trim().is_empty()).unwrap_or(false)
}

fn array_value(value: &Value) -> Value {
    match value {
        Value::Array(_) | Value::Null => value.clone(),
        Value::String(s) => json!([s]),
        other => json!([other.to_string()]),
    }
}

const FILTER_FIELD_NAMES: &[(&str, &str)] = &[
    ("filter", "FilterRule"),
    ("filter_from", "FilterFrom"),
    ("exclude", "ExcludeRule"),
    ("exclude_from", "ExcludeFrom"),
    ("include", "IncludeRule"),
    ("include_from", "IncludeFrom"),
    ("exclude_if_present", "ExcludeFile"),
    ("files_from", "FilesFrom"),
    ("files_from_raw", "FilesFromRaw"),
    ("delete_excluded", "DeleteExcluded"),
    ("min_age", "MinAge"),
    ("max_age", "MaxAge"),
    ("min_size", "MinSize"),
    ("max_size", "MaxSize"),
    ("ignore_case", "IgnoreCase"),
    ("hash_filter", "HashFilter"),
];
const METADATA_FILTER_FIELD_NAMES: &[(&str, &str)] = &[
    ("metadata_filter", "FilterRule"),
    ("metadata_filter_from", "FilterFrom"),
    ("metadata_exclude", "ExcludeRule"),
    ("metadata_exclude_from", "ExcludeFrom"),
    ("metadata_include", "IncludeRule"),
    ("metadata_include_from", "IncludeFrom"),
];
const FILTER_ARRAY_OPTIONS: &[&str] = &[
    "filter",
    "filter_from",
    "exclude",
    "exclude_from",
    "include",
    "include_from",
    "exclude_if_present",
    "files_from",
    "files_from_raw",
    "metadata_filter",
    "metadata_filter_from",
    "metadata_exclude",
    "metadata_exclude_from",
    "metadata_include",
    "metadata_include_from",
];
const CONFIG_FIELD_NAMES: &[(&str, &str)] = &[
    ("contimeout", "ConnectTimeout"),
    ("no_check_certificate", "InsecureSkipVerify"),
    ("retries_sleep", "RetriesInterval"),
    ("update", "UpdateOlder"),
    ("no_gzip_encoding", "NoGzip"),
    ("fast_list", "UseListR"),
    ("stats_unit", "DataRateUnit"),
    ("use_cookies", "Cookie"),
    ("color", "TerminalColorMode"),
];
const CONFIG_ARRAY_OPTIONS: &[&str] = &["compare_dest", "copy_dest", "ca_cert", "name_transform"];
const CONFIG_SPACE_SEPARATED_OPTIONS: &[&str] = &["password_command", "metadata_mapper"];

fn lookup(table: &'static [(&'static str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

pub fn to_filter_param(filter: &Map<String, Value>) -> Option<String> {
    let mut result = Map::new();
    let mut metadata = Map::new();
    for (key, value) in filter {
        if is_blank(value) {
            continue;
        }
        let normalized = normalize_option_name(key);
        let mut normalized_value = if FILTER_ARRAY_OPTIONS.contains(&normalized.as_str()) {
            array_value(value)
        } else {
            value.clone()
        };
        if (normalized == "min_age" || normalized == "max_age")
            && normalized_value
                .as_i64()
                .map(|n| n.abs() > (1i64 << 53) - 1)
                .unwrap_or(false)
        {
            normalized_value = Value::String("off".into());
        }
        if let Some(field) = lookup(METADATA_FILTER_FIELD_NAMES, &normalized) {
            metadata.insert(field.to_string(), normalized_value);
        } else {
            let field = lookup(FILTER_FIELD_NAMES, &normalized)
                .map(str::to_string)
                .unwrap_or_else(|| key.clone());
            result.insert(field, normalized_value);
        }
    }
    if !metadata.is_empty() {
        result.insert("MetaRules".into(), Value::Object(metadata));
    }
    (!result.is_empty()).then(|| Value::Object(result).to_string())
}

/// lib/rclone/requests.ts `mergeMetadataOptions`: the Metadata section maps to two rc channels —
/// the rule flags go to `_filter.MetaRules`, the rest (`metadata`, `metadata_mapper`) to
/// `_config`. The section is spread last so it beats a stale copy of the same flag left in the
/// legacy filter/config groups of an older automount.
pub fn merge_metadata_options(
    config: &Map<String, Value>,
    filter: &Map<String, Value>,
    metadata: &Map<String, Value>,
) -> (Map<String, Value>, Map<String, Value>) {
    let mut merged_config = config.clone();
    let mut merged_filter = filter.clone();
    for (key, value) in metadata {
        if lookup(METADATA_FILTER_FIELD_NAMES, &normalize_option_name(key)).is_some() {
            merged_filter.insert(key.clone(), value.clone());
        } else {
            merged_config.insert(key.clone(), value.clone());
        }
    }
    (merged_config, merged_filter)
}

pub fn to_config_param(config: &Map<String, Value>) -> Option<String> {
    let mut result = Map::new();
    for (key, value) in config {
        if is_blank(value) {
            continue;
        }
        let normalized = normalize_option_name(key);
        let field = lookup(CONFIG_FIELD_NAMES, &normalized)
            .map(str::to_string)
            .unwrap_or_else(|| {
                normalized
                    .split('_')
                    .map(|part| {
                        let mut chars = part.chars();
                        match chars.next() {
                            Some(first) => {
                                first.to_uppercase().collect::<String>() + chars.as_str()
                            }
                            None => String::new(),
                        }
                    })
                    .collect()
            });
        let normalized_value = if CONFIG_ARRAY_OPTIONS.contains(&normalized.as_str()) {
            array_value(value)
        } else if CONFIG_SPACE_SEPARATED_OPTIONS.contains(&normalized.as_str())
            && !value.is_array()
            && !value.is_null()
        {
            let text = match value {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            Value::Array(
                text.split_whitespace()
                    .map(|s| Value::String(s.to_string()))
                    .collect(),
            )
        } else {
            value.clone()
        };
        result.insert(field, normalized_value);
    }
    (!result.is_empty()).then(|| Value::Object(result).to_string())
}

/// `mountOpt` / `vfsOpt` take JSON keyed by Go field names: rekey flag names through the
/// `/options/info` registry ("vfs_cache_mode" → "CacheMode"); unknown keys pass through.
fn to_struct_options(flags: &Map<String, Value>, infos: Option<&Vec<Value>>) -> String {
    let by_name: HashMap<&str, &Value> = infos
        .map(|list| {
            list.iter()
                .filter_map(|i| i["Name"].as_str().map(|n| (n, i)))
                .collect()
        })
        .unwrap_or_default();
    let mut out = Map::new();
    for (key, value) in flags {
        let normalized = normalize_option_name(key);
        let info = by_name.get(normalized.as_str());
        let field = info
            .and_then(|i| i["FieldName"].as_str())
            .map(str::to_string)
            .unwrap_or_else(|| key.clone());
        let is_string_array = info.and_then(|i| i["Type"].as_str()) == Some("stringArray");
        let value = if is_string_array && !value.is_array() && !value.is_null() {
            array_value(value)
        } else {
            value.clone()
        };
        out.insert(field, value);
    }
    Value::Object(out).to_string()
}

// ---------------------------------------------------------------------------
// Retries (p-retry defaults: exponential, factor 2, 1s..)
// ---------------------------------------------------------------------------

async fn retry<T, Fut>(
    retries: u32,
    min: Duration,
    max: Duration,
    should_retry: impl Fn(&String) -> bool,
    mut f: impl FnMut() -> Fut,
) -> Result<T, String>
where
    Fut: Future<Output = Result<T, String>>,
{
    let mut attempt = 0;
    loop {
        match f().await {
            Ok(value) => return Ok(value),
            Err(error) => {
                if attempt >= retries || !should_retry(&error) {
                    return Err(error);
                }
                let delay = (min * 2u32.pow(attempt)).min(max);
                tokio::time::sleep(delay).await;
                attempt += 1;
            }
        }
    }
}

async fn rc_retry(client: &RcClient, endpoint: &str, body: Value) -> Result<Value, String> {
    retry(
        3,
        Duration::from_secs(1),
        Duration::from_secs(8),
        |_| true,
        || {
            let body = body.clone();
            async move { client.call(endpoint, &body).await }
        },
    )
    .await
}

// ---------------------------------------------------------------------------
// probeMountSource / startMountInner
// ---------------------------------------------------------------------------

const AUTOMOUNT_SOURCE_ERROR: &str = "AUTOMOUNT_SOURCE:";

/// Errors that describe a wrong Remote Path (never retried) are prefixed so the caller can
/// tell them from transient failures.
async fn probe_mount_source(client: &RcClient, source: &str) -> Result<(), String> {
    let info = fs_info(source);
    if info.file_path.is_empty() {
        client
            .call(
                "/operations/list",
                &json!({ "fs": info.root, "remote": "" }),
            )
            .await?;
        return Ok(());
    }
    let stat = client
        .call(
            "/operations/stat",
            &json!({ "fs": info.root, "remote": info.file_path }),
        )
        .await?;
    let item = &stat["item"];
    if item.is_null() {
        return Err(format!(
            "{}\"{}\" was not found on {}. Fix the Remote Path in the remote's Auto Mount settings",
            AUTOMOUNT_SOURCE_ERROR, info.file_path, info.root
        ));
    }
    if !item["IsDir"].as_bool().unwrap_or(false) {
        return Err(format!(
            "{}\"{}\" on {} is a file, not a folder. Fix the Remote Path in the remote's Auto Mount settings",
            AUTOMOUNT_SOURCE_ERROR, info.file_path, info.root
        ));
    }
    Ok(())
}

pub async fn start_mount(
    client: &RcClient,
    source: &str,
    destination: &str,
    options: &MountOnStart,
) -> Result<(), String> {
    let is_macos = cfg!(target_os = "macos");
    let is_windows = cfg!(target_os = "windows");
    let is_drive_letter = destination.len() <= 3
        && destination
            .as_bytes()
            .first()
            .map(|b| b.is_ascii_alphabetic())
            .unwrap_or(false)
        && destination[1..].starts_with(':');
    let needs_volume_name = is_macos || (is_windows && destination != "*" && !is_drive_letter);

    let mut mount_options = options.mount_options.clone();
    let has_volname = mount_options
        .get("volname")
        .map(|v| !v.is_null() && !is_blank(v))
        .unwrap_or(false);
    if !has_volname && needs_volume_name {
        let segments: Vec<&str> = source
            .split(['/', '\\'])
            .filter(|s| !s.is_empty())
            .collect();
        let source_path = match segments.as_slice() {
            [single] => single.replace(':', ""),
            [.., last] => last.to_string(),
            [] => "mount".to_string(),
        };
        let suffix = (b'A' + (crate::rc::random_token("volname").as_bytes()[0] % 26)) as char;
        mount_options.insert(
            "volname".into(),
            Value::String(format!("{}-{}", source_path, suffix)),
        );
    }

    let (config_options, filter_options) = merge_metadata_options(
        &options.config_options,
        &options.filter_options,
        &options.metadata_options,
    );
    let config_param = to_config_param(&config_options);
    let filter_param = to_filter_param(&filter_options);
    let vfs_options = &options.vfs_options;

    let mut query = Map::new();
    if !mount_options.is_empty() || !vfs_options.is_empty() {
        let infos = rc_retry(client, "/options/info", json!({ "blocks": "mount,vfs" })).await?;
        if !mount_options.is_empty() {
            query.insert(
                "mountOpt".into(),
                Value::String(to_struct_options(&mount_options, infos["mount"].as_array())),
            );
        }
        if !vfs_options.is_empty() {
            query.insert(
                "vfsOpt".into(),
                Value::String(to_struct_options(vfs_options, infos["vfs"].as_array())),
            );
        }
    }
    if let Some(config) = config_param {
        query.insert("_config".into(), Value::String(config));
    }
    if let Some(filter) = filter_param {
        query.insert("_filter".into(), Value::String(filter));
    }

    let src = fs_info(source);
    query.insert(
        "fs".into(),
        Value::String(serialize_path(&src.full_dir_path)),
    );

    if destination == "*" && is_windows {
        query.insert("mountPoint".into(), Value::String("*".into()));
        rc_retry(client, "/mount/mount", Value::Object(query)).await?;
        return Ok(());
    }

    let dst = fs_info(destination);
    let dst_fs = dst.root.clone();
    let dst_file_path = dst.file_path.replace('\\', "/");

    let directory_exists = match rc_retry(
        client,
        "/operations/stat",
        json!({ "fs": dst_fs, "remote": dst_file_path }),
    )
    .await
    {
        Ok(stat) => {
            if stat["item"].is_null() {
                Some(false)
            } else if !stat["item"]["IsDir"].as_bool().unwrap_or(false) {
                return Err("The selected directory is not a directory".to_string());
            } else {
                Some(true)
            }
        }
        Err(e) => {
            log::warn!("[mounts] could not stat {}: {}", destination, e);
            None
        }
    };

    if directory_exists == Some(true) {
        let is_empty = match rc_retry(
            client,
            "/operations/list",
            json!({ "fs": dst_fs, "remote": dst.file_path }),
        )
        .await
        {
            Ok(listing) => listing["list"]
                .as_array()
                .map(|l| l.is_empty())
                .unwrap_or(true),
            Err(e) => {
                log::warn!("[mounts] could not list {}: {}", destination, e);
                false
            }
        };
        if !is_empty {
            return Err("The selected directory must be empty to mount a remote.".to_string());
        }
        if is_windows {
            let _ = rc_retry(
                client,
                "/operations/rmdir",
                json!({ "fs": dst_fs, "remote": dst.file_path }),
            )
            .await;
        }
    } else if !is_windows {
        rc_retry(
            client,
            "/operations/mkdir",
            json!({ "fs": dst_fs, "remote": dst.file_path }),
        )
        .await
        .map_err(|_| {
            "Failed to create mount directory. Try creating it manually first.".to_string()
        })?;
    }

    // The root carries its own slash (`:local:/…`): the backend's name comes off, nothing goes on.
    let mount_point = if !is_windows {
        dst.full_dir_path.replacen(":local:", "", 1)
    } else {
        let mut mp = dst
            .full_dir_path
            .replacen(":local:", "", 1)
            .replace('\\', "/");
        while mp.contains("//") {
            mp = mp.replace("//", "/");
        }
        if mp.len() == 3 && mp.ends_with(":/") {
            mp.pop();
        }
        mp
    };
    query.insert("mountPoint".into(), Value::String(mount_point));
    if is_macos {
        query.insert("mountType".into(), Value::String("nfsmount".into()));
    }
    rc_retry(client, "/mount/mount", Value::Object(query)).await?;
    Ok(())
}

/// main.ts `startupMounts`: probe each auto-mount source (with the same backoff), then mount it.
pub async fn startup_mounts(ctx: &Ctx, client: &RcClient) {
    let host = match storeread::read_host(&ctx.dirs, "local") {
        Ok(host) => host,
        Err(_) => return,
    };
    let remotes = match client.call("/config/listremotes", &json!({})).await {
        Ok(reply) => reply["remotes"]
            .as_array()
            .map(|r| {
                r.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        Err(e) => {
            log::warn!("[mounts] could not list remotes: {}", e);
            return;
        }
    };

    for remote in remotes {
        let Some(config) = host
            .remote_configs
            .get(&remote)
            .and_then(|c| c.mount_on_start.clone())
        else {
            continue;
        };
        if !config.enabled || config.mount_point.is_empty() {
            continue;
        }
        let source = format!("{}:{}", remote, config.remote_path);
        let mount_point = config.mount_point.clone();

        let probe = retry(
            7,
            Duration::from_secs(1),
            Duration::from_secs(15),
            |error| !error.starts_with(AUTOMOUNT_SOURCE_ERROR),
            || probe_mount_source(client, &source),
        )
        .await;
        if let Err(error) = probe {
            let body = match error.strip_prefix(AUTOMOUNT_SOURCE_ERROR) {
                Some(message) => message.to_string(),
                None => format!(
                    "{} is not reachable (network or sign-in problem) — not mounting to avoid an empty folder at {}",
                    source, mount_point
                ),
            };
            log::warn!("[mounts] {}", body);
            notify(
                ctx,
                "mount.failed",
                "Automount skipped",
                &body,
                json!({ "source": source, "destination": mount_point, "error": error.trim_start_matches(AUTOMOUNT_SOURCE_ERROR) }),
            );
            toast(ctx, "Automount skipped", &body);
            continue;
        }

        log::info!("[mounts] mounting {} at {}", source, mount_point);
        match start_mount(client, &source, &mount_point, &config).await {
            Ok(()) => {
                let info = fs_info(&source);
                if let Err(e) = client
                    .call(
                        "/operations/list",
                        &json!({ "fs": info.root, "remote": info.file_path }),
                    )
                    .await
                {
                    log::warn!("[mounts] {} mounted but listing failed: {}", source, e);
                    toast(
                        ctx,
                        "Automount warning",
                        &format!(
                            "{} mounted at {}, but listing it failed — the folder may appear empty until the connection recovers",
                            source, mount_point
                        ),
                    );
                }
            }
            Err(error) => {
                log::error!("[mounts] failed to mount {}: {}", source, error);
                notify(
                    ctx,
                    "mount.failed",
                    "Mount failed",
                    &format!("Failed to mount {}: {}", source, error),
                    json!({ "source": source, "destination": mount_point, "error": error }),
                );
                toast(ctx, "Automount Error", &error);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fs_info_matches_the_frontend() {
        let remote = fs_info("gdrive:photos/2024");
        assert_eq!(remote.root, "gdrive:");
        assert_eq!(remote.file_path, "photos/2024");
        assert_eq!(remote.full_dir_path, "gdrive:photos/2024/");
        assert!(!remote.is_folder);

        // Colons inside a path belong to the file name (lib/format.ts getFsInfo, e2e/format.spec.ts).
        let colon = fs_info("gdrive:notes/meeting 10:30.txt");
        assert_eq!(colon.root, "gdrive:");
        assert_eq!(colon.file_path, "notes/meeting 10:30.txt");
        let local_colon = fs_info("/Users/me/Backups/2024-01-01 10:30/");
        assert_eq!(local_colon.root, ":local:/");
        assert_eq!(local_colon.file_path, "Users/me/Backups/2024-01-01 10:30");

        let local = fs_info("/Users/me/mnt/");
        assert_eq!(local.root, ":local:/");
        assert_eq!(local.file_path, "Users/me/mnt");
        assert!(local.is_folder);
        assert_eq!(
            serialize_path(&local.full_dir_path),
            ":local:/Users/me/mnt/"
        );

        // A drive is a drive on a Windows host; elsewhere rclone reads the remote `C`, and the
        // frontend says so before anything is sent.
        let win = fs_info_on("C:\\data\\mnt", true);
        assert_eq!(win.root, ":local:C:/");
        assert_eq!(win.file_path, "data/mnt");
        assert_eq!(fs_info_on("C:\\data\\mnt", false).root, "C:/");
        assert_eq!(fs_info_on("c:photos", true).root, ":local:c:/");
        assert_eq!(fs_info_on("c:photos", false).root, "c:");

        assert_eq!(serialize_path("gdrive:photos/2024/"), "gdrive:photos/2024/");
    }

    #[test]
    fn the_slash_after_the_colon_is_kept_on_the_root() {
        // `remote:x` and `remote:/x` are two places on sftp; the root carries the difference.
        let relative = fs_info("sftp:var/www/");
        assert_eq!(relative.root, "sftp:");
        assert_eq!(relative.full_dir_path, "sftp:var/www/");
        let absolute = fs_info("sftp:/var/www/");
        assert_eq!(absolute.root, "sftp:/");
        assert_eq!(absolute.file_path, "var/www");
        assert_eq!(absolute.full_dir_path, "sftp:/var/www/");
        assert_eq!(serialize_path("sftp:/var/www/"), "sftp:/var/www/");
        // A bare root is a folder, and gets no slash it did not have.
        let root = fs_info("sftp:");
        assert!(root.is_folder);
        assert_eq!(root.full_dir_path, "sftp:");
        assert_eq!(fs_info("sftp:/").full_dir_path, "sftp:/");
        // Connection strings keep their parameters ahead of the root.
        let params = fs_info(":sftp,host=\"a:b\",user=me:/srv");
        assert_eq!(params.root, ":sftp,host=\"a:b\",user=me:/");
        assert_eq!(params.remote_name, ":sftp");
        assert_eq!(params.file_path, "srv");
        // What rclone would refuse is no remote; a name it allows is.
        assert_eq!(fs_info("-bad:x").remote_name, ":local");
        assert_eq!(fs_info("my drive:x").remote_name, "my drive");
        assert_eq!(fs_info("photos:2024").remote_name, "photos");
        assert_eq!(fs_info("/tmp/meeting 10:30.txt").remote_name, ":local");
    }

    #[test]
    fn metadata_section_splits_into_config_and_filter() {
        let mut config = Map::new();
        config.insert("metadata".into(), json!(false));
        let mut filter = Map::new();
        filter.insert("exclude".into(), json!("*.tmp"));
        let mut metadata = Map::new();
        metadata.insert("metadata".into(), json!(true));
        metadata.insert("metadata-mapper".into(), json!("python m.py"));
        metadata.insert("metadata_include".into(), json!("x=y"));

        let (merged_config, merged_filter) = merge_metadata_options(&config, &filter, &metadata);
        let config_param: Value =
            serde_json::from_str(&to_config_param(&merged_config).unwrap()).unwrap();
        assert_eq!(config_param["Metadata"], json!(true));
        assert_eq!(config_param["MetadataMapper"], json!(["python", "m.py"]));
        assert!(config_param.get("MetaRules").is_none());
        let filter_param: Value =
            serde_json::from_str(&to_filter_param(&merged_filter).unwrap()).unwrap();
        assert_eq!(filter_param["ExcludeRule"], json!(["*.tmp"]));
        assert_eq!(filter_param["MetaRules"]["IncludeRule"], json!(["x=y"]));
        assert!(filter_param.get("Metadata").is_none());

        let (same_config, same_filter) = merge_metadata_options(&config, &filter, &Map::new());
        assert_eq!(same_config, config);
        assert_eq!(same_filter, filter);
    }

    #[test]
    fn params_follow_requests_ts() {
        let mut filter = Map::new();
        filter.insert("--exclude".into(), json!("*.tmp"));
        filter.insert("min-age".into(), json!("1d"));
        filter.insert("metadata_include".into(), json!("x=y"));
        filter.insert("max_size".into(), json!("  "));
        let param: Value = serde_json::from_str(&to_filter_param(&filter).unwrap()).unwrap();
        assert_eq!(param["ExcludeRule"], json!(["*.tmp"]));
        assert_eq!(param["MinAge"], json!("1d"));
        assert_eq!(param["MetaRules"]["IncludeRule"], json!(["x=y"]));
        assert!(param.get("MaxSize").is_none());

        let mut config = Map::new();
        config.insert("no_check_certificate".into(), json!(true));
        config.insert("buffer-size".into(), json!("16M"));
        config.insert("password_command".into(), json!("pass show x"));
        let param: Value = serde_json::from_str(&to_config_param(&config).unwrap()).unwrap();
        assert_eq!(param["InsecureSkipVerify"], json!(true));
        assert_eq!(param["BufferSize"], json!("16M"));
        assert_eq!(param["PasswordCommand"], json!(["pass", "show", "x"]));
        assert!(to_config_param(&Map::new()).is_none());

        let infos = vec![
            json!({ "Name": "vfs_cache_mode", "FieldName": "CacheMode", "Type": "string" }),
            json!({ "Name": "uid", "FieldName": "UID", "Type": "stringArray" }),
        ];
        let mut vfs = Map::new();
        vfs.insert("vfs-cache-mode".into(), json!("full"));
        vfs.insert("uid".into(), json!(501));
        let out: Value = serde_json::from_str(&to_struct_options(&vfs, Some(&infos))).unwrap();
        assert_eq!(out["CacheMode"], json!("full"));
        assert_eq!(out["UID"], json!(["501"]));
    }
}
