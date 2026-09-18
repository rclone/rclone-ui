//! Accounts for the browser server: who may sign in and what they may change. Owned by the
//! server and never a state document (`/api/state` cannot read it), kept as
//! `<app_data>/state/team.json` with argon2id password hashes. The first start seeds the owner
//! from `--password` / `--email`; the owner is the one account nobody else can remove, demote or
//! reset.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use serde::{Deserialize, Serialize};

pub const DEFAULT_OWNER_EMAIL: &str = "admin@localhost";
pub const MIN_PASSWORD_LEN: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Owner,
    Admin,
    Member,
}

impl Role {
    pub fn parse(value: &str) -> Option<Role> {
        match value {
            "owner" => Some(Role::Owner),
            "admin" => Some(Role::Admin),
            "member" => Some(Role::Member),
            _ => None,
        }
    }

    /// Owners and admins run the team.
    pub fn manages(self) -> bool {
        matches!(self, Role::Owner | Role::Admin)
    }

    fn rank(self) -> u8 {
        match self {
            Role::Owner => 0,
            Role::Admin => 1,
            Role::Member => 2,
        }
    }
}

/// Who is calling, as the session resolved it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub id: String,
    pub email: String,
    pub role: Role,
}

/// A user as the pages see it: no hash.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub id: String,
    pub email: String,
    pub role: Role,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct User {
    id: String,
    email: String,
    role: Role,
    password_hash: String,
    created_at: String,
}

impl User {
    fn member(&self) -> Member {
        Member {
            id: self.id.clone(),
            email: self.email.clone(),
            role: self.role,
            created_at: self.created_at.clone(),
        }
    }

    fn auth(&self) -> AuthUser {
        AuthUser {
            id: self.id.clone(),
            email: self.email.clone(),
            role: self.role,
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
struct TeamFile {
    version: u32,
    users: Vec<User>,
}

pub struct Team {
    path: PathBuf,
    users: Mutex<Vec<User>>,
    /// Verified against for unknown emails, so a miss costs the same as a wrong password.
    decoy: String,
}

fn hash(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hashed| hashed.to_string())
        .map_err(|e| format!("failed to hash the password: {}", e))
}

fn verify(hash: &str, password: &str) -> bool {
    PasswordHash::new(hash)
        .map(|parsed| {
            Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .is_ok()
        })
        .unwrap_or(false)
}

/// Trimmed and lower-cased; one `@` with something on both sides and no spaces.
pub fn normalize_email(raw: &str) -> Result<String, String> {
    let email = raw.trim().to_lowercase();
    let shape = email
        .split_once('@')
        .map(|(user, host)| !user.is_empty() && !host.is_empty() && !host.contains('@'))
        .unwrap_or(false);
    if shape && !email.contains(char::is_whitespace) {
        Ok(email)
    } else {
        Err(format!("'{}' is not an email address.", raw.trim()))
    }
}

fn check_password(password: &str) -> Result<(), String> {
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(format!(
            "The password needs at least {} characters.",
            MIN_PASSWORD_LEN
        ));
    }
    Ok(())
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

impl Team {
    /// Reads `<dir>/team.json` when it exists; an empty team otherwise.
    pub fn open(dir: &Path) -> Result<Team, String> {
        let path = dir.join("team.json");
        let users = match std::fs::read(&path) {
            Ok(raw) => {
                serde_json::from_slice::<TeamFile>(&raw)
                    .map_err(|e| format!("invalid {}: {}", path.display(), e))?
                    .users
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(format!("failed to read {}: {}", path.display(), e)),
        };
        Ok(Team {
            path,
            users: Mutex::new(users),
            decoy: hash("decoy")?,
        })
    }

    pub fn count(&self) -> usize {
        self.users.lock().unwrap().len()
    }

    pub fn owner_email(&self) -> Option<String> {
        self.users
            .lock()
            .unwrap()
            .iter()
            .find(|u| u.role == Role::Owner)
            .map(|u| u.email.clone())
    }

    /// The owner, created once: with accounts on disk this does nothing and returns `false`.
    /// The seed password is taken as given (it is the deployment's own choice), unlike the
    /// ones set through the pages.
    pub fn seed(&self, email: &str, password: &str) -> Result<bool, String> {
        let email = normalize_email(email)?;
        let mut users = self.users.lock().unwrap();
        if !users.is_empty() {
            return Ok(false);
        }
        users.push(User {
            id: uuid::Uuid::new_v4().to_string(),
            email,
            role: Role::Owner,
            password_hash: hash(password)?,
            created_at: now(),
        });
        Self::save(&self.path, &users)?;
        Ok(true)
    }

    /// The account behind an email + password, or nothing. The hash check runs outside the lock.
    pub fn verify(&self, email: &str, password: &str) -> Option<AuthUser> {
        let email = normalize_email(email).ok()?;
        let (stored, user) = {
            let users = self.users.lock().unwrap();
            match users.iter().find(|u| u.email == email) {
                Some(u) => (u.password_hash.clone(), Some(u.auth())),
                None => (self.decoy.clone(), None),
            }
        };
        if verify(&stored, password) {
            user
        } else {
            None
        }
    }

    pub fn get(&self, id: &str) -> Option<AuthUser> {
        self.users
            .lock()
            .unwrap()
            .iter()
            .find(|u| u.id == id)
            .map(User::auth)
    }

    /// Owner first, then admins, then members, each group by email.
    pub fn list(&self) -> Vec<Member> {
        let mut members: Vec<Member> = self
            .users
            .lock()
            .unwrap()
            .iter()
            .map(User::member)
            .collect();
        members.sort_by(|a, b| {
            a.role
                .rank()
                .cmp(&b.role.rank())
                .then_with(|| a.email.cmp(&b.email))
        });
        members
    }

    pub fn add(
        &self,
        caller: &AuthUser,
        email: &str,
        password: &str,
        role: Role,
    ) -> Result<Member, String> {
        if !caller.role.manages() {
            return Err("Only admins can add members.".into());
        }
        if role == Role::Owner {
            return Err("There is only one owner.".into());
        }
        let email = normalize_email(email)?;
        check_password(password)?;
        let password_hash = hash(password)?;
        let mut users = self.users.lock().unwrap();
        if users.iter().any(|u| u.email == email) {
            return Err(format!("{} is already a member.", email));
        }
        let user = User {
            id: uuid::Uuid::new_v4().to_string(),
            email,
            role,
            password_hash,
            created_at: now(),
        };
        users.push(user.clone());
        Self::save(&self.path, &users)?;
        Ok(user.member())
    }

    pub fn remove(&self, caller: &AuthUser, id: &str) -> Result<(), String> {
        if !caller.role.manages() {
            return Err("Only admins can remove members.".into());
        }
        if id == caller.id {
            return Err("You cannot remove yourself.".into());
        }
        let mut users = self.users.lock().unwrap();
        let index = users
            .iter()
            .position(|u| u.id == id)
            .ok_or_else(|| "No such member.".to_string())?;
        if users[index].role == Role::Owner {
            return Err("The owner cannot be removed.".into());
        }
        users.remove(index);
        Self::save(&self.path, &users)
    }

    pub fn set_role(&self, caller: &AuthUser, id: &str, role: Role) -> Result<Member, String> {
        if !caller.role.manages() {
            return Err("Only admins can change roles.".into());
        }
        if role == Role::Owner {
            return Err("There is only one owner.".into());
        }
        if id == caller.id {
            return Err("You cannot change your own role.".into());
        }
        let mut users = self.users.lock().unwrap();
        let user = users
            .iter_mut()
            .find(|u| u.id == id)
            .ok_or_else(|| "No such member.".to_string())?;
        if user.role == Role::Owner {
            return Err("The owner's role cannot change.".into());
        }
        user.role = role;
        let member = user.member();
        Self::save(&self.path, &users)?;
        Ok(member)
    }

    /// Your own password needs the current one; an admin resets anyone but the owner.
    pub fn set_password(
        &self,
        caller: &AuthUser,
        id: &str,
        current: Option<&str>,
        password: &str,
    ) -> Result<(), String> {
        check_password(password)?;
        let (role, stored) = {
            let users = self.users.lock().unwrap();
            let user = users
                .iter()
                .find(|u| u.id == id)
                .ok_or_else(|| "No such member.".to_string())?;
            (user.role, user.password_hash.clone())
        };
        if id == caller.id {
            let current = current.ok_or_else(|| "The current password is required.".to_string())?;
            if !verify(&stored, current) {
                return Err("The current password is wrong.".into());
            }
        } else if !caller.role.manages() {
            return Err("Only admins can reset passwords.".into());
        } else if role == Role::Owner {
            return Err("Only the owner can change the owner's password.".into());
        }
        let password_hash = hash(password)?;
        let mut users = self.users.lock().unwrap();
        let user = users
            .iter_mut()
            .find(|u| u.id == id)
            .ok_or_else(|| "No such member.".to_string())?;
        user.password_hash = password_hash;
        Self::save(&self.path, &users)
    }

    pub fn set_email(&self, caller: &AuthUser, id: &str, email: &str) -> Result<Member, String> {
        let email = normalize_email(email)?;
        let mut users = self.users.lock().unwrap();
        let target = users
            .iter()
            .find(|u| u.id == id)
            .ok_or_else(|| "No such member.".to_string())?;
        if id != caller.id {
            if !caller.role.manages() {
                return Err("Only admins can change other members' emails.".into());
            }
            if target.role == Role::Owner {
                return Err("Only the owner can change the owner's email.".into());
            }
        }
        if users.iter().any(|u| u.email == email && u.id != id) {
            return Err(format!("{} is already a member.", email));
        }
        let user = users.iter_mut().find(|u| u.id == id).expect("found above");
        user.email = email;
        let member = user.member();
        Self::save(&self.path, &users)?;
        Ok(member)
    }

    fn save(path: &Path, users: &[User]) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let body = serde_json::to_vec_pretty(&TeamFile {
            version: 1,
            users: users.to_vec(),
        })
        .map_err(|e| e.to_string())?;
        rclone_ui_shared::fsutil::write_atomic(path, &body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> (Team, PathBuf) {
        let dir = std::env::temp_dir().join(format!("rclone-ui-team-{}", uuid::Uuid::new_v4()));
        (Team::open(&dir).unwrap(), dir)
    }

    fn by_email(team: &Team, email: &str) -> AuthUser {
        let member = team
            .list()
            .into_iter()
            .find(|m| m.email == email)
            .expect("member");
        team.get(&member.id).unwrap()
    }

    #[test]
    fn seeds_the_owner_once_and_reloads_it() {
        let (team, dir) = fresh();
        assert!(team.seed(" Admin@Example.com ", "first-secret").unwrap());
        assert_eq!(team.count(), 1);
        assert_eq!(team.owner_email().as_deref(), Some("admin@example.com"));
        // A later start with another flag value changes nothing.
        assert!(!team.seed("other@example.com", "second-secret").unwrap());
        assert!(team.verify("ADMIN@example.com", "first-secret").is_some());
        assert!(team.verify("admin@example.com", "second-secret").is_none());
        // The file is the truth for the next process.
        let reopened = Team::open(&dir).unwrap();
        assert_eq!(reopened.owner_email().as_deref(), Some("admin@example.com"));
        assert_eq!(
            reopened
                .verify("admin@example.com", "first-secret")
                .unwrap()
                .role,
            Role::Owner
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn verify_rejects_unknown_emails_and_wrong_passwords() {
        let (team, dir) = fresh();
        team.seed(DEFAULT_OWNER_EMAIL, "owner-secret").unwrap();
        assert!(team.verify("nobody@example.com", "owner-secret").is_none());
        assert!(team.verify(DEFAULT_OWNER_EMAIL, "wrong").is_none());
        assert!(team.verify("not an email", "owner-secret").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn admins_manage_members_but_never_the_owner_or_themselves() {
        let (team, dir) = fresh();
        team.seed(DEFAULT_OWNER_EMAIL, "owner-secret").unwrap();
        let owner = by_email(&team, DEFAULT_OWNER_EMAIL);
        team.add(&owner, "Alex@Example.com", "alex-secret", Role::Admin)
            .unwrap();
        let alex = by_email(&team, "alex@example.com");
        team.add(&alex, "pat@example.com", "pat-secret1", Role::Member)
            .unwrap();
        let pat = by_email(&team, "pat@example.com");

        assert!(team
            .add(&pat, "x@example.com", "x-secret-1", Role::Member)
            .unwrap_err()
            .contains("Only admins"));
        assert!(team
            .add(&alex, "PAT@example.com", "pat-secret1", Role::Member)
            .unwrap_err()
            .contains("already"));
        assert!(team
            .add(&alex, "y@example.com", "short", Role::Member)
            .unwrap_err()
            .contains("8 characters"));
        assert!(team
            .add(&alex, "y@example.com", "y-secret-1", Role::Owner)
            .unwrap_err()
            .contains("only one owner"));

        assert!(team.remove(&alex, &owner.id).unwrap_err().contains("owner"));
        assert!(team
            .remove(&alex, &alex.id)
            .unwrap_err()
            .contains("yourself"));
        assert!(team
            .set_role(&alex, &owner.id, Role::Member)
            .unwrap_err()
            .contains("owner"));
        assert!(team
            .set_role(&alex, &alex.id, Role::Member)
            .unwrap_err()
            .contains("own role"));
        assert_eq!(
            team.set_role(&alex, &pat.id, Role::Admin).unwrap().role,
            Role::Admin
        );
        assert_eq!(
            team.set_role(&owner, &pat.id, Role::Member).unwrap().role,
            Role::Member
        );

        team.remove(&alex, &pat.id).unwrap();
        assert!(team.get(&pat.id).is_none());
        assert_eq!(team.list().len(), 2);
        assert_eq!(team.list()[0].role, Role::Owner);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn passwords_and_emails_change_under_the_rules() {
        let (team, dir) = fresh();
        team.seed(DEFAULT_OWNER_EMAIL, "owner-secret").unwrap();
        let owner = by_email(&team, DEFAULT_OWNER_EMAIL);
        team.add(&owner, "alex@example.com", "alex-secret", Role::Admin)
            .unwrap();
        let alex = by_email(&team, "alex@example.com");
        team.add(&owner, "pat@example.com", "pat-secret1", Role::Member)
            .unwrap();
        let pat = by_email(&team, "pat@example.com");

        // Your own password needs the current one.
        assert!(team
            .set_password(&pat, &pat.id, None, "pat-secret2")
            .unwrap_err()
            .contains("current"));
        assert!(team
            .set_password(&pat, &pat.id, Some("nope"), "pat-secret2")
            .unwrap_err()
            .contains("wrong"));
        team.set_password(&pat, &pat.id, Some("pat-secret1"), "pat-secret2")
            .unwrap();
        assert!(team.verify("pat@example.com", "pat-secret1").is_none());
        assert!(team.verify("pat@example.com", "pat-secret2").is_some());
        // Admins reset members; nobody but the owner touches the owner.
        assert!(team
            .set_password(&pat, &alex.id, None, "alex-secret2")
            .unwrap_err()
            .contains("Only admins"));
        team.set_password(&alex, &pat.id, None, "pat-secret3")
            .unwrap();
        assert!(team.verify("pat@example.com", "pat-secret3").is_some());
        assert!(team
            .set_password(&alex, &owner.id, None, "owner-secret2")
            .unwrap_err()
            .contains("owner"));
        team.set_password(&owner, &owner.id, Some("owner-secret"), "owner-secret2")
            .unwrap();
        assert!(team.verify(DEFAULT_OWNER_EMAIL, "owner-secret2").is_some());

        // Emails: your own, or an admin for a member; unique after normalisation.
        assert_eq!(
            team.set_email(&pat, &pat.id, " Pat.New@Example.com")
                .unwrap()
                .email,
            "pat.new@example.com"
        );
        assert!(team
            .set_email(&pat, &alex.id, "z@example.com")
            .unwrap_err()
            .contains("Only admins"));
        assert!(team
            .set_email(&alex, &pat.id, "ALEX@example.com")
            .unwrap_err()
            .contains("already"));
        assert!(team
            .set_email(&alex, &owner.id, "boss@example.com")
            .unwrap_err()
            .contains("owner"));
        assert_eq!(
            team.set_email(&owner, &owner.id, "boss@example.com")
                .unwrap()
                .email,
            "boss@example.com"
        );
        assert!(team
            .set_email(&pat, &pat.id, "not-an-email")
            .unwrap_err()
            .contains("not an email"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
