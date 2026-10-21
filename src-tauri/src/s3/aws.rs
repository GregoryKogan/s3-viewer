//! SigV4 object store, backed by the AWS SDK for Rust (`aws-sdk-s3`).
//!
//! The SDK is configured exactly the way boto3 is in the Python code this app
//! mirrors: static credentials, `Region`, `endpoint_url` and
//! `Config(s3={"addressing_style": ...})`. Payload signing (`x-amz-content-sha256`)
//! is left to the SDK's SigV4 signer.

use super::{
    guess_content_type, kind::detect_kind, ByteRange, ObjectMeta, ObjectStore, ObjectStream, Page,
};
use crate::error::{AppError, AppResult};
use crate::model::{
    AddressingStyle, ChecksumCalculation, ChecksumValidation, Connection, ObjectEntry, StaticCreds,
};
use aws_credential_types::Credentials;
use aws_sdk_s3::config::Region;
use aws_sdk_s3::error::ProvideErrorMetadata;
use aws_sdk_s3::operation::RequestId;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{Delete, ObjectIdentifier};
use aws_sdk_s3::Client;
use std::path::Path;

/// The HTTP client every S3 connection shares in character.
///
/// Idle keep-alive sockets are dropped quickly on purpose. Some S3-compatible
/// endpoints close idle connections without telling the client, and reusing such
/// a socket turns the next request into a silent stall until the OS gives up —
/// which is exactly what a listing that emits nothing for twenty seconds looks
/// like. A short idle timeout costs one TLS handshake and removes the failure.
fn http_client() -> aws_smithy_runtime_api::client::http::SharedHttpClient {
    aws_smithy_http_client::Builder::new()
        .pool_idle_timeout(std::time::Duration::from_secs(5))
        .pool_max_idle_per_host(2)
        .tls_provider(aws_smithy_http_client::tls::Provider::Rustls(
            aws_smithy_http_client::tls::rustls_provider::CryptoMode::AwsLc,
        ))
        .build_https()
}

pub struct AwsStore {
    client: Client,
    bucket: String,
}

impl AwsStore {
    pub fn new(conn: &Connection, creds: &StaticCreds) -> Self {
        let credentials = Credentials::new(
            creds.access_key_id.clone(),
            creds.secret_access_key.clone(),
            creds.session_token.clone(),
            None,
            "s3viewer-local",
        );
        let force_path_style = match conn.addressing_style {
            AddressingStyle::Path => true,
            AddressingStyle::Virtual => false,
            // `auto` mirrors boto3: path style for non-standard endpoints unless
            // the bucket name is DNS-compatible.
            AddressingStyle::Auto => !is_dns_compatible(&conn.bucket),
        };
        let cfg = aws_sdk_s3::Config::builder()
            .behavior_version(aws_config::BehaviorVersion::latest())
            .http_client(http_client())
            // boto3's defaults, which this client aims to reproduce: three
            // attempts, and a read that gives up instead of hanging a worker
            // forever when a socket goes quiet.
            .timeout_config(
                aws_smithy_types::timeout::TimeoutConfig::builder()
                    .connect_timeout(std::time::Duration::from_secs(10))
                    .read_timeout(std::time::Duration::from_secs(30))
                    .build(),
            )
            .retry_config(aws_sdk_s3::config::retry::RetryConfig::standard().with_max_attempts(3))
            .credentials_provider(credentials)
            .region(Region::new(conn.region.clone()))
            .endpoint_url(conn.endpoint_url.clone())
            .force_path_style(force_path_style)
            // Mirror botocore's two checksum switches. They are the difference
            // between working and not working against some S3-compatible
            // deployments, so they must be settable per connection.
            .request_checksum_calculation(match conn.request_checksum_calculation {
                ChecksumCalculation::WhenSupported => {
                    aws_sdk_s3::config::RequestChecksumCalculation::WhenSupported
                }
                ChecksumCalculation::WhenRequired => {
                    aws_sdk_s3::config::RequestChecksumCalculation::WhenRequired
                }
            })
            .response_checksum_validation(match conn.response_checksum_validation {
                ChecksumValidation::WhenSupported => {
                    aws_sdk_s3::config::ResponseChecksumValidation::WhenSupported
                }
                ChecksumValidation::WhenRequired => {
                    aws_sdk_s3::config::ResponseChecksumValidation::WhenRequired
                }
            })
            .build();
        AwsStore {
            client: Client::from_conf(cfg),
            bucket: conn.bucket.clone(),
        }
    }

    /// The raw error mapper: keeps the S3 error code, message, request id and
    /// HTTP status so the UI can explain what went wrong.
    /// Keeps the S3 error code, message and request id so the UI can explain
    /// what went wrong. Transport-level failures carry no code, so the
    /// `Display` form is used as the message instead.
    pub fn map_err<E>(err: E) -> AppError
    where
        E: ProvideErrorMetadata + std::fmt::Display + std::fmt::Debug + Send + Sync + 'static,
    {
        let code = err.code().unwrap_or("UnknownError").to_string();
        let message = err
            .message()
            .map(|m| m.to_string())
            .unwrap_or_else(|| err.to_string());
        let request_id = err.meta().request_id().map(|s| s.to_string());
        AppError::S3 {
            code,
            message,
            request_id,
            status: None,
        }
    }

    async fn list_raw(
        &self,
        prefix: &str,
        delimiter: Option<&str>,
        token: Option<&str>,
        max_keys: i32,
    ) -> AppResult<Page> {
        let mut req = self
            .client
            .list_objects_v2()
            .bucket(&self.bucket)
            .prefix(prefix)
            .max_keys(max_keys);
        if let Some(d) = delimiter {
            req = req.delimiter(d);
        }
        if let Some(t) = token {
            req = req.continuation_token(t);
        }
        let out = req.send().await.map_err(Self::map_err)?;

        let mut entries = Vec::new();
        for cp in out.common_prefixes() {
            if let Some(p) = cp.prefix() {
                entries.push(folder_entry(p));
            }
        }
        for obj in out.contents() {
            let Some(key) = obj.key() else { continue };
            let name = display_name(key, prefix);
            let is_folder = key.ends_with('/');
            entries.push(ObjectEntry {
                key: key.to_string(),
                name,
                is_folder,
                size: obj.size().unwrap_or(0),
                last_modified: obj.last_modified().map(|t| t.to_string()),
                etag: obj.e_tag().map(|e| e.trim_matches('"').to_string()),
                storage_class: obj.storage_class().map(|s| s.as_str().to_string()),
                kind: if is_folder {
                    crate::model::FileKind::Folder
                } else {
                    detect_kind(key, None, None)
                },
            });
        }
        Ok(Page {
            entries,
            next_token: out.next_continuation_token().map(|s| s.to_string()),
            is_truncated: out.is_truncated().unwrap_or(false),
        })
    }
}

pub fn folder_entry(prefix: &str) -> ObjectEntry {
    ObjectEntry {
        key: prefix.to_string(),
        name: display_name(prefix, ""),
        is_folder: true,
        size: 0,
        last_modified: None,
        etag: None,
        storage_class: None,
        kind: crate::model::FileKind::Folder,
    }
}

/// Display name of a key relative to the listed prefix.
pub fn display_name(key: &str, prefix: &str) -> String {
    let rest = key.strip_prefix(prefix).unwrap_or(key);
    let trimmed = rest.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some((_, name)) => name.to_string(),
        None => trimmed.to_string(),
    }
}

fn is_dns_compatible(bucket: &str) -> bool {
    // Mirrors boto3's `is_dns_compatible` heuristic.
    (3..=63).contains(&bucket.len())
        && bucket
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
        && !bucket.starts_with('-')
        && !bucket.ends_with('-')
        && !bucket.contains("..")
}

fn etag_clean(etag: Option<&str>) -> Option<String> {
    etag.map(|e| e.trim_matches('"').to_string())
}

impl ObjectStore for AwsStore {
    fn bucket(&self) -> &str {
        &self.bucket
    }

    async fn list_page(
        &self,
        prefix: &str,
        delimiter: Option<&str>,
        token: Option<&str>,
        max_keys: i32,
    ) -> AppResult<Page> {
        self.list_raw(prefix, delimiter, token, max_keys).await
    }

    async fn stat(&self, key: &str) -> AppResult<ObjectMeta> {
        let out = self
            .client
            .head_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .map_err(Self::map_err)?;
        Ok(ObjectMeta {
            key: key.to_string(),
            size: out.content_length(),
            content_type: out.content_type().map(|s| s.to_string()),
            etag: etag_clean(out.e_tag()),
            last_modified: out.last_modified().map(|t| t.to_string()),
            storage_class: out.storage_class().map(|s| s.as_str().to_string()),
        })
    }

    async fn get_bytes(&self, key: &str, range: Option<ByteRange>) -> AppResult<ObjectStream> {
        let mut req = self.client.get_object().bucket(&self.bucket).key(key);
        if let Some(r) = range {
            req = req.range(r.header());
        }
        let out = req.send().await.map_err(Self::map_err)?;
        let content_range = out.content_range().map(|s| s.to_string());
        let total_length = content_range
            .as_deref()
            .and_then(parse_total_from_content_range);
        let content_length = out.content_length();
        let content_type = out.content_type().map(|s| s.to_string());
        let etag = etag_clean(out.e_tag());
        let last_modified = out.last_modified().map(|t| t.to_string());
        let body = out
            .body
            .collect()
            .await
            .map_err(|e| AppError::msg(format!("read body: {e}")))?
            .into_bytes()
            .to_vec();
        Ok(ObjectStream {
            content_length,
            total_length,
            content_type,
            etag,
            last_modified,
            content_range,
            body,
        })
    }

    async fn get_to(
        &self,
        key: &str,
        sink: &mut (dyn tokio::io::AsyncWrite + Unpin + Send),
    ) -> AppResult<u64> {
        let out = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .map_err(Self::map_err)?;
        let mut reader = out.body.into_async_read();
        let written = tokio::io::copy(&mut reader, sink)
            .await
            .map_err(|e| AppError::msg(format!("stream object: {e}")))?;
        Ok(written)
    }

    async fn put_bytes(
        &self,
        key: &str,
        body: Vec<u8>,
        content_type: Option<&str>,
    ) -> AppResult<()> {
        let mut req = self
            .client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .body(ByteStream::from(body));
        if let Some(ct) = content_type {
            req = req.content_type(ct);
        }
        req.send().await.map_err(Self::map_err)?;
        Ok(())
    }

    async fn put_file(&self, key: &str, path: &Path) -> AppResult<()> {
        let body = ByteStream::read_from()
            .path(path)
            .build()
            .await
            .map_err(|e| AppError::msg(format!("open {}: {e}", path.display())))?;
        let mut req = self
            .client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .body(body);
        let ct = guess_content_type(path);
        if let Some(ct) = ct {
            req = req.content_type(ct);
        }
        req.send().await.map_err(Self::map_err)?;
        Ok(())
    }

    async fn delete_object(&self, key: &str) -> AppResult<()> {
        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .map_err(Self::map_err)?;
        Ok(())
    }

    async fn copy_object(&self, source_key: &str, dest_key: &str) -> AppResult<()> {
        let copy_source = format!("{}/{}", self.bucket, source_key);
        self.client
            .copy_object()
            .bucket(&self.bucket)
            .key(dest_key)
            .copy_source(copy_source)
            .send()
            .await
            .map_err(Self::map_err)?;
        Ok(())
    }

    async fn delete_many(&self, keys: &[String]) -> AppResult<()> {
        // DeleteObjects caps at 1000 per request.
        for chunk in keys.chunks(1000) {
            let mut builder = Delete::builder();
            for key in chunk {
                builder = builder.objects(
                    ObjectIdentifier::builder()
                        .key(key)
                        .build()
                        .map_err(|e| AppError::msg(format!("build identifier: {e}")))?,
                );
            }
            let delete = builder
                .build()
                .map_err(|e| AppError::msg(format!("build delete request: {e}")))?;
            let out = self
                .client
                .delete_objects()
                .bucket(&self.bucket)
                .delete(delete)
                .send()
                .await
                .map_err(Self::map_err)?;
            if let Some(first) = out.errors().first() {
                {
                    return Err(AppError::S3 {
                        code: first.code().unwrap_or("UnknownError").to_string(),
                        message: format!(
                            "{} (key: {})",
                            first.message().unwrap_or("delete failed"),
                            first.key().unwrap_or("?")
                        ),
                        request_id: None,
                        status: None,
                    });
                }
            }
        }
        Ok(())
    }
}

/// `bytes 100-200/12345` -> `12345`
fn parse_total_from_content_range(value: &str) -> Option<i64> {
    let after_slash = value.rsplit('/').next()?;
    after_slash.trim().parse::<i64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_range_total_is_parsed() {
        assert_eq!(
            parse_total_from_content_range("bytes 0-1023/4096"),
            Some(4096)
        );
        assert_eq!(parse_total_from_content_range("bytes 0-1/*"), None);
    }

    #[test]
    fn display_name_strips_prefix_and_trailing_slash() {
        assert_eq!(display_name("a/b/c.png", "a/b/"), "c.png");
        assert_eq!(display_name("a/b/", "a/"), "b");
        assert_eq!(display_name("top.txt", ""), "top.txt");
    }

    #[test]
    fn dns_compatibility_matches_boto3_heuristics() {
        assert!(is_dns_compatible("my-bucket"));
        assert!(is_dns_compatible("my.bucket.name"));
        assert!(!is_dns_compatible("My-Bucket"));
        assert!(!is_dns_compatible("ab"));
        assert!(!is_dns_compatible("-bucket"));
        assert!(!is_dns_compatible("bucket-"));
        assert!(!is_dns_compatible("a..b"));
    }

    #[test]
    fn etag_quotes_are_removed() {
        assert_eq!(etag_clean(Some("\"abc\"")).as_deref(), Some("abc"));
        assert_eq!(etag_clean(None), None);
    }
}
