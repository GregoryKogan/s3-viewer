//! Bridge between Tauri's synchronous command context and async S3 work.
//!
//! Tauri keeps the `State<T>` value available from synchronous command bodies,
//! so commands take a [`Fetch`], pull out the runtime handle, and `block_on` the
//! real async implementation.

use crate::error::{AppError, AppResult};

#[derive(Clone)]
pub struct Fetch {
    handle: tokio::runtime::Handle,
}

impl Fetch {
    pub fn new(handle: tokio::runtime::Handle) -> Self {
        Fetch { handle }
    }

    pub fn handle(&self) -> &tokio::runtime::Handle {
        &self.handle
    }

    /// Run a future to completion on the app runtime.
    pub fn block_on<F: std::future::Future>(&self, future: F) -> AppResult<F::Output> {
        Ok(self.handle.block_on(future))
    }

    /// Convenience for `block_on` where the future already returns a `Result`.
    pub fn run<T>(&self, future: impl std::future::Future<Output = AppResult<T>>) -> AppResult<T> {
        self.handle.block_on(future)
    }
}

/// Helper to attach context to errors without losing the S3 detail.
pub fn with_context<T>(result: AppResult<T>, context: &str) -> AppResult<T> {
    result.map_err(|e| match e {
        AppError::S3 { .. } => e,
        other => AppError::msg(format!("{context}: {other}")),
    })
}
