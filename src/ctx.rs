use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::sync::broadcast;

use crate::bus::{Bus, Event};
use crate::datadir::DataDir;
use crate::zookeeper::DaemonState;

/// App-wide events: a handle on the [`Bus`]. The WebSocket fan-out subscribes and commands emit.
#[derive(Clone, Default)]
pub struct Events {
    bus: Bus,
}

impl Events {
    pub fn new() -> Self {
        Events { bus: Bus::new() }
    }

    /// A bus nobody listens to (tests).
    pub fn noop() -> Self {
        Events::new()
    }

    pub fn bus(&self) -> &Bus {
        &self.bus
    }

    pub fn emit<T: Serialize>(&self, name: &str, payload: T) {
        self.bus.publish(name, payload)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.bus.subscribe()
    }
}

/// Everything a command needs from the server. Cloning is cheap (the state is shared through
/// `Arc`s).
#[derive(Clone)]
pub struct Ctx {
    pub dirs: DataDir,
    pub events: Events,
    /// The long-lived rclone daemon spawned through `zookeeper::spawn_rclone`.
    pub daemon: Arc<Mutex<DaemonState>>,
}

impl Ctx {
    pub fn new(dirs: DataDir, events: Events) -> Self {
        Ctx {
            dirs,
            events,
            daemon: Arc::new(Mutex::new(DaemonState::default())),
        }
    }
}
