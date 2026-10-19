//! One function per endpoint: read the request, run the pipeline, render.
//! The contract is docs/api.md.

use serde_json::{json, Value};

use crate::app::App;
use crate::auth;
use crate::invites;
use crate::errors::{not_found, validation, ApiResult};
use crate::model::{Question, Verse};
use crate::pipeline as p;
use crate::refs::{check_book, invalid_ref, is_book_id};
use crate::router::Call;
use crate::text::query_lang;
use crate::views::{user_view, View};
use crate::errors::repr;
use crate::http::Response;

fn ok(body: Value) -> ApiResult<Response> {
    Ok(Response::json(200, &body))
}

fn created(body: Value, location: String) -> ApiResult<Response> {
    Ok(Response::json(201, &body).with_header("Location", location))
}

pub fn health(_: &App, _: &Call) -> ApiResult<Response> {
    ok(json!({ "ok": true, "version": crate::VERSION }))
}

/* ---------------------------------------------------------------- auth */

pub fn register(app: &App, call: &Call) -> ApiResult<Response> {
    Ok(Response::json(201, &auth::register(app, &call.request.json()?, &call.request.source_ip)?))
}

pub fn login(app: &App, call: &Call) -> ApiResult<Response> {
    ok(auth::login(app, &call.request.json()?, &call.request.source_ip)?)
}

pub fn logout(app: &App, call: &Call) -> ApiResult<Response> {
    ok(auth::logout(app, call.user()?, &call.request.json_or_empty()?)?)
}

pub fn change_password(app: &App, call: &Call) -> ApiResult<Response> {
    ok(auth::change_password(app, call.user()?, &call.request.json()?)?)
}

pub fn get_me(app: &App, call: &Call) -> ApiResult<Response> {
    ok(user_view(app, &call.user()?.user)?)
}

pub fn patch_me(app: &App, call: &Call) -> ApiResult<Response> {
    let user = p::patch_me(app, &call.user()?.user, &call.request.json()?)?;
    ok(user_view(app, &user)?)
}

/* ---------------------------------------------------- invitations, people */

pub fn issue_invite(app: &App, call: &Call) -> ApiResult<Response> {
    Ok(Response::json(201, &invites::issue(app, &call.user()?.user.id)?))
}

pub fn list_invites(app: &App, call: &Call) -> ApiResult<Response> {
    ok(invites::state(app, &call.user()?.user.id)?)
}

/// GET /v1/invites/{code}: failures count like failed registrations (guessing).
pub fn check_invite(app: &App, call: &Call) -> ApiResult<Response> {
    let ip = &call.request.source_ip;
    auth::check_registrations(app, ip)?;
    match invites::check(app, &crate::http::decode(&call.id)) {
        Ok(found) => ok(found),
        Err(error) => {
            // A guess (wrong or used) counts; a half-typed code does not.
            if error.status != 400 {
                auth::count_registration(app, ip)?;
            }
            Err(error)
        }
    }
}

pub fn user_profile(app: &App, call: &Call) -> ApiResult<Response> {
    ok(invites::profile(app, &call.id)?)
}

/* ----------------------------------------------------------- questions */

pub fn list_questions(app: &App, call: &Call) -> ApiResult<Response> {
    query_lang(call.request.param("lang").as_deref())?;
    let tag = call.request.param("tag").map(|t| t.trim().to_lowercase()).filter(|t| !t.is_empty());
    let view = View::new(app, call.viewer());
    let mut questions: Vec<Question> =
        app.db().scan::<Question>()?.into_iter().filter(|q| tag.as_ref().is_none_or(|t| q.tags.contains(t))).collect();
    questions.sort_by(|a, b| (&b.created_at, &b.id).cmp(&(&a.created_at, &a.id)));
    let list: Vec<Value> = questions.iter().map(|q| view.question(q, true, None)).collect::<Result<_, _>>()?;
    ok(json!({ "questions": list }))
}

pub fn create_question(app: &App, call: &Call) -> ApiResult<Response> {
    let user = &call.user()?.user;
    let question = p::create_question(app, user, &call.request.json()?)?;
    created(View::new(app, Some(&user.id)).question(&question, false, None)?, format!("/v1/questions/{}", question.id))
}

pub fn get_question(app: &App, call: &Call) -> ApiResult<Response> {
    query_lang(call.request.param("lang").as_deref())?;
    let question = app.db().get::<Question>(&call.id)?.ok_or_else(|| not_found("Question not found"))?;
    ok(View::new(app, call.viewer()).question_full(&question)?)
}

pub fn patch_question(app: &App, call: &Call) -> ApiResult<Response> {
    let user = &call.user()?.user;
    let question = p::patch_question(app, user, &call.id, &call.request.json()?)?;
    ok(View::new(app, Some(&user.id)).question(&question, false, None)?)
}

pub fn delete_question(app: &App, call: &Call) -> ApiResult<Response> {
    ok(p::delete_question(app, &call.user()?.user, &call.id)?)
}

/* ----------------------------------------------------------- arguments */

pub fn create_argument(app: &App, call: &Call) -> ApiResult<Response> {
    let user = &call.user()?.user;
    let argument = p::create_argument(app, user, &call.id, &call.request.json()?)?;
    created(View::new(app, Some(&user.id)).argument(&argument, None)?, format!("/v1/arguments/{}", argument.id))
}

pub fn patch_argument(app: &App, call: &Call) -> ApiResult<Response> {
    let user = &call.user()?.user;
    let argument = p::patch_argument(app, user, &call.id, &call.request.json()?)?;
    ok(View::new(app, Some(&user.id)).argument(&argument, None)?)
}

pub fn delete_argument(app: &App, call: &Call) -> ApiResult<Response> {
    ok(p::delete_argument(app, &call.user()?.user, &call.id)?)
}

/* -------------------------------------------------------------- verses */

pub fn create_verse(app: &App, call: &Call) -> ApiResult<Response> {
    let user = &call.user()?.user;
    let verse = p::create_verse(app, user, &call.id, &call.request.json()?)?;
    created(View::new(app, Some(&user.id)).verse(&verse)?, format!("/v1/verses/{}", verse.id))
}

pub fn delete_verse(app: &App, call: &Call) -> ApiResult<Response> {
    ok(p::delete_verse(app, &call.user()?.user, &call.id)?)
}

pub fn verse_rating(app: &App, call: &Call) -> ApiResult<Response> {
    let verse = app.db().get::<Verse>(&call.id)?.ok_or_else(|| not_found("Verse not found"))?;
    ok(View::new(app, call.viewer()).verse_rating(&verse)?)
}

/* ----------------------------------------------------- interpretations */

pub fn create_interpretation(app: &App, call: &Call) -> ApiResult<Response> {
    let user = &call.user()?.user;
    let item = p::create_interpretation(app, user, &call.id, &call.request.json()?)?;
    created(View::new(app, Some(&user.id)).interpretation(&item)?, format!("/v1/interpretations/{}", item.id))
}

pub fn patch_interpretation(app: &App, call: &Call) -> ApiResult<Response> {
    let user = &call.user()?.user;
    let item = p::patch_interpretation(app, user, &call.id, &call.request.json()?)?;
    ok(View::new(app, Some(&user.id)).interpretation(&item)?)
}

pub fn delete_interpretation(app: &App, call: &Call) -> ApiResult<Response> {
    ok(p::delete_interpretation(app, &call.user()?.user, &call.id)?)
}

/* --------------------------------------------------------------- votes */

pub fn put_vote(app: &App, call: &Call) -> ApiResult<Response> {
    let user = &call.user()?.user;
    let verse = p::put_vote(app, user, &call.id, &call.request.json()?)?;
    ok(View::new(app, Some(&user.id)).vote_result(&verse)?)
}

pub fn put_interpretation_vote(app: &App, call: &Call) -> ApiResult<Response> {
    let user = &call.user()?.user;
    let item = p::put_interpretation_vote(app, user, &call.id, &call.request.json()?)?;
    ok(json!({ "votes": View::new(app, Some(&user.id)).interpretation_votes(&item)? }))
}

/* ---------------------------------------------------------- verse tags */

/// GET /v1/verse-tags?book=JHN&chapter=3 — which verses of a chapter are "stones" in discussions.
pub fn verse_tags(app: &App, call: &Call) -> ApiResult<Response> {
    query_lang(call.request.param("lang").as_deref())?;
    let Some(book) = call.request.param("book").filter(|b| !b.is_empty()) else {
        return Err(validation("\"book\" is required (a canonical USFM id such as JHN)", "book"));
    };
    if !is_book_id(&book) {
        return Err(invalid_ref(format!("Unknown book id {}", repr(&book)), "book"));
    }
    check_book(&book, "book")?;
    let text = call.request.param("chapter").unwrap_or_default();
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) || text.bytes().all(|b| b == b'0') {
        return Err(validation("\"chapter\" must be a whole number ≥ 1", "chapter"));
    }
    let chapter: u32 = text.parse().unwrap_or(u32::MAX);
    if let Some(count) = crate::books::chapters(&book) {
        if chapter > count {
            return Err(invalid_ref(format!("{book} has {count} chapters"), "chapter"));
        }
    }
    let tags = p::verse_tags(app, &book, chapter, &View::new(app, call.viewer()))?;
    ok(json!({ "book": book, "chapter": chapter, "tags": tags }))
}
