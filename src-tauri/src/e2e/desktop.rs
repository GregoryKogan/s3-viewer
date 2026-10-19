//! Desktop (Tauri) glue for the e2e harness: webview eval, test hooks, report.

use super::{
    parse_report, report_passed, scenario_script, write_report, ScriptHost, TestPlan,
    CONNECTION_NAME, E2E_PREVIEW_LIMIT, SCENARIO_TIMEOUT,
};
use crate::error::{AppError, AppResult};
use crate::model::{AddressingStyle, SecuritySettings, SignatureVersion};
use crate::s3::ObjectStore;
use crate::state::AppCore;
use crate::store::{AppSettings, ConnectionInput};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Runs scripts in the live webview.
///
/// `WebviewWindow::eval` is fire-and-forget, so the page delivers its report by
/// calling the [`e2e_report`] command; a backup path re-delivers the in-page
/// global in case that first attempt fails.
pub struct DesktopHost {
    app: AppHandle,
}

impl DesktopHost {
    pub fn new(app: AppHandle) -> Self {
        DesktopHost { app }
    }

    fn webview(&self) -> AppResult<tauri::WebviewWindow> {
        self.app
            .get_webview_window("main")
            .or_else(|| self.app.webview_windows().into_values().next())
            .ok_or_else(|| AppError::msg("the main webview is not available yet"))
    }
}

impl ScriptHost for DesktopHost {
    fn eval_str(&self, script: &str) -> AppResult<()> {
        self.webview()?
            .eval(script)
            .map_err(|e| AppError::msg(format!("eval failed: {e}")))
    }
}

/// Shared slot the webview fills in when the scenario finishes.
#[derive(Default)]
pub struct ReportSlot(Mutex<Option<serde_json::Value>>);

/// Receives the final report from the page.
#[tauri::command]
pub fn e2e_report(report: String, slot: tauri::State<'_, Arc<ReportSlot>>) -> Result<(), String> {
    let parsed = parse_report(&report).map_err(|e| e.to_string())?;
    let mut guard = slot.0.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(parsed);
    Ok(())
}

/// Starts the harness when the environment asks for it.
pub fn maybe_run(app: &AppHandle, core: &Arc<AppCore>, plan: &TestPlan, slot: Arc<ReportSlot>) {
    // Shrink the preview ceiling so the oversized fixture really is oversized,
    // and route downloads into the runner's scratch directory.
    let _ = core.with_store(|store| {
        let mut settings: AppSettings = store.settings();
        settings.preview_max_bytes = E2E_PREVIEW_LIMIT;
        if let Some(dir) = &plan.download_dir {
            settings.download_dir = Some(dir.clone());
        }
        store.update_settings(settings)
    });

    let app = app.clone();
    let plan = plan.clone();
    tauri::async_runtime::spawn(async move {
        let host = DesktopHost::new(app.clone());
        // Nothing can be read back out of the page (`eval_with_callback` blocks
        // its caller on this platform), so the scenario is simply injected and
        // waits for the IPC bridge itself. Injection is idempotent because the
        // scenario is guarded by `window.__S3VIEWER_E2E_STARTED`.
        let outcome = match super::start(&host, &plan) {
            Ok(()) => await_report(&app, &slot).await,
            Err(err) => Err(err),
        };

        match outcome {
            Ok(report) => {
                let ok = report_passed(&report)
                    && report
                        .get("final")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                write_report(&plan.output, &report);
                eprintln!(
                    "s3viewer e2e: {} — report written to {}",
                    if ok {
                        "all checks passed"
                    } else {
                        "failures present"
                    },
                    plan.output
                );
                app.exit(if ok { 0 } else { 2 });
            }
            Err(err) => {
                eprintln!("s3viewer e2e: harness failed: {err}");
                write_report(
                    &plan.output,
                    &serde_json::json!({
                        "ok": false,
                        "checks": [{ "name": "harness", "ok": false, "detail": err.to_string() }],
                    }),
                );
                app.exit(1);
            }
        }
    });
}

/// Waits for the *final* report.
///
/// The page publishes partial reports after every check so a hang is always
/// attributable — which means this must not treat the first report as the end of
/// the run. If the time limit expires, the last partial report is returned
/// instead of a bare timeout, so the evidence survives.
async fn await_report(app: &AppHandle, slot: &Arc<ReportSlot>) -> AppResult<serde_json::Value> {
    let started = std::time::Instant::now();
    let deadline = started + SCENARIO_TIMEOUT;
    loop {
        let latest = slot.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(report) = &latest {
            // Every heartbeat is mirrored to a file: if the app is killed, that
            // file is the only surviving evidence of where it got stuck.
            if !report
                .get("final")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                if let Some(active) = report.get("active").and_then(|v| v.as_str()) {
                    eprintln!("s3viewer e2e: running — {active}");
                    if let Ok(path) = std::env::var("S3VIEWER_E2E_TRACE") {
                        use std::io::Write;
                        if let Ok(mut file) = std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(path)
                        {
                            // Elapsed time, not a wall-clock stamp: the point of
                            // the line is how far into the run a check got.
                            let _ =
                                writeln!(file, "{:.0}s {active}", started.elapsed().as_secs_f64());
                        }
                    }
                }
            }
        }
        if let Some(report) = &latest {
            if report
                .get("final")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                return Ok(report.clone());
            }
        }
        if std::time::Instant::now() > deadline {
            return match latest {
                Some(report) => {
                    eprintln!("s3viewer e2e: the scenario timed out; reporting partial results");
                    Ok(report)
                }
                None => Err(AppError::msg(
                    "the scenario produced no report within the time limit",
                )),
            };
        }
        if let Ok(webview) = DesktopHost::new(app.clone()).webview() {
            let _ = webview.eval(
                "if (window.__S3VIEWER_E2E_REPORT && !window.__S3VIEWER_E2E_REPORT.final \
                   && !window.__S3VIEWER_E2E_DELIVERED) { \
                   window.__S3VIEWER_E2E_DELIVERED = true; \
                   window.__TAURI__.core.invoke('e2e_report', \
                     { report: JSON.stringify(window.__S3VIEWER_E2E_REPORT) }); \
                 }",
            );
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

// ---------------------------------------------------------------- test hooks

fn plan() -> AppResult<TestPlan> {
    TestPlan::from_env().ok_or_else(|| AppError::invalid("e2e mode is not active"))
}

/// Creates the connection the scenario drives.
///
/// Uses only the settings the runner passes in, and mirrors what the connection
/// form does — minus the typing, which the form test covers separately.
#[tauri::command]
pub async fn e2e_setup(core: tauri::State<'_, Arc<AppCore>>) -> Result<String, String> {
    let plan = plan().map_err(|e| e.to_string())?;
    let input = ConnectionInput {
        id: None,
        name: CONNECTION_NAME.to_string(),
        endpoint_url: plan.endpoint.clone(),
        region: Some(plan.region.clone()),
        access_key_id: plan.access_key.clone(),
        secret_access_key: Some(plan.secret_key.clone()),
        session_token: None,
        clear_session_token: false,
        bucket: plan.bucket.clone(),
        prefix: Some(plan.prefix.clone()),
        addressing_style: Some(AddressingStyle::Virtual),
        signature_version: Some(SignatureVersion::S3v4),
        payload_signing_enabled: Some(false),
        request_checksum_calculation: None,
        response_checksum_validation: None,
        // The scenario asserts the capability badge, so probing happens here
        // explicitly instead of on connect.
        security: Some(SecuritySettings {
            confirm_delete: true,
            confirm_overwrite: true,
            confirm_bulk: false,
            detect_permissions: true,
            auto_probe_on_connect: false,
            read_only_mode: false,
        }),
    };
    let connection = core.upsert_connection(input).map_err(|e| e.to_string())?;

    let store = core.client(&connection.id).map_err(|e| e.to_string())?;
    let detect = connection.security.detect_permissions;
    let caps = crate::objects::probe_capabilities(&store, detect).await;
    core.set_capabilities(&connection.id, caps)
        .map_err(|e| e.to_string())?;

    Ok(connection.id)
}

/// Downloads the image fixture through the same command the Download button
/// calls, then compares the byte count with what S3 reports.
#[tauri::command]
pub async fn e2e_transfer_check(
    core: tauri::State<'_, Arc<AppCore>>,
) -> Result<serde_json::Value, String> {
    let plan = plan().map_err(|e| e.to_string())?;
    let id = connection_with_name(&core).map_err(|e| e.to_string())?;
    let key = format!("{}image.png", plan.prefix);
    let dir = plan
        .download_dir
        .clone()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(crate::fsutil::download_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = crate::fsutil::unique_path(&dir, "e2e-image.png");

    let store = core.client(&id).map_err(|e| e.to_string())?;
    let remote_size = store
        .stat(&key)
        .await
        .map_err(|e| e.to_string())?
        .size
        .unwrap_or(0);

    let written = {
        use tokio::io::AsyncWriteExt;
        let file = tokio::fs::File::create(&dest)
            .await
            .map_err(|e| e.to_string())?;
        let mut writer = tokio::io::BufWriter::new(file);
        let written = store
            .get_to(&key, &mut writer)
            .await
            .map_err(|e| e.to_string())?;
        writer.flush().await.map_err(|e| e.to_string())?;
        written
    };

    let local_size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    let match_ = written == remote_size as u64 && local_size == remote_size as u64;
    let _ = std::fs::remove_file(&dest);

    Ok(serde_json::json!({
        "match": match_,
        "localSize": local_size,
        "remoteSize": remote_size,
    }))
}

/// Uploads a temporary object and deletes it again, through the real commands.
#[tauri::command]
pub async fn e2e_roundtrip_check(
    core: tauri::State<'_, Arc<AppCore>>,
) -> Result<serde_json::Value, String> {
    let plan = plan().map_err(|e| e.to_string())?;
    let id = connection_with_name(&core).map_err(|e| e.to_string())?;
    let key = format!("{}roundtrip-{}.txt", plan.prefix, uuid::Uuid::new_v4());
    let body = b"round-trip probe from the e2e suite".to_vec();
    let store = core.client(&id).map_err(|e| e.to_string())?;

    store
        .put_bytes(&key, body.clone(), Some("text/plain"))
        .await
        .map_err(|e| e.to_string())?;
    let back = store
        .get_bytes(&key, None)
        .await
        .map_err(|e| e.to_string())?;
    if back.body != body {
        return Err("uploaded bytes came back different".to_string());
    }
    store.delete_object(&key).await.map_err(|e| e.to_string())?;

    // Confirm from S3 that the object really is gone: a HEAD on a deleted key
    // fails, which is the signal we want.
    let still_there = store.stat(&key).await.is_ok();

    Ok(serde_json::json!({
        "uploaded": true,
        "deleted": !still_there,
        "size": body.len(),
    }))
}

/// Audits the on-disk configuration: sealed secret, 0600 file, 0700 directory.
#[tauri::command]
pub async fn e2e_config_audit(
    core: tauri::State<'_, Arc<AppCore>>,
) -> Result<serde_json::Value, String> {
    let plan = plan().map_err(|e| e.to_string())?;
    let path = core.read(|store| store.path.clone());
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;

    let mode = file_mode(&path);
    let dir_mode = path.parent().map(file_mode).unwrap_or_default();

    Ok(serde_json::json!({
        "sealed": raw.contains(crate::crypto::CIPHER_PREFIX),
        "containsSecret": raw.contains(&plan.secret_key),
        "containsAccessKey": raw.contains(&plan.access_key),
        "mode": mode,
        "dirMode": dir_mode,
        "bytes": raw.len(),
    }))
}

#[cfg(unix)]
fn file_mode(path: &std::path::Path) -> String {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| format!("{:o}", meta.permissions().mode() & 0o777))
        .unwrap_or_else(|_| "unknown".to_string())
}

#[cfg(not(unix))]
fn file_mode(_path: &std::path::Path) -> String {
    "n/a".to_string()
}

/// Proves the per-connection read-only switch actually stops a write.
///
/// A second connection to the same bucket is created with `read_only_mode` on,
/// and a real upload is attempted through it: the guard must reject the call
/// before anything reaches S3.
#[tauri::command]
pub async fn e2e_readonly_check(
    core: tauri::State<'_, Arc<AppCore>>,
) -> Result<serde_json::Value, String> {
    let plan = plan().map_err(|e| e.to_string())?;

    let read_only = core
        .upsert_connection(ConnectionInput {
            id: None,
            name: "e2e read-only probe".to_string(),
            endpoint_url: plan.endpoint.clone(),
            region: Some(plan.region.clone()),
            access_key_id: plan.access_key.clone(),
            secret_access_key: Some(plan.secret_key.clone()),
            session_token: None,
            clear_session_token: false,
            bucket: plan.bucket.clone(),
            prefix: Some(plan.prefix.clone()),
            addressing_style: Some(AddressingStyle::Virtual),
            signature_version: Some(SignatureVersion::S3v4),
            payload_signing_enabled: Some(false),
            request_checksum_calculation: None,
            response_checksum_validation: None,
            security: Some(SecuritySettings {
                read_only_mode: true,
                ..Default::default()
            }),
        })
        .map_err(|e| e.to_string())?;

    // A real local file, so the read-only guard is the only possible reason for
    // a refusal.
    let dir = std::env::temp_dir().join(format!("s3viewer-e2e-ro-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let local = dir.join("probe.txt");
    std::fs::write(&local, b"should never be uploaded").map_err(|e| e.to_string())?;

    let outcome = crate::commands::upload_files_impl(
        &core,
        crate::commands::UploadInput {
            connection_id: read_only.id.clone(),
            prefix: plan.prefix.clone(),
            local_paths: vec![local.display().to_string()],
            overwrite: true,
            skip_existing: false,
            skip_keys: Vec::new(),
        },
    )
    .await;

    let _ = std::fs::remove_dir_all(&dir);
    let _ = core.delete_connection(&read_only.id);

    match outcome {
        Ok(_) => Ok(serde_json::json!({
            "blocked": false,
            "message": "the upload was NOT blocked by read-only mode"
        })),
        Err(err) => Ok(serde_json::json!({
            "blocked": true,
            "message": err.to_string(),
        })),
    }
}

fn connection_with_name(core: &AppCore) -> AppResult<String> {
    core.connection_views()
        .into_iter()
        .find(|view| view.connection.name == CONNECTION_NAME)
        .map(|view| view.connection.id)
        .ok_or_else(|| AppError::not_found("the e2e connection"))
}

// Keeps the scenario builder referenced from this module for discoverability.
#[allow(dead_code)]
fn scenario() -> String {
    TestPlan::from_env()
        .map(|plan| scenario_script(&plan))
        .unwrap_or_default()
}
