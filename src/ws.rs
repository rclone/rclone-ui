//! One WebSocket per page. The page identifies itself with a uuid (`{type:'hello', session}`)
//! and sends the same uuid as `X-RcloneUI-Session` on every RPC, so a streaming command started
//! over HTTP knows which socket carries its events. Frames the server sends:
//!
//! - `{type:'ready'}` after hello, `{type:'pong'}` for `{type:'ping'}`
//! - `{type:'stream', id, event}` — one message of a stream the page opened (its `stream` id)
//! - `{type:'stream_end', id}` — the producer dropped its sink
//! - `{type:'event', name, payload}` — every bus event (`lifecycle.phase`, `state.changed`, …)
//!
//! Stream frames sent while a page's socket is reconnecting are buffered for a short while;
//! bus events are not (pages re-read state on reconnect).

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use crate::sink::{RawSink, Sink};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::auth::Caller;
use crate::Shared;

const BUFFER_LIMIT: usize = 2000;
const STALE_AFTER: Duration = Duration::from_secs(120);

#[derive(Default)]
struct Session {
    tx: Option<mpsc::UnboundedSender<String>>,
    /// Which attachment `tx` belongs to: a connection that ends after its replacement attached
    /// must not detach the replacement.
    generation: u64,
    buffer: VecDeque<String>,
    last_seen: Option<Instant>,
}

#[derive(Clone, Default)]
pub struct Sessions(Arc<Mutex<HashMap<String, Session>>>);

impl Sessions {
    fn deliver(&self, session: &str, frame: String) {
        let mut map = self.0.lock().unwrap();
        let entry = map.entry(session.to_string()).or_default();
        let mut frame = frame;
        if let Some(tx) = &entry.tx {
            match tx.send(frame) {
                Ok(()) => return,
                Err(err) => {
                    // The socket is gone; keep the frame for the reconnect.
                    entry.tx = None;
                    frame = err.0;
                }
            }
        }
        if entry.buffer.len() >= BUFFER_LIMIT {
            entry.buffer.pop_front();
        }
        entry.buffer.push_back(frame);
        entry.last_seen.get_or_insert_with(Instant::now);
    }

    /// A `Sink` for a stream the page opened: `{type:'stream', id, event}` per message and
    /// `{type:'stream_end', id}` when the last clone is dropped.
    pub fn stream_sink(&self, session: &str, id: &str) -> Sink<Value> {
        Sink::new(StreamSink {
            sessions: self.clone(),
            session: session.to_string(),
            id: id.to_string(),
        })
    }

    /// Returns the attachment's generation, which [`Sessions::detach`] must present.
    fn attach(&self, session: &str, tx: mpsc::UnboundedSender<String>) -> u64 {
        let mut map = self.0.lock().unwrap();
        let now = Instant::now();
        map.retain(|_, s| {
            s.tx.is_some()
                || s.last_seen
                    .map(|t| now.duration_since(t) < STALE_AFTER)
                    .unwrap_or(true)
        });
        let entry = map.entry(session.to_string()).or_default();
        for frame in entry.buffer.drain(..) {
            let _ = tx.send(frame);
        }
        entry.tx = Some(tx);
        entry.generation += 1;
        entry.last_seen = Some(now);
        entry.generation
    }

    /// Clears the session's sender when it is still the one attached under `generation`.
    fn detach(&self, session: &str, generation: u64) {
        let mut map = self.0.lock().unwrap();
        if let Some(s) = map.get_mut(session) {
            if s.generation != generation {
                return;
            }
            s.tx = None;
            s.last_seen = Some(Instant::now());
        }
    }
}

struct StreamSink {
    sessions: Sessions,
    session: String,
    id: String,
}

impl RawSink for StreamSink {
    fn send(&self, message: Value) -> Result<(), String> {
        self.sessions.deliver(
            &self.session,
            json!({ "type": "stream", "id": self.id, "event": message }).to_string(),
        );
        Ok(())
    }
}

impl Drop for StreamSink {
    fn drop(&mut self) {
        self.sessions.deliver(
            &self.session,
            json!({ "type": "stream_end", "id": self.id }).to_string(),
        );
    }
}

pub async fn upgrade(
    State(st): State<Shared>,
    Caller(caller): Caller,
    ws: WebSocketUpgrade,
) -> Response {
    let account = caller.map(|user| user.id);
    ws.on_upgrade(move |socket| connection(st, socket, account))
}

async fn connection(st: Shared, socket: WebSocket, account: Option<String>) {
    let (mut sink, mut stream) = socket.split();
    let mut attached: Option<(String, u64)> = None;
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    // The socket belongs to the account that opened it: a removal or an admin's password reset
    // revokes its HTTP sessions, and closes this too.
    let mut revoked = st.auth.revocations();
    let mut watch_revocations = account.is_some();

    let writer = tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            if sink.send(Message::Text(frame.into())).await.is_err() {
                break;
            }
        }
    });

    // Every bus event reaches every page; the page filters by name.
    let events = {
        let tx = tx.clone();
        let mut rx = st.ctx.events.subscribe();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        let frame = json!({ "type": "event", "name": event.name, "payload": event.payload });
                        if tx.send(frame.to_string()).is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        })
    };

    loop {
        let msg = tokio::select! {
            next = stream.next() => match next {
                Some(Ok(msg)) => msg,
                _ => break,
            },
            revocation = revoked.recv(), if watch_revocations => {
                match revocation {
                    Ok(id) if Some(&id) == account.as_ref() => {
                        log::info!("[ws] closing the socket of a revoked account");
                        break;
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        watch_revocations = false;
                    }
                }
                continue;
            }
        };
        match msg {
            Message::Text(text) => {
                let Ok(value) = serde_json::from_str::<Value>(text.as_str()) else {
                    continue;
                };
                match value["type"].as_str() {
                    Some("hello") => {
                        if let Some(id) = value["session"].as_str() {
                            if let Some((previous, generation)) = attached.take() {
                                st.sessions.detach(&previous, generation);
                            }
                            let generation = st.sessions.attach(id, tx.clone());
                            attached = Some((id.to_string(), generation));
                            let _ = tx.send(json!({ "type": "ready" }).to_string());
                        }
                    }
                    Some("ping") => {
                        let _ = tx.send(json!({ "type": "pong" }).to_string());
                    }
                    _ => {}
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    if let Some((id, generation)) = attached {
        st.sessions.detach(&id, generation);
    }
    events.abort();
    writer.abort();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A page reconnects: the new socket attaches under the same session id. When the old
    /// connection finally ends, it must not clear the replacement's route.
    #[test]
    fn an_old_socket_cannot_detach_its_replacement() {
        let sessions = Sessions::default();
        let (tx1, mut rx1) = mpsc::unbounded_channel::<String>();
        let (tx2, mut rx2) = mpsc::unbounded_channel::<String>();
        let first = sessions.attach("page", tx1);
        let second = sessions.attach("page", tx2);
        sessions.detach("page", first);
        sessions.deliver("page", "frame".into());
        assert_eq!(rx2.try_recv().ok().as_deref(), Some("frame"));
        assert!(rx1.try_recv().is_err(), "the first sender was replaced");
        sessions.detach("page", second);
        sessions.deliver("page", "later".into());
        assert!(
            rx2.try_recv().is_err(),
            "detached: the frame waits in the buffer"
        );
    }
}
