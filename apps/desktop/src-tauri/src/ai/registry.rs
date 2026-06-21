//! Tracks in-flight streaming requests so they can be cancelled. Each running
//! request registers an `Arc<Notify>`; the stream task `select!`s on it and
//! `ai_cancel` fires it. Managed as Tauri state.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

#[derive(Default)]
pub struct AiRegistry(Mutex<HashMap<String, Arc<Notify>>>);

impl AiRegistry {
    /// Register `request_id` and return its cancellation handle.
    pub fn register(&self, request_id: &str) -> Arc<Notify> {
        let notify = Arc::new(Notify::new());
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(request_id.to_string(), notify.clone());
        notify
    }

    /// Drop the handle once the stream is finished (success, error, or cancel).
    pub fn remove(&self, request_id: &str) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(request_id);
    }

    /// Signal the stream task for `request_id` to stop. Returns whether a
    /// matching in-flight request was found.
    pub fn cancel(&self, request_id: &str) -> bool {
        if let Some(notify) = self
            .0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(request_id)
        {
            // `notify_one` stores a permit even if the task isn't waiting yet,
            // so a cancel can't be lost to a race with the stream loop.
            notify.notify_one();
            true
        } else {
            false
        }
    }
}
