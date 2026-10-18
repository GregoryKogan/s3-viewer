use serde::Serialize;

/// Every error surfaced to the UI keeps enough structure to render an
/// actionable message (S3 code + request id when available).
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Message(String),

    #[error("S3 error{code}: {message}")]
    S3 {
        code: String,
        message: String,
        request_id: Option<String>,
        status: Option<u16>,
    },

    #[error("not found: {0}")]
    NotFound(String),

    #[error("invalid input: {0}")]
    Invalid(String),

    #[error("credential store error: {0}")]
    Store(String),

    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),

    #[error("{0}")]
    Other(#[from] anyhow::Error),
}

impl AppError {
    pub fn invalid(msg: impl Into<String>) -> Self {
        AppError::Invalid(msg.into())
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        AppError::NotFound(msg.into())
    }
    pub fn store(msg: impl Into<String>) -> Self {
        AppError::Store(msg.into())
    }
    pub fn msg(msg: impl Into<String>) -> Self {
        AppError::Message(msg.into())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    pub kind: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// Hints the UI can offer: e.g. "switch to virtual-host addressing".
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub hints: Vec<String>,
}

impl From<&AppError> for ErrorPayload {
    fn from(err: &AppError) -> Self {
        match err {
            AppError::S3 {
                code,
                message,
                request_id,
                status,
            } => {
                let mut hints = Vec::new();
                if code == "VirtualHostDomainRequired" {
                    hints.push(
                        "This endpoint requires virtual-host addressing. Set Addressing style = virtual."
                            .to_string(),
                    );
                }
                if code == "SignatureDoesNotMatch" {
                    hints.push(
                        "Check the secret key, the region and the signature version (s3v4 / s3v2)."
                            .to_string(),
                    );
                }
                if code == "PermanentRedirect" || code == "AuthorizationHeaderMalformed" {
                    hints.push(
                        "The bucket lives in a different region. Set Region to that value."
                            .to_string(),
                    );
                }
                if code == "AccessDenied" {
                    hints.push(
                        "Credentials are valid but lack this permission. Use Test connection to inspect the granted rights."
                            .to_string(),
                    );
                    hints.push(
                        "If uploads still work, these credentials may be write-only: PUT is allowed but HEAD (checking whether a key exists) is not."
                            .to_string(),
                    );
                }
                ErrorPayload {
                    kind: "s3",
                    message: message.clone(),
                    code: Some(code.clone()),
                    request_id: request_id.clone(),
                    status: *status,
                    hints,
                }
            }
            AppError::NotFound(m) => ErrorPayload {
                kind: "notFound",
                message: m.clone(),
                code: None,
                request_id: None,
                status: None,
                hints: vec![],
            },
            AppError::Invalid(m) => ErrorPayload {
                kind: "invalid",
                message: m.clone(),
                code: None,
                request_id: None,
                status: None,
                hints: vec![],
            },
            AppError::Store(m) => ErrorPayload {
                kind: "store",
                message: m.clone(),
                code: None,
                request_id: None,
                status: None,
                hints: vec![],
            },
            AppError::Io(e) => ErrorPayload {
                kind: "io",
                message: e.to_string(),
                code: None,
                request_id: None,
                status: None,
                hints: vec![],
            },
            AppError::Message(m) => ErrorPayload {
                kind: "message",
                message: m.clone(),
                code: None,
                request_id: None,
                status: None,
                hints: vec![],
            },
            AppError::Other(e) => ErrorPayload {
                kind: "other",
                message: e.to_string(),
                code: None,
                request_id: None,
                status: None,
                hints: vec![],
            },
        }
    }
}

impl From<AppError> for ErrorPayload {
    fn from(err: AppError) -> Self {
        (&err).into()
    }
}

pub type AppResult<T> = Result<T, AppError>;
