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

/// One delivered page of a folder listing.
pub struct ListingPage {
    pub entries: Vec<ObjectEntry>,
    pub is_last: bool,
    pub truncated: bool,
}

/// One S3 page fitted into the remaining file budget.
struct FittedPage {
    entries: Vec<ObjectEntry>,
    /// File budget left after this page.
    remaining_files: usize,
    /// The caller must not request another page.
    is_last: bool,
    /// The listing is incomplete: a file was dropped or pages were left unread.
    truncated: bool,
}

/// Fit one S3 page into the remaining file budget.
///
/// Folders never consume the budget and keep their original positions, even
/// after the budget is exhausted. Files past the budget are dropped. When
/// `has_more_pages` is true and the budget is spent — a file had to be dropped,
/// or exactly `remaining` files were emitted — no further page is requested, so
/// `is_last` is set and `truncated` records that the listing is incomplete.
/// `already_truncated` carries the flag across pages, although a page that sets
/// it is always the last one.
fn fit_page(
    entries: Vec<ObjectEntry>,
    remaining: usize,
    has_more_pages: bool,
    already_truncated: bool,
) -> FittedPage {
    let mut kept_files = 0usize;
    let mut dropped_file = false;
    let mut fitted = Vec::with_capacity(entries.len());
    for entry in entries {
        if entry.is_folder {
            fitted.push(entry);
        } else if kept_files < remaining {
            kept_files += 1;
            fitted.push(entry);
        } else {
            dropped_file = true;
        }
    }
    let remaining_files = remaining - kept_files;
    let budget_spent = dropped_file || remaining_files == 0;
    FittedPage {
        entries: fitted,
        remaining_files,
        is_last: !has_more_pages || budget_spent,
        truncated: already_truncated || dropped_file || (has_more_pages && remaining_files == 0),
    }
}

/// Drop the folder's own zero-byte marker from a page.
///
/// A folder created in this app is a marker object whose key *is* the prefix.
/// Some S3 implementations return that key as an entry (the suffix after the
/// prefix is empty) even with a delimiter, which used to render as a blank row
/// inside every created folder and stopped an empty folder from ever looking
/// empty.
fn drop_self_marker(entries: Vec<ObjectEntry>, folder: &str) -> Vec<ObjectEntry> {
    if folder.is_empty() {
        return entries;
    }
    entries
        .into_iter()
        .filter(|entry| entry.key != folder)
        .collect()
}

/// List one folder page by page.
///
/// The caller receives every page as soon as S3 returns it, which is what lets
/// the UI paint results while a large prefix is still being read. `limit` is a
/// budget for *files*, not rows: folders never consume it, and every folder on a
/// delivered page is kept in its original position, since a prefix full of
/// sub-folders must not eat the budget meant for files. Once the budget is spent
/// — a file would be dropped, or exactly `limit` files were emitted and S3 has
/// another page — the stream stops requesting pages, and the final emitted page
/// reports `truncated` and `is_last`. Folders that only exist on the unrequested
/// pages are therefore not delivered; stopping is what bounds the listing.
///
/// `limit == 0` means "no files, folders only". The settings UI clamps the
/// field to at least 200 and maps a blank or zero value back to the default, so
/// 0 only comes from a hand-edited config.
pub async fn list_folder_streaming<F>(
    store: &AnyStore,
    prefix: &str,
    limit: usize,
    mut on_page: F,
) -> AppResult<()>
where
    F: FnMut(ListingPage),
{
    let folder = as_folder_prefix(prefix);
    let mut remaining = limit;
    let mut token: Option<String> = None;
    let mut truncated = false;

    loop {
        let page = store
            .list_page(&folder, Some("/"), token.as_deref(), PAGE_SIZE)
            .await?;
        let next_token = if page.is_truncated {
            page.next_token
                .clone()
                .filter(|t| Some(t) != token.as_ref())
        } else {
            None
        };
        let page_entries = drop_self_marker(page.entries, &folder);
        let fitted = fit_page(page_entries, remaining, next_token.is_some(), truncated);
        let FittedPage {
            entries,
            remaining_files,
            is_last,
            truncated: page_truncated,
        } = fitted;
        remaining = remaining_files;
        truncated = page_truncated;
        on_page(ListingPage {
            entries,
            is_last,
            truncated,
        });
        if is_last {
            break;
        }
        token = next_token;
    }
    Ok(())
}

/// Collect the whole folder, used by paths that do not need incremental output.
pub async fn list_folder(
    store: &AnyStore,
    prefix: &str,
    limit: usize,
) -> AppResult<(Vec<ObjectEntry>, bool)> {
    let mut entries: Vec<ObjectEntry> = Vec::new();
    let mut truncated = false;
    list_folder_streaming(store, prefix, limit, |page| {
        entries.extend(page.entries);
        truncated = page.truncated;
    })
    .await?;
    Ok((entries, truncated))
}

/// Every object at or below `prefix` (recursive), capped by
/// [`MAX_RECURSIVE_KEYS`]. Sizes come from the same page, so a bulk download can
/// report progress in bytes without a HEAD per key.
///
/// Folder markers are keys too: a nested empty folder that this app created is
/// a zero-byte object ending in `/`, and leaving it behind makes the parent
/// folder reappear after a recursive delete.
pub async fn list_all_entries(store: &AnyStore, prefix: &str) -> AppResult<Vec<ObjectEntry>> {
    let mut entries = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = store
            .list_page(prefix, None, token.as_deref(), PAGE_SIZE)
            .await?;
        entries.extend(page.entries);
        if entries.len() > MAX_RECURSIVE_KEYS {
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
    Ok(entries)
}

/// Every key at or below `prefix` (recursive); see [`list_all_entries`].
pub async fn list_all_keys(store: &AnyStore, prefix: &str) -> AppResult<Vec<String>> {
    Ok(list_all_entries(store, prefix)
        .await?
        .into_iter()
        .map(|entry| entry.key)
        .collect())
}

/// Human summary used in confirmation prompts, e.g. `12 files (3.4 GB)`.
pub fn describe_objects(entries: &[ObjectEntry]) -> String {
    let (files, folders, bytes) =
        entries
            .iter()
            .fold((0usize, 0usize, 0i64), |(files, folders, bytes), e| {
                if e.is_folder {
                    (files, folders + 1, bytes)
                } else {
                    (files + 1, folders, bytes + e.size)
                }
            });
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

/// Key for the capability probe's throwaway object.
///
/// Lives under the connection's prefix so a scoped connection never touches a
/// key outside its scope, and the e2e suite only ever writes inside its own
/// `_s3viewer-e2e/` area. The uuid keeps concurrent probes apart.
fn probe_key(prefix: &str) -> String {
    format!(
        "{}.s3viewer-probe/{}",
        as_folder_prefix(prefix),
        uuid::Uuid::new_v4()
    )
}

/// Determine what the stored credentials may do.
///
/// Runs three cheap probes and reports what is actually allowed. Nothing here
/// touches user data: the write probe uses a uniquely named key under the
/// connection's own prefix and deletes it immediately afterwards. When
/// `read_only` is set, no write is attempted at all.
pub async fn probe_capabilities(
    store: &AnyStore,
    prefix: &str,
    detect: bool,
    read_only: bool,
) -> Capabilities {
    let mut caps = Capabilities {
        probed: true,
        ..Default::default()
    };

    match store
        .list_page(&as_folder_prefix(prefix), Some("/"), None, 1)
        .await
    {
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
            // An S3 error code means the endpoint answered (403, 404, 500);
            // only a transport-level failure means it did not. The sidebar uses
            // this to colour the health dot, not the permission badge.
            if crate::model::error_code(&err).is_none() {
                caps.probed = false;
            }
        }
    }

    if read_only {
        let mut detail = "write/delete not probed (connection is read-only)".to_string();
        if detect {
            detail.push_str("; the local read-only switch skipped the probe, not the credentials");
        }
        caps.details.push(detail);
    } else if detect && caps.can_list {
        let key = probe_key(prefix);
        match store
            .put_bytes(&key, b"s3viewer probe".to_vec(), Some("text/plain"))
            .await
        {
            Ok(()) => {
                caps.can_write = true;
                match store.delete_object(&key).await {
                    Ok(()) => caps.can_delete = true,
                    Err(err) => {
                        caps.details.push(format!(
                            "write allowed, delete denied ({}) — a leftover probe object may remain at {key}",
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

    if !detect && !read_only {
        caps.details.push(
            "write/delete capability not probed (disabled in connection settings)".to_string(),
        );
    }
    if !caps.can_read && caps.can_list {
        caps.details.push(
            "credentials can list but no readable object was found under this prefix".to_string(),
        );
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
    fn probe_key_stays_inside_the_connection_prefix() {
        for prefix in ["", "a", "a/", "a/b", "_s3viewer-e2e/"] {
            let key = probe_key(prefix);
            assert!(
                key.starts_with(&as_folder_prefix(prefix)),
                "{key:?} must start with {:?}",
                as_folder_prefix(prefix)
            );
            assert!(key.contains(".s3viewer-probe/"), "{key:?}");
        }

        // The scoped case is the one the bug report is about.
        let key = probe_key("scoped");
        assert_eq!(
            &key[.."scoped/.s3viewer-probe/".len()],
            "scoped/.s3viewer-probe/"
        );

        // Each probe gets its own key, so concurrent runs cannot collide.
        assert_ne!(probe_key("scoped"), probe_key("scoped"));
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

    // ------------------------------------------------------------ page fitting

    fn entry(key: &str, is_folder: bool) -> ObjectEntry {
        ObjectEntry {
            name: leaf_name(key, ""),
            key: key.into(),
            is_folder,
            size: if is_folder { 0 } else { 1 },
            last_modified: None,
            etag: None,
            storage_class: None,
            kind: if is_folder {
                crate::model::FileKind::Folder
            } else {
                crate::model::FileKind::Binary
            },
        }
    }

    fn keys(entries: &[ObjectEntry]) -> Vec<&str> {
        entries.iter().map(|entry| entry.key.as_str()).collect()
    }

    #[test]
    fn page_fit_keeps_folders_and_caps_files() {
        // Three folders and ten files. `f2/` and `f3/` sort after files, so they
        // only survive if folders are exempt from the file budget.
        let page = vec![
            entry("f1/", true),
            entry("a.png", false),
            entry("b.png", false),
            entry("f2/", true),
            entry("c.png", false),
            entry("d.png", false),
            entry("e.png", false),
            entry("f3/", true),
            entry("f.png", false),
            entry("g.png", false),
            entry("h.png", false),
            entry("i.png", false),
            entry("j.png", false),
        ];

        let fitted = fit_page(page, 3, true, false);

        assert_eq!(
            keys(&fitted.entries),
            vec!["f1/", "a.png", "b.png", "f2/", "c.png", "f3/"]
        );
        assert_eq!(fitted.remaining_files, 0);
        assert!(
            fitted.is_last,
            "the budget is spent, so no next page may be requested"
        );
        assert!(fitted.truncated, "seven files were dropped");
    }

    #[test]
    fn page_fit_under_the_budget_is_not_truncated() {
        let page = vec![
            entry("f1/", true),
            entry("a.png", false),
            entry("f2/", true),
            entry("b.png", false),
            entry("c.png", false),
        ];

        let fitted = fit_page(page.clone(), 10, false, false);
        assert_eq!(fitted.entries.len(), 5);
        assert_eq!(fitted.remaining_files, 7);
        assert!(fitted.is_last, "there is no next S3 page");
        assert!(!fitted.truncated);

        let more = fit_page(page, 10, true, false);
        assert_eq!(more.remaining_files, 7);
        assert!(
            !more.is_last,
            "budget remains, so the next page is requested"
        );
        assert!(!more.truncated);
    }

    #[test]
    fn exact_budget_is_truncated_only_when_pages_remain() {
        let page = || {
            vec![
                entry("a.png", false),
                entry("b.png", false),
                entry("c.png", false),
            ]
        };

        let more = fit_page(page(), 3, true, false);
        assert_eq!(more.remaining_files, 0);
        assert!(more.is_last);
        assert!(
            more.truncated,
            "pages remain but the stream refuses to request them"
        );

        let end = fit_page(page(), 3, false, false);
        assert!(end.is_last);
        assert!(
            !end.truncated,
            "nothing was dropped and no page was left unread"
        );
    }

    #[test]
    fn folders_after_the_file_budget_are_still_delivered() {
        let page = vec![
            entry("a.png", false),
            entry("b.png", false),
            entry("z1/", true),
            entry("z2/", true),
        ];

        let fitted = fit_page(page, 1, true, false);

        assert_eq!(keys(&fitted.entries), vec!["a.png", "z1/", "z2/"]);
        assert!(fitted.truncated);
    }

    #[test]
    fn zero_limit_emits_folders_only() {
        let page = vec![
            entry("a.png", false),
            entry("f1/", true),
            entry("b.png", false),
            entry("f2/", true),
        ];

        let fitted = fit_page(page, 0, true, false);

        assert_eq!(keys(&fitted.entries), vec!["f1/", "f2/"]);
        assert_eq!(fitted.remaining_files, 0);
        assert!(fitted.is_last);
        assert!(fitted.truncated, "files were dropped");
    }

    #[test]
    fn folder_marker_is_not_listed_as_a_child() {
        // The marker key equals the prefix; S3 may return it as an empty-named
        // entry inside the folder it marks.
        let page = vec![
            entry("a/", false),
            entry("a/child.txt", false),
            entry("a/sub/", true),
        ];
        assert_eq!(
            keys(&drop_self_marker(page, "a/")),
            vec!["a/child.txt", "a/sub/"]
        );
        // Without a trailing slash the normalised folder is still the marker.
        let page = vec![entry("a/", false), entry("a/child.txt", false)];
        assert_eq!(keys(&drop_self_marker(page, "a/")), vec!["a/child.txt"]);
    }

    #[test]
    fn file_budget_is_shared_across_pages() {
        let first = fit_page(
            vec![
                entry("a.png", false),
                entry("b.png", false),
                entry("f1/", true),
            ],
            3,
            true,
            false,
        );
        assert_eq!(first.remaining_files, 1);
        assert!(!first.is_last);
        assert!(!first.truncated);

        let second = fit_page(
            vec![
                entry("c.png", false),
                entry("d.png", false),
                entry("f2/", true),
            ],
            first.remaining_files,
            false,
            first.truncated,
        );

        assert_eq!(keys(&second.entries), vec!["c.png", "f2/"]);
        assert!(second.is_last);
        assert!(second.truncated, "only three files fit across both pages");
    }
}
