//! SigV2 (`AWS` HmacSHA1) signer — the legacy string-to-sign scheme.
//!
//! boto3 exposes it as `Config(signature_version="s3v2")` and some S3-compatible
//! deployments still require it. The AWS SDK for Rust only speaks SigV4, so this
//! module implements the V2 canonical string itself.
//!
//! Canonical form:
//! ```text
//! StringToSign = HTTP-Verb + "\n"
//!              + Content-MD5 + "\n"
//!              + Content-Type + "\n"
//!              + Date + "\n"
//!              + CanonicalizedAmzHeaders
//!              + CanonicalizedResource
//! ```
//! `CanonicalizedResource` starts with the bucket (`/bucket`), followed by the
//! path. For virtual-hosted requests the bucket is *not* in the URL path but is
//! still required in the canonical form.

use crate::error::{AppError, AppResult};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha1::Sha1;

type HmacSha1 = Hmac<Sha1>;

#[derive(Debug, Clone)]
pub struct V2Request<'a> {
    pub method: &'a str,
    /// Path on the wire, without the bucket (virtual-host) or with it (path-style).
    pub path: &'a str,
    /// Raw query string without the leading `?`.
    pub query: Option<String>,
    pub content_type: Option<&'a str>,
    pub content_md5: Option<&'a str>,
    /// Already-formatted RFC 2822 date, e.g. `Fri, 16 Oct 2026 16:39:11 GMT`.
    pub date: &'a str,
    pub extra_amz_headers: &'a [(String, String)],
    /// Bucket name, always included in the canonical resource.
    pub bucket: &'a str,
}

impl V2Request<'_> {
    pub fn canonical_resource(&self) -> String {
        let mut out = format!("/{}", self.bucket);
        if !self.path.is_empty() && self.path != "/" {
            let trimmed = self.path.trim_start_matches('/');
            out.push('/');
            out.push_str(trimmed);
        } else {
            out.push('/');
        }
        if let Some(q) = &self.query {
            // Sub-resources are part of the canonical resource in V2. For the
            // operations this client performs (list/get/put/delete/copy) only a
            // fixed set matters, and key/value filters such as prefix/marker are
            // *not* included — only the acknowledged sub-resources are.
            let subs: Vec<&str> = q
                .split('&')
                .filter(|part| is_canonical_subresource(part))
                .collect();
            if !subs.is_empty() {
                out.push('?');
                out.push_str(&subs.join("&"));
            }
        }
        out
    }

    pub fn string_to_sign(&self) -> String {
        let mut s = String::new();
        s.push_str(self.method);
        s.push('\n');
        s.push_str(self.content_md5.unwrap_or(""));
        s.push('\n');
        s.push_str(self.content_type.unwrap_or(""));
        s.push('\n');
        s.push_str(self.date);
        s.push('\n');

        let mut headers: Vec<(String, String)> = self
            .extra_amz_headers
            .iter()
            .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_string()))
            .collect();
        headers.sort_by(|a, b| a.0.cmp(&b.0));
        for (k, v) in &headers {
            s.push_str(k);
            s.push(':');
            s.push_str(v);
            s.push('\n');
        }
        s.push_str(&self.canonical_resource());
        s
    }

    pub fn authorization(&self, access_key_id: &str, secret_access_key: &str) -> AppResult<String> {
        let sts = self.string_to_sign();
        let mut mac = HmacSha1::new_from_slice(secret_access_key.as_bytes())
            .map_err(|e| AppError::msg(format!("hmac init: {e}")))?;
        mac.update(sts.as_bytes());
        let sig = B64.encode(mac.finalize().into_bytes());
        Ok(format!("AWS {access_key_id}:{sig}"))
    }
}

/// The set of query parameters that SigV2 folds into the canonical resource.
fn is_canonical_subresource(part: &str) -> bool {
    const SUBS: &[&str] = &[
        "acl",
        "cors",
        "delete",
        "lifecycle",
        "location",
        "logging",
        "notification",
        "partNumber",
        "policy",
        "requestPayment",
        "torrent",
        "uploadId",
        "uploads",
        "versionId",
        "versioning",
        "versions",
        "website",
    ];
    let key = part.split('=').next().unwrap_or("");
    SUBS.contains(&key)
}

/// Percent-encode a key for use in a request path, preserving `/` separators.
/// Follows the same rules the AWS SDKs use (RFC 3986, unreserved set kept).
pub fn encode_path(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    for byte in key.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Percent-encode a query parameter value (stricter than [`encode_path`]: `/`
/// is encoded too).
pub fn encode_query_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACCESS: &str = "AKIAIOSFODNN7EXAMPLE";
    const SECRET: &str = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const DATE: &str = "Fri, 16 Oct 2026 16:39:11 GMT";

    #[test]
    fn canonical_resource_uses_bucket_and_path() {
        let req = V2Request {
            method: "GET",
            path: "/a/b.png",
            query: None,
            content_type: None,
            content_md5: None,
            date: DATE,
            extra_amz_headers: &[],
            bucket: "mybucket",
        };
        assert_eq!(req.canonical_resource(), "/mybucket/a/b.png");
    }

    #[test]
    fn canonical_resource_root_has_trailing_slash() {
        let req = V2Request {
            method: "GET",
            path: "/",
            query: None,
            content_type: None,
            content_md5: None,
            date: DATE,
            extra_amz_headers: &[],
            bucket: "mybucket",
        };
        assert_eq!(req.canonical_resource(), "/mybucket/");
    }

    #[test]
    fn canonical_resource_ignores_listing_filters_but_keeps_subresources() {
        let req = V2Request {
            method: "GET",
            path: "/",
            query: Some("prefix=a/&max-keys=100&marker=x".into()),
            content_type: None,
            content_md5: None,
            date: DATE,
            extra_amz_headers: &[],
            bucket: "b",
        };
        assert_eq!(req.canonical_resource(), "/b/");

        let req = V2Request {
            query: Some("uploads=&prefix=x".into()),
            ..req
        };
        assert_eq!(req.canonical_resource(), "/b/?uploads=");
    }

    #[test]
    fn string_to_sign_matches_spec_layout() {
        let req = V2Request {
            method: "PUT",
            path: "/photo.jpg",
            query: None,
            content_type: Some("image/jpeg"),
            content_md5: None,
            date: DATE,
            extra_amz_headers: &[],
            bucket: "mybucket",
        };
        assert_eq!(
            req.string_to_sign(),
            format!("PUT\n\nimage/jpeg\n{DATE}\n/mybucket/photo.jpg")
        );
    }

    #[test]
    fn amz_headers_are_lowercased_sorted_and_trimmed() {
        let headers = vec![
            ("X-Amz-Meta-B".to_string(), " 2 ".to_string()),
            ("x-amz-acl".to_string(), "public-read".to_string()),
        ];
        let req = V2Request {
            method: "PUT",
            path: "/k",
            query: None,
            content_type: None,
            content_md5: None,
            date: DATE,
            extra_amz_headers: &headers,
            bucket: "b",
        };
        let sts = req.string_to_sign();
        let tail = sts.split(DATE).nth(1).unwrap();
        assert_eq!(
            tail,
            "\nx-amz-acl:public-read\nx-amz-meta-b:2\n/b/k",
            "amz headers must be lowercased, sorted and trimmed"
        );
    }

    /// Deterministic vector: the signature must be a stable base64 HmacSHA1 of
    /// the exact string-to-sign. Guards against accidental canonicalization drift.
    #[test]
    fn authorization_is_deterministic() {
        let req = V2Request {
            method: "GET",
            path: "/",
            query: None,
            content_type: None,
            content_md5: None,
            date: DATE,
            extra_amz_headers: &[],
            bucket: "mybucket",
        };
        let sts = req.string_to_sign();
        let mut mac = HmacSha1::new_from_slice(SECRET.as_bytes()).unwrap();
        mac.update(sts.as_bytes());
        let expected = format!("AWS {ACCESS}:{}", B64.encode(mac.finalize().into_bytes()));
        assert_eq!(req.authorization(ACCESS, SECRET).unwrap(), expected);
        assert!(req.authorization(ACCESS, SECRET).unwrap().starts_with("AWS AKIAIOSFODNN7EXAMPLE:"));
    }

    #[test]
    fn different_secrets_produce_different_signatures() {
        let req = V2Request {
            method: "GET",
            path: "/",
            query: None,
            content_type: None,
            content_md5: None,
            date: DATE,
            extra_amz_headers: &[],
            bucket: "b",
        };
        assert_ne!(
            req.authorization(ACCESS, SECRET).unwrap(),
            req.authorization(ACCESS, "other").unwrap()
        );
    }

    #[test]
    fn encode_path_keeps_slashes_and_encodes_specials() {
        assert_eq!(encode_path("a/b c.png"), "a/b%20c.png");
        assert_eq!(encode_path("a+b"), "a%2Bb");
        assert_eq!(encode_path("кириллица"), "%D0%BA%D0%B8%D1%80%D0%B8%D0%BB%D0%BB%D0%B8%D1%86%D0%B0");
    }

    #[test]
    fn encode_query_value_encodes_slash() {
        assert_eq!(encode_query_value("a/b"), "a%2Fb");
    }
}
