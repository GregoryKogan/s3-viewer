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
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| file_name.to_string());
    let ext = path.extension().map(|e| e.to_string_lossy().to_string());
    for n in 1..10_000 {
        let name = match &ext {
            Some(ext) => format!("{stem} ({n}).{ext}"),
            None => format!("{stem} ({n})"),
        };
        let candidate = dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem}-{}", uuid::Uuid::new_v4()))
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

    #[test]
    fn download_dir_exists() {
        assert!(download_dir().is_dir() || download_dir() == home_dir());
    }
}
