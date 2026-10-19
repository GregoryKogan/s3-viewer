//! Tauri application entry point and the `s3stream://` media protocol.

pub mod commands;
pub mod crypto;
pub mod e2e;
pub mod error;
pub mod fsutil;
pub mod model;
pub mod objects;
pub mod parquet_preview;
pub mod preview;
pub mod progress;
pub mod s3;
pub mod sigv2;
pub mod state;
pub mod store;

use crate::state::AppCore;
use std::sync::Arc;
use tauri::http::{Request, Response};
use tauri::Manager;

/// Builds the shared core, then hands it to Tauri.
pub fn run() {
    let store = store::Store::load().expect("load configuration");
    let core = Arc::new(AppCore::new(store));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // Remembers the window geometry between launches (PLT-1).
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // Self-updates. The webview drives the check (see `src/stores/updates.ts`),
        // this plugin downloads the signed bundle and swaps it on disk. Without the
        // signing key nothing is ever accepted, so the key lives only in CI secrets.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .register_asynchronous_uri_scheme_protocol("s3stream", move |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let core = app.state::<Arc<AppCore>>().inner().clone();
            tauri::async_runtime::spawn(async move {
                let response = handle_stream_request(&core, request).await;
                responder.respond(response);
            });
        })
        .manage(core)
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::update_settings,
            commands::security_status,
            commands::list_connections,
            commands::get_connection,
            commands::save_connection,
            commands::delete_connection,
            commands::duplicate_connection,
            commands::test_connection,
            commands::detect_capabilities,
            commands::list_objects,
            commands::list_objects_stream,
            commands::get_preview,
            commands::object_meta,
            commands::download_object,
            commands::download_folder,
            commands::upload_files,
            commands::upload_conflicts,
            commands::cancel_transfer,
            commands::save_text_object,
            commands::transfer_progress,
            commands::clear_transfers,
            commands::create_folder,
            commands::create_file,
            commands::delete_objects,
            commands::copy_objects,
            commands::reveal_in_file_manager,
            commands::open_path,
            commands::open_url,
            commands::default_upload_dir,
            commands::read_text_file,
            e2e::desktop::e2e_setup,
            e2e::desktop::e2e_transfer_check,
            e2e::desktop::e2e_roundtrip_check,
            e2e::desktop::e2e_delete_many_check,
            e2e::desktop::e2e_config_audit,
            e2e::desktop::e2e_readonly_check,
            e2e::desktop::e2e_report,
            ping,
        ])
        .setup(|app| {
            // The self-hosted end-to-end harness only starts when the runner
            // asks for it explicitly (S3VIEWER_E2E=1).
            if let Some(plan) = e2e::TestPlan::from_env() {
                let handle = app.handle().clone();
                let core = handle.state::<Arc<AppCore>>().inner().clone();
                let slot = Arc::new(e2e::desktop::ReportSlot::default());
                app.manage(slot.clone());
                e2e::desktop::maybe_run(&handle, &core, &plan, slot);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running s3viewer");
}

/// A trivial command the e2e suite uses to confirm the IPC bridge is alive.
#[tauri::command]
async fn ping() -> Result<String, crate::error::ErrorPayload> {
    Ok("pong".to_string())
}

/// `s3stream://localhost/<connection-id>/<percent-encoded-key>`
async fn handle_stream_request(core: &AppCore, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = request.uri().to_string();
    let (connection_id, key) = match parse_stream_uri(&uri) {
        Some(parts) => parts,
        None => return error_response(400, "malformed stream URL"),
    };
    let range_header = request
        .headers()
        .get("range")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    match commands::read_stream(core, &connection_id, &key, range_header.as_deref()).await {
        Ok(stream) => {
            let mut builder = Response::builder()
                .status(stream.status)
                .header("Content-Type", stream.content_type)
                .header("Content-Length", stream.content_length.to_string())
                .header("Accept-Ranges", "bytes")
                .header("Cache-Control", "no-store")
                // A webview treats a custom scheme as cross-origin.
                .header("Access-Control-Allow-Origin", "*")
                .header("Access-Control-Allow-Headers", "Range")
                .header(
                    "Access-Control-Expose-Headers",
                    "Content-Range, Content-Length, ETag",
                );
            if let Some(cr) = stream.content_range {
                builder = builder.header("Content-Range", cr);
            }
            if let Some(etag) = stream.etag {
                builder = builder.header("ETag", format!("\"{etag}\""));
            }
            builder
                .body(stream.body)
                .unwrap_or_else(|_| error_response(500, "response build failed"))
        }
        Err(err) => {
            let payload = error::ErrorPayload::from(&err);
            let status = payload.status.unwrap_or(match payload.kind {
                "notFound" => 404,
                "invalid" => 400,
                _ => 502,
            });
            let body = serde_json::to_vec(&payload).unwrap_or_default();
            Response::builder()
                .status(status)
                .header("Content-Type", "application/json")
                .header("Access-Control-Allow-Origin", "*")
                .body(body)
                .unwrap_or_else(|_| error_response(500, "error response build failed"))
        }
    }
}

/// Parse `/connection-id/percent-encoded-key` (the authority is always
/// `localhost` and is ignored). Returns the decoded key.
fn parse_stream_uri(uri: &str) -> Option<(String, String)> {
    let scheme_end = uri.find("://")? + 3;
    let rest = &uri[scheme_end..];
    let path_start = rest.find('/')?;
    let path = &rest[path_start + 1..];
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let mut parts = path.splitn(2, '/');
    let connection_id = percent_decode(parts.next()?);
    let encoded_key = parts.next()?;
    if connection_id.is_empty() || encoded_key.is_empty() {
        return None;
    }
    Some((connection_id, percent_decode(encoded_key)))
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        // Only `%XX` with two valid hex digits is decoded; anything else is
        // passed through untouched so malformed input cannot panic.
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn error_response(status: u16, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Access-Control-Allow-Origin", "*")
        .body(message.as_bytes().to_vec())
        .expect("static error response")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_stream_uri() {
        let (id, key) = parse_stream_uri("s3stream://localhost/abc-123/a%2Fb%20c.png").unwrap();
        assert_eq!(id, "abc-123");
        assert_eq!(key, "a/b c.png");
    }

    #[test]
    fn parses_unicode_key() {
        let (id, key) = parse_stream_uri("s3stream://localhost/c/%D0%BA%D0%B8%D1%80.txt").unwrap();
        assert_eq!(id, "c");
        assert_eq!(key, "кир.txt");
    }

    #[test]
    fn rejects_malformed_uris() {
        assert!(parse_stream_uri("s3stream://localhost/").is_none());
        assert!(parse_stream_uri("s3stream://localhost/only-id").is_none());
        assert!(parse_stream_uri("no-scheme").is_none());
    }

    #[test]
    fn percent_decode_is_forgiving() {
        assert_eq!(percent_decode("a%2Fb"), "a/b");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}
