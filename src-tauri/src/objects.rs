//! Object-level operations shared by all Tauri commands: listing a prefix,
//! recursive walks, capability probing and folder bookkeeping.

use crate::error::{AppError, AppResult};
use crate::model::{Capabilities, ObjectEntry};
use crate::s3::{short_key, AnyStore, ObjectStore};

/// Hard ceiling on how many keys a single recursive operation may touch, so a
/// mis-click on a huge prefix cannot spin forever.
pub const MAX_RECURSIVE_KEYS: usize = 200_000;
/// Per-request page size sent to S3.
pub const PAGE_SIZE: i32 = 1000;

/// Ensure a prefix ends with `/` (unless empty) and is usable as a list prefix.
pub fn as_folder_prefix(prefix: &str) -> String {
    if prefix.is_empty() || prefix.ends_with('/') {
        prefix.to_string()
    } else {
        format!("{prefix}/")
    }
}

/// Entry name for a key inside a folder, e.g. `a/b/c.png` in `a/` -> `c`.
pub fn leaf_name(key: &str, folder: &str) -> String {
    let rest = key.strip_prefix(folder).unwrap_or(key);
    rest.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(rest)
        .to_string()
}

/// List one folder, following continuation tokens up to `limit` entries.
pub async fn list_folder(
    store: &AnyStore,
    prefix: &str,
    limit: usize,
) -> AppResult<(Vec<ObjectEntry>, bool)> {
    let folder = as_folder_prefix(prefix);
    let mut entries: Vec<ObjectEntry> = Vec::new();
    let mut token: Option<String> = None;
    let mut truncated = false;
    loop {
        let page = store
            .list_page(&folder, Some("/"), token.as_deref(), PAGE_SIZE)
            .await?;
        entries.extend(page.entries);
        if entries.len() >= limit {
            truncated = true;
            break;
        }
        if !page.is_truncated {
            break;
        }
        match page.next_token {
            Some(t) if Some(&t) != token.as_ref() => token = Some(t),
            _ => break,
        }
    }
    // A 1000-key page boundary is the common case; only report truncation when
    // the caller really asked for less than S3 can deliver.
    if entries.len() > limit {
        entries.truncate(limit);
        truncated = true;
    }
    Ok((entries, truncated))
}

/// Every key at or below `prefix` (recursive), capped by [`MAX_RECURSIVE_KEYS`].
pub async fn list_all_keys(store: &AnyStore, prefix: &str) -> AppResult<Vec<String>> {
    let mut keys = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = store
            .list_page(prefix, None, token.as_deref(), PAGE_SIZE)
            .await?;
        for entry in page.entries {
            if !entry.is_folder {
                keys.push(entry.key);
            }
        }
        if keys.len() > MAX_RECURSIVE_KEYS {
            return Err(AppError::invalid(format!(
                "refusing to operate on more than {MAX_RECURSIVE_KEYS} keys at once"
            )));
        }
        if !page.is_truncated {
            break;
        }
        match page.next_token {
            Some(t) if Some(&t) != token.as_ref() => token = Some(t),
            _ => break,
        }
    }
    Ok(keys)
}

/// Human summary used in confirmation prompts, e.g. `12 files (3.4 GB)`.
pub fn describe_objects(entries: &[ObjectEntry]) -> String {
    let files = entries.iter().filter(|e| !e.is_folder).count();
    let folders = entries.iter().filter(|e| e.is_folder).count();
    let bytes: i64 = entries
        .iter()
        .filter(|e| !e.is_folder)
        .map(|e| e.size)
        .sum();
    let mut parts = Vec::new();
    if files > 0 {
        parts.push(format!("{files} file(s), {}", human_size(bytes)));
    }
    if folders > 0 {
        parts.push(format!("{folders} folder(s)"));
    }
    if parts.is_empty() {
        "nothing".to_string()
    } else {
        parts.join(" and ")
    }
}

pub fn human_size(bytes: i64) -> String {
    const UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// Label for a batch operation.
pub fn progress_label(action: &str, key: &str) -> String {
    format!("{action} {}", short_key(key))
}

// ---------------------------------------------------------------- permission probe

/// Determine what the stored credentials may do.
///
/// Runs three cheap probes and reports what is actually allowed. Nothing here
/// touches user data: the write probe uses a uniquely named key that is deleted
/// immediately afterwards.
pub async fn probe_capabilities(store: &AnyStore, detect: bool) -> Capabilities {
    let mut caps = Capabilities {
        probed: true,
        ..Default::default()
    };

    match store.list_page("", Some("/"), None, 1).await {
        Ok(page) => {
            caps.can_list = true;
            caps.can_read = !page.entries.is_empty();
            if page.entries.is_empty() {
                caps.details
                    .push("prefix is empty (no keys at the root of this prefix)".to_string());
            }
        }
        Err(err) => {
            caps.details.push(format!(
                "listing failed: {}",
                crate::model::describe_error(&err)
            ));
        }
    }

    if detect && caps.can_list {
        let probe_key = format!(".s3viewer-probe/{}", uuid::Uuid::new_v4());
        match store
            .put_bytes(&probe_key, b"s3viewer probe".to_vec(), Some("text/plain"))
            .await
        {
            Ok(()) => {
                caps.can_write = true;
                match store.delete_object(&probe_key).await {
                    Ok(()) => caps.can_delete = true,
                    Err(err) => {
                        caps.details.push(format!(
                            "write allowed, delete denied ({}) — a leftover probe object may remain at {probe_key}",
                            crate::model::describe_error(&err)
                        ));
                    }
                }
            }
            Err(err) => {
                let code = crate::model::error_code(&err);
                if code.as_deref() == Some("AccessDenied") {
                    caps.details.push(
                        "write probe denied (AccessDenied) — read-only credentials".to_string(),
                    );
                } else {
                    caps.details.push(format!(
                        "write probe failed: {}",
                        crate::model::describe_error(&err)
                    ));
                }
                // A denied write implies a denied delete in practice.
                caps.can_delete = false;
            }
        }
    }

    if !detect {
        caps.details.push(
            "write/delete capability not probed (disabled in connection settings)".to_string(),
        );
    }
    if !caps.can_read && caps.can_list {
        caps.details
            .push("credentials can list but no readable object was found at the root".to_string());
    }
    caps
}

/// Probe a bucket that is *not* a connection, used by "Test connection" before
/// anything is saved.
pub async fn probe_list_only(store: &AnyStore) -> AppResult<usize> {
    let page = store.list_page("", Some("/"), None, 10).await?;
    Ok(page.entries.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_prefix_normalization() {
        assert_eq!(as_folder_prefix("a"), "a/");
        assert_eq!(as_folder_prefix("a/"), "a/");
        assert_eq!(as_folder_prefix(""), "");
        assert_eq!(as_folder_prefix("a/b"), "a/b/");
    }

    #[test]
    fn leaf_names() {
        assert_eq!(leaf_name("a/b/c.png", "a/"), "c.png");
        assert_eq!(leaf_name("a/b/", "a/"), "b");
        assert_eq!(leaf_name("x.txt", ""), "x.txt");
    }

    #[test]
    fn sizes_are_human_readable() {
        assert_eq!(human_size(0), "0 B");
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(1024), "1.0 KB");
        assert_eq!(human_size(1536), "1.5 KB");
        assert_eq!(human_size(1024 * 1024 * 3), "3.0 MB");
        assert_eq!(human_size(1024_i64.pow(4)), "1.0 TB");
    }

    #[test]
    fn describe_objects_summarizes_mixed_entries() {
        let entries = vec![
            ObjectEntry {
                key: "a/".into(),
                name: "a".into(),
                is_folder: true,
                size: 0,
                last_modified: None,
                etag: None,
                storage_class: None,
                kind: crate::model::FileKind::Folder,
            },
            ObjectEntry {
                key: "b.png".into(),
                name: "b.png".into(),
                is_folder: false,
                size: 2048,
                last_modified: None,
                etag: None,
                storage_class: None,
                kind: crate::model::FileKind::Image,
            },
        ];
        let text = describe_objects(&entries);
        assert!(text.contains("1 file(s)"));
        assert!(text.contains("2.0 KB"));
        assert!(text.contains("1 folder(s)"));
    }

    #[test]
    fn describe_empty_selection() {
        assert_eq!(describe_objects(&[]), "nothing");
    }

    #[test]
    fn progress_labels_shorten_deep_keys() {
        assert_eq!(
            progress_label("Downloading", "a/b/c/d.png"),
            "Downloading …/c/d.png"
        );
    }
}
