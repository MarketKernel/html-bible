//! Sign-in with a login and a password.
//!
//! Registration and sign-in return a token: 32 random bytes, valid until
//! the user signs out (there is no expiry). The server keeps only the token's
//! sha256 as the session id, so a copy of the sessions table signs in no one,
//! and a session can be revoked — "sign out", "sign out everywhere", and every
//! other device on a password change.
//!
//! Passwords are stored as salted SHA-256: nothing here is worth a slow hash,
//! and the salt keeps equal passwords from having equal hashes. Guessing is
//! slowed by counting failures per login and attempts per client address
//! (`429` with `Retry-After`).
//! There is no password recovery yet: it comes with e-mail.

use base64::Engine;
use serde_json::{json, Value};

use crate::app::App;
use crate::errors::{validation, ApiError, ApiResult};
use crate::ids::{random_bytes, sha256_hex, uuid_v4};
use crate::invites;
use crate::model::{Counter, Invite, Login, Number, Record, Session, Throttle, User};
use crate::store::Write;
use crate::pipeline::check_name;
use crate::views::user_view;

pub const LOGIN_MIN: usize = 3;
pub const LOGIN_MAX: usize = 32;
pub const PASSWORD_MIN: usize = 8;
pub const PASSWORD_MAX: usize = 128;
pub const TOKEN_PREFIX: &str = "hb1_";

/// Who made the request: the user and the session (device) the token opened.
#[derive(Clone, Debug)]
pub struct Auth {
    pub user: User,
    pub session_id: String,
}

/* ---------------------------------------------------------------- rules */

/// The login as stored (lowercase) and as typed (the first display name).
fn login_of(body: &Value) -> ApiResult<(String, String)> {
    let message = "\"login\" must be 3–32 characters: letters a–z, digits, \".\", \"_\" or \"-\", starting with a letter or digit";
    let typed = body.get("login").and_then(Value::as_str).map(str::trim).ok_or_else(|| validation(message, "login"))?;
    let login = typed.to_ascii_lowercase();
    let ok = (LOGIN_MIN..=LOGIN_MAX).contains(&login.len())
        && login.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
        && login.bytes().next().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    if !ok {
        return Err(validation(message, "login"));
    }
    Ok((login, typed.to_string()))
}

/// A new password: 8–128 characters, kept exactly as typed, not the login.
fn new_password<'a>(body: &'a Value, name: &str, login: &str) -> ApiResult<&'a str> {
    let password = body.get(name).and_then(Value::as_str).unwrap_or("");
    let length = password.chars().count();
    if !(PASSWORD_MIN..=PASSWORD_MAX).contains(&length) {
        return Err(validation(format!("\"{name}\" must be {PASSWORD_MIN}–{PASSWORD_MAX} characters"), name));
    }
    if password.trim().to_lowercase() == login {
        return Err(validation(format!("\"{name}\" must differ from the login"), name));
    }
    Ok(password)
}

fn given<'a>(body: &'a Value, name: &str) -> ApiResult<&'a str> {
    body.get(name).and_then(Value::as_str).ok_or_else(|| validation(format!("\"{name}\" is required"), name))
}

/* ------------------------------------------------------------ passwords */

const HASH_SCHEME: &str = "sha256";

fn salted(salt: &str, password: &str) -> String {
    sha256_hex(format!("{salt}{password}").as_bytes())
}

/// "sha256$<salt>$<hex of sha256(salt + password)>", with a random salt.
pub fn hash_password(password: &str) -> String {
    let salt = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random_bytes::<16>());
    format!("{HASH_SCHEME}${salt}${}", salted(&salt, password))
}

fn verify_password(password: &str, stored: &str) -> bool {
    let mut parts = stored.split('$');
    let (Some(HASH_SCHEME), Some(salt), Some(hash), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    // Compared in constant time: how long it takes says nothing about the hash.
    let actual = salted(salt, password);
    actual.len() == hash.len() && actual.bytes().zip(hash.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/* ------------------------------------------------------------- sessions */

fn new_token() -> String {
    format!("{TOKEN_PREFIX}{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random_bytes::<32>()))
}

pub fn is_token(value: &str) -> bool {
    value.strip_prefix(TOKEN_PREFIX).is_some_and(|rest| rest.len() == 43 && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
}

/// A new session for the user; returns the token, which is shown only now.
pub fn open_session(app: &App, user_id: &str) -> ApiResult<String> {
    let token = new_token();
    app.db().put(&Session { id: sha256_hex(token.as_bytes()), user_id: user_id.to_string(), created_at: app.now_iso() })?;
    Ok(token)
}

fn invalid_token(message: &str) -> ApiError {
    ApiError::new(401, "invalid_token", message).header("WWW-Authenticate", format!("Bearer error=\"invalid_token\", error_description=\"{message}\""))
}

/// The Authorization header → who is asking. No header: nobody (Ok(None));
/// a header that opens no session: 401, even on reads.
pub fn authenticate(app: &App, header: Option<&str>) -> ApiResult<Option<Auth>> {
    let Some(header) = header else {
        return Ok(None);
    };
    let (scheme, token) = header.split_once(' ').unwrap_or((header, ""));
    let token = token.trim();
    if !scheme.eq_ignore_ascii_case("bearer") || token.is_empty() {
        return Err(ApiError::new(401, "invalid_token", "Use 'Authorization: Bearer <token>'").header("WWW-Authenticate", "Bearer"));
    }
    if !is_token(token) {
        return Err(invalid_token("Malformed token"));
    }
    let session_id = sha256_hex(token.as_bytes());
    let Some(session) = app.db().get::<Session>(&session_id)? else {
        return Err(invalid_token("Unknown or revoked token"));
    };
    let Some(user) = app.db().get::<User>(&session.user_id)? else {
        return Err(invalid_token("Unknown or revoked token"));
    };
    Ok(Some(Auth { user, session_id }))
}

fn revoke(app: &App, user_id: &str, keep: Option<&str>) -> ApiResult<usize> {
    let mut revoked = 0;
    for session in app.db().query::<Session>("userId", user_id)? {
        if Some(session.id.as_str()) != keep {
            app.db().delete::<Session>(&session.id)?;
            revoked += 1;
        }
    }
    Ok(revoked)
}

/* ------------------------------------------------------------- throttle */

fn too_many(retry_after_ms: i64) -> ApiError {
    let seconds = (retry_after_ms.max(0) + 999) / 1000;
    ApiError::new(429, "too_many_requests", "Too many attempts; try again later").header("Retry-After", seconds.max(1).to_string())
}

fn window(app: &App, key: &str) -> ApiResult<Throttle> {
    let now = app.now_ms();
    Ok(app.db().get::<Throttle>(key)?.filter(|t| t.reset_at > now).unwrap_or(Throttle {
        id: key.to_string(),
        count: 0,
        reset_at: now + app.config.limits.window_ms,
    }))
}

/// 429 once `limit` is reached in the current window.
fn check(app: &App, key: &str, limit: u32) -> ApiResult<()> {
    let current = window(app, key)?;
    if current.count >= limit {
        return Err(too_many(current.reset_at - app.now_ms()));
    }
    Ok(())
}

fn count(app: &App, key: &str) -> ApiResult<()> {
    let mut current = window(app, key)?;
    current.count += 1;
    app.db().put(&current)?;
    Ok(())
}

/* ------------------------------------------------------------ endpoints */

fn signed_in(app: &App, token: String, user: &User) -> ApiResult<Value> {
    Ok(json!({ "token": token, "user": user_view(app, user)? }))
}

/// Registrations and invitation checks from one address: guessing codes is slowed here.
pub fn check_registrations(app: &App, ip: &str) -> ApiResult<()> {
    check(app, &format!("register:{ip}"), app.config.limits.registrations_per_ip)
}

pub fn count_registration(app: &App, ip: &str) -> ApiResult<()> {
    count(app, &format!("register:{ip}"))
}

/// POST /v1/auth/register { invite, login, password } → 201 { token, user }.
pub fn register(app: &App, body: &Value, ip: &str) -> ApiResult<Value> {
    let (login, typed) = login_of(body)?;
    let password = new_password(body, "password", &login)?;
    let code = body.get("invite").and_then(Value::as_str).ok_or_else(|| validation("\"invite\" is required: an invitation code", "invite"))?;
    check_registrations(app, ip)?;
    let (inviter, seq) = match invites::usable(app, code) {
        Ok(found) => found,
        Err(error) => {
            // A guess (wrong or used) counts; a mistyped code does not.
            if error.status != 400 {
                count_registration(app, ip)?;
            }
            return Err(error);
        }
    };
    let taken = || ApiError::new(409, "login_taken", "This login is taken").field("login");
    if app.db().get::<Login>(&login)?.is_some() {
        return Err(taken());
    }
    let lang = body.get("lang").and_then(Value::as_str).filter(|l| crate::text::LANGS.contains(l)).unwrap_or("en");
    check_name(app, &typed, lang)?;
    let number = app.store.increment(Counter::TABLE, invites::NUMBERS, "value")? as u64;
    let user = User {
        id: uuid_v4(),
        number,
        login: login.clone(),
        display_name: typed,
        created_at: app.now_iso(),
        password_hash: hash_password(password),
        invited_by: Some(inviter.id.clone()),
        invite_seq: Some(seq),
        invites_issued: 0,
        invites_limit: invites::BATCH,
        invites_reset_on: None,
    };
    // All at once: the login, the code's single use, the number, the user.
    let writes = [
        Write::insert(&Login { id: login, user_id: user.id.clone() })?,
        Write::insert(&Invite { id: invites::invite_id(inviter.number, seq), user_id: user.id.clone(), redeemed_at: user.created_at.clone() })?,
        Write::insert(&Number { id: number.to_string(), user_id: user.id.clone() })?,
        Write::put(&user)?,
    ];
    match app.store.transact(&writes)? {
        None => {}
        Some(0) => return Err(taken()),
        Some(1) => return Err(invites::used_error()),
        Some(_) => return Err(crate::errors::internal()),
    }
    count_registration(app, ip)?;
    let token = open_session(app, &user.id)?;
    signed_in(app, token, &user)
}

/// POST /v1/auth/login { login, password } → { token, user }.
pub fn login(app: &App, body: &Value, ip: &str) -> ApiResult<Value> {
    let typed = given(body, "login")?;
    let password = given(body, "password")?;
    let login = typed.trim().to_ascii_lowercase();
    let limits = &app.config.limits;
    check(app, &format!("sign-in:{ip}"), limits.sign_ins_per_ip)?;
    check(app, &format!("fail:{login}"), limits.failures_per_login)?;
    count(app, &format!("sign-in:{ip}"))?;
    let user = match app.db().get::<Login>(&login)? {
        Some(entry) => app.db().get::<User>(&entry.user_id)?,
        None => None,
    };
    let Some(user) = user.filter(|u| verify_password(password, &u.password_hash)) else {
        count(app, &format!("fail:{login}"))?;
        return Err(ApiError::new(401, "invalid_credentials", "Wrong login or password"));
    };
    app.db().delete::<Throttle>(&format!("fail:{login}"))?;
    let token = open_session(app, &user.id)?;
    signed_in(app, token, &user)
}

/// POST /v1/auth/logout { all?: true } → { revoked }: this device, or every one.
pub fn logout(app: &App, auth: &Auth, body: &Value) -> ApiResult<Value> {
    let revoked = if body.get("all").and_then(Value::as_bool) == Some(true) {
        revoke(app, &auth.user.id, None)?
    } else {
        usize::from(app.db().delete::<Session>(&auth.session_id)?)
    };
    Ok(json!({ "revoked": revoked }))
}

/// POST /v1/auth/password { password, newPassword } → { revoked }: the other
/// devices are signed out, this one stays.
pub fn change_password(app: &App, auth: &Auth, body: &Value) -> ApiResult<Value> {
    let current = given(body, "password")?;
    let next = new_password(body, "newPassword", &auth.user.login)?;
    let key = format!("fail:{}", auth.user.login);
    check(app, &key, app.config.limits.failures_per_login)?;
    if !verify_password(current, &auth.user.password_hash) {
        count(app, &key)?;
        return Err(ApiError::new(403, "wrong_password", "The current password is wrong").field("password"));
    }
    app.db().delete::<Throttle>(&key)?;
    let mut user = auth.user.clone();
    user.password_hash = hash_password(next);
    app.db().put(&user)?;
    Ok(json!({ "revoked": revoke(app, &user.id, Some(&auth.session_id))? }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passwords() {
        let one = hash_password("correct horse");
        assert!(verify_password("correct horse", &one));
        assert!(!verify_password("correct horse ", &one));
        assert_ne!(one, hash_password("correct horse"), "salted");
        assert!(!verify_password("x", "plain"));
        assert!(is_token(&new_token()));
    }
}
