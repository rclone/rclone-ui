//! Async-runtime glue standing in for `tauri::async_runtime` (a lazily built global tokio
//! runtime the desktop app shares with Tauri). Hosts may call into this crate from three
//! places, and the helpers work from all of them:
//!
//! - a tokio worker thread (async commands awaited by the server or the desktop's runtime),
//! - a blocking-pool thread (`sync` commands, which the dispatch layer runs via `spawn_blocking`),
//! - a plain thread with no runtime at all (`metadata-map`, which rclone spawns per file).
//!
//! Rule for code in this crate: functions in `notifications` that call `block_on` are
//! synchronous and may block; reach them from `spawn_blocking` or a non-async thread, never
//! `.await` an async wrapper around them from a worker without one.

use std::future::Future;
use std::sync::OnceLock;

use tokio::runtime::{Handle, Runtime, RuntimeFlavor};

fn global() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("failed to build the tokio runtime")
    })
}

/// Runs `f` on the blocking pool of the current runtime, or of the global one when the caller
/// has no runtime context.
pub fn spawn_blocking<F, R>(f: F) -> tokio::task::JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    match Handle::try_current() {
        Ok(handle) => handle.spawn_blocking(f),
        Err(_) => global().spawn_blocking(f),
    }
}

/// Drives `fut` to completion from synchronous code. On a multi-thread runtime worker this
/// parks the worker with `block_in_place` (instead of tokio's "runtime within a runtime" panic);
/// on a blocking-pool thread `block_in_place` is a pass-through; with no runtime it uses the
/// global one.
pub fn block_on<F: Future>(fut: F) -> F::Output {
    match Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(|| handle.block_on(fut))
        }
        Ok(handle) => handle.block_on(fut),
        Err(_) => global().block_on(fut),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn answer() -> u32 {
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        42
    }

    #[test]
    fn block_on_without_a_runtime() {
        assert_eq!(block_on(answer()), 42);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn block_on_from_a_worker_thread() {
        assert_eq!(block_on(answer()), 42);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn block_on_from_the_blocking_pool() {
        let value = spawn_blocking(|| block_on(answer())).await.unwrap();
        assert_eq!(value, 42);
    }

    #[test]
    fn spawn_blocking_without_a_runtime() {
        let value = block_on(spawn_blocking(|| 7)).unwrap();
        assert_eq!(value, 7);
    }
}
