//! Everything that changes discussions: the save pipeline (Task.md §6)
//!
//! ```text
//! validate → review() (decency, relevance, translation: one call) → save
//!   → for a verse or interpretation: verse ai.status = "pending" → evaluate(verse)
//! ```
//!
//! plus deletion (soft when something hangs off the item), votes and verse tags.
//! Tallies are computed on read (views.rs), so nothing needs recounting here.
//! Functions take stored records or ids and return stored records; handlers render.

use serde_json::{json, Value};

use crate::app::App;
use crate::errors::{deleted, forbidden, item_deleted, not_found, validation, validation_general, ApiError, ApiResult};
use crate::evaluation;
use crate::llm::{Review, Subject};
use crate::model::{Argument, Interpretation, Question, Record, Sides, Text, User, Verse, VerseAi, Vote};
use crate::originals;
use crate::refs;
use crate::text::{clean_line, clean_md, clean_tags, require_lang, LANGS, NAME_MAX, SIDE_MAX, TITLE_MAX};
use crate::views::View;

/* ------------------------------------------------------------- helpers */

/// Review what is being saved and give it back in both languages, field by field.
pub fn review(app: &App, subject: &Subject, lang: &str, fields: &[(&str, &str)]) -> ApiResult<Vec<Text>> {
    let unavailable = || ApiError::new(503, "moderation_unavailable", "Moderation is unavailable; nothing was saved. Try again later.");
    match app.reviewer.review(subject, lang, fields) {
        Ok(Review::Allowed(other)) if other.len() == fields.len() => Ok(fields
            .iter()
            .zip(other)
            .map(|((_, text), other)| {
                let (ru, en) = if lang == "ru" { (text.to_string(), other) } else { (other, text.to_string()) };
                Text { orig: lang.to_string(), ru, en }
            })
            .collect()),
        Ok(Review::Allowed(_)) => Err(unavailable()),
        Ok(Review::Rejected(reason)) => {
            let reason = if reason.is_empty() { "Rejected by moderation".to_string() } else { reason };
            Err(ApiError::new(422, "moderation_rejected", reason.clone()).reason(reason))
        }
        Err(_) => Err(unavailable()),
    }
}

/// A display name: decency only.
pub fn check_name(app: &App, name: &str, lang: &str) -> ApiResult<()> {
    review(app, &Subject::Name, lang, &[("displayName", name)]).map(|_| ())
}

fn get<T: Record>(app: &App, id: &str, what: &str) -> ApiResult<T> {
    app.db().get::<T>(id)?.ok_or_else(|| not_found(format!("{what} not found")))
}

fn own(author_id: &str, user: &User) -> ApiResult<()> {
    if author_id == user.id {
        Ok(())
    } else {
        Err(forbidden())
    }
}

fn alive(is_deleted: bool) -> ApiResult<()> {
    if is_deleted {
        Err(item_deleted())
    } else {
        Ok(())
    }
}

fn field<'a>(body: &'a Value, name: &str) -> &'a Value {
    body.get(name).unwrap_or(&Value::Null)
}

fn has(body: &Value, name: &str) -> bool {
    body.get(name).is_some()
}

const SIDES_MESSAGE: &str = "\"sides\" must be an object { pro, con }";

/// The two position labels as the author wrote them, checked.
fn side_texts(value: &Value) -> ApiResult<[String; 2]> {
    if !value.is_object() {
        return Err(validation(SIDES_MESSAGE, "sides"));
    }
    Ok([clean_line(field(value, "pro"), "sides.pro", SIDE_MAX)?, clean_line(field(value, "con"), "sides.con", SIDE_MAX)?])
}

fn default_sides(lang: &str) -> Sides {
    let text = |ru: &str, en: &str| Text { orig: lang.to_string(), ru: ru.into(), en: en.into() };
    Sides { pro: text("За", "For"), con: text("Против", "Against") }
}

/* ---------------------------------------------------------------- users */

pub fn patch_me(app: &App, user: &User, body: &Value) -> ApiResult<User> {
    if !has(body, "displayName") {
        return Err(validation("\"displayName\" is required", "displayName"));
    }
    let name = clean_line(field(body, "displayName"), "displayName", NAME_MAX)?;
    let lang = body.get("lang").and_then(Value::as_str).filter(|l| LANGS.contains(l)).unwrap_or("en");
    check_name(app, &name, lang)?;
    let mut user = get::<User>(app, &user.id, "User")?;
    user.display_name = name;
    app.db().put(&user)?;
    Ok(user)
}

/* ------------------------------------------------------------ questions */

pub fn create_question(app: &App, user: &User, body: &Value) -> ApiResult<Question> {
    let lang = require_lang(body)?;
    let title = clean_line(field(body, "title"), "title", TITLE_MAX)?;
    let summary = clean_md(body.get("summaryMd").unwrap_or(&json!("")), "summaryMd", false)?;
    let tags = clean_tags(body.get("tags").unwrap_or(&json!([])))?;
    let sides_in = body.get("sides").filter(|v| !v.is_null());
    let sides_text = sides_in.map(side_texts).transpose()?;
    let mut fields = vec![("title", title.as_str()), ("summaryMd", summary.as_str())];
    if let Some([pro, con]) = &sides_text {
        fields.extend([("sides.pro", pro.as_str()), ("sides.con", con.as_str())]);
    }
    let mut texts = review(app, &Subject::Question, &lang, &fields)?.into_iter();
    let (title, summary_md) = (texts.next().expect("reviewed"), texts.next().expect("reviewed"));
    let sides = match sides_text {
        Some(_) => Sides { pro: texts.next().expect("reviewed"), con: texts.next().expect("reviewed") },
        None => default_sides(&lang),
    };
    let question = Question {
        id: app.new_id(),
        title,
        summary_md,
        sides,
        tags,
        author_id: user.id.clone(),
        created_at: app.now_iso(),
        updated_at: None,
        deleted: false,
    };
    app.db().put(&question)?;
    Ok(question)
}

pub fn patch_question(app: &App, user: &User, question_id: &str, body: &Value) -> ApiResult<Question> {
    let mut question = get::<Question>(app, question_id, "Question")?;
    own(&question.author_id, user)?;
    alive(question.deleted)?;
    if !["title", "summaryMd", "sides", "tags"].iter().any(|k| has(body, k)) {
        return Err(validation_general("Nothing to change: send title, summaryMd, sides or tags"));
    }
    let has_text = ["title", "summaryMd", "sides"].iter().any(|k| has(body, k));
    let lang = if has_text { Some(require_lang(body)?) } else { None };
    let title = has(body, "title").then(|| clean_line(field(body, "title"), "title", TITLE_MAX)).transpose()?;
    let summary = has(body, "summaryMd").then(|| clean_md(field(body, "summaryMd"), "summaryMd", false)).transpose()?;
    let sides = has(body, "sides").then(|| side_texts(field(body, "sides"))).transpose()?;
    let tags = has(body, "tags").then(|| clean_tags(field(body, "tags"))).transpose()?;
    if let Some(lang) = &lang {
        let mut fields: Vec<(&str, &str)> = Vec::new();
        if let Some(title) = &title {
            fields.push(("title", title));
        }
        if let Some(summary) = &summary {
            fields.push(("summaryMd", summary));
        }
        if let Some([pro, con]) = &sides {
            fields.extend([("sides.pro", pro.as_str()), ("sides.con", con.as_str())]);
        }
        let mut texts = review(app, &Subject::Question, lang, &fields)?.into_iter();
        if title.is_some() {
            question.title = texts.next().expect("reviewed");
        }
        if summary.is_some() {
            question.summary_md = texts.next().expect("reviewed");
        }
        if sides.is_some() {
            question.sides = Sides { pro: texts.next().expect("reviewed"), con: texts.next().expect("reviewed") };
        }
    }
    if let Some(tags) = tags {
        question.tags = tags;
    }
    question.updated_at = Some(app.now_iso());
    app.db().put(&question)?;
    Ok(question)
}

pub fn delete_question(app: &App, user: &User, question_id: &str) -> ApiResult<Value> {
    let mut question = get::<Question>(app, question_id, "Question")?;
    own(&question.author_id, user)?;
    if !app.db().query::<Argument>("questionId", question_id)?.is_empty() {
        if !question.deleted {
            question.deleted = true;
            question.title = question.title.blank();
            question.summary_md = question.summary_md.blank();
            question.sides = Sides { pro: question.sides.pro.blank(), con: question.sides.con.blank() };
            question.updated_at = Some(app.now_iso());
            app.db().put(&question)?;
        }
        return Ok(json!({ "id": question_id, "deleted": "soft" }));
    }
    app.db().delete::<Question>(question_id)?;
    Ok(json!({ "id": question_id, "deleted": "hard" }))
}

/* ------------------------------------------------------------ arguments */

pub fn create_argument(app: &App, user: &User, question_id: &str, body: &Value) -> ApiResult<Argument> {
    let question = get::<Question>(app, question_id, "Question")?;
    alive(question.deleted)?;
    let lang = require_lang(body)?;
    let title = clean_line(field(body, "title"), "title", TITLE_MAX)?;
    let summary = clean_md(body.get("summaryMd").unwrap_or(&json!("")), "summaryMd", false)?;
    let mut texts = review(app, &Subject::Argument { question: &question }, &lang, &[("title", &title), ("summaryMd", &summary)])?.into_iter();
    let argument = Argument {
        id: app.new_id(),
        question_id: question_id.to_string(),
        title: texts.next().expect("reviewed"),
        summary_md: texts.next().expect("reviewed"),
        author_id: user.id.clone(),
        created_at: app.now_iso(),
        updated_at: None,
        deleted: false,
    };
    app.db().put(&argument)?;
    Ok(argument)
}

pub fn patch_argument(app: &App, user: &User, argument_id: &str, body: &Value) -> ApiResult<Argument> {
    let mut argument = get::<Argument>(app, argument_id, "Argument")?;
    own(&argument.author_id, user)?;
    alive(argument.deleted)?;
    if !has(body, "title") && !has(body, "summaryMd") {
        return Err(validation_general("Nothing to change: send title or summaryMd"));
    }
    let lang = require_lang(body)?;
    let title = has(body, "title").then(|| clean_line(field(body, "title"), "title", TITLE_MAX)).transpose()?;
    let summary = has(body, "summaryMd").then(|| clean_md(field(body, "summaryMd"), "summaryMd", false)).transpose()?;
    let question = get::<Question>(app, &argument.question_id, "Question")?;
    let mut fields: Vec<(&str, &str)> = Vec::new();
    if let Some(title) = &title {
        fields.push(("title", title));
    }
    if let Some(summary) = &summary {
        fields.push(("summaryMd", summary));
    }
    let mut texts = review(app, &Subject::Argument { question: &question }, &lang, &fields)?.into_iter();
    if title.is_some() {
        argument.title = texts.next().expect("reviewed");
    }
    if summary.is_some() {
        argument.summary_md = texts.next().expect("reviewed");
    }
    argument.updated_at = Some(app.now_iso());
    app.db().put(&argument)?;
    Ok(argument)
}

pub fn delete_argument(app: &App, user: &User, argument_id: &str) -> ApiResult<Value> {
    let mut argument = get::<Argument>(app, argument_id, "Argument")?;
    own(&argument.author_id, user)?;
    if app.db().query::<Verse>("argumentId", argument_id)?.is_empty() {
        app.db().delete::<Argument>(argument_id)?;
        collect_question(app, &argument.question_id)?;
        return Ok(json!({ "id": argument_id, "deleted": "hard" }));
    }
    if !argument.deleted {
        argument.deleted = true;
        argument.title = argument.title.blank();
        argument.summary_md = argument.summary_md.blank();
        argument.updated_at = Some(app.now_iso());
        app.db().put(&argument)?;
    }
    Ok(json!({ "id": argument_id, "deleted": "soft" }))
}

/* --------------------------------------------------------------- verses */

/// Add a "stone" to a subtopic: one canonical range, unique within the subtopic.
pub fn create_verse(app: &App, user: &User, argument_id: &str, body: &Value) -> ApiResult<Verse> {
    let argument = get::<Argument>(app, argument_id, "Argument")?;
    alive(argument.deleted)?;
    let question = get::<Question>(app, &argument.question_id, "Question")?;
    alive(question.deleted)?;
    if !has(body, "ref") {
        return Err(validation("\"ref\" is required: { from, to }", "ref"));
    }
    let range = refs::parse_range(field(body, "ref"), "ref")?;
    if let Some(existing) = app.db().query::<Verse>("argumentId", argument_id)?.into_iter().find(|v| v.range == range) {
        return Err(ApiError::new(409, "duplicate_verse", "This verse is already in the subtopic").field("ref").extra("id", json!(existing.id)));
    }
    // From the server's own table, never from the request.
    let original = originals::lookup(&app.db(), &range)?;
    let verse = Verse {
        id: app.new_id(),
        argument_id: argument_id.to_string(),
        question_id: argument.question_id.clone(),
        range,
        author_id: user.id.clone(),
        created_at: app.now_iso(),
        ai: VerseAi { status: "none".into(), verdicts: Vec::new(), input_hash: None },
        original,
    };
    app.db().put(&verse)?;
    evaluation::request(app, &verse.id)?;
    get::<Verse>(app, &verse.id, "Verse")
}

/// Only the author, and only while nobody else voted and there are no interpretations.
pub fn delete_verse(app: &App, user: &User, verse_id: &str) -> ApiResult<Value> {
    let verse = get::<Verse>(app, verse_id, "Verse")?;
    own(&verse.author_id, user)?;
    let votes = app.db().query::<Vote>("targetKey", &format!("verse:{verse_id}"))?;
    if votes.iter().any(|v| v.user_id != user.id) {
        return Err(ApiError::new(409, "in_use", "Others have voted on this verse; it can no longer be removed"));
    }
    if !app.db().query::<Interpretation>("verseId", verse_id)?.is_empty() {
        return Err(ApiError::new(409, "in_use", "This verse has interpretations; it can no longer be removed"));
    }
    remove_verse(app, verse_id)?;
    if let Some(argument) = app.db().get::<Argument>(&verse.argument_id)? {
        if argument.deleted && app.db().query::<Verse>("argumentId", &argument.id)?.is_empty() {
            app.db().delete::<Argument>(&argument.id)?;
            collect_question(app, &argument.question_id)?;
        }
    }
    Ok(json!({ "id": verse_id, "deleted": "hard" }))
}

/* ------------------------------------------------------ interpretations */

pub fn create_interpretation(app: &App, user: &User, verse_id: &str, body: &Value) -> ApiResult<Interpretation> {
    let verse = get::<Verse>(app, verse_id, "Verse")?;
    let argument = get::<Argument>(app, &verse.argument_id, "Argument")?;
    alive(argument.deleted)?;
    let lang = require_lang(body)?;
    let side = match body.get("side").and_then(Value::as_str) {
        Some(side @ ("pro" | "con")) => side.to_string(),
        _ => return Err(validation("\"side\" must be \"pro\" or \"con\"", "side")),
    };
    let text = clean_md(field(body, "bodyMd"), "bodyMd", true)?;
    let reply_to = body.get("replyTo").filter(|v| !v.is_null());
    if let Some(reply_to) = reply_to {
        let target = match reply_to.as_str() {
            Some(id) => app.db().get::<Interpretation>(id)?,
            None => None,
        };
        match target {
            Some(target) if target.verse_id == verse_id => {
                if target.deleted {
                    return Err(deleted("The interpretation you reply to was deleted by its author"));
                }
            }
            _ => return Err(validation("\"replyTo\" must be an interpretation of the same verse", "replyTo")),
        }
    }
    let question = get::<Question>(app, &verse.question_id, "Question")?;
    let subject = Subject::Interpretation { question: &question, argument: &argument, verse: &verse.range, side: &side };
    let body_md = review(app, &subject, &lang, &[("bodyMd", &text)])?.remove(0);
    let item = Interpretation {
        id: app.new_id(),
        verse_id: verse_id.to_string(),
        argument_id: verse.argument_id.clone(),
        question_id: verse.question_id.clone(),
        side,
        body_md,
        reply_to: reply_to.and_then(Value::as_str).filter(|r| !r.is_empty()).map(str::to_string),
        author_id: user.id.clone(),
        created_at: app.now_iso(),
        updated_at: None,
        deleted: false,
    };
    app.db().put(&item)?;
    evaluation::request(app, verse_id)?;
    Ok(item)
}

pub fn patch_interpretation(app: &App, user: &User, item_id: &str, body: &Value) -> ApiResult<Interpretation> {
    let mut item = get::<Interpretation>(app, item_id, "Interpretation")?;
    own(&item.author_id, user)?;
    alive(item.deleted)?;
    let current = [("side", json!(item.side)), ("replyTo", json!(item.reply_to))];
    for (name, value) in current {
        if let Some(sent) = body.get(name) {
            if *sent != value {
                return Err(validation(format!("\"{name}\" cannot be changed; delete and write a new one"), name));
            }
        }
    }
    if !has(body, "bodyMd") {
        return Err(validation_general("Nothing to change: send bodyMd"));
    }
    let lang = require_lang(body)?;
    let text = clean_md(field(body, "bodyMd"), "bodyMd", true)?;
    let verse = get::<Verse>(app, &item.verse_id, "Verse")?;
    let argument = get::<Argument>(app, &item.argument_id, "Argument")?;
    let question = get::<Question>(app, &item.question_id, "Question")?;
    let subject = Subject::Interpretation { question: &question, argument: &argument, verse: &verse.range, side: &item.side };
    item.body_md = review(app, &subject, &lang, &[("bodyMd", &text)])?.remove(0);
    item.updated_at = Some(app.now_iso());
    app.db().put(&item)?;
    evaluation::request(app, &item.verse_id)?;
    Ok(item)
}

pub fn delete_interpretation(app: &App, user: &User, item_id: &str) -> ApiResult<Value> {
    let mut item = get::<Interpretation>(app, item_id, "Interpretation")?;
    own(&item.author_id, user)?;
    if item.deleted {
        return Ok(json!({ "id": item_id, "deleted": "soft" }));
    }
    let result = if !app.db().query::<Interpretation>("replyTo", item_id)?.is_empty() {
        item.deleted = true;
        item.body_md = item.body_md.blank();
        item.updated_at = Some(app.now_iso());
        app.db().put(&item)?;
        json!({ "id": item_id, "deleted": "soft" })
    } else {
        remove_interpretation(app, item_id)?;
        collect_reply_chain(app, &item)?;
        json!({ "id": item_id, "deleted": "hard" })
    };
    evaluation::request(app, &item.verse_id)?;
    Ok(result)
}

/* -------------------------------------------- removal and collection */

/// Hard delete of a verse with the votes on it.
fn remove_verse(app: &App, verse_id: &str) -> ApiResult<()> {
    app.db().delete::<Verse>(verse_id)?;
    remove_votes(app, &format!("verse:{verse_id}"))
}

fn remove_interpretation(app: &App, item_id: &str) -> ApiResult<()> {
    app.db().delete::<Interpretation>(item_id)?;
    remove_votes(app, &format!("interpretation:{item_id}"))
}

fn remove_votes(app: &App, target_key: &str) -> ApiResult<()> {
    for vote in app.db().query::<Vote>("targetKey", target_key)? {
        app.db().delete::<Vote>(&vote.id)?;
    }
    Ok(())
}

/// After a hard delete, soft-deleted parents that lost their last reply go too.
fn collect_reply_chain(app: &App, item: &Interpretation) -> ApiResult<()> {
    let mut parent_id = item.reply_to.clone().filter(|r| !r.is_empty());
    while let Some(id) = parent_id {
        let Some(parent) = app.db().get::<Interpretation>(&id)? else { break };
        if !parent.deleted || !app.db().query::<Interpretation>("replyTo", &id)?.is_empty() {
            break;
        }
        remove_interpretation(app, &id)?;
        parent_id = parent.reply_to.filter(|r| !r.is_empty());
    }
    Ok(())
}

fn collect_question(app: &App, question_id: &str) -> ApiResult<()> {
    if let Some(question) = app.db().get::<Question>(question_id)? {
        if question.deleted && app.db().query::<Argument>("questionId", question_id)?.is_empty() {
            app.db().delete::<Question>(question_id)?;
        }
    }
    Ok(())
}

/* ---------------------------------------------------------------- votes */

/// The body's "value": one of `allowed`, or null. Booleans are not numbers here.
fn vote_value(body: &Value, allowed: &[i64], required: &str, invalid: &str) -> ApiResult<Option<i64>> {
    let Some(value) = body.get("value") else {
        return Err(validation(required, "value"));
    };
    if value.is_null() {
        return Ok(None);
    }
    match value.as_i64().or_else(|| value.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)) {
        Some(n) if allowed.contains(&n) && !value.is_boolean() => Ok(Some(n)),
        _ => Err(validation(invalid, "value")),
    }
}

fn set_vote(app: &App, kind: &str, target_id: &str, user: &User, value: Option<i64>) -> ApiResult<()> {
    let id = format!("{kind}:{target_id}:{}", user.id);
    let Some(value) = value else {
        app.db().delete::<Vote>(&id)?;
        return Ok(());
    };
    let now = app.now_iso();
    let created_at = app.db().get::<Vote>(&id)?.map(|v| v.created_at).unwrap_or_else(|| now.clone());
    app.db().put(&Vote { id, target_key: format!("{kind}:{target_id}"), user_id: user.id.clone(), value, created_at, updated_at: now })?;
    Ok(())
}

/// One vote per user and verse; null removes it. Voting on your own verse is
/// allowed: the vote is about what the verse teaches, not about its author.
pub fn put_vote(app: &App, user: &User, verse_id: &str, body: &Value) -> ApiResult<Verse> {
    let value = vote_value(body, &[1, -1, 0], "\"value\" is required (1, -1, 0 or null)", "\"value\" must be 1, -1, 0 or null")?;
    let verse = get::<Verse>(app, verse_id, "Verse")?;
    set_vote(app, "verse", verse_id, user, value)?;
    Ok(verse)
}

/// +1 / −1 / null on an interpretation; not on your own, not on a deleted one.
/// These votes only rank interpretations: no outcome, tally or AI input uses them.
pub fn put_interpretation_vote(app: &App, user: &User, item_id: &str, body: &Value) -> ApiResult<Interpretation> {
    let value = vote_value(
        body,
        &[1, -1],
        "\"value\" is required (1, -1 or null)",
        "\"value\" must be 1, -1 or null for an interpretation",
    )?;
    let item = get::<Interpretation>(app, item_id, "Interpretation")?;
    alive(item.deleted)?;
    if item.author_id == user.id {
        return Err(ApiError::new(403, "own_item", "You cannot rate your own interpretation"));
    }
    set_vote(app, "interpretation", item_id, user, value)?;
    Ok(item)
}

/* ----------------------------------------------------------- verse tags */

/// One tag per canonical verse key of `book chapter` covered by each ArgumentVerse.
pub fn verse_tags(app: &App, book: &str, chapter: u32, view: &View) -> ApiResult<Vec<Value>> {
    let mut tags = Vec::new();
    for verse in app.db().scan::<Verse>()? {
        let numbers = refs::verses_in_chapter(&verse.range, book, chapter);
        if numbers.is_empty() {
            continue;
        }
        let (Some(question), Some(argument)) = (app.db().get::<Question>(&verse.question_id)?, app.db().get::<Argument>(&verse.argument_id)?)
        else {
            continue;
        };
        let rendered = view.verse(&verse)?;
        for number in numbers {
            tags.push(json!({
                "key": format!("{book}.{chapter}.{number}"),
                "questionId": question.id,
                "questionTitle": question.title,
                "argumentId": argument.id,
                "argumentTitle": argument.title,
                "verseId": verse.id,
                "users": rendered["users"]["outcome"],
                "ai": rendered["ai"]["outcome"],
            }));
        }
    }
    let text = |tag: &Value, key: &str| tag[key].as_str().unwrap_or("").to_string();
    tags.sort_by_key(|t| (refs::sort_key(t["key"].as_str().unwrap_or("")), text(t, "questionId"), text(t, "argumentId"), text(t, "verseId")));
    Ok(tags)
}
