//! Progress accounting for long transfers.
//!
//! Downloads update the byte counter as chunks stream in; uploads report
//! start/finish (the SDK PUT is a single opaque stream). The UI polls
//! `transfer_progress`, which keeps the IPC surface tiny and testable.

use crate::model::{ProgressState, ProgressView};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone)]
pub struct ProgressEntry {
    pub id: String,
    pub label: String,
    pub done: u64,
    pub total: Option<u64>,
    pub state: ProgressState,
    pub error: Option<String>,
    pub result_path: Option<String>,
}

impl ProgressEntry {
    pub fn to_view(&self) -> ProgressView {
        ProgressView {
            id: self.id.clone(),
            label: self.label.clone(),
            done: self.done,
            total: self.total,
            state: self.state,
            error: self.error.clone(),
            result_path: self.result_path.clone(),
        }
    }
}

#[derive(Clone, Default)]
pub struct ProgressTracker {
    inner: Arc<Mutex<HashMap<String, ProgressEntry>>>,
}

impl ProgressTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start(&self, label: impl Into<String>, total: Option<u64>) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let entry = ProgressEntry {
            id: id.clone(),
            label: label.into(),
            done: 0,
            total,
            state: ProgressState::Running,
            error: None,
            result_path: None,
        };
        self.map().insert(id.clone(), entry);
        id
    }

    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, ProgressEntry>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn advance(&self, id: &str, delta: u64) {
        let mut map = self.map();
        if let Some(entry) = map.get_mut(id) {
            entry.done = entry.done.saturating_add(delta);
        }
    }

    pub fn finish(&self, id: &str, result_path: Option<String>) {
        let mut map = self.map();
        if let Some(entry) = map.get_mut(id) {
            finish_entry(entry, result_path);
        }
    }

    /// Finish only if the entry is still running.
    ///
    /// A background transfer checks for cancellation and then records its
    /// outcome; doing that in two steps would let a cancel slip in between and
    /// be overwritten by `Done`. This method makes the check and the write one
    /// locked operation. Returns whether the entry was finished.
    pub fn finish_if_running(&self, id: &str, result_path: Option<String>) -> bool {
        let mut map = self.map();
        match map.get_mut(id) {
            Some(entry) if entry.state == ProgressState::Running => {
                finish_entry(entry, result_path);
                true
            }
            _ => false,
        }
    }

    pub fn fail(&self, id: &str, error: impl Into<String>) {
        let mut map = self.map();
        if let Some(entry) = map.get_mut(id) {
            entry.state = ProgressState::Failed;
            entry.error = Some(error.into());
        }
    }

    /// Fail only if the entry is still running; a cancelled transfer must not
    /// be reported as failed after the fact.
    pub fn fail_if_running(&self, id: &str, error: impl Into<String>) -> bool {
        let mut map = self.map();
        match map.get_mut(id) {
            Some(entry) if entry.state == ProgressState::Running => {
                entry.state = ProgressState::Failed;
                entry.error = Some(error.into());
                true
            }
            _ => false,
        }
    }

    pub fn cancel(&self, id: &str) {
        let mut map = self.map();
        if let Some(entry) = map.get_mut(id) {
            entry.state = ProgressState::Cancelled;
        }
    }

    pub fn get(&self, id: &str) -> Option<ProgressView> {
        self.map().get(id).map(|e| e.to_view())
    }

    pub fn all(&self) -> Vec<ProgressView> {
        let mut views: Vec<ProgressView> = self.map().values().map(|e| e.to_view()).collect();
        views.sort_by(|a, b| a.id.cmp(&b.id));
        views
    }

    /// Drop finished entries so polling does not grow without bound.
    pub fn prune_finished(&self) {
        let mut map = self.map();
        map.retain(|_, e| e.state == ProgressState::Running);
    }
}

/// Apply a successful finish to an entry. The caller holds the tracker lock.
fn finish_entry(entry: &mut ProgressEntry, result_path: Option<String>) {
    entry.state = ProgressState::Done;
    if let Some(total) = entry.total {
        entry.done = total;
    }
    entry.result_path = result_path;
}

/// An `AsyncWrite` adapter that ticks progress as bytes flow through.
pub struct ProgressWriter<'a, W> {
    inner: W,
    tracker: ProgressTracker,
    id: String,
    lifetime: std::marker::PhantomData<&'a ()>,
}

impl<'a, W> ProgressWriter<'a, W> {
    pub fn new(inner: W, tracker: ProgressTracker, id: impl Into<String>) -> Self {
        ProgressWriter {
            inner,
            tracker,
            id: id.into(),
            lifetime: std::marker::PhantomData,
        }
    }
}

impl<W: tokio::io::AsyncWrite + Unpin> tokio::io::AsyncWrite for ProgressWriter<'_, W> {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        let this = &mut *self;
        match std::pin::Pin::new(&mut this.inner).poll_write(cx, buf) {
            std::task::Poll::Ready(Ok(n)) => {
                this.tracker.advance(&this.id, n as u64);
                std::task::Poll::Ready(Ok(n))
            }
            other => other,
        }
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    #[test]
    fn tracks_start_advance_finish() {
        let tracker = ProgressTracker::new();
        let id = tracker.start("download a.png", Some(1000));
        tracker.advance(&id, 400);
        let view = tracker.get(&id).unwrap();
        assert_eq!(view.done, 400);
        assert_eq!(view.total, Some(1000));
        assert_eq!(view.state, ProgressState::Running);

        tracker.finish(&id, Some("/tmp/a.png".into()));
        let view = tracker.get(&id).unwrap();
        assert_eq!(view.state, ProgressState::Done);
        assert_eq!(view.done, 1000);
        assert_eq!(view.result_path.as_deref(), Some("/tmp/a.png"));
    }

    #[test]
    fn failure_records_message() {
        let tracker = ProgressTracker::new();
        let id = tracker.start("upload", None);
        tracker.fail(&id, "AccessDenied");
        let view = tracker.get(&id).unwrap();
        assert_eq!(view.state, ProgressState::Failed);
        assert_eq!(view.error.as_deref(), Some("AccessDenied"));
    }

    #[test]
    fn prune_keeps_only_running() {
        let tracker = ProgressTracker::new();
        let a = tracker.start("a", None);
        let b = tracker.start("b", None);
        tracker.finish(&a, None);
        tracker.prune_finished();
        assert!(tracker.get(&a).is_none());
        assert!(tracker.get(&b).is_some());
    }

    #[test]
    fn conditional_finish_completes_a_running_entry() {
        let tracker = ProgressTracker::new();
        let id = tracker.start("upload", Some(10));
        assert!(tracker.finish_if_running(&id, Some("dest".into())));
        let view = tracker.get(&id).unwrap();
        assert_eq!(view.state, ProgressState::Done);
        assert_eq!(view.done, 10);
    }

    #[test]
    fn conditional_finish_cannot_override_a_cancel() {
        let tracker = ProgressTracker::new();
        let id = tracker.start("upload", Some(10));
        tracker.cancel(&id);

        assert!(!tracker.finish_if_running(&id, None));
        assert!(!tracker.fail_if_running(&id, "late failure"));

        let view = tracker.get(&id).unwrap();
        assert_eq!(view.state, ProgressState::Cancelled);
        assert_eq!(view.error, None);
        assert_eq!(view.done, 0);
    }

    #[test]
    fn conditional_finish_ignores_unknown_ids() {
        let tracker = ProgressTracker::new();
        assert!(!tracker.finish_if_running("missing", None));
        assert!(!tracker.fail_if_running("missing", "error"));
    }

    #[tokio::test]
    async fn writer_counts_bytes() {
        let tracker = ProgressTracker::new();
        let id = tracker.start("copy", None);
        let mut buffer = Vec::new();
        {
            let mut writer = ProgressWriter::new(&mut buffer, tracker.clone(), id.clone());
            writer.write_all(b"hello world").await.unwrap();
            writer.flush().await.unwrap();
        }
        assert_eq!(tracker.get(&id).unwrap().done, 11);
        assert_eq!(buffer, b"hello world");
    }

    #[test]
    fn advance_on_unknown_id_is_ignored() {
        let tracker = ProgressTracker::new();
        tracker.advance("missing", 5);
        assert!(tracker.get("missing").is_none());
    }
}
