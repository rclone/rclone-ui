//! The notification engine: the event catalog, the webhook targets and their dispatch, and SMTP.
//! Pages drive it through the RPCs (lib/notifications.ts); a transfer's end, a crash and a
//! scheduled run call [`notify`] or [`dispatch`] themselves. Everything a person needs to see
//! leaves over a webhook or an email.

pub mod catalog;
pub mod smtp;
pub mod targets;
pub mod webhooks;

use serde::Serialize;
use serde_json::Value;

use crate::datadir::DataDir;

#[derive(Serialize)]
pub struct Catalog {
    pub categories: &'static [catalog::CategoryMeta],
    pub events: &'static [catalog::EventMeta],
}

pub fn catalog() -> Catalog {
    Catalog {
        categories: &catalog::CATEGORIES,
        events: &catalog::EVENTS,
    }
}

/// Sends `event_id` to every target subscribed to it and records what each delivery did.
/// Delivery failures come back as log lines, never as an error.
pub async fn dispatch(
    dirs: &DataDir,
    event_id: &str,
    title: &str,
    body: &str,
    data: Value,
) -> Vec<String> {
    webhooks::dispatch(dirs, event_id, title, body, data).await
}

/// [`dispatch`], fire and forget: on its own task, so one endpoint that does not answer holds
/// up nothing else. The handle is for the rare caller that must not say two things out of order.
pub fn notify(
    dirs: &DataDir,
    event_id: &str,
    title: &str,
    body: &str,
    data: Value,
) -> tokio::task::JoinHandle<()> {
    let dirs = dirs.clone();
    let event_id = event_id.to_string();
    let title = title.to_string();
    let body = body.to_string();
    tokio::spawn(async move {
        for line in webhooks::dispatch(&dirs, &event_id, &title, &body, data).await {
            log::warn!("[notifications] {}", line);
        }
    })
}

/// The synthetic test message to one target, saved or not. Errors propagate: the screen shows
/// them.
pub async fn send_test(
    dirs: &DataDir,
    provider: &str,
    url: &str,
    target_id: Option<&str>,
    name: Option<&str>,
) -> Result<(), String> {
    webhooks::send_test(dirs, provider, url, target_id, name).await
}
