//! Preview decision logic.
//!
//! The rule set is intentionally explicit: for every object the app either
//! produces a preview or states precisely why it cannot. Users see that reason
//! in the preview panel instead of a blank pane.
//!
//! Size policy: the app never pulls more than `head_limit` bytes to inspect an
//! object, and never loads more than `inline_limit` bytes over IPC. Media is not
//! inlined at all — the frontend streams it through the `s3stream://` protocol,
//! which supports `Range`, so a 4 GB video previews without being downloaded and
//! is deliberately exempt from the preview size limit.

use crate::error::{AppError, AppResult};
use crate::model::{FileKind, PreviewData};
use crate::s3::{kind::detect_kind, AnyStore, ByteRange, ObjectStore};

/// Bytes fetched to sniff content and to feed the text preview.
pub const HEAD_LIMIT: u64 = 512 * 1024;
/// Bytes of UTF-8 text handed to the frontend in one go.
pub const INLINE_LIMIT: u64 = 2 * 1024 * 1024;

pub fn stream_url(connection_id: &str, key: &str) -> String {
    format!(
        "s3stream://localhost/{}/{}",
        connection_id,
        crate::sigv2::percent_encode(key, false)
    )
}

/// True when the kind can be rendered directly by a webview element.
pub fn is_natively_renderable(kind: FileKind) -> bool {
    matches!(
        kind,
        FileKind::Image | FileKind::Audio | FileKind::Video | FileKind::Pdf
    )
}

/// Kinds the webview plays from `s3stream://` with ranged reads: only the bytes
/// it is about to play are fetched, so the preview limit does not apply.
///
/// Images and PDFs are excluded on purpose — an `<img>` pulls the whole object
/// and PDF.js keeps the document open — so the limit still bounds what the app
/// loads for them.
pub fn is_streamed(kind: FileKind) -> bool {
    matches!(kind, FileKind::Audio | FileKind::Video)
}

/// Bytes read for a Parquet preview. The footer lives at the end, but the first
/// rows are at the start, so the whole object is read up to this cap.
pub const PARQUET_LIMIT: u64 = 64 * 1024 * 1024;

/// Kinds whose preview requires reading the content.
pub fn is_textual(kind: FileKind) -> bool {
    matches!(
        kind,
        FileKind::Text | FileKind::Markdown | FileKind::Code | FileKind::Json | FileKind::Csv
    )
}

/// Kinds that never have a meaningful preview.
fn is_never_previewable(kind: FileKind) -> Option<&'static str> {
    match kind {
        FileKind::Folder => Some("This is a folder, not a file."),
        FileKind::Archive => {
            Some("Archives are not previewed. Download the file and open it locally.")
        }
        _ => None,
    }
}

/// Decide what the preview panel should show for one object.
pub async fn build_preview(
    store: &AnyStore,
    connection_id: &str,
    key: &str,
    max_bytes: u64,
) -> AppResult<PreviewData> {
    let stat = store.stat(key).await?;
    let size = stat.size.unwrap_or(0);
    let url = stream_url(connection_id, key);

    if size == 0 {
        return Ok(PreviewData {
            kind: detect_kind(key, stat.content_type.as_deref(), None),
            key: key.to_string(),
            size,
            content_type: stat.content_type.unwrap_or_default(),
            etag: stat.etag,
            last_modified: stat.last_modified,
            text: None,
            base64: None,
            table: None,
            stream_url: url,
            truncated: false,
            unavailable_reason: Some(
                "This file is empty (0 bytes), so there is nothing to preview.".to_string(),
            ),
        });
    }

    // Sniff the head for classification regardless of size — it is cheap and
    // lets the "too large" message name the real file type.
    let head_range = ByteRange {
        start: 0,
        end: HEAD_LIMIT.saturating_sub(1),
    };
    let head = match store.get_bytes(key, Some(head_range)).await {
        Ok(stream) => stream,
        Err(err) => {
            // Some policies deny ranged reads; fall back to metadata only.
            let kind = detect_kind(key, stat.content_type.as_deref(), None);
            return Ok(PreviewData {
                kind,
                key: key.to_string(),
                size,
                content_type: stat.content_type.unwrap_or_default(),
                etag: stat.etag,
                last_modified: stat.last_modified,
                text: None,
                base64: None,
                table: None,
                stream_url: url,
                truncated: false,
                unavailable_reason: Some(format!(
                    "S3 refused to return the file contents ({}).",
                    crate::model::describe_error(&err)
                )),
            });
        }
    };

    let content_type = head
        .content_type
        .clone()
        .or(stat.content_type.clone())
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let kind = detect_kind(key, Some(&content_type), Some(&head.body));

    let mut data = PreviewData {
        kind,
        key: key.to_string(),
        size,
        content_type,
        etag: head.etag.clone().or(stat.etag.clone()),
        last_modified: head.last_modified.clone().or(stat.last_modified.clone()),
        text: None,
        base64: None,
        table: None,
        stream_url: url,
        truncated: false,
        unavailable_reason: None,
    };

    if let Some(reason) = is_never_previewable(kind) {
        data.unavailable_reason = Some(reason.to_string());
        return Ok(data);
    }

    // Streamed media is exempt: the panel asks the protocol handler only for the
    // ranges it needs, so an hour-long video is never pulled whole.
    if !is_streamed(kind) && size > max_bytes as i64 {
        data.unavailable_reason = Some(format!(
            "File is {} which exceeds the preview limit of {}. Increase it in Settings or download the file.",
            crate::objects::human_size(size),
            crate::objects::human_size(max_bytes as i64)
        ));
        return Ok(data);
    }

    if is_natively_renderable(kind) {
        // Nothing to inline: the panel binds the stream URL, which supports
        // ranged reads so media starts playing immediately.
        if head.body.len() as i64 != size && size > HEAD_LIMIT as i64 {
            data.truncated = true;
        }
        return Ok(data);
    }

    if kind == FileKind::Parquet {
        if size > PARQUET_LIMIT as i64 {
            data.unavailable_reason = Some(format!(
                "Parquet previews are limited to {} (this file is {}). Download it to inspect it locally.",
                crate::objects::human_size(PARQUET_LIMIT as i64),
                crate::objects::human_size(size)
            ));
            return Ok(data);
        }
        // Read the whole object: a Parquet table cannot be rendered from a head
        // slice, because the schema lives in the footer.
        let full = store
            .get_bytes(key, None)
            .await
            .map_err(|e| AppError::msg(format!("read parquet object: {e}")))?;
        match crate::parquet_preview::preview(&full.body) {
            Ok(table) => {
                data.table = Some(table);
                return Ok(data);
            }
            Err(err) => {
                data.unavailable_reason = Some(err.to_string());
                return Ok(data);
            }
        }
    }

    if is_textual(kind) {
        let text = match std::str::from_utf8(&head.body) {
            Ok(text) => text.to_string(),
            Err(_) => {
                // Not valid UTF-8: preview the readable prefix and say so.
                let lossy = String::from_utf8_lossy(&head.body).to_string();
                data.truncated = true;
                data.unavailable_reason = Some(
                    "File is not valid UTF-8 text; showing a lossy preview of the first bytes."
                        .to_string(),
                );
                lossy
            }
        };
        let text = if text.len() as u64 > INLINE_LIMIT {
            data.truncated = true;
            let cut = floor_char_boundary(&text, INLINE_LIMIT as usize);
            text[..cut].to_string()
        } else {
            text
        };
        if size > INLINE_LIMIT as i64 {
            data.truncated = true;
        }
        data.text = Some(text);
        return Ok(data);
    }

    // Unknown / binary: no preview, but say why and offer the download path.
    data.unavailable_reason = Some(match kind {
        FileKind::Binary => {
            "This file type has no in-app preview (binary content). Download it to inspect locally."
                .to_string()
        }
        _ => "This file type has no in-app preview. Download it to inspect locally.".to_string(),
    });
    Ok(data)
}

/// Largest char boundary <= `limit`, so slicing never panics on multi-byte text.
pub fn floor_char_boundary(text: &str, limit: usize) -> usize {
    if limit >= text.len() {
        return text.len();
    }
    let mut idx = limit;
    while idx > 0 && !text.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

/// Range parsing for the `s3stream://` protocol.
/// Accepts `bytes=start-end` and `bytes=start-` (the two forms webviews use).
pub fn parse_range(header: &str, total: u64) -> Option<ByteRange> {
    let spec = header.strip_prefix("bytes=")?;
    let (start_s, end_s) = spec.split_once('-')?;
    let start: u64 = start_s.trim().parse().ok()?;
    let end = if end_s.trim().is_empty() {
        total.saturating_sub(1)
    } else {
        end_s.trim().parse().ok()?
    };
    if start > end || start >= total {
        return None;
    }
    Some(ByteRange {
        start,
        end: end.min(total.saturating_sub(1)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_url_encodes_the_key() {
        let url = stream_url("conn-1", "a/b c+d.png");
        assert_eq!(url, "s3stream://localhost/conn-1/a%2Fb%20c%2Bd.png");
        assert!(!url.contains(' '));
    }

    #[test]
    fn stream_url_keeps_unicode_decodable() {
        let url = stream_url("c", "кириллица.txt");
        assert!(url.starts_with("s3stream://localhost/c/%D0%BA"));
        assert!(!url.contains('к'), "key must be percent-encoded");
    }

    #[test]
    fn native_kinds_are_renderable() {
        for kind in [
            FileKind::Image,
            FileKind::Audio,
            FileKind::Video,
            FileKind::Pdf,
        ] {
            assert!(is_natively_renderable(kind), "{kind:?}");
        }
        assert!(!is_natively_renderable(FileKind::Code));
    }

    #[test]
    fn only_played_media_ignores_the_size_limit() {
        for kind in [FileKind::Audio, FileKind::Video] {
            assert!(is_streamed(kind), "{kind:?}");
        }
        // Anything the app reads whole — images, PDFs, text — stays bounded.
        for kind in [
            FileKind::Image,
            FileKind::Pdf,
            FileKind::Text,
            FileKind::Binary,
        ] {
            assert!(!is_streamed(kind), "{kind:?} must stay bounded");
        }
    }

    #[test]
    fn textual_kinds_are_listed() {
        for kind in [
            FileKind::Text,
            FileKind::Markdown,
            FileKind::Code,
            FileKind::Json,
            FileKind::Csv,
        ] {
            assert!(is_textual(kind), "{kind:?}");
        }
        assert!(!is_textual(FileKind::Image));
    }

    #[test]
    fn folders_and_archives_explain_themselves() {
        assert!(is_never_previewable(FileKind::Folder)
            .unwrap()
            .contains("folder"));
        assert!(is_never_previewable(FileKind::Archive)
            .unwrap()
            .contains("Archives"));
    }

    #[test]
    fn floor_char_boundary_never_splits_a_char() {
        let text = "привет";
        let idx = floor_char_boundary(text, 3);
        assert!(text.is_char_boundary(idx));
        assert_eq!(&text[..idx], "п");
        assert_eq!(floor_char_boundary(text, 1000), text.len());
    }

    #[test]
    fn parse_range_handles_closed_and_open_forms() {
        assert_eq!(
            parse_range("bytes=0-1023", 4096),
            Some(ByteRange {
                start: 0,
                end: 1023
            })
        );
        assert_eq!(
            parse_range("bytes=2048-", 4096),
            Some(ByteRange {
                start: 2048,
                end: 4095
            })
        );
        // Clamped to the object size.
        assert_eq!(
            parse_range("bytes=4000-9999", 4096),
            Some(ByteRange {
                start: 4000,
                end: 4095
            })
        );
    }

    #[test]
    fn parse_range_rejects_nonsense() {
        assert_eq!(parse_range("bytes=10-5", 100), None);
        assert_eq!(parse_range("bytes=500-600", 100), None);
        assert_eq!(parse_range("items=0-1", 100), None);
        assert_eq!(parse_range("bytes=abc-1", 100), None);
    }
}
