//! Boot-time questions answered with native dialogs: at that point there is no page to ask,
//! so the orchestrator's `Interaction` is the one place the desktop still shows OS message
//! boxes (and the native text prompt for a config password).

use rclone_ui_shared::lifecycle::interaction::{Decision, Interaction, Question};
use tauri::AppHandle;
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

pub struct DesktopInteraction {
    pub app: AppHandle,
}

impl DesktopInteraction {
    fn ask_labelled(
        &self,
        title: &str,
        message: &str,
        kind: MessageDialogKind,
        ok: &str,
        cancel: &str,
    ) -> bool {
        match self
            .app
            .dialog()
            .message(message)
            .title(title)
            .kind(kind)
            .buttons(MessageDialogButtons::OkCancelCustom(
                ok.into(),
                cancel.into(),
            ))
            .blocking_show_with_result()
        {
            MessageDialogResult::Ok | MessageDialogResult::Yes => true,
            MessageDialogResult::Custom(label) => label == ok,
            _ => false,
        }
    }

    pub fn message(&self, title: &str, message: &str, kind: MessageDialogKind, ok: &str) {
        let _ = self
            .app
            .dialog()
            .message(message)
            .title(title)
            .kind(kind)
            .buttons(MessageDialogButtons::OkCustom(ok.into()))
            .blocking_show();
    }
}

impl Interaction for DesktopInteraction {
    fn decide(&self, question: Question) -> Decision {
        match question {
            Question::AdoptSystemRclone { path, version } => {
                let yes = self.ask_labelled(
                    "System rclone detected",
                    &format!(
                        "Found rclone v{} at:\n{}\n\nUse it as the app's rclone? Otherwise the app will manage its own copy. You can switch anytime in Settings.",
                        version, path
                    ),
                    MessageDialogKind::Info,
                    "Use system rclone",
                    "Manage a copy",
                );
                if yes {
                    Decision::Yes
                } else {
                    Decision::No
                }
            }
            Question::ConfigPassword { label, attempt, .. } => {
                let message = if attempt > 1 {
                    format!(
                        "Incorrect password. Enter the password for the encrypted config \"{}\".",
                        label
                    )
                } else {
                    format!("Enter the password for the encrypted config \"{}\".", label)
                };
                loop {
                    match prompt_text("Rclone UI", &message.replace('"', "“"), None, true) {
                        Ok(Some(password)) if !password.is_empty() => {
                            return Decision::Text(password)
                        }
                        _ => {}
                    }
                    let try_again = self.ask_labelled(
                        "Password Required",
                        "Password is required for encrypted configurations.",
                        MessageDialogKind::Error,
                        "Try Again",
                        "Close",
                    );
                    if !try_again {
                        // The old orchestrator exited here too: no daemon can run without it.
                        self.app.exit(0);
                        return Decision::Exit;
                    }
                }
            }
            Question::ProxyUnreachable { .. } => {
                let go_on = self.ask_labelled(
                    "Error",
                    "You have a proxy set, but it failed to connect. Do you want to continue anyway?",
                    MessageDialogKind::Warning,
                    "Continue",
                    "Exit",
                );
                if go_on {
                    Decision::Continue
                } else {
                    Decision::Exit
                }
            }
            Question::HostUnreachable { name, url, .. } => {
                let retry = self.ask_labelled(
                    "Host Not Reachable",
                    &format!(
                        "The selected host \"{}\" is not reachable.\n\nURL: {}\n\nWould you like to retry, switch to local host, or exit?",
                        name, url
                    ),
                    MessageDialogKind::Warning,
                    "Retry",
                    "Use Local",
                );
                if retry {
                    Decision::Retry
                } else {
                    Decision::UseLocal
                }
            }
            Question::SyncedConfigMissing { .. } => {
                self.message(
                    "Invalid synced config",
                    "The config file could not be found. Switching to the default config.",
                    MessageDialogKind::Error,
                    "OK",
                );
                Decision::Yes
            }
            Question::RcloneCrashed { .. } => {
                let relaunch = self.ask_labelled(
                    "Error",
                    "Rclone has crashed",
                    MessageDialogKind::Error,
                    "Relaunch",
                    "Exit",
                );
                if relaunch {
                    Decision::Relaunch
                } else {
                    Decision::Exit
                }
            }
            Question::StartFailed { .. } => {
                // The Startup window already shows the error; the next page-driven restart
                // resumes the loop.
                Decision::No
            }
            Question::QuitWithActiveTransfers { relaunch, .. } => {
                let proceed = self.ask_labelled(
                    "Exit",
                    "All active transfers will be stopped.",
                    MessageDialogKind::Info,
                    if relaunch { "Relaunch" } else { "Quit" },
                    "Cancel",
                );
                if proceed {
                    Decision::Yes
                } else {
                    Decision::No
                }
            }
        }
    }
}

/// A native single-line text prompt (macOS: AppleScript, Windows: PowerShell, elsewhere:
/// tinyfiledialogs). Used only for the boot-time config password; every other prompt is
/// rendered in the page.
pub fn prompt_text(
    title: &str,
    message: &str,
    default: Option<&str>,
    sensitive: bool,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;

        let default_value = default.unwrap_or_default();
        // AppleScript string literals can't contain a raw newline, so a multi-line message must
        // have its newlines turned into the `\n` escape sequence. Escape backslashes and quotes
        // first so the conversions don't collide.
        let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
        let esc_message = esc(message)
            .replace("\r\n", "\\n")
            .replace('\n', "\\n")
            .replace('\r', "\\n");
        let esc_title = esc(title);
        let esc_default = esc(default_value);

        let script = if sensitive {
            format!(
                r#"display dialog "{}" with title "{}" default answer "{}" with hidden answer"#,
                esc_message, esc_title, esc_default,
            )
        } else {
            format!(
                r#"display dialog "{}" with title "{}" default answer "{}""#,
                esc_message, esc_title, esc_default,
            )
        };

        let output = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .map_err(|e| e.to_string())?;

        let pid = std::process::id();
        let _ = Command::new("osascript")
            .arg("-e")
            .arg(format!(
                "tell application \"System Events\" to set frontmost of (first process whose unix id is {}) to true",
                pid
            ))
            .output();

        if output.status.success() {
            let result = String::from_utf8_lossy(&output.stdout);
            // Parse AppleScript result: "text returned:VALUE, button returned:OK"
            if let Some(text_part) = result.split("text returned:").nth(1) {
                if let Some(value) = text_part.split(", button returned:").next() {
                    return Ok(Some(value.trim().to_string()));
                }
            }
        }

        Ok(None)
    }

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;

        let default_value = default.unwrap_or_default();
        // PowerShell single-quoted strings keep literal newlines, so a multi-line message renders
        // across lines in the label — the label/form grow to fit its line count.
        let ps_default = default_value.replace('\'', "''");
        let ps_title = title.replace('\'', "''");
        let ps_message = message.replace('\'', "''");
        let ps_password_flag = if sensitive { "$true" } else { "$false" };

        let line_count = message.lines().count().max(1) as i32;
        let label_height = (line_count * 18 + 8).clamp(40, 380);
        let textbox_y = 15 + label_height + 8;
        let button_y = textbox_y + 34;
        let form_height = button_y + 70;

        let powershell_script = format!(
            r#"
            Add-Type -AssemblyName System.Windows.Forms
            Add-Type -AssemblyName System.Drawing

            $form = New-Object System.Windows.Forms.Form
            $form.Text = '{title}'
            $form.Size = New-Object System.Drawing.Size(350, {form_height})
            $form.StartPosition = 'CenterScreen'
            $form.FormBorderStyle = 'FixedDialog'
            $form.MaximizeBox = $false
            $form.MinimizeBox = $false
            $form.TopMost = $true

            $label = New-Object System.Windows.Forms.Label
            $label.Location = New-Object System.Drawing.Point(10, 15)
            $label.Size = New-Object System.Drawing.Size(320, {label_height})
            $label.Text = '{message}'
            $form.Controls.Add($label)

            $textBox = New-Object System.Windows.Forms.TextBox
            $textBox.Location = New-Object System.Drawing.Point(10, {textbox_y})
            $textBox.Size = New-Object System.Drawing.Size(320, 20)
            $textBox.Text = '{default}'
            $textBox.UseSystemPasswordChar = {password}
            $form.Controls.Add($textBox)

            $okButton = New-Object System.Windows.Forms.Button
            $okButton.Location = New-Object System.Drawing.Point(175, {button_y})
            $okButton.Size = New-Object System.Drawing.Size(75, 23)
            $okButton.Text = 'OK'
            $okButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
            $form.AcceptButton = $okButton
            $form.Controls.Add($okButton)

            $cancelButton = New-Object System.Windows.Forms.Button
            $cancelButton.Location = New-Object System.Drawing.Point(255, {button_y})
            $cancelButton.Size = New-Object System.Drawing.Size(75, 23)
            $cancelButton.Text = 'Cancel'
            $cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
            $form.CancelButton = $cancelButton
            $form.Controls.Add($cancelButton)

            $form.Add_Shown({{$textBox.Select()}})
            $result = $form.ShowDialog()

            if ($result -eq [System.Windows.Forms.DialogResult]::OK) {{
                $textBox.Text
            }}
            "#,
            title = ps_title,
            message = ps_message,
            default = ps_default,
            password = ps_password_flag,
            form_height = form_height,
            label_height = label_height,
            textbox_y = textbox_y,
            button_y = button_y,
        );

        let output = Command::new("powershell")
            .args(&[
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &powershell_script,
            ])
            .output()
            .map_err(|e| e.to_string())?;

        if output.status.success() {
            let result = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !result.is_empty() || !default_value.is_empty() {
                return Ok(Some(result));
            }
        }

        Ok(None)
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let default_value = default.unwrap_or_default().to_string();
        let result = if sensitive {
            tinyfiledialogs::password_box(title, message)
        } else {
            tinyfiledialogs::input_box(title, message, &default_value)
        };
        Ok(result)
    }
}
