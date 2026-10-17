//! File classification: extension + magic bytes -> [`FileKind`], plus MIME
//! guessing for uploads. Deliberately table-driven and dependency-free.

use crate::model::FileKind;
use std::path::Path;

/// Classify by extension first, then fall back to sniffing the first bytes.
///
/// The `content_type` hint is the *last* resort: providers frequently serve
/// everything as `application/octet-stream`, and a key like `data.parquet` is
/// better described by its extension than by a generic MIME type.
pub fn detect_kind(key: &str, content_type: Option<&str>, head: Option<&[u8]>) -> FileKind {
    let lower = key.to_ascii_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    let ext = name.rsplit_once('.').map(|(_, e)| e).unwrap_or("");

    if lower.ends_with('/') {
        return FileKind::Folder;
    }

    if let Some(kind) = kind_from_extension(ext) {
        return kind;
    }
    if let Some(kind) = kind_from_magic(head) {
        return kind;
    }
    // Best effort for everything the tables above do not know: an unknown
    // extension (`.pub`, `.pem`, `.conf`, none at all) is far more often text
    // than something binary. S3 is full of text files with a useless extension,
    // and refusing to show them is worse than occasionally showing mojibake.
    if looks_like_text(head) {
        return FileKind::Text;
    }
    // Only consult the MIME type when the key carries no extension at all.
    if ext.is_empty() {
        if let Some(kind) = content_type.and_then(kind_from_mime) {
            return kind;
        }
    }
    if ext.is_empty() {
        FileKind::Unknown
    } else {
        FileKind::Binary
    }
}

fn kind_from_extension(ext: &str) -> Option<FileKind> {
    let kind = match ext {
        // images (browser-renderable)
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "avif" | "svg" => FileKind::Image,
        // images the browser cannot render -> still images, preview layer decides
        "tif" | "tiff" | "heic" | "heif" | "psd" | "dng" | "cr2" | "nef" => FileKind::Image,
        // audio
        "mp3" | "wav" | "ogg" | "oga" | "opus" | "m4a" | "aac" | "flac" | "weba" => FileKind::Audio,
        // video
        "mp4" | "m4v" | "webm" | "ogv" | "mov" | "mkv" | "avi" => FileKind::Video,
        "pdf" => FileKind::Pdf,
        "md" | "markdown" | "mdx" => FileKind::Markdown,
        "json" | "jsonl" | "ndjson" | "geojson" | "json5" | "ipynb" => FileKind::Json,
        "csv" | "tsv" => FileKind::Csv,
        // Columnar data gets a real table preview.
        "parquet" | "pq" | "orc" => FileKind::Parquet,
        "zip" | "tar" | "gz" | "tgz" | "bz2" | "xz" | "7z" | "rar" | "zst" => FileKind::Archive,
        "txt" | "log" | "text" | "rst" | "ini" | "cfg" | "conf" | "env" | "properties" | "srt"
        | "vtt" | "diff" | "patch" => FileKind::Text,
        "py" | "pyi" | "ipynb.txt" | "js" | "mjs" | "cjs" | "ts" | "tsx" | "jsx" | "rs" | "go"
        | "java" | "kt" | "kts" | "c" | "h" | "cc" | "cpp" | "hpp" | "cs" | "rb" | "php"
        | "swift" | "scala" | "sh" | "bash" | "zsh" | "fish" | "ps1" | "bat" | "sql" | "yaml"
        | "yml" | "toml" | "xml" | "html" | "htm" | "css" | "scss" | "less" | "lua" | "pl"
        | "r" | "jl" | "clj" | "ex" | "exs" | "erl" | "hs" | "ml" | "nim" | "zig" | "dart"
        | "vue" | "svelte" | "dockerfile" | "gradle" | "proto" | "tf" | "hcl" | "cmake"
        | "make" | "mk" => FileKind::Code,
        // Notebooks and common "data" text formats
        _ => return None,
    };
    Some(kind)
}

fn kind_from_mime(ct: &str) -> Option<FileKind> {
    let ct = ct
        .split(';')
        .next()
        .unwrap_or(ct)
        .trim()
        .to_ascii_lowercase();
    if ct.starts_with("image/") {
        return Some(FileKind::Image);
    }
    if ct.starts_with("audio/") {
        return Some(FileKind::Audio);
    }
    if ct.starts_with("video/") {
        return Some(FileKind::Video);
    }
    if ct == "application/pdf" {
        return Some(FileKind::Pdf);
    }
    if ct.contains("markdown") {
        return Some(FileKind::Markdown);
    }
    if ct.contains("json") {
        return Some(FileKind::Json);
    }
    if ct == "text/csv" {
        return Some(FileKind::Csv);
    }
    if ct.starts_with("text/") {
        return Some(FileKind::Text);
    }
    None
}

/// Whether the first bytes look like UTF-8 text.
///
/// The bar is deliberately low, because the alternative is telling the user
/// "binary" about a file they can plainly read. What it rejects is what actually
/// characterises a binary: a NUL byte, or a large share of control characters.
pub fn looks_like_text(head: Option<&[u8]>) -> bool {
    let Some(bytes) = head else { return false };
    if bytes.is_empty() {
        return true;
    }
    // Only the sniffed head is examined; a long run of text is already convincing.
    let sample = &bytes[..bytes.len().min(4096)];
    if sample.contains(&0) {
        return false;
    }
    if std::str::from_utf8(sample).is_err() {
        // A multi-byte character may be cut at the boundary; tolerate that one case.
        let boundary = sample.len().saturating_sub(3);
        if std::str::from_utf8(&sample[..boundary]).is_err() {
            return false;
        }
    }
    let control = sample
        .iter()
        .filter(|b| (**b < 0x20 && **b != b'\n' && **b != b'\r' && **b != b'\t') || **b == 0x7f)
        .count();
    control * 20 < sample.len()
}

/// Magic-byte sniffing, used when the key has no useful extension.
pub fn kind_from_magic(head: Option<&[u8]>) -> Option<FileKind> {
    let head = head?;
    let has = |sig: &[u8]| head.len() >= sig.len() && &head[..sig.len()] == sig;
    if has(&[0x89, b'P', b'N', b'G']) {
        return Some(FileKind::Image);
    }
    if has(&[0xFF, 0xD8, 0xFF]) {
        return Some(FileKind::Image);
    }
    if has(b"GIF8") {
        return Some(FileKind::Image);
    }
    if has(b"BM") {
        return Some(FileKind::Image);
    }
    if has(b"ID3") || has(&[0xFF, 0xFB]) || has(&[0xFF, 0xF3]) {
        return Some(FileKind::Audio);
    }
    if has(b"OggS") {
        return Some(FileKind::Audio);
    }
    if has(b"RIFF") && head.len() >= 12 {
        return match &head[8..12] {
            b"WAVE" => Some(FileKind::Audio),
            b"AVI " => Some(FileKind::Video),
            b"WEBP" => Some(FileKind::Image),
            _ => None,
        };
    }
    if has(b"%PDF") {
        return Some(FileKind::Pdf);
    }
    if has(b"PK\x03\x04") {
        return Some(FileKind::Archive);
    }
    if head.len() >= 4 && &head[..4] == b"PAR1" {
        return Some(FileKind::Parquet);
    }
    if head.len() >= 12 && &head[4..8] == b"ftyp" {
        return Some(FileKind::Video);
    }
    if has(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return Some(FileKind::Video);
    }
    if has(b"{\"") || has(b"[\n") || has(b"[]") {
        return Some(FileKind::Json);
    }
    None
}

/// Content-Type for uploads, from the local file name.
pub fn guess_content_type(path: &Path) -> Option<String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())?;
    let ct = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "jsonl" | "ndjson" => "application/x-ndjson",
        "csv" => "text/csv",
        "md" | "markdown" => "text/markdown",
        "txt" | "log" => "text/plain",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "xml" => "application/xml",
        "yaml" | "yml" => "application/yaml",
        "zip" => "application/zip",
        "gz" | "tgz" => "application/gzip",
        "tar" => "application/x-tar",
        "parquet" => "application/vnd.apache.parquet",
        _ => return None,
    };
    Some(ct.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_kind_wins() {
        assert_eq!(detect_kind("a/b/", None, None), FileKind::Folder);
    }

    #[test]
    fn extension_classification() {
        assert_eq!(detect_kind("x/y.png", None, None), FileKind::Image);
        assert_eq!(detect_kind("x/y.JPEG", None, None), FileKind::Image);
        assert_eq!(detect_kind("a.mp3", None, None), FileKind::Audio);
        assert_eq!(detect_kind("a.MP4", None, None), FileKind::Video);
        assert_eq!(detect_kind("a.pdf", None, None), FileKind::Pdf);
        assert_eq!(detect_kind("README.md", None, None), FileKind::Markdown);
        assert_eq!(detect_kind("data.jsonl", None, None), FileKind::Json);
        assert_eq!(detect_kind("t.csv", None, None), FileKind::Csv);
        assert_eq!(detect_kind("main.py", None, None), FileKind::Code);
        assert_eq!(detect_kind("config.yaml", None, None), FileKind::Code);
        assert_eq!(detect_kind("notes.txt", None, None), FileKind::Text);
        assert_eq!(detect_kind("bundle.tar.gz", None, None), FileKind::Archive);
        assert_eq!(detect_kind("data.parquet", None, None), FileKind::Parquet);
        assert_eq!(detect_kind("data.PQ", None, None), FileKind::Parquet);
    }

    #[test]
    fn unknown_then_binary() {
        assert_eq!(detect_kind("LICENSE", None, None), FileKind::Unknown);
        assert_eq!(detect_kind("blob.bin", None, None), FileKind::Binary);
    }

    #[test]
    fn magic_bytes_rescue_extensionless_files() {
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A];
        assert_eq!(detect_kind("noext", None, Some(&png)), FileKind::Image);
        assert_eq!(detect_kind("noext", None, Some(b"%PDF-1.7")), FileKind::Pdf);
        assert_eq!(
            detect_kind("noext", None, Some(b"OggS\0\0")),
            FileKind::Audio
        );
    }

    #[test]
    fn mime_fallback_used_when_extension_is_useless() {
        assert_eq!(
            detect_kind("picture.unknownext", Some("image/png"), None),
            FileKind::Binary,
            "an unknown extension is trusted before a generic mime hint"
        );
        assert_eq!(
            detect_kind("data", Some("image/png"), None),
            FileKind::Image
        );
    }

    #[test]
    fn content_type_guess() {
        assert_eq!(
            guess_content_type(Path::new("/tmp/a.png")).as_deref(),
            Some("image/png")
        );
        assert_eq!(
            guess_content_type(Path::new("/tmp/a.MD")).as_deref(),
            Some("text/markdown")
        );
        assert_eq!(guess_content_type(Path::new("/tmp/README")), None);
    }
    #[test]
    fn extensionless_text_is_text() {
        assert_eq!(
            detect_kind(
                "keys/id_ed25519",
                Some("application/octet-stream"),
                Some(b"-----BEGIN OPENSSH PRIVATE KEY-----\n")
            ),
            FileKind::Text
        );
    }

    #[test]
    fn unknown_extension_with_text_content_is_text() {
        // An SSH public key: a binary-looking extension, plain text inside.
        assert_eq!(
            detect_kind(
                "keys/deploy.pub",
                None,
                Some(b"ssh-ed25519 AAAAC3Nza user@host\n")
            ),
            FileKind::Text
        );
        assert_eq!(
            detect_kind("notes.weird", None, Some(b"line one\nline two\n")),
            FileKind::Text
        );
    }

    #[test]
    fn binaries_stay_binary() {
        assert_eq!(
            detect_kind("blob.bin", None, Some(&[0x00, 0x01, 0x02, 0x00, 0x03])),
            FileKind::Binary
        );
        // A PNG is an image by magic, not text by content.
        assert_eq!(
            detect_kind("picture", None, Some(&[0x89, b'P', b'N', b'G', 0x0d])),
            FileKind::Image
        );
    }

    #[test]
    fn known_extensions_win_over_sniffing() {
        assert_eq!(
            detect_kind("a.json", None, Some(b"{\"a\":1}")),
            FileKind::Json
        );
        assert_eq!(detect_kind("a.py", None, Some(b"print(1)")), FileKind::Code);
    }

    #[test]
    fn utf8_text_is_recognised() {
        assert_eq!(
            detect_kind("pismo", None, Some("привет мир".as_bytes())),
            FileKind::Text
        );
    }
}
