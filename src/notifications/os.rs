//! The OS toast. Two callers: a scheduled run (`scheduler/runner.rs`), which has no page to
//! speak through, and the `os_notify` hook, which the `os.toast` bus event and the RPC of the
//! same name reach. It is off in a container, where `osNotifications` is false and there is no
//! desktop to show it on — pages there show their own toast instead.

// The macOS bundle id / Windows AUMID the bundler registers, which is what makes the toast render
// under the app's name and icon.
use crate::datadir::APP_IDENTIFIER;

pub fn notify_headless(title: &str, body: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // set_application errors if called twice in a process — guard like the plugin does.
        // In dev the binary has no bundle, so borrow Terminal's identity (plugin parity).
        static SET_APP: std::sync::Once = std::sync::Once::new();
        SET_APP.call_once(|| {
            let _ = notify_rust::set_application(if crate::platform::is_dev() {
                "com.apple.Terminal"
            } else {
                APP_IDENTIFIER
            });
        });
    }

    let mut notification = notify_rust::Notification::new();
    notification.summary(title).body(body);

    #[cfg(windows)]
    {
        if !crate::platform::is_dev() {
            notification.app_id(APP_IDENTIFIER);
        }
    }

    notification.show().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    /// Posts a REAL desktop notification (dev identity = Terminal). Ignored by default; run
    /// explicitly with `cargo test e2e_macos_toast -- --ignored` and check the toast appears.
    #[test]
    #[ignore]
    fn e2e_macos_toast() {
        super::notify_headless(
            "Scheduled task completed",
            "rclone-ui notifications e2e — this toast is expected",
        )
        .expect("notify_headless failed");
    }
}
