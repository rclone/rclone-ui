//! RPCs the server answers itself (on top of the command table): its own process, the
//! lifecycle, the machine's filesystem, and the third-party fetches a browser can't make.

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;
use crate::lifecycle::{resolve, RestartOverrides};
use crate::rt;
use crate::transfers::service::StartRequest;
use crate::Sink;
use serde_json::{json, Value};

use crate::rpc::{ok, Reply};
use crate::team::{AuthUser, Role};
use crate::{QuitKind, Shared};

pub async fn capabilities(State(st): State<Shared>) -> Response {
    Json(st.capabilities.clone()).into_response()
}

pub async fn status(State(st): State<Shared>) -> Response {
    Json(st.status()).into_response()
}

fn cap(st: &Shared, name: &str) -> bool {
    st.capabilities[name].as_bool().unwrap_or(false)
}

/// The origin of rclone's OAuth callback server, and the login's own `state`, read from the
/// daemon rather than from the page. rclone binds that server to its own loopback on a port of
/// its choosing, so the page can neither reach it (in a browser tab `127.0.0.1` is the laptop,
/// not the server) nor be trusted to name it: taking it from `config/oauthstatus` means the two
/// RPCs below never fetch a URL somebody else picked.
async fn oauth_callback(st: &Shared) -> Result<(String, String, String), String> {
    let daemon = st
        .local_daemon()
        .ok_or_else(|| "the rclone daemon is not running".to_string())?;
    let status = daemon
        .client()
        .call("/config/oauthstatus", &json!({}))
        .await?;
    if status["status"].as_str() != Some("running") {
        return Err("no sign-in is waiting".into());
    }
    let auth_url = status["authUrl"]
        .as_str()
        .ok_or_else(|| "the daemon reported no sign-in link".to_string())?;
    let parsed = reqwest::Url::parse(auth_url).map_err(|e| e.to_string())?;
    let state = parsed
        .query_pairs()
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v.into_owned())
        .ok_or_else(|| "the sign-in link carries no state".to_string())?;
    Ok((
        auth_url.to_string(),
        parsed.origin().ascii_serialization(),
        state,
    ))
}

/// How long a reconnect claim stands without being released. Long enough for a sign-in that
/// goes through another machine, short enough that a page which went away does not silence the
/// prompt until the process restarts.
const RECONNECT_CLAIM_TTL: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// One dialog per remote: each has its own token, expiring on its own schedule.
fn reconnect_key(args: &Value) -> Result<String, String> {
    str_arg(args, "remote")
}

fn str_arg(args: &Value, key: &str) -> Result<String, String> {
    args[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing '{}'", key))
}

/// Starts the quit/relaunch flow (once); returns `false` when it is already running.
pub fn request_quit(st: &Shared, kind: QuitKind) -> bool {
    if !st.begin_quit() {
        return false;
    }
    let st = st.clone();
    tokio::spawn(quit(st, kind));
    true
}

/// The quit/relaunch flow, once: stop the daemon, then exit.
async fn quit(st: Shared, kind: QuitKind) {
    if let Some(supervisor) = st.supervisor() {
        supervisor.shutdown().await;
    }
    crate::exit(kind);
}

pub async fn handle(
    st: &Shared,
    session: &str,
    caller: &AuthUser,
    name: &str,
    args: Value,
    sink: Option<Sink<Value>>,
) -> Option<Result<Reply, String>> {
    if !SERVER_RPCS.contains(&name) {
        return None;
    }
    if name.starts_with("team_") {
        return Some(team(st, caller.clone(), name, args).await);
    }
    Some(dispatch(st, session, name, args, sink).await)
}

/// Every server-owned command in one place: the arm list is the dispatch, and the names it
/// carries are `SERVER_RPCS` (the admission check and `list-commands`). Adding a command is
/// adding an arm. Team commands need a signed-in caller; the rest take the page's session and
/// stream sink. Handler bodies see the identifiers named in the group headers.
macro_rules! server_rpcs {
    (
        team($tst:ident, $tcaller:ident, $targs:ident, $tteam:ident) {
            $( $( $tname:literal )|+ => $tbody:expr ),+ $(,)?
        }
        general($st:ident, $session:ident, $name:ident, $args:ident, $sink:ident) {
            $( $( $gname:literal )|+ => $gbody:expr ),+ $(,)?
        }
    ) => {
        pub const SERVER_RPCS: &[&str] = &[ $( $( $tname, )+ )+ $( $( $gname, )+ )+ ];

        /// Settings › Team. The rules live in `team.rs`; this only reads arguments and ends
        /// the sessions of whoever lost access. Hashing runs on the blocking pool.
        async fn team(
            $tst: &Shared,
            $tcaller: AuthUser,
            $name: &str,
            $targs: Value,
        ) -> Result<Reply, String> {
            let $tteam = $tst.team.clone();
            match $name {
                $( $( $tname )|+ => $tbody, )+
                _ => Err(format!("unknown team command '{}'", $name)),
            }
        }

        async fn dispatch(
            $st: &Shared,
            $session: &str,
            $name: &str,
            $args: Value,
            $sink: Option<Sink<Value>>,
        ) -> Result<Reply, String> {
            match $name {
                $( $( $gname )|+ => $gbody, )+
                other => Err(format!("unknown command '{}'", other)),
            }
        }
    };
}

server_rpcs! {
    team(st, caller, args, team) {
        "team_list" => ok(team.list()),
        "team_add" => {
            let email = str_arg(&args, "email")?;
            let password = str_arg(&args, "password")?;
            let role = Role::parse(args["role"].as_str().unwrap_or("member"))
                .ok_or_else(|| "Invalid role.".to_string())?;
            let member = rt::spawn_blocking(move || team.add(&caller, &email, &password, role))
                .await
                .map_err(|e| e.to_string())??;
            ok(member)
        },
        "team_remove" => {
            let id = str_arg(&args, "id")?;
            team.remove(&caller, &id)?;
            st.auth.revoke_user(&id);
            ok(true)
        },
        "team_set_role" => {
            let id = str_arg(&args, "id")?;
            let role =
                Role::parse(&str_arg(&args, "role")?).ok_or_else(|| "Invalid role.".to_string())?;
            ok(team.set_role(&caller, &id, role)?)
        },
        "team_set_password" => {
            let id = str_arg(&args, "id")?;
            let password = str_arg(&args, "password")?;
            let current = args["current"].as_str().map(|s| s.to_string());
            let own = id == caller.id;
            let target = id.clone();
            rt::spawn_blocking(move || {
                team.set_password(&caller, &target, current.as_deref(), &password)
            })
            .await
            .map_err(|e| e.to_string())??;
            // A reset by an admin ends the member's sessions; your own change keeps yours.
            if !own {
                st.auth.revoke_user(&id);
            }
            ok(true)
        },
        "team_set_email" => {
            let id = str_arg(&args, "id")?;
            let email = str_arg(&args, "email")?;
            ok(team.set_email(&caller, &id, &email)?)
        },
    }
    general(st, _session, name, args, sink) {
        // --- app ---------------------------------------------------------------------------
        "log" => {
            let level = args["level"].as_str().unwrap_or("info");
            let message = args["message"].as_str().unwrap_or("");
            let target = format!(
                "page{}",
                args["label"]
                    .as_str()
                    .map(|l| format!(":{}", l))
                    .unwrap_or_default()
            );
            match level {
                "error" => log::error!(target: "page", "[{}] {}", target, message),
                "warn" => log::warn!(target: "page", "[{}] {}", target, message),
                "debug" => log::debug!(target: "page", "[{}] {}", target, message),
                "trace" => log::trace!(target: "page", "[{}] {}", target, message),
                _ => log::info!(target: "page", "[{}] {}", target, message),
            }
            ok(Value::Null)
        },
        "app_quit" | "app_relaunch" => {
            if !cap(st, "processExit") {
                return Err(
                    "The process is managed by its container; restart it from there.".into(),
                );
            }
            let kind = if name == "app_relaunch" {
                QuitKind::Relaunch
            } else {
                QuitKind::Exit
            };
            request_quit(st, kind);
            ok(Value::Null)
        },
        "app_update_check" => {
            if !cap(st, "updater") {
                return Err("Updates are not available in this deployment.".into());
            }
            let info = rt::spawn_blocking(crate::updater::check)
                .await
                .map_err(|e| e.to_string())??;
            ok(info)
        },
        "app_update_install" => {
            if !cap(st, "updater") {
                return Err("Updates are not available in this deployment.".into());
            }
            let progress = sink.unwrap_or_else(Sink::discard);
            rt::spawn_blocking(move || crate::updater::install(progress))
                .await
                .map_err(|e| e.to_string())??;
            ok(Value::Null)
        },
        "claim_reconnect_dialog" => {
            let key = reconnect_key(&args)?;
            let mut claims = st.reconnect_claims.lock().unwrap();
            let now = std::time::Instant::now();
            // A page that was closed or reloaded mid-dialog never releases its claim, and a
            // claim kept for the life of the process would silence the prompt for good. One
            // this old is treated as gone rather than held.
            let granted = !matches!(claims.get(&key), Some(at) if now.duration_since(*at) < RECONNECT_CLAIM_TTL);
            if granted {
                claims.insert(key, now);
            }
            ok(granted)
        },
        "release_reconnect_dialog" => {
            let key = reconnect_key(&args)?;
            st.reconnect_claims.lock().unwrap().remove(&key);
            ok(true)
        },

        // --- lifecycle ---------------------------------------------------------------------
        "rclone_restart" => {
            let supervisor = st
                .supervisor()
                .ok_or("the rclone daemon is external (--rclone-url); nothing to restart")?;
            let overrides: Option<RestartOverrides> = match args.get("overrides") {
                Some(v) if !v.is_null() => {
                    Some(serde_json::from_value(v.clone()).map_err(|e| e.to_string())?)
                }
                _ => None,
            };
            supervisor.request_restart(overrides);
            ok(Value::Null)
        },
        "rclone_stop" => {
            let supervisor = st.supervisor().ok_or("the rclone daemon is external")?;
            supervisor.stop().await;
            ok(Value::Null)
        },
        // --- transfers ---------------------------------------------------------------------
        // Submitting and recording are one step, so rclone never runs a transfer the ledger has
        // not heard of. The list and the details are plain reads (`transfers_list`,
        // `transfers_detail` in the command table).
        "transfers_start" => {
            let request: StartRequest = serde_json::from_value(args["transfer"].clone())
                .map_err(|e| format!("invalid 'transfer': {}", e))?;
            ok(st.transfers.start(request).await?)
        },
        "transfers_stop" => {
            st.transfers.stop(&str_arg(&args, "id")?).await?;
            ok(Value::Null)
        },

        // --- scheduler ---------------------------------------------------------------------
        // The rest of the scheduler is in the command table; this one is here because a run is
        // transfers, and those are the server's. Fire and forget, as a fire is: the page watches
        // it through `scheduler_status` and the Transfers list, not through this reply.
        "scheduler_run_now" => {
            let task_id = crate::scheduler::runnable_now(&st.ctx, &str_arg(&args, "taskId")?)?;
            tokio::spawn(crate::scheduler::runner::run(
                st.ctx.clone(),
                std::sync::Arc::clone(&st.transfers),
                task_id,
            ));
            ok(Value::Null)
        },

        "download_link" => {
            let fs = str_arg(&args, "fs")?;
            let remote = str_arg(&args, "remote")?;
            let token = st.downloads.mint(&fs, &remote);
            ok(format!("/api/dl/{}", token))
        },

        // --- filesystem --------------------------------------------------------------------

        // --- finishing a sign-in on another machine ----------------------------------------
        "oauth_auth_link" => {
            // rclone's own link only redirects to the provider; the provider's page is the part
            // another machine can actually open. Following the redirect does not consume the
            // login — rclone keeps serving it until the code arrives.
            let (auth_url, _, _) = oauth_callback(&st).await?;
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|e| e.to_string())?;
            let response = client.get(&auth_url).send().await.map_err(|e| e.to_string())?;
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "rclone did not hand back a sign-in page".to_string())?;
            ok(location.to_string())
        },
        "oauth_deliver_code" => {
            // The other machine's browser could not reach this one, so its callback is replayed
            // here instead. The state must be the login's own: a mismatched one is somebody
            // else's sign-in, and rclone would reject it anyway.
            let code = str_arg(&args, "code")?;
            let state = str_arg(&args, "state")?;
            let (_, origin, expected) = oauth_callback(&st).await?;
            if state != expected {
                return Err("that address belongs to a different sign-in".into());
            }
            let url = reqwest::Url::parse_with_params(
                &format!("{}/", origin),
                &[("code", code.as_str()), ("state", state.as_str())],
            )
            .map_err(|e| e.to_string())?;
            st.http.get(url).send().await.map_err(|e| e.to_string())?;
            ok(true)
        },
        "rclone_latest_version" => ok(resolve::latest_version().await?),
        "rclone_releases" => {
            let min = args["minVersion"].as_str().unwrap_or("1.70.0");
            let limit = args["limit"].as_u64().unwrap_or(20) as usize;
            ok(resolve::available_releases(min, limit).await?)
        },
        "winfsp_download" => {
            let url =
                "https://github.com/winfsp/winfsp/releases/download/v2.2B4/winfsp-2.2.26215.msi";
            let dir = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
            let path = dir.join("winfsp-installer.msi");
            crate::fs::download_to(&st.http, url, &path).await?;
            ok(path.to_string_lossy().into_owned())
        },
    }
}

#[cfg(test)]
mod table_tests {
    use super::SERVER_RPCS;

    /// The table is derived from the dispatch arms; what remains to check is that no name is
    /// declared twice and none shadows a portable command.
    #[test]
    fn the_table_names_each_command_once() {
        let mut names = SERVER_RPCS.to_vec();
        names.sort_unstable();
        names.dedup();
        assert_eq!(
            names.len(),
            SERVER_RPCS.len(),
            "a command is declared twice"
        );
        for name in SERVER_RPCS {
            assert!(
                !crate::commands::COMMAND_NAMES.contains(name),
                "{} is also a portable command",
                name
            );
        }
        assert_eq!(
            SERVER_RPCS
                .iter()
                .filter(|n| n.starts_with("team_"))
                .count(),
            6
        );
    }
}
