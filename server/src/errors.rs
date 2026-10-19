//! The one error type handlers return; it becomes `{ "error": { code, message, … } }`.

use serde_json::{json, Map, Value};

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
    pub field: Option<String>,
    /// Shown to the user as is (422): already in the author's language.
    pub reason: Option<String>,
    pub headers: Vec<(String, String)>,
    /// Code-specific fields, e.g. the existing id of a duplicate verse.
    pub extra: Vec<(&'static str, Value)>,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        ApiError { status, code, message: message.into(), field: None, reason: None, headers: Vec::new(), extra: Vec::new() }
    }

    pub fn field(mut self, field: impl Into<String>) -> Self {
        self.field = Some(field.into());
        self
    }

    pub fn reason(mut self, reason: impl Into<String>) -> Self {
        self.reason = Some(reason.into());
        self
    }

    pub fn header(mut self, name: &str, value: impl Into<String>) -> Self {
        self.headers.push((name.to_string(), value.into()));
        self
    }

    pub fn extra(mut self, key: &'static str, value: Value) -> Self {
        self.extra.push((key, value));
        self
    }

    pub fn body(&self) -> Value {
        let mut error = Map::new();
        error.insert("code".into(), json!(self.code));
        error.insert("message".into(), json!(self.message));
        if let Some(field) = &self.field {
            error.insert("field".into(), json!(field));
        }
        if let Some(reason) = &self.reason {
            error.insert("reason".into(), json!(reason));
        }
        for (key, value) in &self.extra {
            error.insert((*key).into(), value.clone());
        }
        json!({ "error": error })
    }
}

pub fn validation(message: impl Into<String>, field: &str) -> ApiError {
    ApiError::new(400, "validation_error", message).field(field)
}

/// A validation error about the request as a whole, with no one field to point at.
pub fn validation_general(message: impl Into<String>) -> ApiError {
    ApiError::new(400, "validation_error", message)
}

pub fn bad_request(message: impl Into<String>) -> ApiError {
    ApiError::new(400, "bad_request", message)
}

pub fn not_found(what: impl Into<String>) -> ApiError {
    ApiError::new(404, "not_found", what)
}

pub fn unauthorized() -> ApiError {
    ApiError::new(401, "unauthorized", "Sign-in required").header("WWW-Authenticate", "Bearer")
}

pub fn forbidden() -> ApiError {
    ApiError::new(403, "forbidden", "Only the author can do this")
}

pub fn deleted(message: impl Into<String>) -> ApiError {
    ApiError::new(409, "deleted", message)
}

pub fn item_deleted() -> ApiError {
    deleted("This item was deleted by its author")
}

pub fn internal() -> ApiError {
    ApiError::new(500, "internal_error", "Internal server error")
}

/// Python's repr() of a string, which the messages of the original server used
/// ('JHN', or "it's"): messages are part of the contract fixtures.
pub fn repr(value: &str) -> String {
    let quote = if value.contains('\'') && !value.contains('"') { '"' } else { '\'' };
    let mut out = String::with_capacity(value.len() + 2);
    out.push(quote);
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}
