use std::process::Command;

use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct RcSession {
    pub user: String,
    pub pass: String,
}

impl RcSession {
    pub fn new() -> Self {
        Self {
            user: "rclone-ui".to_string(),
            pass: random_secret(),
        }
    }
}

pub fn random_secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

pub fn is_rc_variable(key: &str) -> bool {
    key.to_ascii_uppercase().starts_with("RCLONE_RC_")
}

pub fn set_rc_credentials(cmd: &mut Command, user: &str, pass: &str) {
    for (key, _) in std::env::vars_os() {
        if key.to_str().is_some_and(is_rc_variable) {
            cmd.env_remove(&key);
        }
    }
    cmd.env("RCLONE_RC_USER", user);
    cmd.env("RCLONE_RC_PASS", pass);
}

#[tauri::command]
pub fn rc_session(session: tauri::State<'_, RcSession>) -> RcSession {
    session.inner().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_long_and_different() {
        let a = random_secret();
        let b = random_secret();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn rc_variables() {
        assert!(is_rc_variable("RCLONE_RC_USER"));
        assert!(is_rc_variable("rclone_rc_htpasswd"));
        assert!(!is_rc_variable("RCLONE_CONFIG"));
        assert!(!is_rc_variable("RCLONE_RCD"));
    }

    #[test]
    fn credentials_replace_inherited_rc_variables() {
        std::env::set_var("RCLONE_RC_ADDR", "localhost:9999");
        let mut cmd = Command::new("rclone");
        set_rc_credentials(&mut cmd, "u", "p");
        std::env::remove_var("RCLONE_RC_ADDR");

        let envs: Vec<(String, Option<String>)> = cmd
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert!(envs.contains(&("RCLONE_RC_ADDR".to_string(), None)));
        assert!(envs.contains(&("RCLONE_RC_USER".to_string(), Some("u".to_string()))));
        assert!(envs.contains(&("RCLONE_RC_PASS".to_string(), Some("p".to_string()))));
    }
}
