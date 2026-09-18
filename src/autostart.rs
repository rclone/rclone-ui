//! Start the standalone server at login with the same invocation — a systemd user unit on
//! Linux, a LaunchAgent on macOS, the Run registry key on Windows. Unsupported inside a
//! container (use its restart policy). The desktop shell installs its own [`Autostart`].

use crate::Autostart;

const LABEL: &str = "com.rclone.ui.server";

fn invocation() -> Result<(std::path::PathBuf, Vec<String>, Vec<(String, String)>), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // Without the one-shot `--clear` and its environment form: a login-item start must not
    // empty the data directories again.
    let args = crate::restart_args(std::env::args().skip(1));
    let env: Vec<(String, String)> = std::env::vars()
        .filter(|(k, _)| {
            (k.starts_with("RCLONE_UI_") || k == "RCLONE_CONFIG") && !crate::is_one_shot_env(k)
        })
        .collect();
    Ok((exe, args, env))
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn shell_quote(s: &str) -> String {
    if s.chars().all(|c| {
        c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | ':' | '=' | '@' | ',')
    }) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::*;

    fn unit_path() -> Result<std::path::PathBuf, String> {
        let config = dirs::config_dir().ok_or("no config dir")?;
        Ok(config
            .join("systemd")
            .join("user")
            .join("rclone-ui-server.service"))
    }

    pub fn is_enabled() -> Result<bool, String> {
        Ok(unit_path()?.exists())
    }

    pub fn enable() -> Result<(), String> {
        let (exe, args, env) = invocation()?;
        let path = unit_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut unit = String::from(
            "[Unit]\nDescription=Rclone UI server\nAfter=network-online.target\n\n[Service]\n",
        );
        unit.push_str(&format!(
            "ExecStart={} {}\n",
            shell_quote(&exe.to_string_lossy()),
            args.iter()
                .map(|a| shell_quote(a))
                .collect::<Vec<_>>()
                .join(" ")
        ));
        for (k, v) in env {
            unit.push_str(&format!(
                "Environment=\"{}={}\"\n",
                k,
                v.replace('"', "\\\"")
            ));
        }
        unit.push_str("Restart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n");
        std::fs::write(&path, unit).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        let status = std::process::Command::new("systemctl")
            .args(["--user", "enable", "rclone-ui-server.service"])
            .status()
            .map_err(|e| format!("systemctl failed: {}", e))?;
        if !status.success() {
            return Err("systemctl --user enable failed (is a systemd user session available? try `loginctl enable-linger`)".to_string());
        }
        Ok(())
    }

    pub fn disable() -> Result<(), String> {
        let _ = std::process::Command::new("systemctl")
            .args(["--user", "disable", "rclone-ui-server.service"])
            .status();
        match std::fs::remove_file(unit_path()?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;

    fn plist_path() -> Result<std::path::PathBuf, String> {
        let home = dirs::home_dir().ok_or("no home dir")?;
        Ok(home
            .join("Library")
            .join("LaunchAgents")
            .join(format!("{}.plist", LABEL)))
    }

    fn escape(raw: &str) -> String {
        raw.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }

    pub fn is_enabled() -> Result<bool, String> {
        Ok(plist_path()?.exists())
    }

    pub fn enable() -> Result<(), String> {
        let (exe, args, env) = invocation()?;
        let path = plist_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut plist = String::from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n",
        );
        plist.push_str(&format!(
            "    <key>Label</key>\n    <string>{}</string>\n",
            LABEL
        ));
        plist.push_str("    <key>ProgramArguments</key>\n    <array>\n");
        plist.push_str(&format!(
            "        <string>{}</string>\n",
            escape(&exe.to_string_lossy())
        ));
        for arg in &args {
            plist.push_str(&format!("        <string>{}</string>\n", escape(arg)));
        }
        plist.push_str("    </array>\n");
        if !env.is_empty() {
            plist.push_str("    <key>EnvironmentVariables</key>\n    <dict>\n");
            for (k, v) in &env {
                plist.push_str(&format!(
                    "        <key>{}</key>\n        <string>{}</string>\n",
                    escape(k),
                    escape(v)
                ));
            }
            plist.push_str("    </dict>\n");
        }
        plist.push_str("    <key>RunAtLoad</key>\n    <true/>\n    <key>KeepAlive</key>\n    <dict>\n        <key>SuccessfulExit</key>\n        <false/>\n    </dict>\n</dict>\n</plist>\n");
        std::fs::write(&path, plist).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    pub fn disable() -> Result<(), String> {
        let path = plist_path()?;
        let _ = std::process::Command::new("launchctl")
            .args(["unload", &path.to_string_lossy()])
            .status();
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::*;

    const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const VALUE: &str = "RcloneUIServer";

    pub fn is_enabled() -> Result<bool, String> {
        let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        let key = hkcu.open_subkey(RUN_KEY).map_err(|e| e.to_string())?;
        Ok(key.get_value::<String, _>(VALUE).is_ok())
    }

    pub fn enable() -> Result<(), String> {
        let (exe, args, _env) = invocation()?;
        let mut command = format!("\"{}\"", exe.to_string_lossy());
        for arg in args {
            command.push_str(&format!(" \"{}\"", arg.replace('"', "\\\"")));
        }
        let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        let (key, _) = hkcu.create_subkey(RUN_KEY).map_err(|e| e.to_string())?;
        key.set_value(VALUE, &command).map_err(|e| e.to_string())
    }

    pub fn disable() -> Result<(), String> {
        let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        if let Ok(key) = hkcu.open_subkey_with_flags(RUN_KEY, winreg::enums::KEY_SET_VALUE) {
            let _ = key.delete_value(VALUE);
        }
        Ok(())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod imp {
    pub fn is_enabled() -> Result<bool, String> {
        Ok(false)
    }
    pub fn enable() -> Result<(), String> {
        Err("autostart is not supported on this platform".to_string())
    }
    pub fn disable() -> Result<(), String> {
        Ok(())
    }
}

pub struct LoginItem;

impl Autostart for LoginItem {
    fn is_enabled(&self) -> Result<bool, String> {
        imp::is_enabled()
    }

    fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        if enabled {
            imp::enable()
        } else {
            imp::disable()
        }
    }
}
