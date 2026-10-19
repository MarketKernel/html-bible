//! The route table: which handler answers a method and path, whether it needs
//! a token, 404 and 405, CORS. In AWS everything reaches one Lambda through
//! API Gateway's `$default` route, so routing is here, not in AWS: the API
//! moves to another host as it is.

use crate::app::App;
use crate::auth::{authenticate, Auth};
use crate::errors::{not_found, unauthorized, ApiError, ApiResult};
use crate::handlers as h;
use crate::http::{apply_cors, preflight, Request, Response};

#[derive(Clone, Copy, PartialEq)]
pub enum Access {
    /// A token is required (401 without one).
    Required,
    /// Reading works without a token; a token that is sent must be valid.
    Optional,
    /// The token is not even read.
    Open,
}

/// What a handler gets: the request, the `{id}` of the path, the caller.
pub struct Call<'a> {
    pub request: &'a Request,
    pub id: String,
    pub auth: Option<Auth>,
}

impl Call<'_> {
    /// The caller of a route with `Access::Required`.
    pub fn user(&self) -> ApiResult<&Auth> {
        self.auth.as_ref().ok_or_else(unauthorized)
    }

    pub fn viewer(&self) -> Option<&str> {
        self.auth.as_ref().map(|a| a.user.id.as_str())
    }
}

type Action = fn(&App, &Call) -> ApiResult<Response>;

pub struct Route {
    pub method: &'static str,
    pub path: &'static str,
    pub access: Access,
    action: Action,
}

const fn route(method: &'static str, path: &'static str, access: Access, action: Action) -> Route {
    Route { method, path, access, action }
}

use Access::{Open, Optional, Required};

pub const ROUTES: [Route; 28] = [
    route("GET", "/v1/health", Open, h::health),
    route("POST", "/v1/auth/register", Open, h::register),
    route("POST", "/v1/auth/login", Open, h::login),
    route("POST", "/v1/auth/logout", Required, h::logout),
    route("POST", "/v1/auth/password", Required, h::change_password),
    route("GET", "/v1/me", Required, h::get_me),
    route("PATCH", "/v1/me", Required, h::patch_me),
    route("POST", "/v1/invites", Required, h::issue_invite),
    route("GET", "/v1/invites", Required, h::list_invites),
    route("GET", "/v1/invites/{id}", Open, h::check_invite),
    route("GET", "/v1/users/{id}", Open, h::user_profile),
    route("GET", "/v1/questions", Optional, h::list_questions),
    route("POST", "/v1/questions", Required, h::create_question),
    route("GET", "/v1/questions/{id}", Optional, h::get_question),
    route("PATCH", "/v1/questions/{id}", Required, h::patch_question),
    route("DELETE", "/v1/questions/{id}", Required, h::delete_question),
    route("POST", "/v1/questions/{id}/arguments", Required, h::create_argument),
    route("PATCH", "/v1/arguments/{id}", Required, h::patch_argument),
    route("DELETE", "/v1/arguments/{id}", Required, h::delete_argument),
    route("POST", "/v1/arguments/{id}/verses", Required, h::create_verse),
    route("DELETE", "/v1/verses/{id}", Required, h::delete_verse),
    route("GET", "/v1/verses/{id}/rating", Optional, h::verse_rating),
    route("POST", "/v1/verses/{id}/interpretations", Required, h::create_interpretation),
    route("PATCH", "/v1/interpretations/{id}", Required, h::patch_interpretation),
    route("DELETE", "/v1/interpretations/{id}", Required, h::delete_interpretation),
    route("PUT", "/v1/votes/verse/{id}", Required, h::put_vote),
    route("PUT", "/v1/votes/interpretation/{id}", Required, h::put_interpretation_vote),
    route("GET", "/v1/verse-tags", Optional, h::verse_tags),
];

/// Whether a path is the API's (the local server serves files for the rest).
pub fn owns(path: &str) -> bool {
    path == "/v1" || path.starts_with("/v1/")
}

/// The `{id}` when `path` fits `template`.
fn fit(template: &str, path: &str) -> Option<String> {
    let mut id = String::new();
    let (mut wanted, mut given) = (template.split('/'), path.split('/'));
    loop {
        match (wanted.next(), given.next()) {
            (None, None) => return Some(id),
            (Some("{id}"), Some(part)) if !part.is_empty() => id = part.to_string(),
            (Some(a), Some(b)) if a == b => {}
            _ => return None,
        }
    }
}

pub fn handle(app: &App, request: &Request) -> Response {
    if request.method == "OPTIONS" {
        return preflight(&app.config, request);
    }
    let mut response = answer(app, request).unwrap_or_else(|error| Response::error(&error));
    apply_cors(&app.config, request, &mut response);
    response
}

fn answer(app: &App, request: &Request) -> ApiResult<Response> {
    let method = if request.method == "HEAD" { "GET" } else { request.method.as_str() };
    let mut allowed = Vec::new();
    let mut found = None;
    for route in &ROUTES {
        if let Some(id) = fit(route.path, &request.path) {
            allowed.push(route.method);
            if route.method == method && found.is_none() {
                found = Some((route, id));
            }
        }
    }
    let Some((route, id)) = found else {
        if allowed.is_empty() {
            return Err(not_found("No such route"));
        }
        let list = allowed.join(", ");
        return Err(ApiError::new(405, "method_not_allowed", format!("Use {list} on this path")).header("Allow", list));
    };
    let auth = match route.access {
        Open => None,
        _ => authenticate(app, request.header("authorization"))?,
    };
    if route.access == Required && auth.is_none() {
        return Err(unauthorized());
    }
    (route.action)(app, &Call { request, id, auth })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fitting() {
        assert_eq!(fit("/v1/questions/{id}", "/v1/questions/01J"), Some("01J".into()));
        assert_eq!(fit("/v1/questions/{id}", "/v1/questions/"), None);
        assert_eq!(fit("/v1/questions/{id}", "/v1/questions/01J/arguments"), None);
        assert_eq!(fit("/v1/health", "/v1/health"), Some(String::new()));
    }
}
