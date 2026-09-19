//! The mail server the app sends through: `<app_data>/notifications/smtp.json`, saved by the
//! SMTP settings screen and read at fire time by `webhooks::dispatch` for every email target.
//! Pages get a view without the password.

use std::path::PathBuf;
use std::time::Duration;

use lettre::message::header::ContentType;
use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{Message, SmtpTransport, Transport};
use serde::{Deserialize, Serialize};

use crate::scheduler::storeread::DataDir;

pub const NOT_SET_UP: &str =
    "SMTP is not set up. Save the mail server under Settings → SMTP first.";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SmtpSettings {
    pub host: String,
    pub port: u16,
    /// `starttls`, `tls` (the connection is TLS from its first byte) or `none`.
    pub encryption: String,
    pub username: String,
    pub password: String,
    pub from_address: String,
    pub from_name: String,
}

/// What a page may see: everything but the password, and whether one is saved.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmtpView {
    pub host: String,
    pub port: u16,
    pub encryption: String,
    pub username: String,
    pub has_password: bool,
    pub from_address: String,
    pub from_name: String,
}

/// What the page saves. `password: None` keeps the saved one (the field is never filled in
/// from the file); a string replaces it; an empty username drops it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmtpInput {
    pub host: String,
    pub port: u16,
    pub encryption: String,
    pub username: String,
    pub password: Option<String>,
    pub from_address: String,
    pub from_name: String,
}

#[derive(Serialize, Deserialize)]
struct SmtpFile {
    version: u32,
    #[serde(flatten)]
    settings: SmtpSettings,
}

fn smtp_path(dirs: &DataDir) -> PathBuf {
    dirs.root.join("notifications").join("smtp.json")
}

impl SmtpSettings {
    pub fn view(&self) -> SmtpView {
        SmtpView {
            host: self.host.clone(),
            port: self.port,
            encryption: self.encryption.clone(),
            username: self.username.clone(),
            has_password: !self.password.is_empty(),
            from_address: self.from_address.clone(),
            from_name: self.from_name.clone(),
        }
    }
}

/// `None` until the screen has saved a server. A file that cannot be read is an error, not
/// "not set up": the page must not offer to overwrite settings it cannot show.
pub fn load(dirs: &DataDir) -> Result<Option<SmtpSettings>, String> {
    let path = smtp_path(dirs);
    match std::fs::read_to_string(&path) {
        Ok(raw) => {
            let file: SmtpFile = serde_json::from_str(&raw)
                .map_err(|e| format!("invalid SMTP settings {}: {}", path.display(), e))?;
            Ok(Some(file.settings))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("failed to read {}: {}", path.display(), e)),
    }
}

pub fn view(dirs: &DataDir) -> Result<SmtpView, String> {
    Ok(load(dirs)?.map(|s| s.view()).unwrap_or_default())
}

fn mailbox(address: &str, name: &str) -> Result<Mailbox, String> {
    let address = address
        .trim()
        .parse()
        .map_err(|_| format!("‘{}’ is not an email address.", address.trim()))?;
    let name = name.trim();
    Ok(Mailbox::new(
        if name.is_empty() {
            None
        } else {
            Some(name.to_string())
        },
        address,
    ))
}

/// An empty host clears the settings (the file goes); anything else is checked before it is
/// kept, so a dispatch never meets a server it cannot name.
pub fn save(dirs: &DataDir, input: SmtpInput) -> Result<SmtpView, String> {
    let path = smtp_path(dirs);
    let host = input.host.trim().to_string();
    if host.is_empty() {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("failed to remove {}: {}", path.display(), e)),
        }
        return Ok(SmtpView::default());
    }
    if input.port == 0 {
        return Err("Enter a port between 1 and 65535.".to_string());
    }
    if !matches!(input.encryption.as_str(), "starttls" | "tls" | "none") {
        return Err("Choose STARTTLS, SSL / TLS or None for the encryption.".to_string());
    }
    let from_address = input.from_address.trim().to_string();
    if from_address.is_empty() {
        return Err("Enter the from address, as in rclone-ui@example.com.".to_string());
    }
    mailbox(&from_address, "")?;

    let username = input.username.trim().to_string();
    let password = if username.is_empty() {
        String::new()
    } else {
        match input.password {
            Some(password) => password,
            None => load(dirs)?.map(|s| s.password).unwrap_or_default(),
        }
    };
    let settings = SmtpSettings {
        host,
        port: input.port,
        encryption: input.encryption,
        username,
        password,
        from_address,
        from_name: input.from_name.trim().to_string(),
    };
    let file = SmtpFile {
        version: 1,
        settings: settings.clone(),
    };
    let json = serde_json::to_string_pretty(&file)
        .map_err(|e| format!("failed to serialize SMTP settings: {}", e))?;
    crate::fsutil::write_atomic(&path, json.as_bytes())
        .map_err(|e| format!("failed to save SMTP settings: {}", e))?;
    // A password in the clear: the file is the owner's alone.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(settings.view())
}

fn transport(settings: &SmtpSettings) -> Result<SmtpTransport, String> {
    let tls = match settings.encryption.as_str() {
        "none" => Tls::None,
        kind => {
            let params = TlsParameters::new(settings.host.clone())
                .map_err(|e| format!("TLS setup failed for {}: {}", settings.host, e))?;
            if kind == "tls" {
                Tls::Wrapper(params)
            } else {
                Tls::Required(params)
            }
        }
    };
    let mut builder = SmtpTransport::builder_dangerous(settings.host.as_str())
        .port(settings.port)
        .tls(tls)
        .timeout(Some(Duration::from_secs(15)));
    if !settings.username.is_empty() {
        builder = builder.credentials(Credentials::new(
            settings.username.clone(),
            settings.password.clone(),
        ));
    }
    Ok(builder.build())
}

/// One plain-text message to every address in `to`. One retry after 2s unless the server
/// refused for good (a 5xx): a greylisting 4xx or a dropped connection deserves a second try,
/// a bad password or an unknown recipient does not.
pub fn send(
    settings: &SmtpSettings,
    to: &[String],
    subject: &str,
    text: &str,
) -> Result<(), String> {
    if to.is_empty() {
        return Err("Enter at least one email address.".to_string());
    }
    let mut builder = Message::builder()
        .from(mailbox(&settings.from_address, &settings.from_name)?)
        .subject(subject)
        .header(ContentType::TEXT_PLAIN);
    for address in to {
        builder = builder.to(mailbox(address, "")?);
    }
    let message = builder
        .body(text.to_string())
        .map_err(|e| format!("could not build the email: {}", e))?;
    let mailer = transport(settings)?;

    let mut attempt = 0;
    loop {
        attempt += 1;
        match mailer.send(&message) {
            Ok(_) => return Ok(()),
            Err(e) if attempt < 2 && !e.is_permanent() => {
                std::thread::sleep(Duration::from_secs(2));
            }
            Err(e) => return Err(format!("{}", e)),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn test_dirs(tag: &str) -> DataDir {
        let root =
            std::env::temp_dir().join(format!("rcloneui-smtp-test-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        DataDir { root }
    }

    /// A one-shot SMTP server with no TLS: accepts one session, answers the way a relay does,
    /// and hands the whole client side of the conversation over (envelope and message alike).
    pub(crate) fn stub_server() -> (String, u16, std::sync::mpsc::Receiver<String>) {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut writer = stream.try_clone().unwrap();
            let mut reader = BufReader::new(stream);
            let mut heard = String::new();
            let _ = writer.write_all(b"220 stub ESMTP\r\n");
            let mut in_data = false;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    break;
                }
                heard.push_str(&line);
                let trimmed = line.trim_end_matches("\r\n");
                if in_data {
                    if trimmed == "." {
                        in_data = false;
                        let _ = writer.write_all(b"250 queued\r\n");
                    }
                    continue;
                }
                let upper = trimmed.to_ascii_uppercase();
                let reply: &[u8] = if upper.starts_with("EHLO") || upper.starts_with("HELO") {
                    b"250-stub\r\n250 OK\r\n"
                } else if upper.starts_with("DATA") {
                    in_data = true;
                    b"354 go ahead\r\n"
                } else if upper.starts_with("QUIT") {
                    let _ = writer.write_all(b"221 bye\r\n");
                    break;
                } else {
                    b"250 OK\r\n"
                };
                let _ = writer.write_all(reply);
            }
            let _ = tx.send(heard);
        });
        ("127.0.0.1".to_string(), port, rx)
    }

    fn input(host: &str, port: u16) -> SmtpInput {
        SmtpInput {
            host: host.into(),
            port,
            encryption: "none".into(),
            username: "postmaster".into(),
            password: Some("hunter2".into()),
            from_address: "rclone-ui@example.com".into(),
            from_name: "Rclone UI".into(),
        }
    }

    #[test]
    fn save_keeps_the_password_out_of_the_view_and_a_null_keeps_it() {
        let dirs = test_dirs("save");
        assert!(load(&dirs).unwrap().is_none());
        assert_eq!(view(&dirs).unwrap().host, "");

        let shown = save(&dirs, input("smtp.example.com", 587)).unwrap();
        assert_eq!(shown.host, "smtp.example.com");
        assert!(shown.has_password);
        let raw = serde_json::to_string(&shown).unwrap();
        assert!(
            !raw.contains("hunter2"),
            "the view carries the password: {}",
            raw
        );
        assert!(raw.contains("\"hasPassword\":true"), "{}", raw);

        // Saved again without a password: the saved one stays.
        let again = save(
            &dirs,
            SmtpInput {
                password: None,
                from_name: "Backups".into(),
                ..input("smtp.example.com", 587)
            },
        )
        .unwrap();
        assert!(again.has_password);
        assert_eq!(again.from_name, "Backups");
        assert_eq!(load(&dirs).unwrap().unwrap().password, "hunter2");

        // No username, no password: a relay that takes no credentials keeps none.
        let open = save(
            &dirs,
            SmtpInput {
                username: String::new(),
                password: None,
                ..input("smtp.example.com", 25)
            },
        )
        .unwrap();
        assert!(!open.has_password);
        assert_eq!(load(&dirs).unwrap().unwrap().password, "");

        // What cannot be sent to is refused before it is kept.
        assert!(save(&dirs, input("smtp.example.com", 0))
            .unwrap_err()
            .contains("port"));
        assert!(save(
            &dirs,
            SmtpInput {
                from_address: "not an address".into(),
                ..input("smtp.example.com", 587)
            }
        )
        .unwrap_err()
        .contains("not an email address"));

        // An empty host clears everything.
        let cleared = save(&dirs, input("", 587)).unwrap();
        assert_eq!(cleared.host, "");
        assert!(load(&dirs).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dirs.root);
    }

    #[test]
    fn sends_through_a_plain_server() {
        let (host, port, rx) = stub_server();
        let settings = SmtpSettings {
            host,
            port,
            encryption: "none".into(),
            username: String::new(),
            password: String::new(),
            from_address: "rclone-ui@example.com".into(),
            from_name: "Rclone UI".into(),
        };
        send(
            &settings,
            &["ops@example.com".into(), "alice@example.com".into()],
            "Test notification",
            "This is a test notification from Rclone UI.\n\n— Rclone UI v3",
        )
        .unwrap();
        let session = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            session.contains("MAIL FROM:<rclone-ui@example.com>"),
            "{}",
            session
        );
        assert!(session.contains("RCPT TO:<ops@example.com>"), "{}", session);
        assert!(
            session.contains("RCPT TO:<alice@example.com>"),
            "{}",
            session
        );
        let from = session
            .lines()
            .find(|l| l.starts_with("From:"))
            .unwrap_or_else(|| panic!("no From header in {}", session));
        assert!(
            from.contains("Rclone UI") && from.contains("<rclone-ui@example.com>"),
            "{}",
            from
        );
        assert!(
            session.contains("Subject: Test notification"),
            "{}",
            session
        );
        assert!(
            session.contains("This is a test notification from Rclone UI."),
            "{}",
            session
        );
        assert!(session.contains("Rclone UI v3"), "{}", session);
    }

    #[test]
    fn a_bad_address_is_refused_before_anything_is_sent() {
        let settings = SmtpSettings {
            host: "127.0.0.1".into(),
            port: 9,
            encryption: "none".into(),
            from_address: "rclone-ui@example.com".into(),
            ..Default::default()
        };
        let err = send(&settings, &["nope".into()], "T", "B").unwrap_err();
        assert_eq!(err, "‘nope’ is not an email address.");
        let err = send(&settings, &[], "T", "B").unwrap_err();
        assert_eq!(err, "Enter at least one email address.");
    }
}
