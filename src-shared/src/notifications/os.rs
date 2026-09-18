//! OS toast for the HEADLESS runner only. The GUI never calls this — it uses
//! @tauri-apps/plugin-notification from JS, whose AppHandle-bound Rust API cannot run in
//! scheduled-run mode (main.rs never builds a Tauri app there). This mirrors what that plugin's
//! desktop.rs does per platform (tauri-plugin-notification 2.3.3), minus the icon handling:
//! notify-rust is the plugin's own desktop backend, so behavior and attribution match.

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
