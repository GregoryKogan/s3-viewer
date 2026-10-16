//! Persistence for connections, encrypted secrets and app settings.
//!
//! On-disk layout (`~/Library/Application Support/dev.s3viewer.app/config.json`
//! on macOS, `$XDG_CONFIG_HOME/dev.s3viewer.app/config.json` on Linux):
//!
//! ```json
//! {
//!   "version": 1,
//!   "connections": { "<uuid>": { ...Connection, no secret... } },
//!   "secrets":     { "<uuid>": "enc:v1:<base64 nonce||ciphertext>" },
//!   "settings":    { ...AppSettings... }
//! }
//! ```
//!
//! Secret access keys and session tokens live **only** in `secrets`, sealed by
//! [`crate::crypto::Cipher`]. The file is created `0600`, the directory `0700`.

use crate::crypto::{config_dir, restrict_dir_permissions, restrict_permissions, Cipher};
use crate::error::{AppError, AppResult};
use crate::model::{Capabilities, Connection, StaticCreds};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const CONFIG_VERSION: u32 = 1;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// Preview is refused above this size (bytes). Default 25 MiB.
    pub preview_max_bytes: u64,
    /// Maximum number of *objects* listed per folder (folders are always
    /// included, however many there are).
    pub list_page_limit: u32,
    /// Where downloads land. `None` -> the OS download directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_dir: Option<String>,
    /// Show hidden-ish entries (dotfiles, `_SUCCESS`, `_temporary`).
    pub show_system_objects: bool,
    pub theme: Theme,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Dark,
    Light,
    System,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            preview_max_bytes: 25 * 1024 * 1024,
            list_page_limit: 20_000,
            download_dir: None,
            show_system_objects: false,
            theme: Theme::Dark,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedConfig {
    pub version: u32,
    #[serde(default)]
    pub connections: HashMap<String, Connection>,
    /// Sealed values, keyed by connection id.
    #[serde(default)]
    pub secrets: HashMap<String, String>,
    /// `true` when the sealed value holds a session token as well.
    #[serde(default)]
    pub secret_has_session_token: HashMap<String, bool>,
    #[serde(default)]
    pub capabilities: HashMap<String, Capabilities>,
    #[serde(default)]
    pub settings: AppSettings,
}

impl Default for PersistedConfig {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            connections: HashMap::new(),
            secrets: HashMap::new(),
            secret_has_session_token: HashMap::new(),
            capabilities: HashMap::new(),
            settings: AppSettings::default(),
        }
    }
}

pub struct Store {
    pub path: PathBuf,
    pub config: PersistedConfig,
    cipher: Cipher,
}

/// Payload used to create or update a connection. Omitting `secretAccessKey`
/// on update keeps the stored secret untouched.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub endpoint_url: String,
    #[serde(default)]
    pub region: Option<String>,
    pub access_key_id: String,
    #[serde(default)]
    pub secret_access_key: Option<String>,
    #[serde(default)]
    pub session_token: Option<String>,
    #[serde(default)]
    pub clear_session_token: bool,
    pub bucket: String,
    #[serde(default)]
    pub prefix: Option<String>,
    #[serde(default)]
    pub addressing_style: Option<crate::model::AddressingStyle>,
    #[serde(default)]
    pub signature_version: Option<crate::model::SignatureVersion>,
    #[serde(default)]
    pub payload_signing_enabled: Option<bool>,
    #[serde(default)]
    pub security: Option<crate::model::SecuritySettings>,
}

impl Store {
    pub fn load() -> AppResult<Self> {
        Self::load_from(config_dir())
    }

    pub fn load_from(dir: impl AsRef<Path>) -> AppResult<Self> {
        let dir = dir.as_ref().to_path_buf();
        std::fs::create_dir_all(&dir)?;
        restrict_dir_permissions(&dir);
        let path = dir.join("config.json");
        let cipher = Cipher::load(&dir);
        let config = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<PersistedConfig>(&text).unwrap_or_else(|err| {
                // A corrupt config must not brick the app: keep a backup and start clean.
                let backup =
                    path.with_extension(format!("corrupt-{}.json", chrono::Utc::now().timestamp()));
                let _ = std::fs::write(&backup, &text);
                eprintln!(
                    "s3viewer: config parse failed ({err}); moved to {}",
                    backup.display()
                );
                PersistedConfig::default()
            }),
            Err(_) => PersistedConfig::default(),
        };
        let mut store = Store {
            path,
            config,
            cipher,
        };
        store.migrate_cleartext_secrets()?;
        Ok(store)
    }

    /// Older builds (and hand-edited files) may carry a cleartext secret inside
    /// the connection body. Move it into the sealed store.
    fn migrate_cleartext_secrets(&mut self) -> AppResult<()> {
        let mut changed = false;
        let ids: Vec<String> = self.config.connections.keys().cloned().collect();
        for id in ids {
            let Some(conn) = self.config.connections.get(&id) else {
                continue;
            };
            let legacy: Option<String> = serde_json::from_value::<LegacySecret>(
                serde_json::to_value(conn).unwrap_or_default(),
            )
            .ok()
            .and_then(|l| l.secret_access_key);
            if let Some(secret) = legacy {
                if !secret.is_empty() {
                    self.set_secret(&id, &secret, None)?;
                    changed = true;
                }
            }
        }
        if changed {
            self.save()?;
        }
        Ok(())
    }

    pub fn save(&self) -> AppResult<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
            restrict_dir_permissions(parent);
        }
        let text = serde_json::to_string_pretty(&self.config)
            .map_err(|e| AppError::Store(format!("serialize config: {e}")))?;
        // Write-then-rename so a crash cannot leave a half-written config.
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, text)?;
        restrict_permissions(&tmp);
        std::fs::rename(&tmp, &self.path)?;
        restrict_permissions(&self.path);
        Ok(())
    }

    pub fn master_key_in_keychain(&self) -> bool {
        self.cipher.in_keychain
    }

    // ---------------------------------------------------------------- secrets

    pub fn set_secret(
        &mut self,
        id: &str,
        secret_access_key: &str,
        session_token: Option<&str>,
    ) -> AppResult<()> {
        let payload = serde_json::json!({
            "secretAccessKey": secret_access_key,
            "sessionToken": session_token,
        })
        .to_string();
        let sealed = self
            .cipher
            .seal(&payload)
            .map_err(|e| AppError::Store(format!("seal secret: {e}")))?;
        self.config.secrets.insert(id.to_string(), sealed);
        self.config
            .secret_has_session_token
            .insert(id.to_string(), session_token.is_some());
        Ok(())
    }

    pub fn creds(&self, id: &str) -> AppResult<StaticCreds> {
        let conn = self
            .config
            .connections
            .get(id)
            .ok_or_else(|| AppError::not_found(format!("connection {id}")))?;
        let sealed = self
            .config
            .secrets
            .get(id)
            .ok_or_else(|| AppError::Store(format!("no stored secret for connection {id}")))?;
        let plain = self
            .cipher
            .open(sealed)
            .map_err(|e| AppError::Store(format!("unseal secret for {id}: {e}")))?;
        let parsed: SealedSecret = serde_json::from_str(&plain)
            .map_err(|e| AppError::Store(format!("malformed sealed secret for {id}: {e}")))?;
        Ok(StaticCreds {
            access_key_id: conn.access_key_id.clone(),
            secret_access_key: parsed.secret_access_key,
            session_token: parsed.session_token.filter(|t| !t.is_empty()),
        })
    }

    pub fn has_secret(&self, id: &str) -> bool {
        self.config.secrets.contains_key(id)
    }

    // ------------------------------------------------------------ connections

    pub fn list(&self) -> Vec<Connection> {
        let mut all: Vec<Connection> = self.config.connections.values().cloned().collect();
        all.sort_by(|a, b| {
            b.last_used_at
                .cmp(&a.last_used_at)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        all
    }

    pub fn get(&self, id: &str) -> AppResult<Connection> {
        self.config
            .connections
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::not_found(format!("connection {id}")))
    }

    pub fn upsert(&mut self, input: ConnectionInput) -> AppResult<Connection> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err(AppError::invalid("name is required"));
        }
        let endpoint = input.endpoint_url.trim().trim_end_matches('/');
        if endpoint.is_empty() {
            return Err(AppError::invalid("endpoint URL is required"));
        }
        if !(endpoint.starts_with("http://") || endpoint.starts_with("https://")) {
            return Err(AppError::invalid(
                "endpoint URL must start with http:// or https://",
            ));
        }
        if input.bucket.trim().is_empty() {
            return Err(AppError::invalid("bucket is required"));
        }
        if input.access_key_id.trim().is_empty() {
            return Err(AppError::invalid("access key id is required"));
        }

        let id = match input.id.clone() {
            Some(id) if !id.is_empty() => id,
            _ => uuid::Uuid::new_v4().to_string(),
        };
        let existing = self.config.connections.get(&id).cloned();
        let created_at = existing
            .as_ref()
            .map(|c| c.created_at.clone())
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

        let session_token_present = if input.clear_session_token {
            false
        } else {
            input
                .session_token
                .as_ref()
                .map(|t| !t.is_empty())
                .unwrap_or_else(|| {
                    existing
                        .as_ref()
                        .map(|c| c.session_token_present)
                        .unwrap_or(false)
                })
        };

        let conn = Connection {
            id: id.clone(),
            name: name.to_string(),
            endpoint_url: endpoint.to_string(),
            region: input
                .region
                .map(|r| r.trim().to_string())
                .filter(|r| !r.is_empty())
                .or_else(|| existing.as_ref().map(|c| c.region.clone()))
                .unwrap_or_else(|| "us-east-1".to_string()),
            access_key_id: input.access_key_id.trim().to_string(),
            session_token_present,
            bucket: input.bucket.trim().to_string(),
            prefix: normalize_prefix(input.prefix.as_deref().unwrap_or_default()),
            addressing_style: input
                .addressing_style
                .or_else(|| existing.as_ref().map(|c| c.addressing_style))
                .unwrap_or_default(),
            signature_version: input
                .signature_version
                .or_else(|| existing.as_ref().map(|c| c.signature_version))
                .unwrap_or_default(),
            payload_signing_enabled: input
                .payload_signing_enabled
                .or_else(|| existing.as_ref().map(|c| c.payload_signing_enabled))
                .unwrap_or(false),
            use_path_style_for_list: existing
                .as_ref()
                .map(|c| c.use_path_style_for_list)
                .unwrap_or(true),
            security: input
                .security
                .or_else(|| existing.as_ref().map(|c| c.security.clone()))
                .unwrap_or_default(),
            last_used_at: existing.as_ref().and_then(|c| c.last_used_at.clone()),
            created_at,
        };

        // Validate the bucket/prefix combination early so the user gets the
        // error in the form rather than on the first listing.
        if conn.bucket.contains('/') {
            return Err(AppError::invalid("bucket name must not contain '/'"));
        }
        if conn.addressing_style == crate::model::AddressingStyle::Virtual
            && conn.bucket.contains('.')
            && endpoint_is_https(&conn.endpoint_url)
        {
            // Allowed, but worth knowing: TLS certificates for dotted buckets
            // require wildcard support from the provider.
        }

        let secret_update = input
            .secret_access_key
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let token_update = if input.clear_session_token {
            Some(None)
        } else {
            input.session_token.clone().map(Some)
        };

        match (secret_update, token_update) {
            (Some(secret), token) => {
                let token = token.flatten();
                self.set_secret(&id, &secret, token.as_deref())?;
            }
            (None, Some(None)) => {
                // Keep the secret, drop the session token.
                let creds = self.creds(&id)?;
                self.set_secret(&id, &creds.secret_access_key, None)?;
            }
            (None, Some(Some(token))) => {
                let creds = self.creds(&id)?;
                self.set_secret(&id, &creds.secret_access_key, Some(&token))?;
            }
            (None, None) => {
                if !self.has_secret(&id) {
                    return Err(AppError::invalid("secret access key is required"));
                }
            }
        }

        self.config.connections.insert(id.clone(), conn.clone());
        self.config.capabilities.remove(&id);
        self.save()?;
        Ok(conn)
    }

    pub fn delete(&mut self, id: &str) -> AppResult<()> {
        if self.config.connections.remove(id).is_none() {
            return Err(AppError::not_found(format!("connection {id}")));
        }
        self.config.secrets.remove(id);
        self.config.secret_has_session_token.remove(id);
        self.config.capabilities.remove(id);
        self.save()
    }

    pub fn touch(&mut self, id: &str) -> AppResult<()> {
        if let Some(conn) = self.config.connections.get_mut(id) {
            conn.last_used_at = Some(chrono::Utc::now().to_rfc3339());
            self.save()?;
        }
        Ok(())
    }

    pub fn set_capabilities(&mut self, id: &str, caps: Capabilities) -> AppResult<()> {
        self.config.capabilities.insert(id.to_string(), caps);
        self.save()
    }

    pub fn capabilities(&self, id: &str) -> Option<Capabilities> {
        self.config.capabilities.get(id).cloned()
    }

    pub fn settings(&self) -> AppSettings {
        self.config.settings.clone()
    }

    pub fn update_settings(&mut self, settings: AppSettings) -> AppResult<()> {
        self.config.settings = settings;
        self.save()
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SealedSecret {
    secret_access_key: String,
    #[serde(default)]
    session_token: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySecret {
    #[serde(default)]
    secret_access_key: Option<String>,
}

fn endpoint_is_https(endpoint: &str) -> bool {
    endpoint.starts_with("https://")
}

/// S3 prefixes are key prefixes, matched literally against object keys — the
/// same semantics boto3's `Prefix=` has. Keys in some buckets genuinely start
/// with `/`, so a leading slash is preserved. A single trailing slash is added
/// because every listing this app performs is a folder listing.
pub fn normalize_prefix(prefix: &str) -> String {
    let trimmed = prefix.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.ends_with('/') {
        trimmed.to_string()
    } else {
        format!("{trimmed}/")
    }
}

/// Reject keys that would escape the connection prefix or break the URL.
pub fn validate_key(key: &str) -> AppResult<()> {
    if key.is_empty() {
        return Err(AppError::invalid("key is empty"));
    }
    if key.starts_with('/') {
        return Err(AppError::invalid("key must not start with '/'"));
    }
    if key.split('/').any(|seg| seg == "..") {
        return Err(AppError::invalid("key must not contain '..'"));
    }
    if key.contains('\u{0}') {
        return Err(AppError::invalid("key contains a NUL byte"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AddressingStyle, SignatureVersion};

    fn temp_store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var(
            crate::crypto::ENV_TEST_KEY,
            "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
        );
        let store = Store::load_from(dir.path()).unwrap();
        (dir, store)
    }

    fn sample_input() -> ConnectionInput {
        ConnectionInput {
            id: None,
            name: "Dev".into(),
            endpoint_url: "https://obs.example.ru/".into(),
            region: Some("us-east-1".into()),
            access_key_id: "AKIAEXAMPLE".into(),
            secret_access_key: Some("top-secret".into()),
            session_token: None,
            clear_session_token: false,
            bucket: "d-bucket".into(),
            prefix: Some("/a/b/".into()),
            addressing_style: Some(AddressingStyle::Virtual),
            signature_version: Some(SignatureVersion::S3v4),
            payload_signing_enabled: Some(false),
            security: None,
        }
    }

    #[test]
    fn create_encrypts_secret_and_never_writes_plaintext() {
        let (dir, mut store) = temp_store();
        let conn = store.upsert(sample_input()).unwrap();
        // A leading slash is preserved because it is part of the key prefix.
        assert_eq!(conn.prefix, "/a/b/");
        assert_eq!(conn.endpoint_url, "https://obs.example.ru");
        assert_eq!(conn.region, "us-east-1");
        let creds = store.creds(&conn.id).unwrap();
        assert_eq!(creds.secret_access_key, "top-secret");

        let raw = std::fs::read_to_string(dir.path().join("config.json")).unwrap();
        assert!(
            !raw.contains("top-secret"),
            "secret leaked into config.json"
        );
        assert!(raw.contains("enc:v1:"));
    }

    #[test]
    fn config_file_is_0600_and_dir_0700() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let (dir, mut store) = temp_store();
            store.upsert(sample_input()).unwrap();
            let file = std::fs::metadata(dir.path().join("config.json")).unwrap();
            assert_eq!(file.permissions().mode() & 0o777, 0o600);
            let d = std::fs::metadata(dir.path()).unwrap();
            assert_eq!(d.permissions().mode() & 0o777, 0o700);
        }
    }

    #[test]
    fn update_without_secret_keeps_previous_secret() {
        let (_dir, mut store) = temp_store();
        let conn = store.upsert(sample_input()).unwrap();
        let mut input = sample_input();
        input.id = Some(conn.id.clone());
        input.secret_access_key = None;
        input.name = "Renamed".into();
        let updated = store.upsert(input).unwrap();
        assert_eq!(updated.name, "Renamed");
        assert_eq!(
            store.creds(&conn.id).unwrap().secret_access_key,
            "top-secret"
        );
    }

    #[test]
    fn session_token_roundtrip_and_clear() {
        let (_dir, mut store) = temp_store();
        let mut input = sample_input();
        input.session_token = Some("tok".into());
        let conn = store.upsert(input).unwrap();
        assert!(conn.session_token_present);
        assert_eq!(
            store.creds(&conn.id).unwrap().session_token.as_deref(),
            Some("tok")
        );

        let mut clear = sample_input();
        clear.id = Some(conn.id.clone());
        clear.clear_session_token = true;
        let conn = store.upsert(clear).unwrap();
        assert!(!conn.session_token_present);
        assert!(store.creds(&conn.id).unwrap().session_token.is_none());
    }

    #[test]
    fn requires_secret_on_create() {
        let (_dir, mut store) = temp_store();
        let mut input = sample_input();
        input.secret_access_key = None;
        assert!(store.upsert(input).is_err());
    }

    #[test]
    fn rejects_bad_input() {
        let (_dir, mut store) = temp_store();
        let mut input = sample_input();
        input.endpoint_url = "obs.example.ru".into();
        assert!(store.upsert(input).is_err());

        let mut input = sample_input();
        input.bucket = "a/b".into();
        assert!(store.upsert(input).is_err());
    }

    #[test]
    fn delete_removes_connection_and_secret() {
        let (_dir, mut store) = temp_store();
        let conn = store.upsert(sample_input()).unwrap();
        store.delete(&conn.id).unwrap();
        assert!(store.list().is_empty());
        assert!(!store.has_secret(&conn.id));
    }

    #[test]
    fn two_connections_same_bucket_different_prefix() {
        let (_dir, mut store) = temp_store();
        let a = store.upsert(sample_input()).unwrap();
        let mut input = sample_input();
        input.prefix = Some("other/path".into());
        let b = store.upsert(input).unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(b.prefix, "other/path/");
        assert_eq!(store.list().len(), 2);
    }

    #[test]
    fn normalize_prefix_shapes() {
        assert_eq!(normalize_prefix(""), "");
        assert_eq!(normalize_prefix("   "), "");
        assert_eq!(normalize_prefix("a"), "a/");
        assert_eq!(normalize_prefix("/a/b/"), "/a/b/");
        assert_eq!(normalize_prefix("a/b"), "a/b/");
        // Leading slashes are preserved: keys in some buckets really start with
        // one, so trimming it would silently change which objects are listed.
        assert_eq!(normalize_prefix("/absolute"), "/absolute/");
    }

    #[test]
    fn validate_key_blocks_traversal() {
        assert!(validate_key("ok/key.png").is_ok());
        assert!(validate_key("").is_err());
        assert!(validate_key("/abs").is_err());
        assert!(validate_key("a/../b").is_err());
    }

    #[test]
    fn corrupt_config_is_backed_up_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var(
            crate::crypto::ENV_TEST_KEY,
            "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
        );
        std::fs::write(dir.path().join("config.json"), "{not json").unwrap();
        let store = Store::load_from(dir.path()).unwrap();
        assert!(store.list().is_empty());
        let backups: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("corrupt"))
            .collect();
        assert_eq!(backups.len(), 1);
    }
}
