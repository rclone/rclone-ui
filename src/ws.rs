//! One WebSocket per page: every bus event, as `{type:'event', name, payload}`. The server says
//! `{type:'ready'}` once the socket is up and `{type:'pong'}` to `{type:'ping'}`; a page whose
//! socket came back asks its queries again on the next `ready` (`lib/api/ws.ts`). The socket
//! belongs to the account that opened it and closes when that account's sessions are revoked.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::auth::Caller;
use crate::Shared;

pub async fn upgrade(
    State(st): State<Shared>,
    Caller(caller): Caller,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| connection(st, socket, caller.id))
}

async fn connection(st: Shared, socket: WebSocket, account: String) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    // A removal or an admin's password reset revokes the account's HTTP sessions, and closes
    // this too.
    let mut revoked = st.auth.revocations();
    let mut watch_revocations = true;

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
        let mut rx = st.bus.subscribe();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        let frame =
                            json!({ "type": "event", "name": event.name, "payload": event.payload });
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

    let _ = tx.send(json!({ "type": "ready" }).to_string());

    loop {
        let msg = tokio::select! {
            next = stream.next() => match next {
                Some(Ok(msg)) => msg,
                _ => break,
            },
            revocation = revoked.recv(), if watch_revocations => {
                match revocation {
                    Ok(id) if id == account => {
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
                if value["type"].as_str() == Some("ping") {
                    let _ = tx.send(json!({ "type": "pong" }).to_string());
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    events.abort();
    writer.abort();
}
