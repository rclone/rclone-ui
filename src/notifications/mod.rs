//! The notification engine: event catalog, webhook targets + dispatch, and SMTP. Pages drive it
//! through the commands below (lib/notifications.ts); the scheduler runner calls
//! webhooks::dispatch directly. There are no OS toasts: a server has no desktop to show one on,
//! so everything a person needs to see leaves over a webhook or email.

pub mod catalog;
pub mod smtp;
pub mod targets;
pub mod webhooks;

use serde::Serialize;

use crate::ctx::Ctx;

#[derive(Serialize)]
pub struct Catalog {
    pub categories: &'static [catalog::CategoryMeta],
    pub events: &'static [catalog::EventMeta],
}

pub fn notifications_catalog(_ctx: &Ctx) -> Result<Catalog, String> {
    Ok(Catalog {
        categories: &catalog::CATEGORIES,
        events: &catalog::EVENTS,
    })
}

/// The cross-process store lock can wait up to ~10s under contention — these are `sync`
/// commands in the table so hosts keep them off the async workers.
pub fn notifications_list_targets(ctx: &Ctx) -> Result<Vec<targets::NotificationTarget>, String> {
    targets::load(&ctx.dirs)
}

pub fn notifications_add_target(
    ctx: &Ctx,
    target: targets::NewTarget,
) -> Result<targets::NotificationTarget, String> {
    targets::add(&ctx.dirs, target)
}

pub fn notifications_update_target(
    ctx: &Ctx,
    id: String,
    patch: targets::TargetPatch,
) -> Result<(), String> {
    targets::update(&ctx.dirs, &id, patch)
}

pub fn notifications_remove_target(ctx: &Ctx, id: String) -> Result<(), String> {
    targets::remove(&ctx.dirs, &id)
}

/// Fire-and-forget for the caller: delivery failures are recorded per target and logged, never
/// returned as an error (matching the old TS dispatchNotification contract).
pub fn notifications_dispatch(
    ctx: &Ctx,
    event_id: String,
    title: String,
    body: String,
    data: Option<serde_json::Value>,
) -> Result<(), String> {
    let client = webhooks::http_client();
    for line in webhooks::dispatch(
        &ctx.dirs,
        &client,
        &event_id,
        &title,
        &body,
        data.unwrap_or(serde_json::Value::Null),
    ) {
        log::warn!("[notifications] {}", line);
    }
    Ok(())
}

/// The SMTP settings as a page may see them: no password, only whether one is saved.
pub fn smtp_get(ctx: &Ctx) -> Result<smtp::SmtpView, String> {
    smtp::view(&ctx.dirs)
}

pub fn smtp_set(ctx: &Ctx, settings: smtp::SmtpInput) -> Result<smtp::SmtpView, String> {
    smtp::save(&ctx.dirs, settings)
}

/// The synthetic test mail to one address, through the saved settings. Errors propagate — the
/// screen shows them.
pub fn smtp_send_test(ctx: &Ctx, to: String) -> Result<(), String> {
    webhooks::send_test(&ctx.dirs, "email", &to, None, None)
}

/// Errors propagate — the UI shows them in the "Test failed" dialog.
pub fn notifications_send_test(
    ctx: &Ctx,
    provider: String,
    url: String,
    target_id: Option<String>,
    name: Option<String>,
) -> Result<(), String> {
    webhooks::send_test(
        &ctx.dirs,
        &provider,
        &url,
        target_id.as_deref(),
        name.as_deref(),
    )
}
