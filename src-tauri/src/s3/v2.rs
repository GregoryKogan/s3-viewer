//! SigV2 (`s3v2`) object store — a focused HTTP client for providers that still
//! require the legacy HmacSHA1 scheme, which the AWS SDK for Rust no longer
//! implements.
//!
//! Only the operations this app performs are implemented: ListObjectsV2,
//! HeadObject, GetObject (with `Range`), PutObject, DeleteObject, CopyObject and
//! CreateFolder (a zero-byte `key/` PUT). Responses are XML, parsed with
//! `quick-xml`; the parsing helpers are pure functions so they are unit tested.

use super::{kind::detect_kind, ByteRange, ObjectMeta, ObjectStore, ObjectStream, Page};
use crate::error::{AppError, AppResult};
use crate::model::{AddressingStyle, Connection, ObjectEntry, StaticCreds};
use crate::sigv2::{encode_path, encode_query_value, V2Request};

const XMLNS_S3: &str = "http://s3.amazonaws.com/doc/2006-03-01/";

pub struct V2Store {
    http: reqwest::Client,
    /// e.g. `https://obs.example.ru`
    endpoint: String,
    bucket: String,
    // `region` is deliberately not stored: SigV2 has no region in the canonical
    // string or in the Authorization header, and the endpoint URL already
    // identifies the deployment.
    access_key_id: String,
    secret_access_key: String,
    session_token: Option<String>,
    virtual_host: bool,
}

/// A response from the V2 client, before XML/body interpretation.
pub struct V2Response {
    pub status: u16,
    pub headers: reqwest::header::HeaderMap,
    pub body: Vec<u8>,
}

impl V2Store {
    pub fn new(conn: &Connection, creds: &StaticCreds) -> AppResult<Self> {
        let http = reqwest::Client::builder()
            .user_agent(format!("s3viewer/{}", env!("CARGO_PKG_VERSION")))
            // The endpoint may be self-hosted with an internal CA; use the
            // platform trust store rather than a bundled root list.
            .use_rustls_tls()
            .build()
            .map_err(|e| AppError::msg(format!("http client: {e}")))?;
        let virtual_host = match conn.addressing_style {
            AddressingStyle::Virtual => true,
            AddressingStyle::Path => false,
            AddressingStyle::Auto => true,
        };
        Ok(V2Store {
            http,
            endpoint: conn.endpoint_url.trim_end_matches('/').to_string(),
            bucket: conn.bucket.clone(),
            access_key_id: creds.access_key_id.clone(),
            secret_access_key: creds.secret_access_key.clone(),
            session_token: creds.session_token.clone(),
            virtual_host,
        })
    }

    /// Host part of the endpoint, e.g. `obs.example.ru:443`.
    fn host(&self) -> String {
        self.endpoint
            .split("://")
            .nth(1)
            .unwrap_or(&self.endpoint)
            .trim_end_matches('/')
            .to_string()
    }

    fn url_for(&self, key: &str, query: &str) -> String {
        let scheme = self.endpoint.split("://").next().unwrap_or("https");
        let host = self.host();
        let encoded = encode_path(key);
        let path = if self.virtual_host {
            format!("{scheme}://{}.{host}/{encoded}", self.bucket)
        } else {
            format!("{scheme}://{host}/{}/{encoded}", self.bucket)
        };
        let query = query.strip_prefix('?').unwrap_or(query);
        if query.is_empty() {
            path
        } else {
            format!("{path}?{query}")
        }
    }

    /// Sign and send one request.
    #[allow(clippy::too_many_arguments)]
    pub async fn send(
        &self,
        method: reqwest::Method,
        key: &str,
        query: &str,
        content_type: Option<&str>,
        range: Option<&str>,
        body: Option<Vec<u8>>,
    ) -> AppResult<V2Response> {
        let url = self.url_for(key, query);
        let date = httpdate::fmt_http_date(std::time::SystemTime::now());
        let mut amz_headers: Vec<(String, String)> = Vec::new();
        if let Some(token) = &self.session_token {
            amz_headers.push(("x-amz-security-token".to_string(), token.clone()));
        }
        let path_for_sign = format!("/{key}");

        // Content-Type participates in the V2 string-to-sign, so it must be the
        // exact value that goes on the wire.
        let sign_content_type = content_type.unwrap_or("");
        let signer = V2Request {
            method: method.as_str(),
            path: &path_for_sign,
            query: if query.is_empty() {
                None
            } else {
                Some(query.to_string())
            },
            content_type: if sign_content_type.is_empty() {
                None
            } else {
                Some(sign_content_type)
            },
            content_md5: None,
            date: &date,
            extra_amz_headers: &amz_headers,
            bucket: &self.bucket,
        };
        let authorization = signer.authorization(&self.access_key_id, &self.secret_access_key)?;

        let mut req = self
            .http
            .request(method, &url)
            .header("Date", &date)
            .header("Authorization", authorization)
            .header("Accept", "*/*");
        if !sign_content_type.is_empty() {
            req = req.header("Content-Type", sign_content_type);
        }
        if let Some(r) = range {
            req = req.header("Range", r);
        }
        for (k, v) in &amz_headers {
            req = req.header(k, v);
        }
        if let Some(bytes) = body {
            req = req.body(bytes);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| AppError::msg(format!("request {url} failed: {e}")))?;
        let status = resp.status().as_u16();
        let headers = resp.headers().clone();
        let body = resp
            .bytes()
            .await
            .map_err(|e| AppError::msg(format!("read response from {url}: {e}")))?
            .to_vec();
        if !(200..300).contains(&status) {
            return Err(parse_error_response(status, &body));
        }
        Ok(V2Response {
            status,
            headers,
            body,
        })
    }

    fn list_query(
        &self,
        prefix: &str,
        delimiter: Option<&str>,
        token: Option<&str>,
        max_keys: i32,
    ) -> String {
        let mut q = String::from("list-type=2");
        q.push_str(&format!("&max-keys={max_keys}"));
        if !prefix.is_empty() {
            q.push_str(&format!("&prefix={}", encode_query_value(prefix)));
        }
        if let Some(d) = delimiter {
            q.push_str(&format!("&delimiter={}", encode_query_value(d)));
        }
        if let Some(t) = token {
            q.push_str(&format!("&continuation-token={}", encode_query_value(t)));
        }
        q
    }
}

fn header_str(headers: &reqwest::header::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

impl ObjectStore for V2Store {
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
        let query = self.list_query(prefix, delimiter, token, max_keys);
        let resp = self
            .send(reqwest::Method::GET, "", &query, None, None, None)
            .await?;
        let listing = parse_list_response(&resp.body)?;
        let mut entries = Vec::new();
        for p in &listing.common_prefixes {
            entries.push(super::aws::folder_entry(p));
        }
        for obj in &listing.contents {
            let is_folder = obj.key.ends_with('/');
            entries.push(ObjectEntry {
                key: obj.key.clone(),
                name: super::aws::display_name(&obj.key, prefix),
                is_folder,
                size: obj.size,
                last_modified: obj.last_modified.clone(),
                etag: obj.etag.clone(),
                storage_class: obj.storage_class.clone(),
                kind: if is_folder {
                    crate::model::FileKind::Folder
                } else {
                    detect_kind(&obj.key, None, None)
                },
            });
        }
        Ok(Page {
            entries,
            next_token: listing.next_token,
            is_truncated: listing.is_truncated,
        })
    }

    async fn stat(&self, key: &str) -> AppResult<ObjectMeta> {
        let resp = self
            .send(reqwest::Method::HEAD, key, "", None, None, None)
            .await?;
        let size = header_str(&resp.headers, "content-length").and_then(|v| v.parse().ok());
        Ok(ObjectMeta {
            key: key.to_string(),
            size,
            content_type: header_str(&resp.headers, "content-type"),
            etag: header_str(&resp.headers, "etag").map(|e| e.trim_matches('"').to_string()),
            last_modified: header_str(&resp.headers, "last-modified"),
            storage_class: header_str(&resp.headers, "x-amz-storage-class"),
        })
    }

    async fn get_bytes(&self, key: &str, range: Option<ByteRange>) -> AppResult<ObjectStream> {
        let range_header = range.map(|r| r.header());
        let resp = self
            .send(
                reqwest::Method::GET,
                key,
                "",
                None,
                range_header.as_deref(),
                None,
            )
            .await?;
        let content_range = header_str(&resp.headers, "content-range");
        let total_length = content_range
            .as_deref()
            .and_then(|v| v.rsplit('/').next())
            .and_then(|v| v.trim().parse::<i64>().ok());
        let content_length =
            header_str(&resp.headers, "content-length").and_then(|v| v.parse().ok());
        let content_type = header_str(&resp.headers, "content-type");
        let etag = header_str(&resp.headers, "etag").map(|e| e.trim_matches('"').to_string());
        let last_modified = header_str(&resp.headers, "last-modified");
        Ok(ObjectStream {
            content_length,
            total_length,
            content_type,
            etag,
            last_modified,
            content_range,
            body: resp.body,
        })
    }

    async fn get_to(
        &self,
        key: &str,
        sink: &mut (dyn tokio::io::AsyncWrite + Unpin + Send),
    ) -> AppResult<u64> {
        use tokio::io::AsyncWriteExt;
        let url = self.url_for(key, "");
        let date = httpdate::fmt_http_date(std::time::SystemTime::now());
        let mut amz_headers: Vec<(String, String)> = Vec::new();
        if let Some(token) = &self.session_token {
            amz_headers.push(("x-amz-security-token".to_string(), token.clone()));
        }
        let path_for_sign = format!("/{key}");
        let signer = V2Request {
            method: "GET",
            path: &path_for_sign,
            query: None,
            content_type: None,
            content_md5: None,
            date: &date,
            extra_amz_headers: &amz_headers,
            bucket: &self.bucket,
        };
        let authorization = signer.authorization(&self.access_key_id, &self.secret_access_key)?;
        let mut req = self
            .http
            .get(&url)
            .header("Date", &date)
            .header("Authorization", authorization);
        for (k, v) in &amz_headers {
            req = req.header(k, v);
        }
        let mut resp = req
            .send()
            .await
            .map_err(|e| AppError::msg(format!("request {url} failed: {e}")))?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.bytes().await.unwrap_or_default().to_vec();
            return Err(parse_error_response(status, &body));
        }
        let mut written = 0u64;
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| AppError::msg(format!("stream body: {e}")))?
        {
            sink.write_all(&chunk)
                .await
                .map_err(|e| AppError::msg(format!("write output: {e}")))?;
            written += chunk.len() as u64;
        }
        sink.flush()
            .await
            .map_err(|e| AppError::msg(format!("flush output: {e}")))?;
        Ok(written)
    }

    async fn put_bytes(
        &self,
        key: &str,
        body: Vec<u8>,
        content_type: Option<&str>,
    ) -> AppResult<()> {
        self.send(
            reqwest::Method::PUT,
            key,
            "",
            content_type,
            None,
            Some(body),
        )
        .await?;
        Ok(())
    }

    async fn put_file(
        &self,
        key: &str,
        path: &std::path::Path,
        content_type: Option<&str>,
    ) -> AppResult<()> {
        let body = tokio::fs::read(path)
            .await
            .map_err(|e| AppError::msg(format!("read {}: {e}", path.display())))?;
        let ct = content_type
            .map(|s| s.to_string())
            .or_else(|| super::guess_content_type(path));
        self.put_bytes(key, body, ct.as_deref()).await
    }

    async fn delete_object(&self, key: &str) -> AppResult<()> {
        self.send(reqwest::Method::DELETE, key, "", None, None, None)
            .await?;
        Ok(())
    }

    async fn copy_object(&self, source_key: &str, dest_key: &str) -> AppResult<()> {
        let copy_source = format!("{}/{}", self.bucket, source_key);
        let headers = vec![("x-amz-copy-source".to_string(), copy_source)];
        let date = httpdate::fmt_http_date(std::time::SystemTime::now());
        let path_for_sign = format!("/{dest_key}");
        let signer = V2Request {
            method: "PUT",
            path: &path_for_sign,
            query: None,
            content_type: None,
            content_md5: None,
            date: &date,
            extra_amz_headers: &headers,
            bucket: &self.bucket,
        };
        let authorization = signer.authorization(&self.access_key_id, &self.secret_access_key)?;
        let url = self.url_for(dest_key, "");
        let resp = self
            .http
            .put(&url)
            .header("Date", &date)
            .header("Authorization", authorization)
            .header("x-amz-copy-source", &headers[0].1)
            .body(Vec::new())
            .send()
            .await
            .map_err(|e| AppError::msg(format!("copy request failed: {e}")))?;
        let status = resp.status().as_u16();
        let body = resp.bytes().await.unwrap_or_default().to_vec();
        if !(200..300).contains(&status) {
            return Err(parse_error_response(status, &body));
        }
        Ok(())
    }

    async fn delete_many(&self, keys: &[String]) -> AppResult<()> {
        // SigV2 has no batch delete request in this client; delete one by one.
        for key in keys {
            self.delete_object(key).await?;
        }
        Ok(())
    }
}

// ------------------------------------------------------------------ XML parsing

#[derive(Debug, Default, PartialEq)]
pub struct ListEntry {
    pub key: String,
    pub size: i64,
    pub last_modified: Option<String>,
    pub etag: Option<String>,
    pub storage_class: Option<String>,
}

#[derive(Debug, Default, PartialEq)]
pub struct ListResponse {
    pub contents: Vec<ListEntry>,
    pub common_prefixes: Vec<String>,
    pub is_truncated: bool,
    pub next_token: Option<String>,
}

/// Parse a `ListBucketResult` document. Tolerates the namespace being present or
/// absent, and ignores unknown elements.
pub fn parse_list_response(xml: &[u8]) -> AppResult<ListResponse> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_reader(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut out = ListResponse::default();
    let mut current: Option<ListEntry> = None;
    let mut tag = String::new();
    let mut in_common_prefix = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                tag = local_name(e.name().as_ref());
                if tag == "Contents" {
                    current = Some(ListEntry::default());
                } else if tag == "CommonPrefixes" {
                    in_common_prefix = true;
                }
            }
            Ok(Event::Text(t)) => {
                let text = t
                    .unescape()
                    .map_err(|e| AppError::msg(format!("bad XML text: {e}")))?
                    .to_string();
                if in_common_prefix && tag == "Prefix" {
                    out.common_prefixes.push(text);
                } else if let Some(entry) = current.as_mut() {
                    match tag.as_str() {
                        "Key" => entry.key = text,
                        "Size" => entry.size = text.parse().unwrap_or(0),
                        "LastModified" => entry.last_modified = Some(text),
                        "ETag" => entry.etag = Some(text.trim_matches('"').to_string()),
                        "StorageClass" => entry.storage_class = Some(text),
                        _ => {}
                    }
                } else {
                    match tag.as_str() {
                        "IsTruncated" => out.is_truncated = text.eq_ignore_ascii_case("true"),
                        "NextContinuationToken" => out.next_token = Some(text),
                        "NextMarker" => out.next_token = Some(text),
                        _ => {}
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = local_name(e.name().as_ref());
                if name == "Contents" {
                    if let Some(entry) = current.take() {
                        out.contents.push(entry);
                    }
                } else if name == "CommonPrefixes" {
                    in_common_prefix = false;
                }
                tag.clear();
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(e) => {
                return Err(AppError::msg(format!(
                    "failed to parse S3 XML listing: {e}"
                )))
            }
        }
        buf.clear();
    }
    Ok(out)
}

/// Extract the S3 `<Code>`/`<Message>` pair from an error document, tolerating
/// non-XML bodies (proxies like to return HTML).
pub fn parse_error_response(status: u16, body: &[u8]) -> AppError {
    let text = String::from_utf8_lossy(body);
    let code = extract_tag(&text, "Code").unwrap_or_else(|| format!("HTTP{status}"));
    let message = extract_tag(&text, "Message").unwrap_or_else(|| {
        if text.trim().is_empty() {
            format!("request failed with HTTP {status}")
        } else {
            text.chars().take(400).collect()
        }
    });
    let request_id = extract_tag(&text, "RequestId");
    AppError::S3 {
        code,
        message,
        request_id,
        status: Some(status),
    }
}

fn extract_tag(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml[start..end].trim().to_string())
}

fn local_name(raw: &[u8]) -> String {
    let s = String::from_utf8_lossy(raw);
    match s.rsplit_once(':') {
        Some((_, local)) => local.to_string(),
        None => s.to_string(),
    }
}

/// Namespace-aware variant retained for documentation of the wire format.
pub const LIST_NAMESPACE: &str = XMLNS_S3;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_listing_with_prefixes_and_token() {
        let xml = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="{XMLNS_S3}">
  <Name>bucket</Name>
  <Prefix>a/</Prefix>
  <KeyCount>2</KeyCount>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>TOKEN==</NextContinuationToken>
  <Contents>
    <Key>a/b.png</Key>
    <LastModified>2026-05-21T13:16:04.000Z</LastModified>
    <ETag>&quot;d41d8cd98f00b204e9800998ecf8427e&quot;</ETag>
    <Size>19845133</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <Contents>
    <Key>a/c.txt</Key>
    <Size>12</Size>
  </Contents>
  <CommonPrefixes><Prefix>a/sub/</Prefix></CommonPrefixes>
</ListBucketResult>"#
        );
        let parsed = parse_list_response(xml.as_bytes()).unwrap();
        assert_eq!(parsed.contents.len(), 2);
        assert_eq!(parsed.contents[0].key, "a/b.png");
        assert_eq!(parsed.contents[0].size, 19845133);
        assert_eq!(
            parsed.contents[0].etag.as_deref(),
            Some("d41d8cd98f00b204e9800998ecf8427e")
        );
        assert_eq!(
            parsed.contents[0].storage_class.as_deref(),
            Some("STANDARD")
        );
        assert_eq!(parsed.contents[1].size, 12);
        assert_eq!(parsed.common_prefixes, vec!["a/sub/".to_string()]);
        assert!(parsed.is_truncated);
        assert_eq!(parsed.next_token.as_deref(), Some("TOKEN=="));
    }

    #[test]
    fn parses_listing_without_namespace() {
        let xml = b"<ListBucketResult><Contents><Key>k</Key><Size>1</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>";
        let parsed = parse_list_response(xml).unwrap();
        assert_eq!(parsed.contents.len(), 1);
        assert!(!parsed.is_truncated);
        assert!(parsed.next_token.is_none());
    }

    #[test]
    fn parses_empty_listing() {
        let xml = b"<ListBucketResult><Name>b</Name><KeyCount>0</KeyCount></ListBucketResult>";
        let parsed = parse_list_response(xml).unwrap();
        assert!(parsed.contents.is_empty());
        assert!(parsed.common_prefixes.is_empty());
    }

    #[test]
    fn keeps_etag_quotes_stripped() {
        let xml = b"<ListBucketResult><Contents><Key>k</Key><ETag>\"abc\"</ETag></Contents></ListBucketResult>";
        let parsed = parse_list_response(xml).unwrap();
        assert_eq!(parsed.contents[0].etag.as_deref(), Some("abc"));
    }

    #[test]
    fn error_document_becomes_structured_error() {
        let xml = br#"<?xml version="1.0"?><Error><Code>VirtualHostDomainRequired</Code><Message>Virtual host domain is required</Message><RequestId>RID123</RequestId></Error>"#;
        let err = parse_error_response(403, xml);
        match err {
            AppError::S3 {
                code,
                message,
                request_id,
                status,
            } => {
                assert_eq!(code, "VirtualHostDomainRequired");
                assert_eq!(message, "Virtual host domain is required");
                assert_eq!(request_id.as_deref(), Some("RID123"));
                assert_eq!(status, Some(403));
            }
            other => panic!("expected S3 error, got {other:?}"),
        }
    }

    #[test]
    fn non_xml_error_body_is_not_lost() {
        let err = parse_error_response(502, b"<html>Bad gateway</html>");
        match err {
            AppError::S3 { code, message, .. } => {
                assert_eq!(code, "HTTP502");
                assert!(message.contains("Bad gateway"));
            }
            other => panic!("expected S3 error, got {other:?}"),
        }
    }

    #[test]
    fn empty_error_body_still_reports_status() {
        match parse_error_response(500, b"") {
            AppError::S3 { message, .. } => assert!(message.contains("500")),
            other => panic!("expected S3 error, got {other:?}"),
        }
    }
}
