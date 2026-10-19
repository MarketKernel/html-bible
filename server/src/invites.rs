//! Invitations (Task2.md §2–6): registration needs a code from a member.
//!
//! A code is "<inviter's number>-<seq>-<signature>": the signature is the first
//! 50 bits of HMAC-SHA256 under the server's key over the two numbers. Codes
//! are computed, never stored — the owner's list is computed again from their
//! count — and a used code leaves only the fact of its use (`invites`), which
//! makes it single-use. Codes do not expire.
//!
//! Each member may take codes up to a limit (10 at first). When it runs out,
//! it grows by 10 from the next 00:00 UTC.

use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;

use crate::app::App;
use crate::auth::hash_password;
use crate::errors::{internal, not_found, validation, ApiError, ApiResult};
use crate::ids::{iso, uuid_v4};
use crate::model::{Counter, Invite, Login, Number, User};
use crate::store::{StoreResult, Write};

/// Codes added to the limit each time it is renewed (and given at registration).
pub const BATCH: u64 = 10;
/// root's first password, in a new database and in the demo data.
pub const ROOT_PASSWORD: &str = "rootroot";
/// The counter of member numbers in `meta`.
pub const NUMBERS: &str = "userNumber";

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// The 10 base32 characters that make a code genuine.
pub fn signature(key: &[u8], number: u64, seq: u64) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes any key");
    mac.update(format!("html-bible/invite/v1:{number}:{seq}").as_bytes());
    let digest = mac.finalize().into_bytes();
    let first: [u8; 8] = digest[..8].try_into().expect("32 bytes");
    let bits = u64::from_be_bytes(first) >> 14; // the first 50 bits
    (0..10).map(|i| CROCKFORD[((bits >> (45 - 5 * i)) & 31) as usize] as char).collect()
}

/// "1-7-K3M9Q-T8ZR2"
pub fn code(key: &[u8], number: u64, seq: u64) -> String {
    let signature = signature(key, number, seq);
    format!("{number}-{seq}-{}-{}", &signature[..5], &signature[5..])
}

/// The parts of a code as a person typed it: any case, spaces or dashes between parts,
/// and the letters Crockford's base32 forgives (O for 0, I and L for 1).
pub fn parse(input: &str) -> Option<(u64, u64, String)> {
    let normal: String = input
        .chars()
        .map(|c| match c.to_ascii_uppercase() {
            // Spaces separate like dashes.
            c if c.is_whitespace() => '-',
            'O' => '0',
            'I' | 'L' => '1',
            other => other,
        })
        .collect();
    let mut parts = normal.split('-').filter(|p| !p.is_empty());
    let number = parts.next()?;
    let seq = parts.next()?;
    let signature: String = parts.collect();
    let whole = |text: &str| -> Option<u64> { (text.len() <= 12 && text.bytes().all(|b| b.is_ascii_digit())).then(|| text.parse().ok()).flatten() };
    let (number, seq) = (whole(number)?, whole(seq)?);
    if number == 0 || seq == 0 || signature.len() != 10 || !signature.bytes().all(|b| CROCKFORD.contains(&b)) {
        return None;
    }
    Some((number, seq, signature))
}

fn invalid() -> ApiError {
    ApiError::new(403, "invalid_invite", "This invitation code is not valid").field("invite")
}

fn used() -> ApiError {
    ApiError::new(409, "invite_used", "This invitation code has been used").field("invite")
}

/// A genuine code → its inviter and the code's number. Says nothing about use.
pub fn verify(app: &App, input: &str) -> ApiResult<(User, u64)> {
    let Some((number, seq, given)) = parse(input) else {
        return Err(validation("\"invite\" is not an invitation code", "invite"));
    };
    let expected = signature(&app.config.invite_key, number, seq);
    // Compared in constant time: how long it takes says nothing about the code.
    if expected.bytes().zip(given.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) != 0 {
        return Err(invalid());
    }
    let inviter = match app.db().get::<Number>(&number.to_string())? {
        Some(entry) => app.db().get::<User>(&entry.user_id)?,
        None => None,
    };
    match inviter {
        Some(inviter) if seq <= inviter.invites_issued => Ok((inviter, seq)),
        _ => Err(invalid()),
    }
}

pub fn invite_id(number: u64, seq: u64) -> String {
    format!("{number}:{seq}")
}

/// A genuine code that nobody has used yet.
pub fn usable(app: &App, input: &str) -> ApiResult<(User, u64)> {
    let (inviter, seq) = verify(app, input)?;
    if app.db().get::<Invite>(&invite_id(inviter.number, seq))?.is_some() {
        return Err(used());
    }
    Ok((inviter, seq))
}

pub fn used_error() -> ApiError {
    used()
}

/* -------------------------------------------------------------- the limit */

fn day(ms: i64) -> String {
    iso(ms)[..10].to_string()
}

/// Codes the user may take right now.
fn available(app: &App, user: &User) -> u64 {
    if user.invites_issued < user.invites_limit {
        return user.invites_limit - user.invites_issued;
    }
    match &user.invites_reset_on {
        Some(on) if day(app.now_ms()) < *on => 0,
        _ => BATCH,
    }
}

/// POST /v1/invites → 201 { seq, code }: the user's next code, if the limit allows.
pub fn issue(app: &App, user_id: &str) -> ApiResult<Value> {
    // Two requests at once must not get the same number: the user is saved only
    // while invitesIssued is still what was read, and the loser tries again.
    for _ in 0..5 {
        let mut user = app.db().get::<User>(user_id)?.ok_or_else(|| not_found("User not found"))?;
        let read = user.invites_issued;
        if user.invites_issued >= user.invites_limit {
            match &user.invites_reset_on {
                Some(on) if day(app.now_ms()) < *on => {
                    return Err(ApiError::new(429, "invite_limit", format!("No more invitation codes until {on} 00:00 UTC"))
                        .extra("resetOn", json!(on)));
                }
                _ => {
                    user.invites_limit += BATCH;
                    user.invites_reset_on = None;
                }
            }
        }
        user.invites_issued += 1;
        let seq = user.invites_issued;
        if user.invites_issued >= user.invites_limit {
            user.invites_reset_on = Some(day(app.now_ms() + 86_400_000));
        }
        if app.db().put_if(&user, "invitesIssued", &json!(read))? {
            return Ok(json!({ "seq": seq, "code": code(&app.config.invite_key, user.number, seq) }));
        }
    }
    Err(internal())
}

/// GET /v1/invites: the limit and every code the user has taken, with who used it.
pub fn state(app: &App, user_id: &str) -> ApiResult<Value> {
    let user = app.db().get::<User>(user_id)?.ok_or_else(|| not_found("User not found"))?;
    let invitees = app.db().query::<User>("invitedBy", &user.id)?;
    let codes: Vec<Value> = (1..=user.invites_issued)
        .map(|seq| {
            let mut entry = json!({ "seq": seq, "code": code(&app.config.invite_key, user.number, seq) });
            if let Some(member) = invitees.iter().find(|u| u.invite_seq == Some(seq)) {
                entry["usedBy"] = json!({ "id": member.id, "displayName": member.display_name, "at": member.created_at });
            }
            entry
        })
        .collect();
    Ok(json!({
        "issued": user.invites_issued,
        "limit": user.invites_limit,
        "resetOn": user.invites_reset_on,
        "available": available(app, &user),
        "codes": codes,
    }))
}

/// GET /v1/invites/{code}: who invites, for "Anna invites you" before registering.
pub fn check(app: &App, input: &str) -> ApiResult<Value> {
    let (inviter, _) = usable(app, input)?;
    Ok(json!({ "inviter": { "id": inviter.id, "displayName": inviter.display_name } }))
}

/* --------------------------------------------------------------- profiles */

fn person(user: &User) -> Value {
    json!({ "id": user.id, "displayName": user.display_name })
}

/// The user's inviter as { id, displayName }, or None for root.
pub fn inviter_of(app: &App, user: &User) -> StoreResult<Option<Value>> {
    let Some(id) = &user.invited_by else { return Ok(None) };
    Ok(Some(match app.db().get::<User>(id)? {
        Some(inviter) => person(&inviter),
        None => json!({ "id": id, "displayName": "—" }),
    }))
}

/// GET /v1/users/{id}: what anyone may see — never the login or the codes.
pub fn profile(app: &App, id: &str) -> ApiResult<Value> {
    let user = app.db().get::<User>(id)?.ok_or_else(|| not_found("User not found"))?;
    let mut invitees = app.db().query::<User>("invitedBy", &user.id)?;
    invitees.sort_by(|a, b| (&a.created_at, &a.id).cmp(&(&b.created_at, &b.id)));
    Ok(json!({
        "id": user.id,
        "number": user.number,
        "displayName": user.display_name,
        "createdAt": user.created_at,
        "invitedBy": inviter_of(app, &user)?,
        "invitees": invitees.iter().map(|u| json!({ "id": u.id, "displayName": u.display_name, "createdAt": u.created_at })).collect::<Vec<_>>(),
    }))
}

/* ------------------------------------------------------------------- root */

/// A new database gets its first member: root, number 1, password "rootroot"
/// (the usual rules: 8 characters, not the login), to be changed in the profile.
/// "New" means the member counter does not exist yet; it is made in the same
/// write, so root is made once. True when made now.
pub fn ensure_root(app: &App) -> StoreResult<bool> {
    if app.db().get::<Counter>(NUMBERS)?.is_some() {
        return Ok(false);
    }
    let root = User {
        id: uuid_v4(),
        number: 1,
        login: "root".into(),
        display_name: "root".into(),
        created_at: app.now_iso(),
        password_hash: hash_password(ROOT_PASSWORD),
        invited_by: None,
        invite_seq: None,
        invites_issued: 0,
        invites_limit: BATCH,
        invites_reset_on: None,
    };
    let writes = [
        Write::insert(&Counter { id: NUMBERS.into(), value: 1 })?,
        Write::insert(&Login { id: root.login.clone(), user_id: root.id.clone() })?,
        Write::insert(&Number { id: "1".into(), user_id: root.id.clone() })?,
        Write::put(&root)?,
    ];
    let made = app.store.transact(&writes)?.is_none();
    app.store.flush()?;
    Ok(made)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes() {
        let key = b"test key";
        let one = code(key, 1, 7);
        assert_eq!(one.len(), "1-7-".len() + 11);
        let (number, seq, sig) = parse(&one).unwrap();
        assert_eq!((number, seq, sig.as_str()), (1, 7, signature(key, 1, 7).as_str()));
        // As a person may type it.
        let typed = one.to_lowercase().replace('-', " - ").replace('0', "o").replace('1', "l");
        assert_eq!(parse(&typed).map(|p| p.2), Some(signature(key, 1, 7)));
        assert!(parse(&one.replace('-', "")).is_none(), "the numbers need their dashes");
        assert_ne!(signature(key, 1, 7), signature(key, 1, 8));
        assert_ne!(signature(key, 1, 7), signature(b"other key", 1, 7));
        for bad in ["", "1-7", "0-1-ABCDEFGHJK", "1-7-ABCDEFGHJ", "1-7-ABCDEFGHJU", "x-7-ABCDEFGHJK"] {
            assert!(parse(bad).is_none(), "{bad}");
        }
    }
}
