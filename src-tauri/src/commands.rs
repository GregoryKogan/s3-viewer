//! All Tauri commands. These are deliberately thin: validate input, call into
//! [`crate::state::AppCore`], map errors to a structured payload.

use crate::error::{AppError, AppResult, ErrorPayload};
// `macro_export` places these at the crate root, so they need importing here.
use crate::model::{
    Capabilities, Connection, ConnectionView, FileKind, ListResult, ObjectEntry, PreviewData,
    ProgressView, StaticCreds,
};
use crate::objects::{self, as_folder_prefix};
use crate::preview::{self, parse_range};
use crate::s3::{AnyStore, ObjectStore};
use crate::state::AppCore;
use crate::store::{AppSettings, ConnectionInput, Theme};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

pub type CmdResult<T> = Result<T, ErrorPayload>;

fn err(e: AppError) -> ErrorPayload {
    e.into()
}

/// Access the shared core from a command.
struct Ctx<'a>(&'a State<'a, Arc<AppCore>>);

impl Ctx<'_> {
    fn core(&self) -> &AppCore {
        self.0.inner()
    }
}

// ------------------------------------------------------------------ settings

#[tauri::command]
pub async fn get_settings(app: State<'_, Arc<AppCore>>) -> CmdResult<AppSettings> {
    Ok(Ctx(&app).core().settings())
}

#[tauri::command]
pub async fn update_settings(
    app: State<'_, Arc<AppCore>>,
    settings: AppSettings,
) -> CmdResult<AppSettings> {
    let ctx = Ctx(&app);
    ctx.core()
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
    let ctx = Ctx(&app);
    Ok(ctx.core().read(|store| SecurityStatus {
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
    Ok(Ctx(&app).core().connection_views())
}

#[tauri::command]
pub async fn get_connection(app: State<'_, Arc<AppCore>>, id: String) -> CmdResult<ConnectionView> {
    let ctx = Ctx(&app);
    let core = ctx.core();
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
    let ctx = Ctx(&app);
    let old_id = input.id.clone();
    let conn = ctx.core().upsert_connection(input).map_err(err)?;
    if let Some(old) = old_id {
        if old != conn.id {
            ctx.core().invalidate(&old);
        }
    }
    Ok(conn)
}

#[tauri::command]
pub async fn delete_connection(app: State<'_, Arc<AppCore>>, id: String) -> CmdResult<()> {
    Ctx(&app).core().delete_connection(&id).map_err(err)
}

#[tauri::command]
pub async fn duplicate_connection(
    app: State<'_, Arc<AppCore>>,
    id: String,
) -> CmdResult<Connection> {
    let ctx = Ctx(&app);
    let core = ctx.core();
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

impl Ctx<'_> {
    /// Resolve a probe input into a live store plus the connection it describes.
    fn resolve_probe(&self, input: &ProbeInput) -> Result<(AnyStore, Connection), AppError> {
        let core = self.core();
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
                use_path_style_for_list: true,
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
}

#[tauri::command]
pub async fn test_connection(
    app: State<'_, Arc<AppCore>>,
    input: ProbeInput,
) -> CmdResult<ProbeOutcome> {
    let ctx = Ctx(&app);
    let (store, conn) = ctx.resolve_probe(&input).map_err(err)?;
    let prefix = as_folder_prefix(&conn.prefix);
    let list = objects::list_folder(&store, &prefix, 25).await?;
    let sample_keys = list
        .0
        .iter()
        .take(10)
        .map(|e| e.key.clone())
        .collect::<Vec<_>>();

    let caps = objects::probe_capabilities(&store, input.detect_write).await;

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
    let ctx = Ctx(&app);
    let core = ctx.core();
    let conn = core.connection(&id).map_err(err)?;
    let store = core.client(&id).map_err(err)?;
    let detect = conn.security.detect_permissions;
    let caps = objects::probe_capabilities(&store, detect).await;
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
    let ctx = Ctx(&app);
    let core = ctx.core();
    let conn = core.connection(&input.connection_id).map_err(err)?;
    let limit = core.settings().list_page_limit as usize;
    let show_system = core.settings().show_system_objects;
    let prefix = match input.prefix {
        Some(p) => as_folder_prefix(&p),
        None => as_folder_prefix(&conn.prefix),
    };
    core.mark_used(&input.connection_id);
    let store = core.client(&input.connection_id).map_err(err)?;
    let (mut entries, mut truncated) = objects::list_folder(&store, &prefix, limit).await?;

    if !show_system {
        entries.retain(|e| !is_system_entry(e));
    }
    truncated = trim_to_limit(&mut entries, limit) || truncated;
    Ok(ListResult {
        prefix: prefix.clone(),
        entries,
        truncated,
        warning: truncation_warning(truncated, limit),
    })
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
    let ctx = Ctx(&app_state);
    let core = ctx.core();
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

    let emit = |event: &str, payload: serde_json::Value| {
        let _ = app.emit(event, payload);
    };

    let result: AppResult<(usize, usize, bool)> = async {
        let app = app.clone();
        let prefix_for_pages = prefix.clone();
        let request = request_id.clone();
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
        })
        .await?;
        Ok::<_, AppError>((sent, total_files, truncated))
    }
    .await;

    let (sent, total_files, truncated) = match result {
        Ok(counts) => counts,
        Err(e) => {
            let payload = ErrorPayload::from(&e);
            let _ = app.emit(
                "listing://error",
                serde_json::json!({ "requestId": input.request_id, "error": payload }),
            );
            return Err(payload);
        }
    };
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

/// Keep every folder and trim only the file tail past `limit`.
fn trim_to_limit(entries: &mut Vec<ObjectEntry>, limit: usize) -> bool {
    if entries.iter().filter(|e| !e.is_folder).count() <= limit {
        return false;
    }
    let mut kept = 0usize;
    entries.retain(|entry| {
        if entry.is_folder {
            return true;
        }
        kept += 1;
        kept <= limit
    });
    true
}

fn truncation_warning(truncated: bool, limit: usize) -> Option<String> {
    truncated.then(|| {
        format!("Listing truncated at {limit} objects. Open a sub-folder or narrow the prefix.")
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
    let ctx = Ctx(&app);
    let core = ctx.core();
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
    let ctx = Ctx(&app);
    let store = ctx.core().client(&connection_id).map_err(err)?;
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
    /// Optional explicit destination; otherwise the download directory is used.
    #[serde(default)]
    pub dest_path: Option<String>,
}

#[tauri::command]
pub async fn download_object(
    app: State<'_, Arc<AppCore>>,
    input: DownloadInput,
) -> CmdResult<TransferResult> {
    let ctx = Ctx(&app);
    let core = ctx.core();
    let conn = core.connection(&input.connection_id).map_err(err)?;
    let store = core.client(&input.connection_id).map_err(err)?;
    let dest = match input.dest_path.clone() {
        Some(path) => PathBuf::from(path),
        None => {
            let base = core
                .settings()
                .download_dir
                .map(PathBuf::from)
                .unwrap_or_else(crate::fsutil::download_dir);
            crate::fsutil::unique_path(&base, &default_file_name(&input.key))
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
    let conn_name = conn.name.clone();

    tauri::async_runtime::spawn(async move {
        let outcome = async {
            if let Some(parent) = dest_task.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            let mut file = tokio::fs::File::create(&dest_task).await?;
            // Size is best-effort: a failed HEAD must not block the download.
            let total = store.stat(&key).await.ok().and_then(|m| m.size);
            let written = store.get_to(&key, &mut file).await?;
            let _ = total;
            Ok::<u64, AppError>(written)
        }
        .await;

        match outcome {
            Ok(_) => tracker.finish(&progress_id_task, Some(dest_task.display().to_string())),
            Err(e) => {
                // Do not leave a half-written file behind.
                let _ = tokio::fs::remove_file(&dest_task).await;
                tracker.fail(&progress_id_task, crate::model::describe_error(&e));
            }
        }
    });
    let _ = conn_name;

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
pub struct UploadInput {
    pub connection_id: String,
    /// Folder the files are uploaded into (S3 prefix).
    pub prefix: String,
    pub local_paths: Vec<String>,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadPlanItem {
    pub id: String,
    pub local_path: String,
    pub key: String,
}

#[tauri::command]
pub async fn upload_files(
    app: State<'_, Arc<AppCore>>,
    input: UploadInput,
) -> CmdResult<Vec<UploadPlanItem>> {
    let ctx = Ctx(&app);
    upload_files_impl(ctx.core(), input).await.map_err(err)
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
    let prefix = as_folder_prefix(&input.prefix);
    let mut plan = Vec::new();
    for local in &input.local_paths {
        let path = PathBuf::from(local);
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .ok_or_else(|| AppError::invalid(format!("bad local path: {local}")))?;
        plan.push(UploadPlanItem {
            id: uuid::Uuid::new_v4().to_string(),
            local_path: local.clone(),
            key: format!("{prefix}{name}"),
        });
    }

    let tracker = core.progress.clone();
    let items = plan.clone();
    let overwrite = input.overwrite;
    tauri::async_runtime::spawn(async move {
        for item in items {
            let id = tracker.start(objects::progress_label("Uploading", &item.key), None);
            let path = PathBuf::from(&item.local_path);
            if !overwrite && store.stat(&item.key).await.is_ok() {
                tracker.fail(
                    &id,
                    format!("{} already exists (overwrite is disabled)", item.key),
                );
                continue;
            }
            match store.put_file(&item.key, &path, None).await {
                Ok(()) => tracker.finish(&id, Some(item.key.clone())),
                Err(e) => tracker.fail(&id, crate::model::describe_error(&e)),
            }
        }
    });

    Ok(plan)
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
    let ctx = Ctx(&app);
    let core = ctx.core();
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
    let ctx = Ctx(&app);
    // Finished entries are kept until the user clears them (or the app exits):
    // pruning here would race with a poll that is waiting for a result.
    Ok(ctx.core().progress.all())
}

/// Drops every finished transfer from the tracker and reports how many went.
#[tauri::command]
pub async fn clear_transfers(app: State<'_, Arc<AppCore>>) -> CmdResult<usize> {
    let ctx = Ctx(&app);
    let before = ctx.core().progress.all().len();
    ctx.core().progress.prune_finished();
    Ok(before - ctx.core().progress.all().len())
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
    let ctx = Ctx(&app);
    let core = ctx.core();
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
    let ctx = Ctx(&app);
    let core = ctx.core();
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
    let ctx = Ctx(&app);
    let core = ctx.core();
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
            Ok(()) => tracker.finish(&progress_id_task, None),
            Err(e) => tracker.fail(&progress_id_task, crate::model::describe_error(&e)),
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
}

#[tauri::command]
pub async fn copy_objects(
    app: State<'_, Arc<AppCore>>,
    input: CopyInput,
) -> CmdResult<CopyOutcome> {
    let ctx = Ctx(&app);
    let core = ctx.core();
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
    tauri::async_runtime::spawn(async move {
        let mut done = 0u64;
        for (from, to) in &pairs_task {
            if let Err(e) = dst_task.copy_object(from, to).await {
                tracker.fail(
                    &progress_id,
                    format!("copy {from}: {}", crate::model::describe_error(&e)),
                );
                return;
            }
            if move_objects {
                if let Err(e) = src_task.delete_object(from).await {
                    tracker.fail(
                        &progress_id,
                        format!("delete {from}: {}", crate::model::describe_error(&e)),
                    );
                    return;
                }
            }
            done += 1;
            tracker.advance(&progress_id, 1);
        }
        let _ = done;
        tracker.finish(&progress_id, None);
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
}
