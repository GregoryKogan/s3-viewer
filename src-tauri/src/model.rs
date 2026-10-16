use serde::{Deserialize, Serialize};

/// Which SigV4 credentials the connection uses.
/// Mirrors boto3: `aws_access_key_id` + `aws_secret_access_key` (+ optional
/// `aws_session_token` for temporary STS credentials).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StaticCreds {
    pub access_key_id: String,
    #[serde(default)]
    pub secret_access_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_token: Option<String>,
}

/// boto3 `Config(signature_version=...)`.
/// `s3v4` -> "s3v4" (default), `s3v2` -> legacy HmacSHA1 signer, `v4` -> plain SigV4.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SignatureVersion {
    #[default]
    S3v4,
    V4,
    S3v2,
}

impl SignatureVersion {
    pub fn is_v2(self) -> bool {
        matches!(self, SignatureVersion::S3v2)
    }
}

/// boto3 `Config(s3={"addressing_style": ...})`.
/// This endpoint *requires* virtual-host addressing: path-style requests to a
/// bucket return `VirtualHostDomainRequired`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AddressingStyle {
    #[default]
    Virtual,
    Path,
    Auto,
}

impl AddressingStyle {
    pub fn force_path_style(self) -> bool {
        matches!(self, AddressingStyle::Path)
    }
}

fn default_true() -> bool {
    true
}
fn default_confirm() -> bool {
    true
}
fn default_probe() -> bool {
    true
}
fn default_auto_probe() -> bool {
    true
}

/// Per-connection security switches. Read-only connections still get
/// destructive-action guards; these only control whether the UI asks first.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecuritySettings {
    #[serde(default = "default_confirm")]
    pub confirm_delete: bool,
    #[serde(default = "default_confirm")]
    pub confirm_overwrite: bool,
    #[serde(default)]
    pub confirm_bulk: bool,
    /// Run the capability probe (read / write / delete) on connect.
    #[serde(default = "default_probe")]
    pub detect_permissions: bool,
    #[serde(default = "default_auto_probe")]
    pub auto_probe_on_connect: bool,
    /// Refuse every mutating operation regardless of the above.
    #[serde(default)]
    pub read_only_mode: bool,
}

impl Default for SecuritySettings {
    fn default() -> Self {
        Self {
            confirm_delete: true,
            confirm_overwrite: true,
            confirm_bulk: false,
            detect_permissions: true,
            auto_probe_on_connect: true,
            read_only_mode: false,
        }
    }
}

/// A saved connection. Everything here maps 1:1 onto a boto3 client
/// configuration so it can be copied by hand from working Python code.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub name: String,
    /// boto3 `endpoint_url`
    pub endpoint_url: String,
    /// boto3 `region_name`
    #[serde(default = "default_region")]
    pub region: String,
    /// boto3 `aws_access_key_id` (kept in cleartext: it is not a secret).
    pub access_key_id: String,
    #[serde(default)]
    pub session_token_present: bool,
    /// boto3 `Bucket=`
    pub bucket: String,
    /// boto3 `Prefix=`
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub addressing_style: AddressingStyle,
    #[serde(default)]
    pub signature_version: SignatureVersion,
    /// boto3 `Config(s3={"payload_signing_enabled": ...})`
    #[serde(default)]
    pub payload_signing_enabled: bool,
    /// boto3 `Config(s3={"use_accelerate_endpoint": ...})` is intentionally absent:
    /// this client targets S3-compatible object storage, not AWS-only acceleration.
    /// boto3 `Config(s3={"us_east_1_regional_endpoint": "regional"})` equivalent:
    #[serde(default = "default_true")]
    pub use_path_style_for_list: bool,
    /// Ask the user for confirmation before destructive operations.
    #[serde(default)]
    pub security: SecuritySettings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
    #[serde(default)]
    pub created_at: String,
}

fn default_region() -> String {
    "us-east-1".to_string()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub can_list: bool,
    pub can_read: bool,
    pub can_write: bool,
    pub can_delete: bool,
    pub probed: bool,
    #[serde(default)]
    pub details: Vec<String>,
}

/// A stored connection plus what the app knows about it.
///
/// The connection is nested (not flattened) on purpose: the UI reads
/// `view.connection.id`, and flattening would silently collide with the
/// `capabilities` / `hasSecret` keys.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionView {
    pub connection: Connection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Capabilities>,
    pub has_secret: bool,
}

/// One row in the object browser: an object or a common prefix ("folder").
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectEntry {
    /// Full key, e.g. `a/b/c.png`.
    pub key: String,
    /// Display name, e.g. `c.png`.
    pub name: String,
    pub is_folder: bool,
    pub size: i64,
    pub last_modified: Option<String>,
    pub etag: Option<String>,
    pub storage_class: Option<String>,
    pub kind: FileKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    Image,
    Audio,
    Video,
    Pdf,
    Text,
    Markdown,
    Code,
    Json,
    Csv,
    Archive,
    Binary,
    Folder,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    /// Prefix that was listed (always ends with `/` or is empty).
    pub prefix: String,
    pub entries: Vec<ObjectEntry>,
    pub truncated: bool,
    /// Present when the listing stopped early and the view may be incomplete.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewData {
    pub kind: FileKind,
    pub key: String,
    pub size: i64,
    pub content_type: String,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    /// Inline payload. For media this is empty and the frontend uses `streamUrl`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base64: Option<String>,
    pub stream_url: String,
    pub truncated: bool,
    /// Set when the preview is not available, explaining exactly why.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressView {
    pub id: String,
    pub label: String,
    pub done: u64,
    pub total: Option<u64>,
    pub state: ProgressState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProgressState {
    Running,
    Done,
    Failed,
    Cancelled,
}

/// Result of the connection probe, shown on the connection card.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub capabilities: Capabilities,
    pub bucket_region: Option<String>,
}

/// Machine-readable S3 error code, when the failure came from S3.
pub fn error_code(err: &crate::error::AppError) -> Option<String> {
    match err {
        crate::error::AppError::S3 { code, .. } => Some(code.clone()),
        _ => None,
    }
}

/// Short human description used inside capability details and preview notes.
pub fn describe_error(err: &crate::error::AppError) -> String {
    match err {
        crate::error::AppError::S3 { code, message, .. } => format!("{code}: {message}"),
        other => other.to_string(),
    }
}
