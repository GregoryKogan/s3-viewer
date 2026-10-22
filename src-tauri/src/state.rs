//! Shared application state and connection → store resolution.

use crate::error::AppResult;
use crate::model::{Capabilities, Connection, ConnectionView, StaticCreds};
use crate::progress::ProgressTracker;
use crate::s3::{aws::AwsStore, v2::V2Store, AnyStore};
use crate::store::{ConnectionInput, Store};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A small object kept in RAM so `s3stream://` can answer ranges without a
/// network round trip each.
///
/// A webview's media stack reads a file in a couple of hundred tiny ranged
/// requests, strictly one after another: 8-byte box headers while it parses the
/// container, then 10-24 KB chunks while it plays. Over S3 every one of those is
/// a full round trip, and that is what made playback stutter. One download, then
/// slices.
pub struct CachedMedia {
    pub connection_id: String,
    pub key: String,
    pub size: u64,
    pub content_type: Option<String>,
    pub etag: Option<String>,
    pub body: Arc<Vec<u8>>,
    fetched_at: Instant,
}

/// How long a cached object is trusted. Opening a preview drops the cache, so
/// the window only bounds what an idle app keeps in RAM.
const MEDIA_TTL: Duration = Duration::from_secs(10 * 60);

impl CachedMedia {
    pub fn new(
        connection_id: &str,
        key: &str,
        size: u64,
        content_type: Option<String>,
        etag: Option<String>,
        body: Vec<u8>,
    ) -> Self {
        CachedMedia {
            connection_id: connection_id.to_string(),
            key: key.to_string(),
            size,
            content_type,
            etag,
            body: Arc::new(body),
            fetched_at: Instant::now(),
        }
    }
}

pub struct AppCore {
    store: Mutex<Store>,
    pub progress: ProgressTracker,
    /// One live client per connection, invalidated whenever the connection is
    /// edited or deleted.
    clients: Mutex<HashMap<String, AnyStore>>,
    /// The one object the media player is reading right now (see [`CachedMedia`]).
    media: Mutex<Option<Arc<CachedMedia>>>,
}

impl AppCore {
    pub fn new(store: Store) -> Self {
        AppCore {
            store: Mutex::new(store),
            progress: ProgressTracker::new(),
            clients: Mutex::new(HashMap::new()),
            media: Mutex::new(None),
        }
    }

    /// Run a closure with exclusive access to the persisted config.
    pub fn with_store<T>(&self, f: impl FnOnce(&mut Store) -> AppResult<T>) -> AppResult<T> {
        let mut guard = self.store.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut guard)
    }

    /// Read-only convenience for values that are cheap to clone.
    pub fn read<T>(&self, f: impl FnOnce(&Store) -> T) -> T {
        let guard = self.store.lock().unwrap_or_else(|e| e.into_inner());
        f(&guard)
    }

    pub fn connection(&self, id: &str) -> AppResult<Connection> {
        self.read(|store| store.get(id))
    }

    pub fn settings(&self) -> crate::store::AppSettings {
        self.read(|store| store.settings())
    }

    /// Build (or reuse) the store for a connection.
    pub fn client(&self, id: &str) -> AppResult<AnyStore> {
        if let Some(existing) = self.clients.lock().unwrap().get(id).cloned() {
            return Ok(existing);
        }
        let conn = self.connection(id)?;
        let creds = self.read(|store| store.creds(id))?;
        let client = self.build_client(&conn, &creds)?;
        self.clients
            .lock()
            .unwrap()
            .insert(id.to_string(), client.clone());
        Ok(client)
    }

    /// A throwaway client, used by "Test connection" before anything is saved.
    pub fn build_client(&self, conn: &Connection, creds: &StaticCreds) -> AppResult<AnyStore> {
        if conn.signature_version.is_v2() {
            Ok(AnyStore::from_v2(V2Store::new(conn, creds)?))
        } else {
            Ok(AnyStore::from_aws(AwsStore::new(conn, creds)))
        }
    }

    pub fn invalidate(&self, id: &str) {
        self.clients.lock().unwrap().remove(id);
    }

    /// The object cached for `s3stream://`, if it is still the right one.
    pub fn cached_media(&self, connection_id: &str, key: &str) -> Option<Arc<CachedMedia>> {
        let guard = self.media.lock().unwrap_or_else(|e| e.into_inner());
        let media = guard.clone()?;
        let fresh = media.fetched_at.elapsed() <= MEDIA_TTL;
        (fresh && media.connection_id == connection_id && media.key == key).then_some(media)
    }

    /// Keep one object in RAM; whatever the previous preview cached is dropped.
    pub fn remember_media(&self, media: CachedMedia) {
        *self.media.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(media));
    }

    /// Drop the cached object, so the next preview reads the current bytes.
    pub fn forget_media(&self) {
        *self.media.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    pub fn connection_views(&self) -> Vec<ConnectionView> {
        self.read(|store| {
            store
                .list()
                .into_iter()
                .map(|conn| ConnectionView {
                    has_secret: store.has_secret(&conn.id),
                    capabilities: store.capabilities(&conn.id),
                    connection: conn,
                })
                .collect()
        })
    }

    pub fn set_capabilities(&self, id: &str, caps: Capabilities) -> AppResult<()> {
        self.with_store(|store| store.set_capabilities(id, caps))
    }
    pub fn upsert_connection(&self, input: ConnectionInput) -> AppResult<Connection> {
        let conn = self.with_store(|store| store.upsert(input))?;
        self.invalidate(&conn.id);
        Ok(conn)
    }

    pub fn delete_connection(&self, id: &str) -> AppResult<()> {
        self.with_store(|store| store.delete(id))?;
        self.invalidate(id);
        Ok(())
    }

    pub fn mark_used(&self, id: &str) {
        let _ = self.with_store(|store| store.touch(id));
    }
}
