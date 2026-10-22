//! All Tauri commands. These are deliberately thin: validate input, call into
//! [`crate::state::AppCore`], map errors to a structured payload.

use crate::error::{AppError, AppResult, ErrorPayload};
// `macro_export` places these at the crate root, so they need importing here.
use crate::model::{
    Capabilities, Connection, ConnectionView, FileKind, ListResult, ObjectEntry, PreviewData,
    ProgressState, ProgressView, StaticCreds,
};
use crate::objects::{self, as_folder_prefix};
use crate::preview::{self, parse_range};
use crate::progress::ProgressTracker;
use crate::s3::{AnyStore, ObjectStore};
use crate::state::AppCore;
use crate::store::{AppSettings, ConnectionInput, Theme};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use tauri::{AppHandle, Emitter, State};

pub type CmdResult<T> = Result<T, ErrorPayload>;

fn err(e: AppError) -> ErrorPayload {
    e.into()
}

// ------------------------------------------------------------------ settings

#[tauri::command]
pub async fn get_settings(app: State<'_, Arc<AppCore>>) -> CmdResult<AppSettings> {
    Ok(app.inner().settings())
}

#[tauri::command]
pub async fn update_settings(
    app: State<'_, Arc<AppCore>>,
    settings: AppSettings,
) -> CmdResult<AppSettings> {
    app.inner()
        .with_store(|store| {
            store.update_settings(settings.clone())?;
            Ok(settings)
        })
        .map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityStatus {
    /// true when the master key lives in the OS keychain.
    pub master_key_in_keychain: bool,
    pub config_path: String,
    pub config_version: u32,
    pub connection_count: usize,
    pub home_download_dir: String,
    pub theme: Theme,
}

#[tauri::command]
pub async fn security_status(app: State<'_, Arc<AppCore>>) -> CmdResult<SecurityStatus> {
    Ok(app.inner().read(|store| SecurityStatus {
        master_key_in_keychain: store.master_key_in_keychain(),
        config_path: store.path.display().to_string(),
        config_version: store.config.version,
        connection_count: store.config.connections.len(),
        home_download_dir: crate::fsutil::download_dir().display().to_string(),
        theme: store.config.settings.theme,
    }))
}

// --------------------------------------------------------------- connections

#[tauri::command]
pub async fn list_connections(app: State<'_, Arc<AppCore>>) -> CmdResult<Vec<ConnectionView>> {
    Ok(app.inner().connection_views())
}

#[tauri::command]
pub async fn get_connection(app: State<'_, Arc<AppCore>>, id: String) -> CmdResult<ConnectionView> {
    let core = app.inner();
    let conn = core.connection(&id).map_err(err)?;
    Ok(core.read(|store| ConnectionView {
        has_secret: store.has_secret(&id),
        capabilities: store.capabilities(&id),
        connection: conn,
    }))
}

#[tauri::command]
pub async fn save_connection(
    app: State<'_, Arc<AppCore>>,
    input: ConnectionInput,
) -> CmdResult<Connection> {
    // Moving or renaming invalidates the cached capabilities of the old id too.
    let core = app.inner();
    let old_id = input.id.clone();
    let conn = core.upsert_connection(input).map_err(err)?;
    if let Some(old) = old_id {
        if old != conn.id {
            core.invalidate(&old);
        }
    }
    Ok(conn)
}

#[tauri::command]
pub async fn delete_connection(app: State<'_, Arc<AppCore>>, id: String) -> CmdResult<()> {
    app.inner().delete_connection(&id).map_err(err)
}

#[tauri::command]
pub async fn duplicate_connection(
    app: State<'_, Arc<AppCore>>,
    id: String,
) -> CmdResult<Connection> {
    let core = app.inner();
    let conn = core.connection(&id).map_err(err)?;
    let creds = core.read(|store| store.creds(&id)).map_err(err)?;
    let input = ConnectionInput {
        id: None,
        name: format!("{} (copy)", conn.name),
        endpoint_url: conn.endpoint_url.clone(),
        region: Some(conn.region.clone()),
        access_key_id: conn.access_key_id.clone(),
        secret_access_key: Some(creds.secret_access_key.clone()),
        session_token: creds.session_token.clone(),
        clear_session_token: false,
        bucket: conn.bucket.clone(),
        // A duplicate usually means "same bucket, another prefix".
        prefix: Some(conn.prefix.trim_end_matches('/').to_string()),
        addressing_style: Some(conn.addressing_style),
        signature_version: Some(conn.signature_version),
        payload_signing_enabled: Some(conn.payload_signing_enabled),
        request_checksum_calculation: Some(conn.request_checksum_calculation),
        response_checksum_validation: Some(conn.response_checksum_validation),
        security: Some(conn.security.clone()),
    };
    core.upsert_connection(input).map_err(err)
}

/// Input for the "Test connection" and "Detect permissions" buttons. Works both
/// for a saved connection (only `id`) and for a form that is not saved yet.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeInput {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub connection: Option<ConnectionDraft>,
    #[serde(default = "default_detect")]
    pub detect_write: bool,
}

fn default_detect() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionDraft {
    pub endpoint_url: String,
    #[serde(default)]
    pub region: Option<String>,
    pub access_key_id: String,
    #[serde(default)]
    pub secret_access_key: Option<String>,
    #[serde(default)]
    pub session_token: Option<String>,
    pub bucket: String,
    #[serde(default)]
    pub prefix: Option<String>,
    #[serde(default)]
    pub addressing_style: Option<crate::model::AddressingStyle>,
    #[serde(default)]
    pub signature_version: Option<crate::model::SignatureVersion>,
    #[serde(default)]
    pub request_checksum_calculation: Option<crate::model::ChecksumCalculation>,
    #[serde(default)]
    pub response_checksum_validation: Option<crate::model::ChecksumValidation>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeOutcome {
    pub capabilities: Capabilities,
    pub sample_keys: Vec<String>,
    pub prefix: String,
    pub bucket: String,
    pub endpoint: String,
    pub signature_version: String,
    pub addressing_style: String,
}

/// Resolve a probe input into a live store plus the connection it describes.
fn resolve_probe(core: &AppCore, input: &ProbeInput) -> Result<(AnyStore, Connection), AppError> {
    if let Some(draft) = &input.connection {
        let id = input.id.clone().unwrap_or_else(|| "draft".to_string());
        let existing = input.id.as_ref().and_then(|id| core.connection(id).ok());
        let secret = match draft.secret_access_key.clone() {
            Some(s) if !s.is_empty() => Some(s),
            _ => input
                .id
                .as_ref()
                .and_then(|id| core.read(|store| store.creds(id)).ok())
                .map(|c| c.secret_access_key),
        };
        let secret = secret.ok_or_else(|| {
            AppError::invalid("secret access key is required to test this connection")
        })?;
        let session_token = draft.session_token.clone().or_else(|| {
            input
                .id
                .as_ref()
                .and_then(|id| core.read(|store| store.creds(id)).ok())
                .and_then(|c| c.session_token)
        });
        let conn = Connection {
            id,
            name: "draft".into(),
            endpoint_url: draft.endpoint_url.trim().trim_end_matches('/').to_string(),
            region: draft
                .region
                .clone()
                .filter(|r| !r.trim().is_empty())
                .or_else(|| existing.as_ref().map(|c| c.region.clone()))
                .unwrap_or_else(|| "us-east-1".to_string()),
            access_key_id: draft.access_key_id.trim().to_string(),
            session_token_present: session_token.is_some(),
            bucket: draft.bucket.trim().to_string(),
            prefix: draft.prefix.clone().unwrap_or_default(),
            addressing_style: draft
                .addressing_style
                .or_else(|| existing.as_ref().map(|c| c.addressing_style))
                .unwrap_or_default(),
            signature_version: draft
                .signature_version
                .or_else(|| existing.as_ref().map(|c| c.signature_version))
                .unwrap_or_default(),
            payload_signing_enabled: false,
            request_checksum_calculation: draft
                .request_checksum_calculation
                .or_else(|| existing.as_ref().map(|c| c.request_checksum_calculation))
                .unwrap_or_default(),
            response_checksum_validation: draft
                .response_checksum_validation
                .or_else(|| existing.as_ref().map(|c| c.response_checksum_validation))
                .unwrap_or_default(),
            security: Default::default(),
            last_used_at: None,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        if conn.endpoint_url.is_empty() {
            return Err(AppError::invalid("endpoint URL is required"));
        }
        if conn.bucket.is_empty() {
            return Err(AppError::invalid("bucket is required"));
        }
        let creds = StaticCreds {
            access_key_id: conn.access_key_id.clone(),
            secret_access_key: secret,
            session_token,
        };
        let store = core.build_client(&conn, &creds)?;
        return Ok((store, conn));
    }

    let id = input.id.clone().ok_or_else(|| {
        AppError::invalid("either a connection id or a connection draft is required")
    })?;
    let conn = core.connection(&id)?;
    let store = core.client(&id)?;
    Ok((store, conn))
}

#[tauri::command]
pub async fn test_connection(
    app: State<'_, Arc<AppCore>>,
    input: ProbeInput,
) -> CmdResult<ProbeOutcome> {
    let (store, conn) = resolve_probe(app.inner(), &input).map_err(err)?;
    let prefix = as_folder_prefix(&conn.prefix);
    let list = objects::list_folder(&store, &prefix, 25).await?;
    let sample_keys = list
        .0
        .iter()
        .take(10)
        .map(|e| e.key.clone())
        .collect::<Vec<_>>();

    // The draft carries no local read-only switch, so only the credentials are
    // probed here; `detect_capabilities` reports the switch for saved connections.
    let caps = objects::probe_capabilities(&store, &conn.prefix, input.detect_write, false).await;

    Ok(ProbeOutcome {
        capabilities: caps,
        sample_keys,
        prefix: conn.prefix.clone(),
        bucket: conn.bucket.clone(),
        endpoint: conn.endpoint_url.clone(),
        signature_version: format!("{:?}", conn.signature_version),
        addressing_style: format!("{:?}", conn.addressing_style),
    })
}

#[tauri::command]
pub async fn detect_capabilities(
    app: State<'_, Arc<AppCore>>,
    id: String,
) -> CmdResult<Capabilities> {
    let core = app.inner();
    let conn = core.connection(&id).map_err(err)?;
    let store = core.client(&id).map_err(err)?;
    let detect = conn.security.detect_permissions;
    let read_only = conn.security.read_only_mode;
    let caps = objects::probe_capabilities(&store, &conn.prefix, detect, read_only).await;
    core.set_capabilities(&id, caps.clone()).map_err(err)?;
    Ok(caps)
}

// -------------------------------------------------------------------- listing

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListStreamInput {
    pub connection_id: String,
    #[serde(default)]
    pub prefix: Option<String>,
    /// Echoed back in every event so stale listeners can be ignored.
    pub request_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListInput {
    pub connection_id: String,
    #[serde(default)]
    pub prefix: Option<String>,
}

#[tauri::command]
pub async fn list_objects(app: State<'_, Arc<AppCore>>, input: ListInput) -> CmdResult<ListResult> {
    let core = app.inner();
    let conn = core.connection(&input.connection_id).map_err(err)?;
    let limit = core.settings().list_page_limit as usize;
    let show_system = core.settings().show_system_objects;
    let prefix = match input.prefix {
        Some(p) => as_folder_prefix(&p),
        None => as_folder_prefix(&conn.prefix),
    };
    core.mark_used(&input.connection_id);
    let store = core.client(&input.connection_id).map_err(err)?;
    let (mut entries, truncated) = objects::list_folder(&store, &prefix, limit).await?;

    if !show_system {
        entries.retain(|e| !is_system_entry(e));
    }
    Ok(ListResult {
        prefix: prefix.clone(),
        entries,
        truncated,
        warning: truncation_warning(truncated, limit),
    })
}

/// Listings the webview can still abort, keyed by the `request_id` it chose.
///
/// A prefix with hundreds of thousands of sub-folders keeps S3 answering one
/// page every few seconds for half an hour, so walking away from it must stop
/// the scan instead of leaving it to compete with whatever is opened next.
static LIVE_LISTINGS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(Default::default);

fn register_listing(id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut live) = LIVE_LISTINGS.lock() {
        live.insert(id.to_string(), flag.clone());
    }
    flag
}

fn release_listing(id: &str) {
    if let Ok(mut live) = LIVE_LISTINGS.lock() {
        live.remove(id);
    }
}

/// Stop a listing whose rows nobody is going to look at.
///
/// An unknown id is not an error: the listing may have finished between the UI
/// deciding to walk away and this call arriving.
#[tauri::command]
pub fn cancel_listing(request_id: String) {
    if let Ok(live) = LIVE_LISTINGS.lock() {
        if let Some(flag) = live.get(&request_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// Listing that streams: every S3 page is emitted as an event so the UI can paint
/// results while a large prefix is still being read.
///
/// Returns when the listing is complete. The final `listing://done` event carries
/// the authoritative totals, including the result of the system-object filter.
#[tauri::command]
pub async fn list_objects_stream(
    app: AppHandle,
    app_state: State<'_, Arc<AppCore>>,
    input: ListStreamInput,
) -> CmdResult<()> {
    let core = app_state.inner();
    let conn = core.connection(&input.connection_id).map_err(err)?;
    let limit = core.settings().list_page_limit as usize;
    let show_system = core.settings().show_system_objects;
    let prefix = match input.prefix.clone() {
        Some(p) => as_folder_prefix(&p),
        None => as_folder_prefix(&conn.prefix),
    };
    core.mark_used(&input.connection_id);
    let store = core.client(&input.connection_id).map_err(err)?;

    let request_id = input.request_id.clone();
    let live = register_listing(&request_id);

    let emit = |event: &str, payload: serde_json::Value| {
        let _ = app.emit(event, payload);
    };

    let result: AppResult<(usize, usize, bool)> = async {
        let app = app.clone();
        let prefix_for_pages = prefix.clone();
        let request = request_id.clone();
        let live = live.clone();
        let mut sent = 0usize;
        let mut total_files = 0usize;
        let mut truncated = false;
        objects::list_folder_streaming(&store, &prefix, limit, |page| {
            let mut entries = page.entries;
            if !show_system {
                entries.retain(|entry| !is_system_entry(entry));
            }
            total_files += entries.iter().filter(|entry| !entry.is_folder).count();
            sent += entries.len();
            truncated = page.truncated;
            let _ = app.emit(
                "listing://page",
                serde_json::json!({
                    "requestId": request,
                    "prefix": prefix_for_pages,
                    "entries": entries,
                    "total": sent,
                    "done": page.is_last,
                }),
            );
            !live.load(Ordering::Relaxed)
        })
        .await?;
        Ok::<_, AppError>((sent, total_files, truncated))
    }
    .await;

    let (sent, total_files, truncated) = match result {
        Ok(counts) => counts,
        Err(e) => {
            release_listing(&request_id);
            let payload = ErrorPayload::from(&e);
            let _ = app.emit(
                "listing://error",
                serde_json::json!({ "requestId": input.request_id, "error": payload }),
            );
            return Err(payload);
        }
    };
    release_listing(&request_id);
    emit(
        "listing://done",
        serde_json::json!({
            "requestId": request_id,
            "prefix": prefix,
            "total": sent,
            "files": total_files,
            "truncated": truncated,
            "warning": truncation_warning(truncated, limit),
        }),
    );
    Ok(())
}

fn truncation_warning(truncated: bool, limit: usize) -> Option<String> {
    truncated.then(|| {
        format!(
            "Listing truncated at {limit} objects. Raise the limit in Settings, or open a sub-folder."
        )
    })
}

/// CyberDuck-style filtering of HDFS/Spark bookkeeping objects.
fn is_system_entry(entry: &ObjectEntry) -> bool {
    let name = entry.name.as_str();
    name == "_SUCCESS"
        || name == "_temporary"
        || name == ".DS_Store"
        || name.starts_with("._")
        || name.ends_with(".crc")
}

// -------------------------------------------------------------------- preview

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewInput {
    pub connection_id: String,
    pub key: String,
    /// `true` forces the kind so a Markdown-as-text toggle does not re-fetch.
    #[serde(default)]
    pub kind_hint: Option<FileKind>,
}

#[tauri::command]
pub async fn get_preview(
    app: State<'_, Arc<AppCore>>,
    input: PreviewInput,
) -> CmdResult<PreviewData> {
    let core = app.inner();
    let max = core.settings().preview_max_bytes;
    let store = core.client(&input.connection_id).map_err(err)?;
    let mut data: PreviewData =
        preview::build_preview(&store, &input.connection_id, &input.key, max)
            .await
            .map_err(err)?;
    if let Some(hint) = input.kind_hint {
        // The UI may re-open the same bytes rendered differently (markdown vs
        // plain text); keep the classification consistent with the toggle.
        if preview::is_textual(hint) && preview::is_textual(data.kind) {
            data.kind = hint;
        }
    }
    Ok(data)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamMeta {
    pub size: i64,
    pub content_type: String,
}

#[tauri::command]
pub async fn object_meta(
    app: State<'_, Arc<AppCore>>,
    connection_id: String,
    key: String,
) -> CmdResult<StreamMeta> {
    let store = app.inner().client(&connection_id).map_err(err)?;
    let meta = store.stat(&key).await?;
    Ok(StreamMeta {
        size: meta.size.unwrap_or(0),
        content_type: meta
            .content_type
            .unwrap_or_else(|| "application/octet-stream".into()),
    })
}

// ------------------------------------------------------------------ transfers

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    pub id: String,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadInput {
    pub connection_id: String,
    pub key: String,
    /// Optional explicit destination; otherwise `dest_dir` (or the configured
    /// download directory) is used.
    #[serde(default)]
    pub dest_path: Option<String>,
    /// Directory for a batch download. `dest_path` wins when both are set.
    #[serde(default)]
    pub dest_dir: Option<String>,
}

#[tauri::command]
pub async fn download_object(
    app: State<'_, Arc<AppCore>>,
    input: DownloadInput,
) -> CmdResult<TransferResult> {
    let core = app.inner();
    // The connection must exist even when a client for it is already cached.
    core.connection(&input.connection_id).map_err(err)?;
    let store = core.client(&input.connection_id).map_err(err)?;
    // Reserve the destination before spawning. `unique_path` only checks that a
    // name is free; two concurrent downloads with the same basename could both
    // pick it, truncate each other and both report success. The reservation
    // (`create_new`) returns the already-open file, so the spawn writes exactly
    // the slot the caller was told about.
    let (dest, reserved_file) = match input.dest_path.clone() {
        Some(path) => (PathBuf::from(path), None),
        None => {
            let base = match input
                .dest_dir
                .as_deref()
                .filter(|dir| !dir.trim().is_empty())
            {
                // A batch destination is chosen in one dialog and may not exist
                // yet; the reservation creates it.
                Some(dir) => PathBuf::from(dir),
                None => core
                    .settings()
                    .download_dir
                    .map(PathBuf::from)
                    .unwrap_or_else(crate::fsutil::download_dir),
            };
            let file_name = default_file_name(&input.key);
            let (path, file) = crate::fsutil::reserve_unique_path(&base, &file_name)
                .await
                .map_err(err)?;
            (path, Some(file))
        }
    };

    let progress_id = core
        .progress
        .start(objects::progress_label("Downloading", &input.key), None);
    let tracker = core.progress.clone();
    let progress_id_task = progress_id.clone();
    let store = store.clone();
    let key = input.key.clone();
    let dest_task = dest.clone();

    let reserved = reserved_file.is_some();
    tauri::async_runtime::spawn(async move {
        // Cancelled before the task got scheduled: drop the reservation instead
        // of leaving an empty file behind.
        if !entry_is_running(&tracker, &progress_id_task) {
            drop(reserved_file);
            if reserved {
                let _ = tokio::fs::remove_file(&dest_task).await;
            }
            return;
        }
        let outcome = async {
            let mut file = match reserved_file {
                Some(file) => file,
                None => {
                    if let Some(parent) = dest_task.parent() {
                        tokio::fs::create_dir_all(parent).await?;
                    }
                    tokio::fs::File::create(&dest_task).await?
                }
            };
            let written = store.get_to(&key, &mut file).await?;
            Ok::<u64, AppError>(written)
        }
        .await;

        // A GET that has already started cannot be aborted either. If the user
        // cancelled, the entry stays cancelled and the file is dropped instead
        // of being reported as a finished download. `finish_if_running` makes
        // the check and the state write one locked operation, so a cancel that
        // lands in between cannot be overwritten by `Done`.
        match outcome {
            Ok(_) => {
                if !tracker
                    .finish_if_running(&progress_id_task, Some(dest_task.display().to_string()))
                {
                    let _ = tokio::fs::remove_file(&dest_task).await;
                }
            }
            Err(e) => {
                // Do not leave a half-written file behind.
                let _ = tokio::fs::remove_file(&dest_task).await;
                tracker.fail_if_running(&progress_id_task, crate::model::describe_error(&e));
            }
        }
    });

    Ok(TransferResult {
        id: progress_id,
        path: dest.display().to_string(),
    })
}

fn default_file_name(key: &str) -> String {
    let name = key.trim_end_matches('/').rsplit('/').next().unwrap_or(key);
    if name.is_empty() {
        "object".to_string()
    } else {
        name.to_string()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadFolderInput {
    pub connection_id: String,
    /// Folder key, e.g. `photos/`. A trailing slash is added when missing.
    pub prefix: String,
    /// Parent directory the folder is created in. The configured download
    /// directory is used when absent.
    #[serde(default)]
    pub dest_dir: Option<String>,
}

/// Where one object of a downloaded folder lands on disk.
#[derive(Debug, PartialEq, Eq)]
pub enum LocalTarget {
    /// A regular object: its bytes go to this path below the folder's root.
    File(PathBuf),
    /// A zero-byte folder marker: an empty directory at this path.
    Dir(PathBuf),
}

/// Map `key` to its place below the root of a downloaded folder.
///
/// The key is remote input and may contain `..`, `.`, empty segments or control
/// characters. Every segment is either dropped or joined below the root, so no
/// key can write outside the directory the user chose. `None` means the prefix
/// marker itself — the folder being downloaded, not its content.
pub fn local_target(prefix: &str, key: &str) -> Option<LocalTarget> {
    let rest = key.strip_prefix(prefix)?;
    let mut path = PathBuf::new();
    for segment in rest.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            continue;
        }
        path.push(segment);
    }
    if path.as_os_str().is_empty() {
        return None;
    }
    if key.ends_with('/') {
        Some(LocalTarget::Dir(path))
    } else {
        Some(LocalTarget::File(path))
    }
}

/// A folder name that is safe to create on disk.
///
/// A key tail is arbitrary text: it can be `..`, contain a separator, or be
/// empty for a bucket root. None of those may decide where the download lands.
fn safe_dir_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\') {
                '_'
            } else {
                c
            }
        })
        .collect();
    match cleaned.trim() {
        "" | "." | ".." => "folder".to_string(),
        trimmed => trimmed.to_string(),
    }
}

#[tauri::command]
pub async fn download_folder(
    app: State<'_, Arc<AppCore>>,
    input: DownloadFolderInput,
) -> CmdResult<TransferResult> {
    download_folder_impl(app.inner(), input).await.map_err(err)
}

/// Download every object under a prefix into a new directory of its own.
///
/// The tree is listed before anything is written, so an unreadable prefix fails
/// without leaving a directory or a progress entry behind. Files are fetched one
/// at a time: one request per file is what makes cancellation possible between
/// files, and a folder listing is never a ranged batch GET anyway.
///
/// A failed file does not stop the batch — the rest of the folder is still worth
/// having — and the entry then reports how many failed and the first error.
pub async fn download_folder_impl(
    core: &AppCore,
    input: DownloadFolderInput,
) -> AppResult<TransferResult> {
    core.connection(&input.connection_id)?;
    let store = core.client(&input.connection_id)?;
    let prefix = as_folder_prefix(&input.prefix);
    if prefix.is_empty() {
        return Err(AppError::invalid("a folder download needs a folder prefix"));
    }
    let entries = objects::list_all_entries(&store, &prefix).await?;

    let base = input
        .dest_dir
        .as_deref()
        .filter(|dir| !dir.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| core.settings().download_dir.map(PathBuf::from))
        .unwrap_or_else(crate::fsutil::download_dir);
    let folder_name = safe_dir_name(&objects::leaf_name(&prefix, ""));
    let root = crate::fsutil::reserve_unique_dir(&base, &folder_name).await?;

    let mut files: Vec<(String, PathBuf)> = Vec::new();
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut total = 0u64;
    for entry in &entries {
        match local_target(&prefix, &entry.key) {
            Some(LocalTarget::File(rel)) => {
                total = total.saturating_add(entry.size.max(0) as u64);
                files.push((entry.key.clone(), rel));
            }
            Some(LocalTarget::Dir(rel)) => dirs.push(rel),
            None => {}
        }
    }

    let label = format!(
        "Downloading {folder_name} ({} file{})",
        files.len(),
        if files.len() == 1 { "" } else { "s" }
    );
    let progress_id = core
        .progress
        .start(label, if total == 0 { None } else { Some(total) });
    let tracker = core.progress.clone();
    let id_task = progress_id.clone();
    let root_task = root.clone();

    tauri::async_runtime::spawn(async move {
        // Markers first: `create_dir_all` is a no-op where a file already
        // created the same parent directory.
        for rel in &dirs {
            let path = root_task.join(rel);
            if let Err(e) = tokio::fs::create_dir_all(&path).await {
                tracker.fail_if_running(&id_task, format!("cannot create {}: {e}", path.display()));
                return;
            }
        }

        let mut failed = 0usize;
        let mut first_error = String::new();
        for (key, rel) in &files {
            if !entry_is_running(&tracker, &id_task) {
                // Cancelled between files. An in-flight GET cannot be aborted,
                // so only whole files are ever skipped.
                return;
            }
            let dest = root_task.join(rel);
            // A fresh root cannot already hold these bytes; the reservation is
            // what keeps two keys that sanitize to the same path apart.
            let outcome = async {
                let parent = dest.parent().unwrap_or(root_task.as_path());
                let name = dest
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| "object".to_string());
                let (path, mut file) = crate::fsutil::reserve_unique_path(parent, &name).await?;
                match store.get_to(key, &mut file).await {
                    Ok(written) => Ok::<u64, AppError>(written),
                    Err(e) => {
                        // Never leave a truncated file behind.
                        let _ = tokio::fs::remove_file(&path).await;
                        Err(e)
                    }
                }
            }
            .await;
            match outcome {
                Ok(written) => tracker.advance(&id_task, written),
                Err(e) => {
                    failed += 1;
                    if first_error.is_empty() {
                        first_error = format!("{key}: {}", crate::model::describe_error(&e));
                    }
                }
            }
        }

        if failed > 0 {
            tracker.fail_if_running(
                &id_task,
                format!("{failed} of {} files failed: {first_error}", files.len()),
            );
        } else {
            tracker.finish_if_running(&id_task, Some(root_task.display().to_string()));
        }
    });

    Ok(TransferResult {
        id: progress_id,
        path: root.display().to_string(),
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadInput {
    pub connection_id: String,
    /// Folder the files are uploaded into (S3 prefix).
    pub prefix: String,
    pub local_paths: Vec<String>,
    #[serde(default)]
    pub overwrite: bool,
    /// Leave keys that already exist untouched instead of uploading them.
    #[serde(default)]
    pub skip_existing: bool,
    /// Keys the caller already knows exist (normally the answer from
    /// `upload_conflicts`). With `skip_existing` set these are skipped without a
    /// second HEAD scan; an empty list falls back to scanning for legacy
    /// callers.
    #[serde(default)]
    pub skip_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadPlanItem {
    pub id: String,
    pub local_path: String,
    pub key: String,
    /// The key already exists and `skip_existing` was set. Nothing will be
    /// uploaded, but `id` is still a progress entry (finished immediately) so
    /// the UI can wait for every id in the plan.
    pub skipped: bool,
}

/// One file — or one zero-byte folder marker — that an upload plan contains.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedUpload {
    pub local_path: PathBuf,
    pub key: String,
    /// A marker for a directory that would otherwise disappear from S3 because
    /// it contains no files of its own. Uploaded as a zero-byte key ending in
    /// `/`, exactly like `create_folder` does.
    pub is_marker: bool,
}

/// Ceiling on one upload plan.
///
/// A paste/drop that produces more keys than this is almost always a folder the
/// user did not mean to send; failing up front beats starting ten thousand
/// background PUTs.
pub const MAX_PLAN_ITEMS: usize = 10_000;
/// `upload_conflicts` is a pre-flight check the user waits on, so it is capped
/// well below the upload cap and stops walking as soon as the cap is hit.
const MAX_CONFLICT_SCAN: usize = 2_000;
/// Most existence checks in flight at once.
const STAT_CONCURRENCY: usize = 16;

/// Why a plan is being built. The cap and its error message differ between a
/// real upload and the conflict pre-flight check.
#[derive(Debug, Clone, Copy)]
enum PlanPurpose {
    Upload,
    Conflicts,
}

impl PlanPurpose {
    fn cap_message(self, max_items: usize) -> String {
        match self {
            PlanPurpose::Upload => format!(
                "refusing to upload more than {max_items} items at once; select fewer files or split the folder"
            ),
            PlanPurpose::Conflicts => {
                format!("too many files to check for conflicts (the limit is {max_items})")
            }
        }
    }
}

/// Accumulates a plan, keeping keys unique and the item count capped.
struct PlanBuilder {
    items: Vec<PlannedUpload>,
    seen: HashSet<String>,
    max_items: usize,
    cap_message: String,
}

impl PlanBuilder {
    fn new(max_items: usize, purpose: PlanPurpose) -> Self {
        PlanBuilder {
            items: Vec::new(),
            seen: HashSet::new(),
            max_items,
            cap_message: purpose.cap_message(max_items),
        }
    }

    /// Add one item. Duplicate keys are dropped: a drop list can contain the
    /// same path twice, and that must not PUT the same key twice.
    fn push(&mut self, local_path: PathBuf, key: String, is_marker: bool) -> AppResult<()> {
        if !self.seen.insert(key.clone()) {
            return Ok(());
        }
        if self.items.len() >= self.max_items {
            return Err(AppError::invalid(self.cap_message.clone()));
        }
        self.items.push(PlannedUpload {
            local_path,
            key,
            is_marker,
        });
        Ok(())
    }

    fn into_items(self) -> Vec<PlannedUpload> {
        self.items
    }
}

/// Build the upload plan for a set of local paths.
///
/// Files keep their name (`prefix + name`). Directories are walked recursively
/// without following symlinks and keep their structure under
/// `prefix + dir_name/`. Every directory that ends up with no files below it
/// gets a zero-byte marker, so an empty folder survives the round trip.
///
/// The walk is deterministic: entries are sorted by name before they are
/// visited, so the same tree always produces the same plan. A top-level path
/// that is a symlink is followed deliberately (the user picked it); nothing
/// below a walked directory is ever followed.
pub fn plan_uploads(paths: &[String], prefix: &str) -> AppResult<Vec<PlannedUpload>> {
    plan_uploads_for(paths, prefix, PlanPurpose::Upload, MAX_PLAN_ITEMS)
}

/// The conflict pre-flight uses the same walk but stops at 2 000 items instead
/// of walking a 10 000-file tree and only then rejecting it.
fn plan_conflicts(paths: &[String], prefix: &str) -> AppResult<Vec<PlannedUpload>> {
    plan_uploads_for(paths, prefix, PlanPurpose::Conflicts, MAX_CONFLICT_SCAN)
}

fn plan_uploads_for(
    paths: &[String],
    prefix: &str,
    purpose: PlanPurpose,
    max_items: usize,
) -> AppResult<Vec<PlannedUpload>> {
    let prefix = as_folder_prefix(prefix);
    let mut plan = PlanBuilder::new(max_items, purpose);
    for raw in paths {
        let path = PathBuf::from(raw);
        let meta = std::fs::metadata(&path)
            .map_err(|e| AppError::invalid(format!("cannot read {}: {e}", path.display())))?;
        let name = utf8_file_name(&path)?;
        if meta.is_dir() {
            let key_prefix = format!("{prefix}{name}/");
            walk_upload_dir(&path, &key_prefix, &mut plan)?;
        } else if meta.is_file() {
            plan.push(path, format!("{prefix}{name}"), false)?;
        } else {
            return Err(AppError::invalid(format!(
                "{} is not a file or a directory",
                path.display()
            )));
        }
    }
    Ok(plan.into_items())
}

/// File name as UTF-8.
///
/// `to_string_lossy` would map two distinct non-UTF-8 local names onto one key,
/// silently collapsing files, so such paths are rejected instead.
fn utf8_file_name(path: &Path) -> AppResult<String> {
    let name = path
        .file_name()
        .ok_or_else(|| AppError::invalid(format!("bad local path: {}", path.display())))?;
    name.to_str()
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            AppError::invalid(format!(
                "local file name is not valid UTF-8: {}",
                path.display()
            ))
        })
}

/// Walk one directory in sorted order, appending files and folder markers.
///
/// Returns whether this directory contributed anything (a file, a marker below
/// it, or its own marker). A directory with nothing uploadable (empty, or
/// containing only symlinks/special files) gets a marker so the folder does not
/// vanish; that marker also keeps every ancestor visible, so no ancestor adds
/// one of its own.
fn walk_upload_dir(dir: &Path, key_prefix: &str, plan: &mut PlanBuilder) -> AppResult<bool> {
    let read_error = |e: std::io::Error| {
        AppError::invalid(format!("cannot read directory {}: {e}", dir.display()))
    };
    let mut entries = std::fs::read_dir(dir)
        .map_err(read_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(read_error)?;
    // Deterministic order: the same tree must always produce the same plan.
    entries.sort_by_key(|entry| entry.file_name());

    let mut planned = false;
    for entry in entries {
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| AppError::invalid(format!("cannot read {}: {e}", path.display())))?;
        // Never follow symlinks during the walk: a link pointing back up the
        // tree would turn the upload into an endless one.
        if file_type.is_symlink() {
            continue;
        }
        let name = utf8_file_name(&path)?;
        if file_type.is_dir() {
            let child_prefix = format!("{key_prefix}{name}/");
            if walk_upload_dir(&path, &child_prefix, plan)? {
                planned = true;
            }
        } else if file_type.is_file() {
            plan.push(path, format!("{key_prefix}{name}"), false)?;
            planned = true;
        }
        // Sockets, FIFOs and devices are skipped: a PUT of one would block or
        // fail, and they have no place in S3.
    }
    if !planned {
        plan.push(dir.to_path_buf(), key_prefix.to_string(), true)?;
        // The marker keeps this level (and every ancestor) visible, so the
        // caller must not add a marker of its own.
        planned = true;
    }
    Ok(planned)
}

/// Is this error S3 saying "there is no such key"?
fn is_missing(err: &AppError) -> bool {
    match err {
        AppError::NotFound(_) => true,
        AppError::S3 { code, status, .. } => {
            *status == Some(404)
                || matches!(
                    code.as_str(),
                    "NotFound" | "NoSuchKey" | "NoSuchObject" | "HTTP404" | "404"
                )
        }
        _ => false,
    }
}

/// Which of `keys` already exist, with at most [`STAT_CONCURRENCY`] HEADs in
/// flight.
///
/// A missing key is `false`. Any other failure is returned **unchanged** so the
/// original S3 code, status and hints still reach the UI (a HEAD denied for
/// write-only credentials must not become an opaque wrapper); the call stays
/// fail-closed.
async fn keys_that_exist(store: &AnyStore, keys: &[String]) -> AppResult<Vec<bool>> {
    let mut exists = vec![false; keys.len()];
    for (chunk_index, chunk) in keys.chunks(STAT_CONCURRENCY).enumerate() {
        let mut tasks = tokio::task::JoinSet::new();
        for (offset, key) in chunk.iter().enumerate() {
            let store = store.clone();
            let key = key.clone();
            tasks.spawn(async move {
                let index = chunk_index * STAT_CONCURRENCY + offset;
                (index, store.stat(&key).await)
            });
        }
        while let Some(joined) = tasks.join_next().await {
            let (index, result) =
                joined.map_err(|e| AppError::msg(format!("existence check failed: {e}")))?;
            match result {
                Ok(_) => exists[index] = true,
                Err(e) if is_missing(&e) => {}
                Err(e) => return Err(e),
            }
        }
    }
    Ok(exists)
}

/// Which planned items the caller already knows exist.
///
/// The UI passes the list it got from `upload_conflicts`, so the upload does not
/// repeat those HEADs. Markers are never skipped: writing a zero-byte marker
/// again is harmless and keeps an empty folder visible.
fn skipped_from_keys(plan: &[PlannedUpload], skip_keys: &[String]) -> Vec<bool> {
    if skip_keys.is_empty() {
        return vec![false; plan.len()];
    }
    let skip: HashSet<&str> = skip_keys.iter().map(String::as_str).collect();
    plan.iter()
        .map(|item| !item.is_marker && skip.contains(item.key.as_str()))
        .collect()
}

/// Planning touches the filesystem, so keep it off the async worker thread.
async fn plan_uploads_off_thread(
    paths: Vec<String>,
    prefix: String,
) -> AppResult<Vec<PlannedUpload>> {
    tokio::task::spawn_blocking(move || plan_uploads(&paths, &prefix))
        .await
        .map_err(|e| AppError::msg(format!("upload planning failed: {e}")))?
}

async fn plan_conflicts_off_thread(
    paths: Vec<String>,
    prefix: String,
) -> AppResult<Vec<PlannedUpload>> {
    tokio::task::spawn_blocking(move || plan_conflicts(&paths, &prefix))
        .await
        .map_err(|e| AppError::msg(format!("upload planning failed: {e}")))?
}

/// Is this progress entry still waiting for its transfer to finish?
fn entry_is_running(tracker: &ProgressTracker, id: &str) -> bool {
    tracker.get(id).map(|view| view.state) == Some(ProgressState::Running)
}

/// A non-skipped plan item handed to the background upload task.
struct UploadTask {
    id: String,
    local_path: PathBuf,
    key: String,
    is_marker: bool,
}

#[tauri::command]
pub async fn upload_files(
    app: State<'_, Arc<AppCore>>,
    input: UploadInput,
) -> CmdResult<Vec<UploadPlanItem>> {
    upload_files_impl(app.inner(), input).await.map_err(err)
}

/// Implementation shared by the command and the e2e hooks: validates the
/// connection, builds the upload plan and spawns the transfer.
pub async fn upload_files_impl(
    core: &AppCore,
    input: UploadInput,
) -> crate::error::AppResult<Vec<UploadPlanItem>> {
    let conn = core.connection(&input.connection_id)?;
    if conn.security.read_only_mode {
        return Err(AppError::invalid(
            "this connection is in read-only mode (connection settings)",
        ));
    }
    // Capabilities may be unknown; only block on an explicit, probed denial.
    if let Some(caps) = core.read(|store| store.capabilities(&input.connection_id)) {
        if caps.probed && !caps.can_write {
            return Err(AppError::invalid(
                "credentials for this connection cannot write (detected). Adjust the connection or reconnect.",
            ));
        }
    }
    let store = core.client(&input.connection_id)?;

    // Build the whole plan before touching progress: a bad path or an oversized
    // tree must fail without leaving a single entry behind. The walk is blocking
    // `std::fs`, so it runs on the blocking pool.
    let plan = plan_uploads_off_thread(input.local_paths.clone(), input.prefix.clone()).await?;

    // The UI already ran `upload_conflicts`, so its conflict list is used as-is:
    // no second HEAD scan and no delay before the rows (and their cancel
    // buttons) exist. An empty list means an old caller that did not pre-check;
    // only then does the backend ask the bucket itself.
    let skipped = if !input.skip_existing {
        vec![false; plan.len()]
    } else if !input.skip_keys.is_empty() {
        skipped_from_keys(&plan, &input.skip_keys)
    } else {
        let indexes: Vec<usize> = plan
            .iter()
            .enumerate()
            .filter(|(_, item)| !item.is_marker)
            .map(|(index, _)| index)
            .collect();
        let keys: Vec<String> = indexes
            .iter()
            .map(|index| plan[*index].key.clone())
            .collect();
        let existing = keys_that_exist(&store, &keys).await?;
        let mut flags = vec![false; plan.len()];
        for (index, exists) in indexes.into_iter().zip(existing) {
            flags[index] = exists;
        }
        flags
    };

    let tracker = core.progress.clone();
    let mut plan_items = Vec::with_capacity(plan.len());
    let mut tasks: Vec<UploadTask> = Vec::new();
    for (planned, skip) in plan.into_iter().zip(skipped) {
        let PlannedUpload {
            local_path,
            key,
            is_marker,
        } = planned;
        let label = if skip {
            format!("Skipped {key}")
        } else {
            objects::progress_label("Uploading", &key)
        };
        // The progress entry itself is the item's identity: the UI waits for
        // exactly these ids, so the transfer cannot finish before it is watched.
        let id = tracker.start(label, None);
        if skip {
            // Finished immediately: a UI waiting on every id must settle even
            // though no PUT will ever run for this item.
            tracker.finish(&id, None);
        }
        plan_items.push(UploadPlanItem {
            id: id.clone(),
            local_path: local_path.display().to_string(),
            key: key.clone(),
            skipped: skip,
        });
        if !skip {
            tasks.push(UploadTask {
                id,
                local_path,
                key,
                is_marker,
            });
        }
    }

    let tracker_task = tracker.clone();
    let overwrite = input.overwrite;
    // One background batch; the plan returns to the UI immediately.
    //
    // Cancellation is checked before every item. An in-flight PUT cannot be
    // aborted — the store API has no cancellation handle — so cancelling during
    // one only marks the entry, the bytes may still land, and the result is
    // discarded because the entry is no longer `Running`.
    tauri::async_runtime::spawn(async move {
        for task in tasks {
            if !entry_is_running(&tracker_task, &task.id) {
                // Cancelled while queued: nothing was uploaded.
                continue;
            }
            if task.is_marker {
                let result = store
                    .put_bytes(&task.key, Vec::new(), Some("application/x-directory"))
                    .await;
                match result {
                    Ok(()) => {
                        tracker_task.finish_if_running(&task.id, Some(task.key.clone()));
                    }
                    Err(e) => {
                        tracker_task.fail_if_running(&task.id, crate::model::describe_error(&e));
                    }
                }
                continue;
            }
            // Keep the pre-existing guard for callers that do not use
            // `skip_existing`: with neither flag set an existing key fails
            // instead of being replaced without being asked. The check is
            // fail-closed: a HEAD that fails for any reason other than "missing"
            // fails the entry instead of being read as "does not exist".
            if !overwrite {
                match store.stat(&task.key).await {
                    Ok(_) => {
                        tracker_task.fail_if_running(
                            &task.id,
                            format!("{} already exists (overwrite is disabled)", task.key),
                        );
                        continue;
                    }
                    Err(e) if is_missing(&e) => {}
                    Err(e) => {
                        tracker_task.fail_if_running(&task.id, crate::model::describe_error(&e));
                        continue;
                    }
                }
            }
            if !entry_is_running(&tracker_task, &task.id) {
                continue;
            }
            let result = store.put_file(&task.key, &task.local_path).await;
            match result {
                Ok(()) => {
                    tracker_task.finish_if_running(&task.id, Some(task.key));
                }
                Err(e) => {
                    tracker_task.fail_if_running(&task.id, crate::model::describe_error(&e));
                }
            }
        }
    });

    Ok(plan_items)
}

/// Keys from the same plan that already exist in the bucket.
///
/// Read-only: nothing is uploaded. The UI calls this before an upload to offer
/// Replace / Skip / Rename instead of failing on the first conflict.
#[tauri::command]
pub async fn upload_conflicts(
    app: State<'_, Arc<AppCore>>,
    input: UploadInput,
) -> CmdResult<Vec<String>> {
    upload_conflicts_impl(app.inner(), input).await.map_err(err)
}

pub async fn upload_conflicts_impl(
    core: &AppCore,
    input: UploadInput,
) -> crate::error::AppResult<Vec<String>> {
    let store = core.client(&input.connection_id)?;
    // The conflict walk is capped at 2 000 items from the start: a huge folder
    // fails before it is fully walked, not after planning all 10 000 keys.
    let plan = plan_conflicts_off_thread(input.local_paths.clone(), input.prefix.clone()).await?;
    let keys: Vec<String> = plan
        .into_iter()
        .filter(|item| !item.is_marker)
        .map(|item| item.key)
        .collect();
    let existing = keys_that_exist(&store, &keys).await?;
    let mut conflicts = Vec::new();
    for (key, exists) in keys.into_iter().zip(existing) {
        if exists {
            conflicts.push(key);
        }
    }
    Ok(conflicts)
}

/// Cancel a transfer that is still queued or running.
///
/// Only a running entry can be cancelled; an unknown or already finished id is
/// an error so the UI can say why the click did nothing.
#[tauri::command]
pub async fn cancel_transfer(app: State<'_, Arc<AppCore>>, id: String) -> CmdResult<()> {
    cancel_transfer_impl(&app.inner().progress, &id).map_err(err)
}

pub fn cancel_transfer_impl(tracker: &ProgressTracker, id: &str) -> crate::error::AppResult<()> {
    let Some(view) = tracker.get(id) else {
        return Err(AppError::not_found(format!("transfer {id}")));
    };
    if view.state != ProgressState::Running {
        return Err(AppError::invalid(format!(
            "transfer {id} is no longer running and cannot be cancelled"
        )));
    }
    tracker.cancel(id);
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTextInput {
    pub connection_id: String,
    pub key: String,
    pub content: String,
    #[serde(default)]
    pub content_type: Option<String>,
}

#[tauri::command]
pub async fn save_text_object(app: State<'_, Arc<AppCore>>, input: SaveTextInput) -> CmdResult<()> {
    let core = app.inner();
    ensure_writable(core, &input.connection_id)?;
    let store = core.client(&input.connection_id).map_err(err)?;
    store
        .put_bytes(
            &input.key,
            input.content.into_bytes(),
            input
                .content_type
                .as_deref()
                .or(Some("text/plain; charset=utf-8")),
        )
        .await
        .map_err(err)
}

fn ensure_writable(core: &AppCore, connection_id: &str) -> CmdResult<()> {
    let conn = core.connection(connection_id).map_err(err)?;
    if conn.security.read_only_mode {
        return Err(err(AppError::invalid(
            "this connection is in read-only mode (connection settings)",
        )));
    }
    if let Some(caps) = core.read(|store| store.capabilities(connection_id)) {
        if caps.probed && (!caps.can_write || !caps.can_delete) {
            return Err(err(AppError::invalid(
                "detected credentials cannot modify this bucket. Use “Detect permissions” in the connection settings to re-check.",
            )));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn transfer_progress(app: State<'_, Arc<AppCore>>) -> CmdResult<Vec<ProgressView>> {
    // Finished entries are kept until the user clears them (or the app exits):
    // pruning here would race with a poll that is waiting for a result.
    Ok(app.inner().progress.all())
}

/// Drops every finished transfer from the tracker and reports how many went.
#[tauri::command]
pub async fn clear_transfers(app: State<'_, Arc<AppCore>>) -> CmdResult<usize> {
    let core = app.inner();
    let before = core.progress.all().len();
    core.progress.prune_finished();
    Ok(before - core.progress.all().len())
}

// ------------------------------------------------------------------- mutation

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFolderInput {
    pub connection_id: String,
    pub prefix: String,
    pub name: String,
}

#[tauri::command]
pub async fn create_folder(
    app: State<'_, Arc<AppCore>>,
    input: CreateFolderInput,
) -> CmdResult<String> {
    let core = app.inner();
    ensure_writable(core, &input.connection_id)?;
    let name = input.name.trim().trim_matches('/');
    if name.is_empty() {
        return Err(err(AppError::invalid("folder name is required")));
    }
    if name.contains('/') {
        return Err(err(AppError::invalid(
            "folder name must not contain '/'; use the breadcrumb to navigate instead",
        )));
    }
    let key = format!("{}{}/", as_folder_prefix(&input.prefix), name);
    let store = core.client(&input.connection_id).map_err(err)?;
    store
        .put_bytes(&key, Vec::new(), Some("application/x-directory"))
        .await?;
    Ok(key)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFileInput {
    pub connection_id: String,
    pub prefix: String,
    pub name: String,
    #[serde(default)]
    pub content: String,
}

#[tauri::command]
pub async fn create_file(
    app: State<'_, Arc<AppCore>>,
    input: CreateFileInput,
) -> CmdResult<String> {
    let core = app.inner();
    ensure_writable(core, &input.connection_id)?;
    let name = input.name.trim().trim_matches('/');
    if name.is_empty() {
        return Err(err(AppError::invalid("file name is required")));
    }
    let key = format!("{}{}", as_folder_prefix(&input.prefix), name);
    crate::store::validate_key(&key).map_err(err)?;
    let store = core.client(&input.connection_id).map_err(err)?;
    let content_type = crate::s3::guess_content_type(Path::new(&name))
        .unwrap_or_else(|| "text/plain; charset=utf-8".to_string());
    store
        .put_bytes(&key, input.content.into_bytes(), Some(&content_type))
        .await?;
    Ok(key)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteInput {
    pub connection_id: String,
    /// Keys to delete. Folder keys (trailing `/`) are expanded recursively.
    pub keys: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome {
    pub deleted: usize,
    pub summary: String,
    /// Id of the queued progress entry, so the UI can wait for completion.
    pub id: String,
}

#[tauri::command]
pub async fn delete_objects(
    app: State<'_, Arc<AppCore>>,
    input: DeleteInput,
) -> CmdResult<DeleteOutcome> {
    let core = app.inner();
    ensure_writable(core, &input.connection_id)?;
    if input.keys.is_empty() {
        return Ok(DeleteOutcome {
            deleted: 0,
            summary: "nothing selected".into(),
            id: String::new(),
        });
    }
    let store = core.client(&input.connection_id).map_err(err)?;

    // Expand folders into every key underneath *and the folder marker itself*.
    // S3 has no real folders, so a folder is a key ending in `/`; leaving the
    // marker behind would make the folder reappear right after being deleted.
    let mut keys: Vec<String> = Vec::new();
    let mut folders = 0usize;
    for key in &input.keys {
        if key.ends_with('/') {
            folders += 1;
            keys.push(key.clone());
            let nested = objects::list_all_keys(&store, key).await?;
            keys.extend(nested);
        } else {
            keys.push(key.clone());
        }
    }
    keys.sort();
    keys.dedup();

    if keys.is_empty() {
        return Ok(DeleteOutcome {
            deleted: 0,
            summary: format!("{folders} empty folder(s) — nothing to delete"),
            id: String::new(),
        });
    }

    let progress_id = core
        .progress
        .start(format!("Deleting {} object(s)", keys.len()), None);
    let tracker = core.progress.clone();
    let store_task = store.clone();
    let keys_task = keys.clone();
    let progress_id_task = progress_id.clone();
    tauri::async_runtime::spawn(async move {
        match store_task.delete_many(&keys_task).await {
            Ok(()) => tracker.finish_if_running(&progress_id_task, None),
            Err(e) => tracker.fail_if_running(&progress_id_task, crate::model::describe_error(&e)),
        }
    });

    Ok(DeleteOutcome {
        deleted: keys.len(),
        summary: format!("deleting {} object(s)", keys.len()),
        id: progress_id,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyInput {
    pub source_connection_id: String,
    pub dest_connection_id: String,
    pub keys: Vec<String>,
    pub dest_prefix: String,
    /// `true` removes the source objects after a successful copy.
    #[serde(default)]
    pub move_objects: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyOutcome {
    pub copied: usize,
    pub summary: String,
    /// Id of the queued progress entry, so the UI can wait for completion.
    pub id: String,
}

#[tauri::command]
pub async fn copy_objects(
    app: State<'_, Arc<AppCore>>,
    input: CopyInput,
) -> CmdResult<CopyOutcome> {
    let core = app.inner();
    ensure_writable(core, &input.dest_connection_id)?;
    if input.move_objects {
        ensure_writable(core, &input.source_connection_id)?;
    }
    if input.keys.is_empty() {
        return Err(err(AppError::invalid("nothing selected")));
    }
    let dest_prefix = as_folder_prefix(&input.dest_prefix);
    let src = core.client(&input.source_connection_id).map_err(err)?;
    let dst = core.client(&input.dest_connection_id).map_err(err)?;

    // Resolve the concrete list of source objects (folders expand recursively).
    let mut pairs: Vec<(String, String)> = Vec::new();
    for key in &input.keys {
        if key.ends_with('/') {
            let folder_name = objects::leaf_name(key, "");
            let nested = objects::list_all_keys(&src, key).await?;
            for nested_key in nested {
                let rel = nested_key.strip_prefix(key).unwrap_or(&nested_key);
                pairs.push((
                    nested_key.clone(),
                    format!("{dest_prefix}{folder_name}/{rel}"),
                ));
            }
        } else {
            let name = objects::leaf_name(key, "");
            pairs.push((key.clone(), format!("{dest_prefix}{name}")));
        }
    }
    if pairs.is_empty() {
        return Err(err(AppError::invalid("nothing to copy")));
    }
    for (from, to) in &pairs {
        if from == to {
            return Err(err(AppError::invalid(format!(
                "source and destination are the same object: {from}"
            ))));
        }
    }

    let progress_id = core.progress.start(
        if input.move_objects {
            format!("Moving {} object(s)", pairs.len())
        } else {
            format!("Copying {} object(s)", pairs.len())
        },
        Some(pairs.len() as u64),
    );
    let tracker = core.progress.clone();
    let move_objects = input.move_objects;
    let src_task = src.clone();
    let dst_task = dst.clone();
    let pairs_task = pairs.clone();
    let copied = pairs.len();
    let progress_id_task = progress_id.clone();
    tauri::async_runtime::spawn(async move {
        for (from, to) in &pairs_task {
            if let Err(e) = dst_task.copy_object(from, to).await {
                tracker.fail_if_running(
                    &progress_id_task,
                    format!("copy {from}: {}", crate::model::describe_error(&e)),
                );
                return;
            }
            if move_objects {
                if let Err(e) = src_task.delete_object(from).await {
                    tracker.fail_if_running(
                        &progress_id_task,
                        format!("delete {from}: {}", crate::model::describe_error(&e)),
                    );
                    return;
                }
            }
            tracker.advance(&progress_id_task, 1);
        }
        tracker.finish_if_running(&progress_id_task, None);
    });

    Ok(CopyOutcome {
        copied,
        summary: format!(
            "{} {} object(s)",
            if input.move_objects {
                "moving"
            } else {
                "copying"
            },
            copied
        ),
        id: progress_id,
    })
}

// -------------------------------------------------------------- stream bridge

/// Metadata + bytes for the `s3stream://` protocol handler. Kept public so
/// `lib.rs` can register the scheme.
pub async fn read_stream(
    core: &AppCore,
    connection_id: &str,
    key: &str,
    range_header: Option<&str>,
) -> Result<StreamResponse, AppError> {
    let store = core.client(connection_id)?;
    let size = store.stat(key).await?.size.unwrap_or(0);
    let range = match range_header {
        Some(h) => match parse_range(h, size as u64) {
            Some(r) => Some(r),
            None => {
                return Err(AppError::invalid(format!(
                    "unsatisfiable range {h} for an object of {size} bytes"
                )))
            }
        },
        None => None,
    };
    let stream = store.get_bytes(key, range).await?;
    let content_type = stream.content_type.clone().unwrap_or_else(|| {
        crate::s3::guess_content_type(Path::new(key))
            .unwrap_or_else(|| "application/octet-stream".into())
    });
    let total = stream.total_length.unwrap_or(size);
    let (status, content_range) = match range {
        Some(r) => (
            206u16,
            Some(format!("bytes {}-{}/{}", r.start, r.end, total)),
        ),
        None => (200u16, None),
    };
    Ok(StreamResponse {
        status,
        content_type,
        content_range,
        content_length: stream.body.len() as u64,
        etag: stream.etag,
        body: stream.body,
    })
}

pub struct StreamResponse {
    pub status: u16,
    pub content_type: String,
    pub content_range: Option<String>,
    pub content_length: u64,
    pub etag: Option<String>,
    pub body: Vec<u8>,
}

// ---------------------------------------------------------------- filesystem

#[tauri::command]
pub async fn reveal_in_file_manager(path: String) -> CmdResult<()> {
    crate::fsutil::reveal(Path::new(&path)).map_err(err)
}

#[tauri::command]
pub async fn open_path(path: String) -> CmdResult<()> {
    crate::fsutil::open(Path::new(&path)).map_err(err)
}

/// Open a link from rendered Markdown in the system browser.
///
/// The URL comes from untrusted document content, so validation lives in
/// `fsutil::is_allowed_url` (http/https only) rather than in this thin wrapper.
#[tauri::command]
pub async fn open_url(url: String) -> CmdResult<()> {
    crate::fsutil::open_url(&url).map_err(err)
}

/// Home directory of the user, used as the default upload start folder.
#[tauri::command]
pub async fn default_upload_dir() -> CmdResult<String> {
    Ok(crate::fsutil::home_dir().display().to_string())
}

/// Largest file the import dialog will read.
///
/// A credentials file is a few kilobytes; the cap exists so that picking the
/// wrong file cannot pull a gigabyte into the webview.
const IMPORT_FILE_LIMIT: u64 = 2 * 1024 * 1024;

/// Read a text file the user chose in the native file dialog.
///
/// The webview cannot read `file://` URLs, so this has to go through the
/// backend. The path always comes from a dialog the user completed, and the
/// result is size-capped and must be valid UTF-8: this reads configuration, not
/// arbitrary binary content.
#[tauri::command]
pub async fn read_text_file(path: String) -> CmdResult<String> {
    let file = std::path::PathBuf::from(&path);
    let meta = std::fs::metadata(&file).map_err(|e| {
        err(AppError::msg(format!(
            "Cannot open {}: {e}",
            file.display()
        )))
    })?;
    if !meta.is_file() {
        return Err(err(AppError::msg(format!(
            "{} is not a file.",
            file.display()
        ))));
    }
    if meta.len() > IMPORT_FILE_LIMIT {
        return Err(err(AppError::msg(format!(
            "{} is {}, which is too large to import (limit {}).",
            file.display(),
            crate::objects::human_size(meta.len() as i64),
            crate::objects::human_size(IMPORT_FILE_LIMIT as i64)
        ))));
    }
    let bytes = std::fs::read(&file).map_err(|e| {
        err(AppError::msg(format!(
            "Cannot read {}: {e}",
            file.display()
        )))
    })?;
    String::from_utf8(bytes).map_err(|_| {
        err(AppError::msg(format!(
            "{} is not UTF-8 text, so it cannot be read as JSON.",
            file.display()
        )))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cancelled_listing_stops_and_is_forgotten() {
        let live = register_listing("cancel-live");
        assert!(!live.load(Ordering::Relaxed));
        cancel_listing("cancel-live".into());
        assert!(live.load(Ordering::Relaxed));
        release_listing("cancel-live");
        assert!(!LIVE_LISTINGS.lock().unwrap().contains_key("cancel-live"));
    }

    /// The webview can walk away between the last page and `done`; a cancel that
    /// arrives for a listing nobody is streaming is a no-op, not an error.
    #[test]
    fn cancelling_an_unknown_listing_is_harmless() {
        cancel_listing("never-started".into());
        assert!(!LIVE_LISTINGS.lock().unwrap().contains_key("never-started"));
    }

    #[test]
    fn system_entries_are_filtered() {
        let entry = |name: &str| ObjectEntry {
            key: name.into(),
            name: name.into(),
            is_folder: false,
            size: 0,
            last_modified: None,
            etag: None,
            storage_class: None,
            kind: FileKind::Unknown,
        };
        assert!(is_system_entry(&entry("_SUCCESS")));
        assert!(is_system_entry(&entry(".DS_Store")));
        assert!(is_system_entry(&entry("._resource")));
        assert!(is_system_entry(&entry("part-0.crc")));
        assert!(!is_system_entry(&entry("part-0.parquet")));
        assert!(!is_system_entry(&entry("image.png")));
    }

    #[test]
    fn default_file_names_come_from_the_key_tail() {
        assert_eq!(default_file_name("a/b/c.png"), "c.png");
        assert_eq!(default_file_name("c.png"), "c.png");
        assert_eq!(default_file_name("a/b/"), "b");
        assert_eq!(default_file_name(""), "object");
    }

    #[test]
    fn folder_download_keeps_the_nested_structure() {
        assert_eq!(
            local_target("a/", "a/b/c.png"),
            Some(LocalTarget::File(PathBuf::from("b/c.png")))
        );
        assert_eq!(
            local_target("a/", "a/x/y/"),
            Some(LocalTarget::Dir(PathBuf::from("x/y")))
        );
        // The marker of the folder being downloaded is the root itself.
        assert_eq!(local_target("a/", "a/"), None);
        // A key outside the prefix is not part of this download.
        assert_eq!(local_target("a/", "b/c.png"), None);
    }

    #[test]
    fn folder_download_cannot_escape_the_chosen_directory() {
        assert_eq!(
            local_target("a/", "a/../../etc/passwd"),
            Some(LocalTarget::File(PathBuf::from("etc/passwd")))
        );
        assert_eq!(
            local_target("a/", "a/./x"),
            Some(LocalTarget::File(PathBuf::from("x")))
        );
        assert_eq!(
            local_target("a/", "a//x"),
            Some(LocalTarget::File(PathBuf::from("x")))
        );
        assert_eq!(local_target("a/", "a/.."), None);
    }

    #[test]
    fn folder_download_names_are_safe() {
        assert_eq!(safe_dir_name("photos"), "photos");
        assert_eq!(safe_dir_name(""), "folder");
        assert_eq!(safe_dir_name("."), "folder");
        assert_eq!(safe_dir_name(".."), "folder");
        assert_eq!(safe_dir_name("a/b"), "a_b");
        assert_eq!(safe_dir_name("  spaced  "), "spaced");
    }

    /// A unique directory under the system temp dir, removed on drop.
    struct TempTree(PathBuf);

    impl TempTree {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("s3viewer-plan-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).expect("create temp dir");
            TempTree(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn planned_keys(plan: &[PlannedUpload]) -> Vec<&str> {
        plan.iter().map(|item| item.key.as_str()).collect()
    }

    #[test]
    fn plan_preserves_a_nested_tree_and_its_order() {
        let root = TempTree::new();
        let photos = root.path().join("photos");
        std::fs::create_dir_all(photos.join("a")).unwrap();
        std::fs::write(photos.join("b.txt"), b"b").unwrap();
        std::fs::write(photos.join("a/z.txt"), b"z").unwrap();
        std::fs::write(photos.join("a/y.txt"), b"y").unwrap();

        let plan = plan_uploads(&[photos.display().to_string()], "up/").unwrap();

        assert_eq!(
            planned_keys(&plan),
            vec!["up/photos/a/y.txt", "up/photos/a/z.txt", "up/photos/b.txt"]
        );
        assert!(plan.iter().all(|item| !item.is_marker));
    }

    #[test]
    fn a_single_file_keeps_its_name_and_handles_spaces_and_unicode() {
        let root = TempTree::new();
        let file = root.path().join("тест с пробелами.txt");
        std::fs::write(&file, b"x").unwrap();

        let plan = plan_uploads(&[file.display().to_string()], "reports").unwrap();

        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].key, "reports/тест с пробелами.txt");
        assert!(!plan[0].is_marker);
        assert_eq!(plan[0].local_path, file);
    }

    #[test]
    fn directories_without_files_get_a_zero_byte_marker() {
        let root = TempTree::new();
        let empty = root.path().join("empty");
        let nested = root.path().join("tree/nested");
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::create_dir_all(&nested).unwrap();

        let plan = plan_uploads(
            &[
                empty.display().to_string(),
                root.path().join("tree").display().to_string(),
            ],
            "",
        )
        .unwrap();

        assert_eq!(planned_keys(&plan), vec!["empty/", "tree/nested/"]);
        assert!(plan.iter().all(|item| item.is_marker));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_not_followed_while_walking() {
        use std::os::unix::fs::symlink;

        let root = TempTree::new();
        let real = root.path().join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("inside.txt"), b"x").unwrap();

        let picked = root.path().join("picked");
        std::fs::create_dir_all(&picked).unwrap();
        symlink(&real, picked.join("link")).unwrap();

        let plan = plan_uploads(&[picked.display().to_string()], "").unwrap();

        // The linked directory is skipped, so the folder would disappear from S3
        // and therefore keeps a marker instead.
        assert_eq!(planned_keys(&plan), vec!["picked/"]);
        assert!(plan[0].is_marker);
    }

    #[test]
    fn duplicate_paths_do_not_plan_the_same_key_twice() {
        let root = TempTree::new();
        let shots = root.path().join("shots");
        std::fs::create_dir_all(&shots).unwrap();
        let file = shots.join("a.png");
        std::fs::write(&file, b"a").unwrap();

        // A drop list can repeat the same entry; the key must still be planned
        // (and PUT) only once.
        let files = plan_uploads(
            &[file.display().to_string(), file.display().to_string()],
            "up/",
        )
        .unwrap();
        assert_eq!(planned_keys(&files), vec!["up/a.png"]);

        let folders = plan_uploads(
            &[shots.display().to_string(), shots.display().to_string()],
            "",
        )
        .unwrap();
        assert_eq!(planned_keys(&folders), vec!["shots/a.png"]);
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_file_names_are_rejected() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        let name = OsString::from_vec(vec![b'f', 0xff, b'.', b't', b'x', b't']);
        let error = utf8_file_name(Path::new(&name)).unwrap_err();

        assert!(
            error.to_string().contains("UTF-8"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn skip_keys_mark_planned_items_without_a_scan() {
        let item = |key: &str, is_marker: bool| PlannedUpload {
            local_path: PathBuf::from("/tmp/example"),
            key: key.to_string(),
            is_marker,
        };
        let plan = vec![
            item("up/a.png", false),
            item("up/empty/", true),
            item("up/b.png", false),
        ];

        let skipped = skipped_from_keys(&plan, &["up/a.png".to_string(), "up/empty/".to_string()]);

        // Markers are never skipped, even if a caller put one in the list.
        assert_eq!(skipped, vec![true, false, false]);
        // With no list there is nothing to mark; the caller falls back to a scan.
        assert_eq!(skipped_from_keys(&plan, &[]), vec![false, false, false]);
    }

    #[test]
    fn conflict_planning_uses_the_preflight_cap_message() {
        let root = TempTree::new();
        for name in ["a.txt", "b.txt", "c.txt"] {
            std::fs::write(root.path().join(name), b"x").unwrap();
        }
        let raw = root.path().display().to_string();

        let error = plan_uploads_for(std::slice::from_ref(&raw), "", PlanPurpose::Conflicts, 2)
            .unwrap_err();

        assert!(
            error.to_string().contains("too many files to check"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn plan_refuses_more_items_than_the_cap() {
        let root = TempTree::new();
        for name in ["a.txt", "b.txt", "c.txt"] {
            std::fs::write(root.path().join(name), b"x").unwrap();
        }

        let raw = root.path().display().to_string();
        let error =
            plan_uploads_for(std::slice::from_ref(&raw), "", PlanPurpose::Upload, 2).unwrap_err();

        assert!(
            error.to_string().contains("more than 2"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn plan_rejects_a_missing_path_and_names_it() {
        let missing =
            std::env::temp_dir().join(format!("s3viewer-missing-{}", uuid::Uuid::new_v4()));
        let raw = missing.display().to_string();

        let error = plan_uploads(std::slice::from_ref(&raw), "").unwrap_err();

        assert!(
            error.to_string().contains(&raw),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn cancel_only_accepts_a_running_transfer() {
        let tracker = ProgressTracker::new();

        assert!(cancel_transfer_impl(&tracker, "missing").is_err());

        let finished = tracker.start("finished", None);
        tracker.finish(&finished, None);
        assert!(cancel_transfer_impl(&tracker, &finished).is_err());

        let running = tracker.start("running", None);
        cancel_transfer_impl(&tracker, &running).unwrap();
        assert_eq!(
            tracker.get(&running).unwrap().state,
            ProgressState::Cancelled
        );
    }

    #[test]
    fn copy_outcome_carries_the_progress_id() {
        let outcome = CopyOutcome {
            copied: 2,
            summary: "copying 2 object(s)".into(),
            id: "progress-1".into(),
        };
        let json = serde_json::to_value(&outcome).unwrap();
        assert_eq!(json["copied"], 2);
        assert_eq!(json["id"], "progress-1");
    }
}
