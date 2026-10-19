//! Requests and responses as the core sees them. The local server and the
//! Lambda adapter translate to and from these, so the same code answers both.

use serde_json::Value;

use crate::app::Config;
use crate::errors::{bad_request, ApiError, ApiResult};

#[derive(Clone, Debug, Default)]
pub struct Request {
    pub method: String,
    /// Without the query string, not percent-decoded: "/v1/questions/01J…".
    pub path: String,
    /// The raw query string, without "?".
    pub query: String,
    /// Names in lowercase.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub source_ip: String,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }

    /// A query parameter, decoded; repeats are joined with commas, as API Gateway does.
    pub fn param(&self, name: &str) -> Option<String> {
        let values: Vec<String> = self
            .query
            .split('&')
            .filter(|pair| !pair.is_empty())
            .filter_map(|pair| {
                let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
                (decode(key) == name).then(|| decode(value))
            })
            .collect();
        (!values.is_empty()).then(|| values.join(","))
    }

    /// The body as a JSON object (400 bad_request otherwise).
    pub fn json(&self) -> ApiResult<Value> {
        let text = std::str::from_utf8(&self.body).map_err(|_| bad_request("The body is not UTF-8"))?;
        if text.trim().is_empty() {
            return Err(bad_request("A JSON body is required"));
        }
        let value: Value = serde_json::from_str(text).map_err(|_| bad_request("The body is not valid JSON"))?;
        if !value.is_object() {
            return Err(bad_request("The body must be a JSON object"));
        }
        Ok(value)
    }

    /// Like `json`, but an empty body is an empty object.
    pub fn json_or_empty(&self) -> ApiResult<Value> {
        if self.body.iter().all(u8::is_ascii_whitespace) {
            return Ok(Value::Object(Default::default()));
        }
        self.json()
    }
}

/// Percent-decoding of a query component ("+" is a space).
pub fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() && bytes[i + 1].is_ascii_hexdigit() && bytes[i + 2].is_ascii_hexdigit() => {
                let hex = |b: u8| (b as char).to_digit(16).unwrap_or(0) as u8;
                out.push(hex(bytes[i + 1]) * 16 + hex(bytes[i + 2]));
                i += 2;
            }
            byte => out.push(byte),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[derive(Clone, Debug)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

pub const JSON_TYPE: &str = "application/json; charset=utf-8";

impl Response {
    pub fn json(status: u16, body: &Value) -> Self {
        Response {
            status,
            headers: vec![("Content-Type".into(), JSON_TYPE.into()), ("Cache-Control".into(), "no-store".into())],
            body: serde_json::to_vec(body).expect("JSON values serialize"),
        }
    }

    pub fn error(error: &ApiError) -> Self {
        let mut response = Response::json(error.status, &error.body());
        for (name, value) in &error.headers {
            response.set_header(name, value);
        }
        response
    }

    pub fn empty(status: u16) -> Self {
        Response { status, headers: Vec::new(), body: Vec::new() }
    }

    pub fn with_header(mut self, name: &str, value: impl Into<String>) -> Self {
        self.set_header(name, &value.into());
        self
    }

    pub fn set_header(&mut self, name: &str, value: &str) {
        self.headers.retain(|(key, _)| !key.eq_ignore_ascii_case(name));
        self.headers.push((name.to_string(), value.to_string()));
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }
}

pub const CORS_METHODS: &str = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
pub const CORS_HEADERS: &str = "Authorization, Content-Type";

/// CORS on every response: the allowed origin is echoed (with Vary: Origin),
/// Location is exposed. No cookies are used, so no credentials.
pub fn apply_cors(config: &Config, request: &Request, response: &mut Response) {
    response.set_header("Vary", "Origin");
    if let Some(origin) = request.header("origin").filter(|o| config.origin_allowed(o)) {
        response.set_header("Access-Control-Allow-Origin", origin);
        response.set_header("Access-Control-Expose-Headers", "Location");
    }
}

/// The answer to an OPTIONS preflight: 204, with the allowances for an allowed origin.
pub fn preflight(config: &Config, request: &Request) -> Response {
    let mut response = Response::empty(204);
    if request.header("origin").is_some_and(|o| config.origin_allowed(o)) {
        response.set_header("Access-Control-Allow-Methods", CORS_METHODS);
        response.set_header("Access-Control-Allow-Headers", CORS_HEADERS);
        response.set_header("Access-Control-Max-Age", "600");
        // Chrome's Private Network Access: the public site calling localhost.
        if request.header("access-control-request-private-network") == Some("true") {
            response.set_header("Access-Control-Allow-Private-Network", "true");
        }
    }
    apply_cors(config, request, &mut response);
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query() {
        let request = Request { query: "book=JHN&lang=ru&tag=a+b&tag=%D0%B0&x".into(), ..Default::default() };
        assert_eq!(request.param("book").as_deref(), Some("JHN"));
        assert_eq!(request.param("tag").as_deref(), Some("a b,а"));
        assert_eq!(request.param("x").as_deref(), Some(""));
        assert_eq!(request.param("none"), None);
        assert_eq!(decode("100%"), "100%");
        assert_eq!(decode("%4"), "%4");
    }
}
