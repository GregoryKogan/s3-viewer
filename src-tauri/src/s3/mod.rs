//! S3 access layer.
//!
//! Two interchangeable implementations of [`ObjectStore`]:
//!  * [`aws::AwsStore`] — the AWS SDK for Rust (SigV4 / `s3v4`), used by default.
//!  * [`v2::V2Store`] — a small hand-rolled client for the legacy SigV2 scheme,
//!    which the AWS SDK dropped.
//!
//! Everything else in the app talks to [`ObjectStore`] only.

pub mod aws;
pub mod kind;
pub mod v2;

use crate::error::AppResult;
use crate::model::ObjectEntry;
use std::path::Path;
use tokio::io::AsyncWrite;

pub use kind::{detect_kind, guess_content_type};

/// A single page of a listing.
#[derive(Debug, Default)]
pub struct Page {
    pub entries: Vec<ObjectEntry>,
    pub next_token: Option<String>,
    pub is_truncated: bool,
}

/// Byte range for a ranged GET.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    /// Inclusive end offset.
    pub end: u64,
}

impl ByteRange {
    pub fn header(self) -> String {
        format!("bytes={}-{}", self.start, self.end)
    }
}

#[derive(Debug, Default)]
pub struct ObjectStream {
    pub content_length: Option<i64>,
    pub total_length: Option<i64>,
    pub content_type: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_range: Option<String>,
    pub body: Vec<u8>,
}

#[derive(Debug, Default, Clone)]
pub struct ObjectMeta {
    pub key: String,
    pub size: Option<i64>,
    pub content_type: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub storage_class: Option<String>,
}

#[allow(async_fn_in_trait)]
pub trait ObjectStore: Send + Sync {
    fn bucket(&self) -> &str;

    async fn list_page(
        &self,
        prefix: &str,
        delimiter: Option<&str>,
        token: Option<&str>,
        max_keys: i32,
    ) -> AppResult<Page>;

    async fn stat(&self, key: &str) -> AppResult<ObjectMeta>;

    /// Ranged/whole GET returning the body in memory. Used for previews, which
    /// are size-bounded by the caller.
    async fn get_bytes(&self, key: &str, range: Option<ByteRange>) -> AppResult<ObjectStream>;

    /// Streaming GET into a writer. Used for downloads.
    async fn get_to(&self, key: &str, sink: &mut (dyn AsyncWrite + Unpin + Send))
        -> AppResult<u64>;

    async fn put_bytes(
        &self,
        key: &str,
        body: Vec<u8>,
        content_type: Option<&str>,
    ) -> AppResult<()>;

    /// Streaming PUT from a local file.
    async fn put_file(&self, key: &str, path: &Path) -> AppResult<()>;

    async fn delete_object(&self, key: &str) -> AppResult<()>;

    async fn copy_object(&self, source_key: &str, dest_key: &str) -> AppResult<()>;

    /// Server-side delete of many keys (may be a loop for the V2 client).
    async fn delete_many(&self, keys: &[String]) -> AppResult<()>;
}

/// Truncate a key for display in progress labels, keeping the tail readable.
pub fn short_key(key: &str) -> String {
    let parts: Vec<&str> = key.split('/').collect();
    if parts.len() <= 3 {
        return key.to_string();
    }
    format!("…/{}", parts[parts.len() - 2..].join("/"))
}

/// Enum dispatch over the two signers.
///
/// A trait object is not an option here: the trait uses `async fn`, which is not
/// dyn-compatible. There are only ever two implementations, so a small enum with
/// explicit forwarding beats boxes and manual `Future` plumbing — and every call
/// site keeps writing `store.get_bytes(...)` exactly as before.
#[derive(Clone)]
pub enum AnyStore {
    Aws(std::sync::Arc<aws::AwsStore>),
    V2(std::sync::Arc<v2::V2Store>),
}

impl AnyStore {
    pub fn from_aws(store: aws::AwsStore) -> Self {
        AnyStore::Aws(std::sync::Arc::new(store))
    }

    pub fn from_v2(store: v2::V2Store) -> Self {
        AnyStore::V2(std::sync::Arc::new(store))
    }
}

#[allow(unused_variables)]
impl ObjectStore for AnyStore {
    fn bucket(&self) -> &str {
        match self {
            AnyStore::Aws(s) => s.bucket(),
            AnyStore::V2(s) => s.bucket(),
        }
    }

    async fn list_page(
        &self,
        prefix: &str,
        delimiter: Option<&str>,
        token: Option<&str>,
        max_keys: i32,
    ) -> AppResult<Page> {
        match self {
            AnyStore::Aws(s) => {
                s.as_ref()
                    .list_page(prefix, delimiter, token, max_keys)
                    .await
            }
            AnyStore::V2(s) => {
                s.as_ref()
                    .list_page(prefix, delimiter, token, max_keys)
                    .await
            }
        }
    }

    async fn stat(&self, key: &str) -> AppResult<ObjectMeta> {
        match self {
            AnyStore::Aws(s) => s.as_ref().stat(key).await,
            AnyStore::V2(s) => s.as_ref().stat(key).await,
        }
    }

    async fn get_bytes(&self, key: &str, range: Option<ByteRange>) -> AppResult<ObjectStream> {
        match self {
            AnyStore::Aws(s) => s.as_ref().get_bytes(key, range).await,
            AnyStore::V2(s) => s.as_ref().get_bytes(key, range).await,
        }
    }

    async fn get_to(
        &self,
        key: &str,
        sink: &mut (dyn AsyncWrite + Unpin + Send),
    ) -> AppResult<u64> {
        match self {
            AnyStore::Aws(s) => s.as_ref().get_to(key, &mut *sink).await,
            AnyStore::V2(s) => s.as_ref().get_to(key, &mut *sink).await,
        }
    }

    async fn put_bytes(
        &self,
        key: &str,
        body: Vec<u8>,
        content_type: Option<&str>,
    ) -> AppResult<()> {
        match self {
            AnyStore::Aws(s) => s.as_ref().put_bytes(key, body, content_type).await,
            AnyStore::V2(s) => s.as_ref().put_bytes(key, body, content_type).await,
        }
    }

    async fn put_file(&self, key: &str, path: &Path) -> AppResult<()> {
        match self {
            AnyStore::Aws(s) => s.as_ref().put_file(key, path).await,
            AnyStore::V2(s) => s.as_ref().put_file(key, path).await,
        }
    }

    async fn delete_object(&self, key: &str) -> AppResult<()> {
        match self {
            AnyStore::Aws(s) => s.as_ref().delete_object(key).await,
            AnyStore::V2(s) => s.as_ref().delete_object(key).await,
        }
    }

    async fn copy_object(&self, source_key: &str, dest_key: &str) -> AppResult<()> {
        match self {
            AnyStore::Aws(s) => s.as_ref().copy_object(source_key, dest_key).await,
            AnyStore::V2(s) => s.as_ref().copy_object(source_key, dest_key).await,
        }
    }

    async fn delete_many(&self, keys: &[String]) -> AppResult<()> {
        match self {
            AnyStore::Aws(s) => s.as_ref().delete_many(keys).await,
            AnyStore::V2(s) => s.as_ref().delete_many(keys).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_key_keeps_tail() {
        assert_eq!(short_key("a.png"), "a.png");
        assert_eq!(short_key("a/b/c.png"), "a/b/c.png");
        assert_eq!(short_key("x/y/z/w.png"), "…/z/w.png");
    }

    #[test]
    fn byte_range_header() {
        assert_eq!(
            ByteRange {
                start: 0,
                end: 1023
            }
            .header(),
            "bytes=0-1023"
        );
    }
}
