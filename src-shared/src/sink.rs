//! Streaming results from a command back to whoever invoked it — the Tauri `Channel` on the
//! desktop, a WebSocket on the server. Framing (message index, end-of-stream) belongs to the
//! transport: Tauri's `Channel` frames on its own, the server's WebSocket adapter frames to
//! match, and this type only carries ordered JSON messages.

use std::marker::PhantomData;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

/// Receiving side of a [`Sink`]: takes one JSON message at a time, in order. `Err` means the
/// receiver is gone and the producer should stop.
pub trait RawSink: Send + Sync {
    fn send(&self, message: Value) -> Result<(), String>;
}

impl<F> RawSink for F
where
    F: Fn(Value) -> Result<(), String> + Send + Sync,
{
    fn send(&self, message: Value) -> Result<(), String> {
        (self)(message)
    }
}

/// Typed, cloneable handle a command streams events through.
pub struct Sink<T> {
    raw: Arc<dyn RawSink>,
    _marker: PhantomData<fn(T)>,
}

impl<T> Clone for Sink<T> {
    fn clone(&self) -> Self {
        Sink {
            raw: Arc::clone(&self.raw),
            _marker: PhantomData,
        }
    }
}

impl<T> Sink<T> {
    pub fn new(raw: impl RawSink + 'static) -> Self {
        Sink {
            raw: Arc::new(raw),
            _marker: PhantomData,
        }
    }

    /// A sink that drops every message (tests, callers that don't care about progress).
    pub fn discard() -> Self {
        Sink::new(|_: Value| Ok(()))
    }

    /// Re-labels the message type; the transport only ever sees JSON, so this is free.
    pub fn retype<U>(self) -> Sink<U> {
        Sink {
            raw: self.raw,
            _marker: PhantomData,
        }
    }
}

impl<T: Serialize> Sink<T> {
    pub fn send(&self, message: T) -> Result<(), String> {
        let value = serde_json::to_value(message).map_err(|e| e.to_string())?;
        self.raw.send(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn sends_in_order_and_stops_when_the_receiver_is_gone() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink_seen = Arc::clone(&seen);
        let sink: Sink<u32> = Sink::new(move |v: Value| {
            let mut seen = sink_seen.lock().unwrap();
            if seen.len() == 2 {
                return Err("closed".to_string());
            }
            seen.push(v);
            Ok(())
        });
        assert!(sink.send(1).is_ok());
        assert!(sink.send(2).is_ok());
        assert!(sink.send(3).is_err());
        assert_eq!(*seen.lock().unwrap(), vec![Value::from(1), Value::from(2)]);
    }
}
