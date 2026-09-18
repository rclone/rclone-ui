//! The server's side of the ledger: it starts transfers, watches them to the end and writes what
//! happened. One per server process, alive with no page open, which is how a transfer's outcome
//! gets recorded (and its webhook sent) while nobody is looking.
//!
//! The pages build the request and hand it over ([`TransferService::start`]): it is submitted
//! and recorded in the same breath, before the page hears back.
//!
//! A transfer ends once. Whatever wants to write an end — the tick that saw the job finish, a
//! stop from a page, the daemon going down — first takes the transfer out of the watched set
//! ([`TransferService::claim`]); whoever comes second finds nothing and writes nothing.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::ctx::Ctx;
use crate::lifecycle::notify;
use crate::rc::RcClient;
use crate::scheduler::history::now_iso;
use crate::scheduler::jobfile::RcRequest;

use super::ledger::{self, Finished, Line, Started, State, Stats};
use super::status::{self, merge_failed, Failed, Verdict};

const POLL_INTERVAL: Duration = Duration::from_secs(5);
/// How long one question to a daemon may take. The rc client's own limit is minutes, for calls
/// that do work; these only read, and one host that accepts a connection and never answers
/// must not hold up the watching of the others.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a daemon may stay out of reach before its transfer is given up as
/// [`State::Unknown`]. A daemon that outlives us (a NAS over a VPN, this machine waking from
/// sleep) is out of reach for a while and then back with the transfer still running: giving up
/// is for good, so it waits. The managed daemon is not waited for here: the supervisor says
/// when it went down ([`TransferService::daemon_stopped`]).
const LOST_AFTER: Duration = Duration::from_secs(10 * 60);
/// How long a fresh transfer gets to fail before `start` answers: a wrong path or a refused
/// login ends a job within moments, and the page wants that as the error of its START button.
const LAUNCH_GRACE: Duration = Duration::from_secs(1);
/// How long "started" gets to be delivered before the end of a transfer that is already over
/// is said: the two go out side by side, and should arrive in the order they happened.
const SAID_FIRST: Duration = Duration::from_secs(3);
/// What a page may start through here. The builders emit nothing else (`lib/rclone/requests.ts`).
const START_ENDPOINTS: &[&str] = &["/job/batch", "/sync/sync", "/sync/bisync"];

pub const LOCAL: &str = "local";

/// Builds an `RcClient` for a host id, `local` included (the server provides it).
pub type HostResolver = Arc<dyn Fn(&str) -> Option<RcClient> + Send + Sync>;

/// What a page sends to start a transfer: the request its builders made, and what to remember
/// about it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    #[serde(default)]
    pub host_id: Option<String>,
    pub operation: String,
    #[serde(default)]
    pub sources: Vec<String>,
    #[serde(default)]
    pub destination: Option<String>,
    #[serde(default)]
    pub is_dry_run: bool,
    #[serde(default)]
    pub preset: Option<Value>,
    /// The transfer whose failures this one retries.
    #[serde(default)]
    pub retry_of: Option<String>,
    /// Where the page says it came from (`page_tags` decides what of that is kept).
    #[serde(default)]
    pub tags: Vec<String>,
    pub request: RcRequest,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartReply {
    pub id: String,
    pub jobid: i64,
}

/// A transfer being watched, and what is only known while it is.
struct Watched {
    started: Started,
    /// The files that failed so far.
    failed: Failed,
    /// Since when its daemon has not answered; `None` while it does.
    unreachable_since: Option<Instant>,
    /// `start` has not looked at it yet. It does so itself a moment after submitting, and says
    /// what it finds; until then the ticker leaves it alone, or it could end the transfer and
    /// say "completed" before "started" was said.
    launching: bool,
}

pub struct TransferService {
    ctx: Ctx,
    /// `local` is a daemon this process spawns, so its transfers die with it; otherwise
    /// (`--rclone-url`) it outlives us like any remote host.
    managed_local: bool,
    watched: Mutex<HashMap<String, Watched>>,
    resolver: RwLock<Option<HostResolver>>,
}

/// The tags a page may give its transfer: short lowercase words, each once, and never
/// [`ledger::TAG_SCHEDULE`]. That one sends a row to the Schedules page and keeps rclone from
/// being asked about it, so only the scheduled runner writes it.
pub fn page_tags(given: Vec<String>) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    for tag in given {
        let tag = tag.trim().to_lowercase();
        if tag.is_empty() || tag.len() > 32 || tag == ledger::TAG_SCHEDULE || tags.contains(&tag) {
            continue;
        }
        tags.push(tag);
    }
    tags.truncate(8);
    tags
}

fn is_lost(since: Instant, now: Instant) -> bool {
    now.duration_since(since) >= LOST_AFTER
}

/// How long a transfer has been going, from its id: the ids made here begin with the
/// millisecond they were made at. For the ends rclone gives no duration for (a stop).
fn elapsed_ms(started: &Started) -> u64 {
    let Some(began) = started
        .id
        .split('-')
        .next()
        .and_then(|ms| ms.parse::<u128>().ok())
    else {
        return 0;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    now.saturating_sub(began) as u64
}

fn group_of(started: &Started) -> Value {
    json!({ "group": format!("job/{}", started.jobid) })
}

fn describe(started: &Started) -> String {
    let sources = &started.sources;
    let source_label = if sources.len() > 2 {
        format!("{} and {} more", sources[..2].join(", "), sources.len() - 2)
    } else {
        sources.join(", ")
    };
    let mut description = started.operation.clone();
    if !source_label.is_empty() {
        description.push_str(&format!(" of {}", source_label));
    }
    if let Some(destination) = &started.destination {
        description.push_str(&format!(" to {}", destination));
    }
    description
}

fn webhook_data(started: &Started) -> Value {
    json!({
        "jobid": started.jobid,
        "operation": started.operation,
        "sources": started.sources,
        "destination": started.destination,
    })
}

impl TransferService {
    pub fn new(ctx: Ctx, managed_local: bool) -> Arc<Self> {
        Arc::new(TransferService {
            ctx,
            managed_local,
            watched: Mutex::new(HashMap::new()),
            resolver: RwLock::new(None),
        })
    }

    pub fn set_host_resolver(&self, resolver: HostResolver) {
        *self.resolver.write().unwrap() = Some(resolver);
    }

    fn client_for(&self, host: &str) -> Option<RcClient> {
        let resolver = self.resolver.read().unwrap().clone()?;
        resolver(host)
    }

    /// What a previous process left open. A managed daemon died with that process, so its
    /// transfers were interrupted; anything else may still be running and is watched again
    /// (whether its daemon is still the same one shows at the first look).
    pub fn recover(&self) {
        for path in ledger::host_files(&self.ctx.dirs) {
            for started in ledger::open(&path) {
                if started.host_id == LOCAL && self.managed_local {
                    self.write_end(&started, State::Interrupted, None, None);
                } else {
                    self.hold(started, false);
                }
            }
        }
    }

    /// The managed daemon is gone (stopped, restarted, crashed): what ran on it went with it.
    pub fn daemon_stopped(&self) {
        let local: Vec<String> = {
            let watched = self.watched.lock().unwrap();
            let on_local = watched.values().filter(|w| w.started.host_id == LOCAL);
            on_local.map(|w| w.started.id.clone()).collect()
        };
        for watched in local.iter().filter_map(|id| self.claim(id)) {
            self.write_end(&watched.started, State::Interrupted, None, None);
        }
    }

    /// How many running transfers a quit would stop: those of the daemon this process spawned.
    /// A daemon it did not spawn (`--rclone-url`) and a remote host's carry on without it.
    pub fn stopped_by_quit(&self) -> usize {
        if !self.managed_local {
            return 0;
        }
        let watched = self.watched.lock().unwrap();
        watched
            .values()
            .filter(|w| w.started.host_id == LOCAL)
            .count()
    }

    pub async fn start(&self, request: StartRequest) -> Result<StartReply, String> {
        let host_id = request
            .host_id
            .clone()
            .filter(|host| !host.is_empty())
            .unwrap_or_else(|| LOCAL.to_string());
        // It names a file.
        let host_id = crate::scheduler::sanitize_id(&host_id).map_err(|_| "invalid host id")?;
        let endpoint = request.request.endpoint.as_str();
        if !START_ENDPOINTS.contains(&endpoint) {
            return Err(format!("'{}' does not start a transfer", endpoint));
        }
        let client = self
            .client_for(&host_id)
            .ok_or("the rclone daemon is not running yet")?;

        // One attempt: a start that is retried because its reply got lost runs twice.
        let mut body = request.request.body.clone();
        body["_async"] = Value::Bool(true);
        let submitted = client.call(endpoint, &body).await?;
        let jobid = submitted["jobid"]
            .as_i64()
            .ok_or("Failed to start operation")?;

        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let started = Started {
            id: format!(
                "{}-{}-{}",
                millis,
                jobid,
                &crate::rc::random_token(&host_id)[..6]
            ),
            ts: now_iso(),
            host_id,
            // Which daemon took it, in the same reply as the job's id.
            execute_id: submitted["executeId"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            jobid,
            operation: request.operation,
            sources: request.sources,
            destination: request.destination,
            is_dry_run: request.is_dry_run,
            preset: request.preset,
            retry_of: request.retry_of,
            tags: page_tags(request.tags),
            ..Started::default()
        };
        let reply = StartReply {
            id: started.id.clone(),
            jobid,
        };
        self.watch(started.clone(), true);
        // What a retry of its failures is made from, on disk from the start: a server that
        // restarts and watches this transfer again has nothing in memory.
        self.keep_request(
            &started.id,
            &RcRequest {
                endpoint: endpoint.to_string(),
                body,
            },
        );
        tokio::time::sleep(LAUNCH_GRACE).await;
        // A status that can't be read is not a failed launch: the transfer is recorded and
        // watched, and the next tick asks again.
        let status = probe(&client, "/job/status", &json!({ "jobid": jobid }))
            .await
            .ok();
        // A launch that died says so once, as the failure it is (and as this call's error),
        // and never as a start: "started" is for a transfer that got going.
        let launch_error = status.as_ref().and_then(status::launch_error);
        let said = (launch_error.is_none() && !started.is_dry_run).then(|| {
            notify(
                &self.ctx,
                "job.started",
                "Transfer started",
                &describe(&started),
                webhook_data(&started),
            )
        });
        if let Some(status) = &status {
            if let Some((state, error)) = status::outcome_of(status) {
                // Over already, so its end is about to be said too. Notifications go out side
                // by side: "started" is given a moment to land first, and no longer than that
                // (an endpoint that does not answer must not hold the START button).
                if let Some(said) = said {
                    let _ = tokio::time::timeout(SAID_FIRST, said).await;
                }
                self.finish(&client, &started.id, state, error, status)
                    .await;
            }
        }
        // The launch check is done, and whatever it had to say is said: the ticker's from here.
        self.launched(&started.id);
        if let Some(error) = launch_error {
            return Err(error);
        }
        Ok(reply)
    }

    /// Stops a running transfer. Claimed first: a stopped job ends with "context canceled", and
    /// a tick that read that must find the transfer already spoken for, not record a failure.
    pub async fn stop(&self, id: &str) -> Result<(), String> {
        let mut watched = self.claim(id).ok_or("This transfer is not running.")?;
        let stopped = match self.client_for(&watched.started.host_id) {
            Some(client) => client
                .call("/job/stopgroup", &group_of(&watched.started))
                .await
                .map(|_| client),
            None => Err("the rclone daemon is not running yet".to_string()),
        };
        match stopped {
            Ok(client) => {
                let stats = self.snapshot(&client, &mut watched, &json!({})).await;
                self.write_end(&watched.started, State::Stopped, None, Some(stats));
                Ok(())
            }
            // Still running, so still watched.
            Err(error) => {
                let mut all = self.watched.lock().unwrap();
                all.insert(id.to_string(), watched);
                Err(error)
            }
        }
    }

    pub fn spawn_ticker(self: &Arc<Self>) {
        let service = Arc::clone(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(POLL_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                service.tick().await;
            }
        });
    }

    /// One look at everything watched: the hosts side by side, a host's transfers in turn, so a
    /// host that is slow to answer holds up nobody but itself.
    async fn tick(self: &Arc<Self>) {
        let mut hosts = tokio::task::JoinSet::new();
        for transfers in self.due().into_values() {
            let service = Arc::clone(self);
            hosts.spawn(async move {
                for started in transfers {
                    service.check(&started).await;
                }
            });
        }
        while hosts.join_next().await.is_some() {}
    }

    /// What a tick looks at, by host: everything watched but what is still being launched.
    fn due(&self) -> HashMap<String, Vec<Started>> {
        let mut by_host: HashMap<String, Vec<Started>> = HashMap::new();
        let all = self.watched.lock().unwrap();
        for watched in all.values().filter(|watched| !watched.launching) {
            let host = by_host.entry(watched.started.host_id.clone());
            host.or_default().push(watched.started.clone());
        }
        by_host
    }

    async fn check(&self, started: &Started) {
        let Some(client) = self.client_for(&started.host_id) else {
            return self.unreachable(started, "its rclone daemon is not available");
        };
        let reply = probe(&client, "/job/status", &json!({ "jobid": started.jobid })).await;
        match status::verdict(&started.execute_id, reply) {
            Verdict::Running => self.collect_failed(&client, started).await,
            Verdict::Ended {
                state,
                error,
                status,
            } => {
                self.finish(&client, &started.id, state, error, &status)
                    .await
            }
            Verdict::AnotherDaemon => self.give_up(&started.id, State::Interrupted, None),
            // Not on this daemon: because it is another one, and the job went down with its
            // own, or because the job expired while nothing was watching.
            Verdict::Gone => {
                let replaced = probe(&client, "/job/list", &json!({}))
                    .await
                    .is_ok_and(|list| status::is_another_daemon(&started.execute_id, &list));
                if replaced {
                    self.give_up(&started.id, State::Interrupted, None);
                } else {
                    let error = "It ended while Rclone UI was not running, and rclone no longer remembers how.";
                    self.give_up(&started.id, State::Unknown, Some(error.into()));
                }
            }
            Verdict::Unreachable(error) => self.unreachable(started, &error),
        }
    }

    /// Ends a transfer nothing more can be learnt about.
    fn give_up(&self, id: &str, state: State, error: Option<String>) {
        if let Some(watched) = self.claim(id) {
            self.write_end(&watched.started, state, error, None);
        }
    }

    fn unreachable(&self, started: &Started, error: &str) {
        let lost = {
            let mut all = self.watched.lock().unwrap();
            let since = all
                .get_mut(&started.id)
                .map(|watched| *watched.unreachable_since.get_or_insert_with(Instant::now));
            since.is_some_and(|since| is_lost(since, Instant::now()))
        };
        if lost {
            log::warn!("[transfers] lost {}: {}", started.id, error);
            let error = format!("Lost contact with its rclone daemon: {}", error);
            self.give_up(&started.id, State::Unknown, Some(error));
        }
    }

    /// One look at what rclone still remembers of a running transfer's files, for the failures
    /// among them: by the end the early ones are gone from its list.
    async fn collect_failed(&self, client: &RcClient, started: &Started) {
        let reply = probe(client, "/core/transferred", &group_of(started)).await;
        let mut all = self.watched.lock().unwrap();
        let Some(watched) = all.get_mut(&started.id) else {
            return;
        };
        // It answered.
        watched.unreachable_since = None;
        if let Ok(reply) = reply {
            merge_failed(&mut watched.failed, &reply["transferred"]);
        }
    }

    /// The totals of a transfer and its files, as rclone has them right now, with the outcome
    /// written beside the request. Best effort: a daemon that stops answering costs the numbers,
    /// not the record.
    async fn snapshot(&self, client: &RcClient, watched: &mut Watched, status: &Value) -> Stats {
        let group = group_of(&watched.started);
        let stats = probe(client, "/core/stats", &group)
            .await
            .unwrap_or_default();
        let transferred = probe(client, "/core/transferred", &group)
            .await
            .map(|reply| reply["transferred"].clone())
            .unwrap_or_default();
        merge_failed(&mut watched.failed, &transferred);
        self.keep_outcome(&watched.started.id, status, &transferred, &watched.failed);
        let mut totals = status::stats_of(&stats, status);
        if totals.duration_ms == 0 {
            totals.duration_ms = elapsed_ms(&watched.started);
        }
        totals
    }

    /// A job that ended on its own: recorded, and said.
    async fn finish(
        &self,
        client: &RcClient,
        id: &str,
        state: State,
        error: Option<String>,
        status: &Value,
    ) {
        // A page may have stopped it while the status was on its way.
        let Some(mut watched) = self.claim(id) else {
            return;
        };
        let stats = self.snapshot(client, &mut watched, status).await;
        let duration = stats.duration_ms / 1000;
        let started = watched.started;
        self.write_end(&started, state, error.clone(), Some(stats));
        if started.is_dry_run {
            return;
        }
        let mut data = webhook_data(&started);
        data["durationSeconds"] = json!(duration);
        match error {
            Some(error) => {
                data["error"] = Value::String(error.clone());
                notify(
                    &self.ctx,
                    "job.failed",
                    "Transfer failed",
                    &format!("{} — {}", describe(&started), error),
                    data,
                );
            }
            None => {
                notify(
                    &self.ctx,
                    "job.completed",
                    "Transfer completed",
                    &describe(&started),
                    data,
                );
            }
        }
    }

    /// Records a transfer that just started and watches it. `launching`: its first look is
    /// `start`'s own ([`TransferService::launched`] hands it to the ticker).
    fn watch(&self, started: Started, launching: bool) {
        let path = ledger::host_path(&self.ctx.dirs, &started.host_id);
        if let Err(error) = ledger::append(&path, &Line::Started(started.clone())) {
            log::error!("[transfers] {} not recorded: {}", started.id, error);
        }
        self.changed(&started);
        self.hold(started, launching);
    }

    fn hold(&self, started: Started, launching: bool) {
        let watched = Watched {
            started,
            failed: Failed::default(),
            unreachable_since: None,
            launching,
        };
        let mut all = self.watched.lock().unwrap();
        all.insert(watched.started.id.clone(), watched);
    }

    /// The launch check is done: from here on the ticker looks after it.
    fn launched(&self, id: &str) {
        if let Some(watched) = self.watched.lock().unwrap().get_mut(id) {
            watched.launching = false;
        }
    }

    /// Takes a transfer out of the watched set, for whoever is about to write its end. The one
    /// place that decides who does: only a transfer still being watched has an end to write.
    fn claim(&self, id: &str) -> Option<Watched> {
        self.watched.lock().unwrap().remove(id)
    }

    fn changed(&self, started: &Started) {
        self.ctx.events.emit(
            "transfers.changed",
            json!({ "hostId": started.host_id, "id": started.id }),
        );
    }

    /// Writes the end of a transfer that has been claimed (or that nothing watches yet).
    fn write_end(
        &self,
        started: &Started,
        state: State,
        error: Option<String>,
        stats: Option<Stats>,
    ) {
        let path = ledger::host_path(&self.ctx.dirs, &started.host_id);
        let finished = Finished {
            id: started.id.clone(),
            ts: now_iso(),
            state,
            error,
            stats,
        };
        if let Err(error) = ledger::finish(&self.ctx.dirs, &path, finished) {
            log::error!(
                "[transfers] the end of {} not recorded: {}",
                started.id,
                error
            );
        }
        self.changed(started);
    }

    /// The request a transfer was started with, written as it starts.
    fn keep_request(&self, id: &str, request: &RcRequest) {
        let details = json!({ "request": { "endpoint": request.endpoint, "body": request.body } });
        if let Err(error) = ledger::write_details(&self.ctx.dirs, id, &details) {
            log::warn!("[transfers] the request of {} not kept: {}", id, error);
        }
    }

    /// What a transfer left behind, added to the request that is already there.
    fn keep_outcome(&self, id: &str, status: &Value, transferred: &Value, failed: &Failed) {
        let mut details = ledger::read_details(&self.ctx.dirs, id).unwrap_or_else(|| json!({}));
        status::keep_outcome(&mut details, status, transferred, failed);
        // Before the `finished` line: the line is what tells the pages there is something to read.
        if let Err(error) = ledger::write_details(&self.ctx.dirs, id, &details) {
            log::warn!("[transfers] details of {} not written: {}", id, error);
        }
    }
}

/// One question to a daemon, bounded ([`PROBE_TIMEOUT`]).
async fn probe(client: &RcClient, endpoint: &str, body: &Value) -> Result<Value, String> {
    client
        .call_with_timeout(endpoint, body, Some(PROBE_TIMEOUT))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ctx::Events;
    use crate::datadir::DataDir;

    fn service(name: &str, managed_local: bool) -> (Arc<TransferService>, DataDir) {
        let root = std::env::temp_dir().join(format!(
            "rcloneui-transfers-{}-{}",
            name,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let dirs = DataDir { root };
        let ctx = Ctx::new(dirs.clone(), Events::noop());
        (TransferService::new(ctx, managed_local), dirs)
    }

    fn started(id: &str, host: &str) -> Started {
        Started {
            id: id.into(),
            ts: now_iso(),
            host_id: host.into(),
            execute_id: "daemon-1".into(),
            jobid: 7,
            operation: "copy".into(),
            is_dry_run: true, // keeps the webhooks out of the tests
            ..Started::default()
        }
    }

    fn is_watched(service: &TransferService, id: &str) -> bool {
        service.watched.lock().unwrap().contains_key(id)
    }

    /// A page says where its transfer came from. It cannot say "a schedule": that tag is what
    /// sends a row to the Schedules page and keeps rclone from being asked about it, and only
    /// the scheduled runner writes it.
    #[test]
    fn a_page_tags_its_transfer_but_never_as_a_schedule() {
        let tags = |given: &[&str]| page_tags(given.iter().map(|tag| tag.to_string()).collect());
        assert_eq!(tags(&["commander"]), ["commander"]);
        assert_eq!(
            tags(&["operation", "schedule", " Commander "]),
            ["operation", "commander"]
        );
        assert_eq!(tags(&["", "  ", &"x".repeat(40)]), Vec::<String>::new());
        assert_eq!(tags(&["commander", "commander"]), ["commander"]);
    }

    fn state_of(dirs: &DataDir, host: &str, id: &str) -> State {
        ledger::list(dirs, host, 50)
            .into_iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.state)
            .expect("the transfer is in the ledger")
    }

    /// Quitting stops the daemon this process spawned, and with it what that daemon runs: that,
    /// and nothing else, is what a quit asks about. It is known from the moment a transfer
    /// starts, which rclone's files-in-flight are not (a transfer still listing has none).
    #[test]
    fn a_quit_would_stop_what_the_managed_daemon_is_running() {
        let (managed, dirs) = service("quit-managed", true);
        assert_eq!(managed.stopped_by_quit(), 0);
        managed.watch(started("here", LOCAL), false);
        managed.watch(started("there", "nas"), false);
        assert_eq!(managed.stopped_by_quit(), 1, "a remote host's carry on");
        managed.give_up("here", State::Completed, None);
        assert_eq!(managed.stopped_by_quit(), 0);
        let _ = std::fs::remove_dir_all(&dirs.root);

        // A daemon this process did not spawn outlives it, and so do its transfers.
        let (external, dirs) = service("quit-external", false);
        external.watch(started("here", LOCAL), false);
        assert_eq!(external.stopped_by_quit(), 0);
        let _ = std::fs::remove_dir_all(&dirs.root);
    }

    /// The managed daemon restarts (a setting changed, it crashed): its transfers went down with
    /// it and say so, and a remote host's, which it never ran, are left alone.
    #[test]
    fn a_daemon_that_stops_interrupts_its_own_transfers() {
        let (service, dirs) = service("stopped", true);
        service.watch(started("here", LOCAL), false);
        service.watch(started("there", "nas"), false);

        service.daemon_stopped();

        assert_eq!(state_of(&dirs, LOCAL, "here"), State::Interrupted);
        assert_eq!(state_of(&dirs, "nas", "there"), State::Running);
        assert!(is_watched(&service, "there"));
        assert!(!is_watched(&service, "here"));
        let _ = std::fs::remove_dir_all(&dirs.root);
    }

    /// The server comes back after a crash. What its own daemon was running is over; what a
    /// daemon it does not own was running may well not be, so that is watched again (and
    /// whether that daemon is still the same one shows at the first look).
    #[test]
    fn a_restart_closes_what_the_managed_daemon_left_open_and_watches_the_rest() {
        let (first, dirs) = service("recover", true);
        first.watch(started("here", LOCAL), false);
        first.watch(started("there", "nas"), false);
        drop(first);

        let ctx = Ctx::new(dirs.clone(), Events::noop());
        let second = TransferService::new(ctx, true);
        second.recover();

        assert_eq!(state_of(&dirs, LOCAL, "here"), State::Interrupted);
        assert_eq!(state_of(&dirs, "nas", "there"), State::Running);
        assert!(is_watched(&second, "there"));

        // With `--rclone-url` the local daemon is not ours either: it may have carried on.
        let (first, dirs_external) = service("recover-external", false);
        first.watch(started("here", LOCAL), false);
        drop(first);
        let external = TransferService::new(Ctx::new(dirs_external.clone(), Events::noop()), false);
        external.recover();
        assert_eq!(state_of(&dirs_external, LOCAL, "here"), State::Running);
        let _ = std::fs::remove_dir_all(&dirs.root);
        let _ = std::fs::remove_dir_all(&dirs_external.root);
    }

    /// A stop ends the job with an error of rclone's own making ("context canceled"), which a
    /// tick may read before the stop is done. The stop claimed the transfer first, so the tick
    /// finds nothing to end: it is recorded as stopped, once, and never as a failure.
    #[test]
    fn a_transfer_ends_once_and_a_stop_is_never_recorded_as_a_failure() {
        let (service, dirs) = service("stop", true);
        service.watch(started("t", LOCAL), false);

        // The stop, up to where it asks rclone.
        let claimed = service.claim("t").expect("it is being watched");
        // The tick, having read the canceled job in the meantime.
        assert!(service.claim("t").is_none(), "already spoken for");
        service.give_up("t", State::Failed, Some("context canceled".into()));
        // The stop, done.
        service.write_end(&claimed.started, State::Stopped, None, None);

        assert_eq!(state_of(&dirs, LOCAL, "t"), State::Stopped);
        assert_eq!(ledger::read(&ledger::host_path(&dirs, LOCAL)).len(), 2);
        let _ = std::fs::remove_dir_all(&dirs.root);
    }

    /// A daemon out of reach is waited for: it may be a VPN that dropped or this machine waking
    /// up, with the transfer still running on the other side. Giving up is for good, so it
    /// takes ten minutes of silence, and any answer starts the wait over.
    #[test]
    fn a_daemon_out_of_reach_is_waited_for_before_its_transfer_is_given_up() {
        let since = Instant::now();
        assert!(!is_lost(since, since + Duration::from_secs(9 * 60)));
        assert!(is_lost(since, since + LOST_AFTER));

        let (service, dirs) = service("lost", false);
        let transfer = started("t", "nas");
        service.watch(transfer.clone(), false);
        service.unreachable(&transfer, "connection refused");
        assert!(
            is_watched(&service, "t"),
            "the first silence is not the last"
        );
        assert_eq!(state_of(&dirs, "nas", "t"), State::Running);
        let noticed =
            |service: &TransferService| service.watched.lock().unwrap()["t"].unreachable_since;
        assert!(noticed(&service).is_some());
        // Silent again: the wait is counted from the first time, not started over.
        let first = noticed(&service);
        service.unreachable(&transfer, "connection refused");
        assert_eq!(noticed(&service), first);
        let _ = std::fs::remove_dir_all(&dirs.root);
    }

    /// `start` looks at a fresh transfer itself, a second after submitting it, and says what it
    /// finds: "started" if it got going, its failure if it did not. The ticker runs on its own
    /// clock and could land inside that second, end the transfer and say "completed" before
    /// "started" was said. Until the launch check is done the transfer is the launch's.
    #[test]
    fn the_ticker_leaves_a_transfer_alone_while_it_is_being_launched() {
        let (service, dirs) = service("launching", true);
        service.hold(started("fresh", LOCAL), true);
        service.hold(started("going", LOCAL), false);
        let due = |service: &TransferService| -> Vec<String> {
            let mut ids: Vec<String> = service
                .due()
                .into_values()
                .flatten()
                .map(|started| started.id)
                .collect();
            ids.sort();
            ids
        };
        assert_eq!(due(&service), ["going"]);
        // It can still be stopped, and still counts as running.
        assert_eq!(service.stopped_by_quit(), 2);
        service.launched("fresh");
        assert_eq!(due(&service), ["fresh", "going"]);
        let _ = std::fs::remove_dir_all(&dirs.root);
    }

    /// A stop has no duration from rclone; the id says when the transfer began.
    #[test]
    fn a_transfers_id_says_when_it_began() {
        let mut old = started("1000-7-abcdef", LOCAL);
        assert!(elapsed_ms(&old) > 1_000_000);
        old.id = "not-ours".into();
        assert_eq!(elapsed_ms(&old), 0);
    }

    /// A retry is made from the request the transfer was started with. It is on disk from the
    /// start (a server that restarts has nothing in memory), and the end is added around it.
    #[test]
    fn the_request_is_kept_from_the_start_and_the_outcome_joins_it() {
        let (service, dirs) = service("details", true);
        service.watch(started("t", LOCAL), false);
        let request = RcRequest {
            endpoint: "/job/batch".into(),
            body: json!({ "inputs": [{ "_path": "sync/copy", "srcFs": "/a", "dstFs": "/b" }] }),
        };
        service.keep_request("t", &request);
        assert_eq!(
            ledger::read_details(&dirs, "t").unwrap()["request"]["endpoint"],
            "/job/batch"
        );

        let mut failed = Failed::default();
        merge_failed(
            &mut failed,
            &json!([{ "name": "a.txt", "error": "no", "srcFs": "/a" }]),
        );
        service.keep_outcome(
            "t",
            &json!({ "finished": true }),
            &json!([{ "name": "b.txt", "error": "" }]),
            &failed,
        );

        let details = ledger::read_details(&dirs, "t").unwrap();
        assert_eq!(details["request"]["body"]["inputs"][0]["srcFs"], "/a");
        assert_eq!(details["status"]["finished"], true);
        assert_eq!(details["transferred"][0]["name"], "b.txt");
        assert_eq!(details["failed"][0]["name"], "a.txt");
        let _ = std::fs::remove_dir_all(&dirs.root);
    }
}
