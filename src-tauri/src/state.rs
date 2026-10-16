//! Shared application state and connection → store resolution.

use crate::error::AppResult;
use crate::fetch::Fetch;
use crate::model::{Capabilities, Connection, ConnectionView, StaticCreds};
use crate::progress::ProgressTracker;
use crate::s3::{aws::AwsStore, v2::V2Store, AnyStore};
use crate::store::{ConnectionInput, Store};
use std::collections::HashMap;
use std::sync::Mutex;

pub struct AppCore {
    store: Mutex<Store>,
    pub progress: ProgressTracker,
    pub fetch: Fetch,
    /// One live client per connection, invalidated whenever the connection is
    /// edited or deleted.
    clients: Mutex<HashMap<String, AnyStore>>,
}

impl AppCore {
    pub fn new(store: Store, handle: tokio::runtime::Handle) -> Self {
        AppCore {
            store: Mutex::new(store),
            progress: ProgressTracker::new(),
            fetch: Fetch::new(handle),
            clients: Mutex::new(HashMap::new()),
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
