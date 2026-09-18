//! Rclone UI's core, shared by the desktop app (`src-tauri`) and the browser server
//! (`src-server`). Nothing in this crate may depend on `tauri`: the server has to link on a
//! machine with no GTK/WebKit, and this crate is what makes that guarantee checkable
//! (`cargo tree -p rclone-ui-shared | grep tauri` must stay empty).
//!
//! Host processes give commands a [`Ctx`] (data dirs, event emitter, daemon/listing state) and
//! stream results through a [`Sink`]; the command table in [`commands`] is the single list both
//! hosts derive their wrappers from.

pub mod bus;
pub mod commands;
pub mod ctx;
pub mod datadir;
pub mod fsutil;
pub mod lifecycle;
pub mod metadata_mapper;
pub mod notifications;
pub mod platform;
pub mod rc;
pub mod rt;
pub mod scheduler;
pub mod sink;
pub mod state_files;
pub mod storage;
pub mod transfers;
pub mod version;
pub mod zookeeper;

pub use bus::{Bus, Event};
pub use ctx::{Ctx, Events};
pub use datadir::DataDir;
pub use platform::{is_flatpak, kill_pid};
pub use sink::Sink;
pub use state_files::StateStore;
