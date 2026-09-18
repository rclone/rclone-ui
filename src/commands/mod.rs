//! The command table: every portable command is declared exactly once, in `for_each_command!`
//! below. The desktop app expands the same list into `#[tauri::command]` wrappers
//! (src-tauri/src/commands.rs) and the server routes `invoke` names through [`dispatch`], so the
//! two hosts cannot drift — a command missing here is missing from both.
//!
//! Wire contract (unchanged from the Tauri-only days): argument keys are the camelCase form of
//! the declared parameter names, exactly what `@tauri-apps/api` `invoke(name, { ... })` sends;
//! every command yields `Result<T, String>`.
//!
//! Kinds:
//! - `sync`   — the body may block (filesystem, subprocesses, HTTP via `rt::block_on`); hosts
//!              run it on the blocking pool.
//! - `async`  — the body awaits; hosts await it directly.
//! - `stream` — returns quickly and keeps sending on its `Sink` afterwards; the channel
//!              argument is declared after `;` and arrives from JS as `onEvent`.

pub mod misc;

use serde::Serialize;
use serde_json::Value;

use crate::ctx::Ctx;
use crate::sink::Sink;

#[macro_export]
macro_rules! for_each_command {
    ($callback:ident) => {
        $callback! {
            // --- rclone binary management (zookeeper) ---
            sync exec_rclone(path: String, args: Vec<String>, env: ::std::collections::HashMap<String, String>, stdin_lines: Option<Vec<String>>, timeout_ms: Option<u64>) -> $crate::zookeeper::ExecResult = $crate::zookeeper::exec_rclone;
            sync validate_rclone_binary(path: String) -> String = $crate::zookeeper::validate_rclone_binary;
            sync rclone_config_path(path: String) -> String = $crate::zookeeper::rclone_config_path;
            stream spawn_rclone(path: String, args: Vec<String>, env: ::std::collections::HashMap<String, String>; on_event: $crate::zookeeper::RcloneEvent) -> u32 = $crate::zookeeper::spawn_rclone;
            sync kill_rclone_daemon(timeout_ms: Option<u64>) -> bool = $crate::zookeeper::kill_rclone_daemon;
            sync find_system_rclone() -> Option<String> = $crate::zookeeper::find_system_rclone;
            sync classify_rclone_path(path: String) -> $crate::zookeeper::RcloneClassification = $crate::zookeeper::classify_rclone_path;
            sync list_downloaded_rclone_versions() -> Vec<$crate::zookeeper::DownloadedVersion> = $crate::zookeeper::list_downloaded_rclone_versions;
            sync delete_rclone_version(version: String, active_path: Option<String>) -> () = $crate::zookeeper::delete_rclone_version;
            sync managed_version_path(version: String) -> Option<String> = $crate::zookeeper::managed_version_path;
            async download_rclone_version(version: String, proxy_url: Option<String>) -> String = $crate::zookeeper::download_rclone_version;
            sync update_path_pointer(target_path: String) -> () = $crate::zookeeper::update_path_pointer;
            sync get_rclone_path_integration() -> $crate::zookeeper::PathStatus = $crate::zookeeper::get_rclone_path_integration;
            sync set_rclone_path_integration(enable: bool, target_path: String) -> $crate::zookeeper::PathStatus = $crate::zookeeper::set_rclone_path_integration;
            sync get_config_sync_status(app_config_path: String, owned_link_target: Option<String>) -> $crate::zookeeper::ConfigSyncStatus = $crate::zookeeper::get_config_sync_status;
            sync set_config_sync(enable: bool, app_config_path: String, owned_link_target: Option<String>, default_config_path: Option<String>) -> $crate::zookeeper::ConfigSyncStatus = $crate::zookeeper::set_config_sync;

            // --- scheduler ---
            sync scheduler_supported() -> $crate::scheduler::SupportInfo = $crate::scheduler::scheduler_supported;
            sync scheduler_validate_cron(cron: String) -> $crate::scheduler::CronValidation = $crate::scheduler::scheduler_validate_cron;
            sync scheduler_register(spec: $crate::scheduler::jobfile::JobSpec, enabled: bool) -> () = $crate::scheduler::scheduler_register;
            sync scheduler_unregister(task_id: String) -> () = $crate::scheduler::scheduler_unregister;
            sync scheduler_set_enabled(task_id: String, enabled: bool) -> () = $crate::scheduler::scheduler_set_enabled;
            sync scheduler_run_now(task_id: String) -> () = $crate::scheduler::scheduler_run_now;
            sync scheduler_status() -> Vec<$crate::scheduler::TaskStatus> = $crate::scheduler::scheduler_status;
            sync scheduler_read_log(task_id: String, which: String) -> $crate::scheduler::LogContent = $crate::scheduler::scheduler_read_log;
            sync scheduler_read_history(task_id: String, limit: Option<usize>) -> Vec<::serde_json::Value> = $crate::scheduler::scheduler_read_history;
            sync scheduler_unregister_all() -> u32 = $crate::scheduler::scheduler_unregister_all;
            sync scheduler_sweep_orphans() -> u32 = $crate::scheduler::scheduler_sweep_orphans;

            // --- transfers (the record; starting and stopping are the server's) ---
            sync transfers_list(limit: Option<usize>) -> Vec<$crate::transfers::ledger::Entry> = $crate::transfers::transfers_list;
            sync transfers_detail(id: String) -> Option<::serde_json::Value> = $crate::transfers::transfers_detail;

            // --- notifications ---
            sync notifications_catalog() -> $crate::notifications::Catalog = $crate::notifications::notifications_catalog;
            sync notifications_list_targets() -> Vec<$crate::notifications::targets::NotificationTarget> = $crate::notifications::notifications_list_targets;
            sync notifications_add_target(target: $crate::notifications::targets::NewTarget) -> $crate::notifications::targets::NotificationTarget = $crate::notifications::notifications_add_target;
            sync notifications_update_target(id: String, patch: $crate::notifications::targets::TargetPatch) -> () = $crate::notifications::notifications_update_target;
            sync notifications_remove_target(id: String) -> () = $crate::notifications::notifications_remove_target;
            sync notifications_dispatch(event_id: String, title: String, body: String, data: Option<::serde_json::Value>) -> () = $crate::notifications::notifications_dispatch;
            sync notifications_send_test(provider: String, url: String, target_id: Option<String>, name: Option<String>) -> () = $crate::notifications::notifications_send_test;
            sync smtp_get() -> $crate::notifications::smtp::SmtpView = $crate::notifications::smtp_get;
            sync smtp_set(settings: $crate::notifications::smtp::SmtpInput) -> $crate::notifications::smtp::SmtpView = $crate::notifications::smtp_set;
            sync smtp_send_test(to: String) -> () = $crate::notifications::smtp_send_test;

            // --- machine / process helpers ---
            sync get_arch() -> String = $crate::commands::misc::get_arch;
            sync is_flatpak() -> bool = $crate::commands::misc::is_flatpak;
            sync extract_tgz(tgz_path: String, output_folder: String) -> () = $crate::commands::misc::extract_tgz;
            // The one caller that sends a snake_case key (lib/rclone/init.ts, ProxySection.tsx).
            async test_proxy_connection(#[serde(alias = "proxy_url")] proxy_url: String) -> String = $crate::commands::misc::test_proxy_connection;
        }
    };
}

fn parse_args<T: serde::de::DeserializeOwned>(args: Value) -> Result<T, String> {
    let args = if args.is_null() {
        Value::Object(Default::default())
    } else {
        args
    };
    serde_json::from_value(args).map_err(|e| format!("invalid arguments: {}", e))
}

fn to_value<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| format!("failed to serialize the result: {}", e))
}

macro_rules! gen_dispatch {
    ( $( $kind:ident $name:ident ( $( $(#[$attr:meta])* $arg:ident : $ty:ty ),* $(,)? $( ; $ch:ident : $ev:ty )? ) -> $ok:ty = $path:path ; )* ) => {
        /// Every command in the table, by wire name.
        pub const COMMAND_NAMES: &[&str] = &[ $( stringify!($name) ),* ];

        /// Whether a command streams through a channel (`onEvent` in its arguments).
        pub fn is_streaming(cmd: &str) -> bool {
            match cmd {
                $( stringify!($name) => gen_dispatch!(@is_stream $kind), )*
                _ => false,
            }
        }

        /// Runs a command by wire name with the JSON arguments the frontend's `invoke` sends.
        /// Streaming commands need `sink`; the others ignore it.
        pub async fn dispatch(
            ctx: &Ctx,
            cmd: &str,
            args: Value,
            sink: Option<Sink<Value>>,
        ) -> Result<Value, String> {
            match cmd {
                $( stringify!($name) => gen_dispatch!(@call $kind ctx args sink ( $( $(#[$attr])* $arg : $ty ),* $( ; $ch : $ev )? ) $path), )*
                other => Err(format!("unknown command '{}'", other)),
            }
        }
    };
    (@is_stream stream) => { true };
    (@is_stream $kind:ident) => { false };
    (@call sync $ctx:ident $args:ident $sink:ident ( $( $(#[$attr:meta])* $arg:ident : $ty:ty ),* ) $path:path) => {{
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Args { $( $(#[$attr])* $arg: $ty ),* }
        #[allow(unused_variables)]
        let a: Args = parse_args($args)?;
        let ctx = $ctx.clone();
        let out = $crate::rt::spawn_blocking(move || $path(&ctx, $( a.$arg ),* ))
            .await
            .map_err(|e| e.to_string())??;
        to_value(out)
    }};
    (@call async $ctx:ident $args:ident $sink:ident ( $( $(#[$attr:meta])* $arg:ident : $ty:ty ),* ) $path:path) => {{
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Args { $( $(#[$attr])* $arg: $ty ),* }
        #[allow(unused_variables)]
        let a: Args = parse_args($args)?;
        let out = $path($ctx, $( a.$arg ),* ).await?;
        to_value(out)
    }};
    (@call stream $ctx:ident $args:ident $sink:ident ( $( $(#[$attr:meta])* $arg:ident : $ty:ty ),* ; $ch:ident : $ev:ty ) $path:path) => {{
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Args { $( $(#[$attr])* $arg: $ty ),* }
        #[allow(unused_variables)]
        let a: Args = parse_args($args)?;
        let sink = $sink
            .ok_or_else(|| format!("'{}' needs a channel ({})", stringify!($name), stringify!($ch)))?
            .retype::<$ev>();
        let out = $path($ctx, $( a.$arg ),*, sink)?;
        to_value(out)
    }};
}

for_each_command!(gen_dispatch);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ctx::Events;
    use crate::datadir::DataDir;

    fn ctx() -> Ctx {
        let root = std::env::temp_dir().join(format!("rcloneui-dispatch-{}", std::process::id()));
        Ctx::new(
            DataDir {
                root: root.join("data"),
            },
            Events::noop(),
        )
    }

    #[test]
    fn table_has_no_duplicates() {
        let mut names: Vec<&str> = COMMAND_NAMES.to_vec();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), COMMAND_NAMES.len());
        assert!(is_streaming("spawn_rclone"));
        assert!(!is_streaming("get_arch"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dispatches_sync_async_and_unknown() {
        let ctx = ctx();
        let arch = dispatch(&ctx, "get_arch", Value::Null, None).await.unwrap();
        assert!(arch.is_string());

        let validation = dispatch(
            &ctx,
            "scheduler_validate_cron",
            serde_json::json!({ "cron": "*/5 * * * *" }),
            None,
        )
        .await
        .unwrap();
        assert_eq!(validation["valid"], Value::Bool(true));

        let err = dispatch(&ctx, "no_such_command", Value::Null, None)
            .await
            .unwrap_err();
        assert!(err.contains("unknown command"));

        // Missing required argument → a deserialization error, never a panic.
        let err = dispatch(&ctx, "scheduler_validate_cron", Value::Null, None)
            .await
            .unwrap_err();
        assert!(err.contains("invalid arguments"));
    }
}
