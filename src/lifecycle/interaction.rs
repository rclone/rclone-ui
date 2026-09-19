//! Questions the orchestrator can't answer on its own. The desktop shell answers them with
//! native dialogs (there is no page yet at boot); the standalone server answers with policies.

use std::sync::Arc;

#[derive(Clone, Debug)]
pub enum Question {
    /// A system rclone was found on PATH; adopt it instead of managing a copy?
    AdoptSystemRclone { path: String, version: String },
    /// The configured proxy failed its connectivity test. `Continue` or `Exit`.
    ProxyUnreachable { url: String, error: String },
    /// rclone kept crashing (`attempts` in a row). `Relaunch` starts over now, `Exit` gives up;
    /// anything else keeps retrying at the longest backoff.
    RcloneCrashed { code: Option<i32>, attempts: u32 },
    /// rclone could not be started `attempts` times in a row. `Relaunch` starts over now,
    /// `Continue` keeps retrying with backoff, `No` parks until a restart is requested, `Exit`
    /// gives up.
    StartFailed { error: String, attempts: u32 },
    /// Quit/relaunch was requested while transfers are active. `Yes` proceeds.
    QuitWithActiveTransfers { relaunch: bool, active: usize },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    Yes,
    No,
    Text(String),
    Retry,
    Continue,
    Relaunch,
    Exit,
}

pub trait Interaction: Send + Sync {
    /// May block (a native dialog). Callers run it off the async workers.
    fn decide(&self, question: Question) -> Decision;
}

/// The standalone server's answers: never block, never prompt.
pub struct ServerPolicy;

impl Interaction for ServerPolicy {
    fn decide(&self, question: Question) -> Decision {
        match question {
            Question::AdoptSystemRclone { .. } => Decision::Yes,
            Question::ProxyUnreachable { .. } => Decision::Continue,
            // A headless server has nobody to click Relaunch: keep trying, backing off.
            Question::RcloneCrashed { .. } => Decision::Continue,
            Question::StartFailed { .. } => Decision::Continue,
            Question::QuitWithActiveTransfers { .. } => Decision::Yes,
        }
    }
}

pub type SharedInteraction = Arc<dyn Interaction>;

/// Runs a (possibly blocking) question on the blocking pool.
pub async fn ask(interaction: &SharedInteraction, question: Question) -> Decision {
    let interaction = Arc::clone(interaction);
    crate::rt::spawn_blocking(move || interaction.decide(question))
        .await
        .unwrap_or(Decision::No)
}
