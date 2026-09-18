#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Headless scheduled-task mode: `"Rclone UI" run-task <taskId> [--host <hostId>]`, invoked
    // by cron/Task Scheduler. Handled BEFORE app_lib::run() so no GUI, Sentry, or
    // single-instance plugin ever initializes (the plugin would otherwise intercept this
    // process and just pop the running app's toolbar).
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 3 && args[1] == "run-task" {
        // Schedulers hand us a bare environment; passCommand helpers and rclone need the
        // login-shell PATH.
        let _ = fix_path_env::fix();
        let flag_value = |flag: &str| {
            args.iter()
                .position(|a| a == flag)
                .and_then(|i| args.get(i + 1))
                .cloned()
        };
        let task_id = args[2].clone();
        let host_id = flag_value("--host").unwrap_or_else(|| "local".to_string());
        // Set by Run Now (a manual, off-schedule run) — bypasses the macOS launchd catch-up
        // suppression so a manual trigger always executes.
        let forced = args.iter().any(|a| a == "--forced");
        // The GUI's resolved data directory, baked into the trigger at registration — a bare
        // cron environment can re-derive a different one (session XDG_DATA_HOME). Absent on
        // triggers registered by older versions; the runner then derives it itself.
        let data_dir = flag_value("--data-dir");
        std::process::exit(app_lib::run_scheduled_task(
            &task_id,
            &host_id,
            forced,
            data_dir.as_deref(),
        ));
    }

    // The metadata mapper (`--metadata-mapper`), which rclone spawns once per file and
    // directory copied: one JSON object in, one out, nothing started, nothing logged.
    if args.len() >= 2 && args[1] == "metadata-map" {
        std::process::exit(app_lib::run_metadata_map(&args[2..]));
    }

    #[cfg(target_os = "linux")]
    {
        let is_dri_present = std::path::Path::new("/dev/dri").exists();
        let is_wayland = std::env::var("WAYLAND_DISPLAY").is_ok();
        let is_x11_session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default() == "x11";
        if is_dri_present && !is_wayland && is_x11_session {
            if std::env::var_os("__NV_DISABLE_EXPLICIT_SYNC").is_none() {
                std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--ignore-gpu-blocklist --force-device-scale-factor=1 --disable-features=msWebOOUI",
        );
    }
    let _ = fix_path_env::fix();
    app_lib::run();
}
