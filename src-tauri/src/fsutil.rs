//! Small filesystem helpers: where downloads go, unique names, opening files.

use crate::error::{AppError, AppResult};
use std::path::{Path, PathBuf};

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

pub fn download_dir() -> PathBuf {
    let dir = home_dir().join("Downloads");
    if dir.is_dir() {
        dir
    } else {
        home_dir()
    }
}

/// Never overwrite an existing file: append ` (1)`, ` (2)`, … before the
/// extension, exactly like Finder/browsers do.
pub fn unique_path(dir: &Path, file_name: &str) -> PathBuf {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    for n in 1..10_000 {
        let candidate = dir.join(counter_name(file_name, n));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{}-{}", file_stem(file_name), uuid::Uuid::new_v4()))
}

/// `photo.png`, 2 -> `photo (2).png`; `LICENSE`, 2 -> `LICENSE (2)`.
fn counter_name(file_name: &str, n: u32) -> String {
    let stem = file_stem(file_name);
    match Path::new(file_name).extension() {
        Some(ext) => format!("{stem} ({n}).{}", ext.to_string_lossy()),
        None => format!("{stem} ({n})"),
    }
}

fn file_stem(file_name: &str) -> String {
    Path::new(file_name)
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| file_name.to_string())
}

/// Reserve a fresh file atomically and return it already opened for writing.
///
/// `unique_path` only *looks* for a free name, so two concurrent downloads of
/// the same basename can both pick `report.pdf` and then truncate each other's
/// bytes. `create_new` makes "is it free?" and "create it" one filesystem
/// operation: the loser of that race moves on to `report (1).pdf`.
pub async fn reserve_unique_path(
    dir: &Path,
    file_name: &str,
) -> AppResult<(PathBuf, tokio::fs::File)> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| AppError::msg(format!("cannot create {}: {e}", dir.display())))?;
    for n in 0..10_000 {
        let name = if n == 0 {
            file_name.to_string()
        } else {
            counter_name(file_name, n)
        };
        let candidate = dir.join(&name);
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
            .await
        {
            Ok(file) => return Ok((candidate, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(AppError::msg(format!(
                    "cannot create {}: {e}",
                    candidate.display()
                )))
            }
        }
    }
    Err(AppError::msg(format!(
        "cannot find a free name for {file_name} in {}",
        dir.display()
    )))
}

/// Open a file with the OS default application.
pub fn open(path: &Path) -> AppResult<()> {
    let opener = opener_command();
    std::process::Command::new(opener.0)
        .args(opener.1)
        .arg(path)
        .spawn()
        .map_err(|e| AppError::msg(format!("cannot open {}: {e}", path.display())))?;
    Ok(())
}

/// Is this a URL the system opener may be handed?
///
/// Only absolute `http`/`https` URLs are allowed: the preview renders untrusted
/// Markdown, and an opener invoked with `file:`, `javascript:` or a bare path
/// would be a way to launch something that is not a web page. Control
/// characters and whitespace are rejected rather than normalized — a URL that
/// needs trimming is not one this UI produced.
pub fn is_allowed_url(url: &str) -> bool {
    if url.is_empty() || url.trim() != url {
        return false;
    }
    if url.chars().any(char::is_control) || url.chars().any(char::is_whitespace) {
        return false;
    }
    let Some((scheme, rest)) = url.split_once("://") else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return false;
    }
    // `http:///path` has no host and is not something a browser can open.
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    !host.is_empty()
}

/// Open an http(s) URL in the user's browser.
pub fn open_url(url: &str) -> AppResult<()> {
    if !is_allowed_url(url) {
        return Err(AppError::invalid(
            "Only http and https links can be opened.",
        ));
    }
    let opener = opener_command();
    std::process::Command::new(opener.0)
        .args(opener.1)
        .arg(url)
        .spawn()
        .map_err(|e| AppError::msg(format!("cannot open {url}: {e}")))?;
    Ok(())
}

/// Reveal a file in Finder / the Linux file manager.
#[cfg(target_os = "macos")]
pub fn reveal(path: &Path) -> AppResult<()> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn()
        .map_err(|e| AppError::msg(format!("cannot reveal {}: {e}", path.display())))?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn reveal(path: &Path) -> AppResult<()> {
    // No portable "reveal"; open the containing directory instead.
    let dir = path.parent().unwrap_or(path);
    open(dir)
}

#[cfg(target_os = "macos")]
fn opener_command() -> (&'static str, &'static [&'static str]) {
    ("open", &[])
}

#[cfg(not(target_os = "macos"))]
fn opener_command() -> (&'static str, &'static [&'static str]) {
    if which("xdg-open") {
        ("xdg-open", &[])
    } else if which("gio") {
        ("gio", &["open"])
    } else {
        ("kde-open", &[])
    }
}

#[cfg(not(target_os = "macos"))]
fn which(binary: &str) -> bool {
    std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .any(|dir| Path::new(dir).join(binary).is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_path_appends_counter_before_extension() {
        let dir = tempfile::tempdir().unwrap();
        let first = unique_path(dir.path(), "photo.png");
        assert_eq!(first.file_name().unwrap(), "photo.png");

        std::fs::write(&first, b"x").unwrap();
        let second = unique_path(dir.path(), "photo.png");
        assert_eq!(second.file_name().unwrap(), "photo (1).png");

        std::fs::write(&second, b"x").unwrap();
        let third = unique_path(dir.path(), "photo.png");
        assert_eq!(third.file_name().unwrap(), "photo (2).png");
    }

    #[test]
    fn unique_path_handles_extensionless_names() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("LICENSE"), b"x").unwrap();
        let next = unique_path(dir.path(), "LICENSE");
        assert_eq!(next.file_name().unwrap(), "LICENSE (1)");
    }

    #[tokio::test]
    async fn reserve_unique_path_never_hands_out_the_same_file_twice() {
        let dir = tempfile::tempdir().unwrap();
        // Two downloads of `a/report.pdf` and `b/report.pdf` land in one folder.
        let (first, first_file) = reserve_unique_path(dir.path(), "report.pdf").await.unwrap();
        let (second, second_file) = reserve_unique_path(dir.path(), "report.pdf").await.unwrap();

        assert_eq!(first.file_name().unwrap(), "report.pdf");
        assert_eq!(second.file_name().unwrap(), "report (1).pdf");
        assert_ne!(first, second);
        assert!(first.is_file());
        assert!(second.is_file());
        drop(first_file);
        drop(second_file);
    }

    #[tokio::test]
    async fn reserve_unique_path_creates_a_missing_directory() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("batch/2024");
        let (path, file) = reserve_unique_path(&nested, "photo.png").await.unwrap();
        assert_eq!(path, nested.join("photo.png"));
        assert!(nested.is_dir());
        drop(file);
    }

    #[test]
    fn download_dir_exists() {
        assert!(download_dir().is_dir() || download_dir() == home_dir());
    }

    #[test]
    fn only_absolute_http_urls_are_allowed() {
        assert!(is_allowed_url("https://example.com/a?b=c#d"));
        assert!(is_allowed_url("http://localhost:8080/path"));
        assert!(is_allowed_url("HTTP://EXAMPLE.COM"));
        assert!(is_allowed_url("https://user@example.com/x"));

        assert!(!is_allowed_url(""));
        assert!(!is_allowed_url("   "));
        assert!(!is_allowed_url(" example.com"));
        assert!(!is_allowed_url("example.com"));
        assert!(!is_allowed_url("ftp://example.com"));
        assert!(!is_allowed_url("file:///etc/passwd"));
        assert!(!is_allowed_url("javascript:alert(1)"));
        assert!(!is_allowed_url("mailto:someone@example.com"));
        assert!(!is_allowed_url("https://"));
        assert!(!is_allowed_url("http:///path"));
        assert!(!is_allowed_url("https://exa mple.com"));
        assert!(!is_allowed_url("https://example.com\n"));
        assert!(!is_allowed_url("https://example.com/\u{0}"));
    }
}
