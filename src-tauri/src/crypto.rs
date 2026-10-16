//! Local secret protection.
//!
//! Design goals (this is the "serious about cyber-security" part):
//!  * Secret access keys are **never** written to disk in cleartext.
//!  * Each secret is sealed with XChaCha20-Poly1305 using a random 32-byte
//!    master key.
//!  * The master key lives in the OS keychain (macOS Keychain / Linux Secret
//!    Service). If no keychain is reachable the key falls back to a `0600`
//!    file inside the app config dir, and the app surfaces that degradation in
//!    Settings instead of silently pretending to be secure.
//!  * The app never logs secrets. `redact()` exists so diagnostics can be
//!    shared safely.
//!  * `S3VIEWER_TEST_MASTER_KEY` allows deterministic tests; it is only read
//!    when set, and setting it is what makes the fallback explicit.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit, OsRng};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::RngCore;
use std::path::{Path, PathBuf};

const KEYCHAIN_SERVICE: &str = "dev.s3viewer.app";
const KEYCHAIN_USER: &str = "master-key-v1";
pub const ENV_TEST_KEY: &str = "S3VIEWER_TEST_MASTER_KEY";
pub const CIPHER_PREFIX: &str = "enc:v1:";

pub struct Cipher {
    key: [u8; 32],
    /// true when the master key came from the OS keychain.
    pub in_keychain: bool,
}

impl Cipher {
    /// Load the master key, creating it on first run.
    pub fn load(config_dir: &Path) -> Self {
        if let Ok(hex) = std::env::var(ENV_TEST_KEY) {
            if let Some(key) = parse_key_hex(&hex) {
                return Cipher {
                    key,
                    in_keychain: false,
                };
            }
        }

        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER);
        if let Ok(entry) = entry {
            match entry.get_password() {
                Ok(stored) => {
                    if let Some(key) = parse_key_text(&stored) {
                        return Cipher {
                            key,
                            in_keychain: true,
                        };
                    }
                }
                Err(keyring::Error::NoEntry) => {
                    let key = random_key();
                    if entry.set_password(&B64.encode(key)).is_ok() {
                        return Cipher {
                            key,
                            in_keychain: true,
                        };
                    }
                }
                Err(_) => {}
            }
        }

        // Fallback: key file with 0600 permissions.
        let path = config_dir.join("master.key");
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Some(key) = parse_key_text(text.trim()) {
                return Cipher {
                    key,
                    in_keychain: false,
                };
            }
        }
        let key = random_key();
        let _ = std::fs::create_dir_all(config_dir);
        let _ = std::fs::write(&path, B64.encode(key));
        restrict_permissions(&path);
        Cipher {
            key,
            in_keychain: false,
        }
    }

    pub fn seal(&self, plaintext: &str) -> Result<String, String> {
        let cipher = XChaCha20Poly1305::new((&self.key).into());
        let mut nonce = [0u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let ct = cipher
            .encrypt(XNonce::from_slice(&nonce), plaintext.as_bytes())
            .map_err(|_| "encryption failed".to_string())?;
        let mut blob = Vec::with_capacity(24 + ct.len());
        blob.extend_from_slice(&nonce);
        blob.extend_from_slice(&ct);
        Ok(format!("{CIPHER_PREFIX}{}", B64.encode(blob)))
    }

    pub fn open(&self, sealed: &str) -> Result<String, String> {
        let body = sealed
            .strip_prefix(CIPHER_PREFIX)
            .ok_or_else(|| "value is not sealed".to_string())?;
        let blob = B64
            .decode(body)
            .map_err(|_| "corrupt ciphertext".to_string())?;
        if blob.len() < 25 {
            return Err("corrupt ciphertext".to_string());
        }
        let (nonce, ct) = blob.split_at(24);
        let cipher = XChaCha20Poly1305::new((&self.key).into());
        let pt = cipher
            .decrypt(XNonce::from_slice(nonce), ct)
            .map_err(|_| "decryption failed (master key changed?)".to_string())?;
        String::from_utf8(pt).map_err(|_| "secret is not valid UTF-8".to_string())
    }
}

fn random_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    key
}

fn parse_key_hex(hex: &str) -> Option<[u8; 32]> {
    let bytes = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
        .collect::<Option<Vec<u8>>>()?;
    bytes.try_into().ok()
}

/// Accepts base64 (keychain / key file) or 64-char hex.
fn parse_key_text(text: &str) -> Option<[u8; 32]> {
    if let Ok(bytes) = B64.decode(text) {
        if let Ok(key) = <[u8; 32]>::try_from(bytes.as_slice()) {
            return Some(key);
        }
    }
    parse_key_hex(text)
}

#[cfg(unix)]
pub fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
pub fn restrict_permissions(_path: &Path) {}

#[cfg(unix)]
pub fn restrict_dir_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
}

#[cfg(not(unix))]
pub fn restrict_dir_permissions(_path: &Path) {}

/// Keep only the first 4 characters of an access key id for diagnostics.
pub fn redact(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    let visible: String = value.chars().take(4).collect();
    format!("{visible}…({} chars)", value.chars().count())
}

pub fn config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("S3VIEWER_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    let base = dirs_config_dir();
    base.join("dev.s3viewer.app")
}

fn dirs_config_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join("Library/Application Support");
        }
    }
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(xdg);
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join(".config");
    }
    PathBuf::from(".")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_cipher() -> Cipher {
        Cipher {
            key: random_key(),
            in_keychain: false,
        }
    }

    #[test]
    fn seal_roundtrip() {
        let c = test_cipher();
        let sealed = c.seal("super-secret").unwrap();
        assert!(sealed.starts_with(CIPHER_PREFIX));
        assert!(!sealed.contains("super-secret"));
        assert_eq!(c.open(&sealed).unwrap(), "super-secret");
    }

    #[test]
    fn decrypt_with_wrong_key_fails() {
        let sealed = test_cipher().seal("x").unwrap();
        assert!(test_cipher().open(&sealed).is_err());
    }

    #[test]
    fn plaintext_is_rejected() {
        assert!(test_cipher().open("plain").is_err());
    }

    #[test]
    fn redact_hides_secret() {
        let r = redact("AKIAIOSFODNN7EXAMPLE");
        assert!(r.starts_with("AKIA"));
        assert!(!r.contains("ZQLI"));
    }

    #[test]
    fn parse_key_accepts_both_encodings() {
        let key = random_key();
        assert_eq!(parse_key_text(&B64.encode(key)).unwrap(), key);
        let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(parse_key_text(&hex).unwrap(), key);
    }
}
