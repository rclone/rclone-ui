//! The in-process event bus: WebSocket sessions forward it to pages, and Rust code can
//! subscribe directly. Slow subscribers lag rather than block the publisher.

use serde::Serialize;
use serde_json::Value;
use tokio::sync::broadcast;

#[derive(Clone, Debug)]
pub struct Event {
    pub name: String,
    pub payload: Value,
}

#[derive(Clone)]
pub struct Bus {
    tx: broadcast::Sender<Event>,
}

impl Default for Bus {
    fn default() -> Self {
        Self::new()
    }
}

impl Bus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(2048);
        Bus { tx }
    }

    pub fn publish<T: Serialize>(&self, name: &str, payload: T) {
        match serde_json::to_value(payload) {
            Ok(payload) => {
                // No subscribers is not an error worth logging (boot, tests).
                let _ = self.tx.send(Event {
                    name: name.to_string(),
                    payload,
                });
            }
            Err(e) => log::warn!("[bus] could not serialize '{}': {}", name, e),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }
}
