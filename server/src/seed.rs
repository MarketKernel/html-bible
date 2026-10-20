//! Demo data: the balanced "Trinity" topic (Task.md §4), loaded into an empty
//! local store. Three subtopics, verses both sides cite, interpretations in
//! both columns and votes that give every kind of outcome (pro, con, not
//! relevant, undecided). Never loaded in production.
//!
//! The seed users sign in with their login and "<login>-demo" as the password
//! (anna / anna-demo, david / david-demo, …). root (password "rootroot") invited
//! them all: they are members 2–6, with root's codes 1–5.

use serde_json::Value;

use crate::app::App;
use crate::auth::hash_password;
use crate::evaluation;
use crate::invites::{BATCH, NUMBERS};
use crate::model::{Argument, Counter, Interpretation, Invite, Login, Meta, Number, Question, User, Verse, VerseAi, Vote};
use crate::refs::parse_range;
use crate::store::StoreResult;

/// Bumped when the data model changes: an older local store is wiped and seeded again.
pub const SEED_VERSION: u32 = 6;

/// root of the demo data (in AWS root gets a random id: invites::ensure_root).
pub const ROOT_ID: &str = "00000000-0000-4000-8000-000000000001";

pub fn data() -> Value {
    serde_json::from_str(include_str!("../seed/trinity.json")).expect("seed/trinity.json is valid JSON")
}

pub fn demo_password(login: &str) -> String {
    format!("{login}-demo")
}

/// The id of a seed user by its key ("anna").
pub fn user_id(data: &Value, key: &str) -> String {
    data["users"].as_array().into_iter().flatten().find(|u| u["key"] == key).map(|u| text(u, "id")).unwrap_or_default()
}

pub fn seeded(app: &App) -> StoreResult<bool> {
    Ok(app.db().get::<Meta>("seed")?.is_some_and(|meta| meta.version == SEED_VERSION))
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_string()
}

fn parse<T: serde::de::DeserializeOwned>(value: &Value) -> T {
    serde_json::from_value(value.clone()).expect("the seed matches the data model")
}

fn list(data: &Value, key: &str) -> Vec<Value> {
    data[key].as_array().cloned().unwrap_or_default()
}

pub fn load(app: &App) -> StoreResult<()> {
    let data = data();
    let db = app.db();
    let users = |key: &Value| user_id(&data, key.as_str().unwrap_or_default());
    let evaluated_at = text(&data, "evaluatedAt");
    let users_list = list(&data, "users");
    let root = User {
        id: ROOT_ID.into(),
        number: 1,
        login: "root".into(),
        display_name: "root".into(),
        created_at: "2026-09-28T07:00:00.000Z".into(),
        password_hash: hash_password(crate::invites::ROOT_PASSWORD),
        invited_by: None,
        invite_seq: None,
        invites_issued: users_list.len() as u64,
        invites_limit: BATCH,
        invites_reset_on: None,
    };
    db.put(&root)?;
    db.put(&Login { id: "root".into(), user_id: ROOT_ID.into() })?;
    db.put(&Number { id: "1".into(), user_id: ROOT_ID.into() })?;
    for (index, user) in users_list.iter().enumerate() {
        let (login, id, seq) = (text(user, "login"), text(user, "id"), index as u64 + 1);
        db.put(&User {
            id: id.clone(),
            number: seq + 1,
            login: login.clone(),
            display_name: text(user, "displayName"),
            created_at: text(user, "createdAt"),
            password_hash: hash_password(&demo_password(&login)),
            invited_by: Some(ROOT_ID.into()),
            invite_seq: Some(seq),
            invites_issued: 0,
            invites_limit: BATCH,
            invites_reset_on: None,
        })?;
        db.put(&Login { id: login, user_id: id.clone() })?;
        db.put(&Number { id: (seq + 1).to_string(), user_id: id.clone() })?;
        db.put(&Invite { id: format!("1:{seq}"), user_id: id, redeemed_at: text(user, "createdAt") })?;
    }
    db.put(&Counter { id: NUMBERS.into(), value: users_list.len() as i64 + 1 })?;
    for question in list(&data, "questions") {
        db.put(&Question {
            id: text(&question, "id"),
            title: parse(&question["title"]),
            summary_md: parse(&question["summaryMd"]),
            sides: parse(&question["sides"]),
            tags: parse(&question["tags"]),
            author_id: users(&question["author"]),
            created_at: text(&question, "createdAt"),
            updated_at: None,
            deleted: false,
        })?;
    }
    for argument in list(&data, "arguments") {
        db.put(&Argument {
            id: text(&argument, "id"),
            question_id: text(&argument, "questionId"),
            title: parse(&argument["title"]),
            summary_md: parse(&argument["summaryMd"]),
            author_id: users(&argument["author"]),
            created_at: text(&argument, "createdAt"),
            updated_at: None,
            deleted: false,
        })?;
    }
    let arguments = list(&data, "arguments");
    let question_of = |argument_id: &str| arguments.iter().find(|a| a["id"] == argument_id).map(|a| text(a, "questionId")).unwrap_or_default();
    let mut verses = Vec::new();
    for verse in list(&data, "verses") {
        let id = text(&verse, "id");
        // Validated like user input: a bad seed reference fails loudly.
        let range = parse_range(&verse["ref"], &format!("seed {id}")).unwrap_or_else(|e| panic!("seed {id}: {}", e.message));
        let record = Verse {
            id,
            argument_id: text(&verse, "argumentId"),
            question_id: question_of(&text(&verse, "argumentId")),
            original: crate::originals::lookup(&db, &range)?,
            range,
            author_id: users(&verse["author"]),
            created_at: text(&verse, "createdAt"),
            ai: VerseAi { status: "none".into(), verdicts: Vec::new(), input_hash: None },
        };
        db.put(&record)?;
        verses.push(record);
    }
    for item in list(&data, "interpretations") {
        let verse_id = text(&item, "verseId");
        let verse = verses.iter().find(|v| v.id == verse_id).expect("seed interpretations cite seed verses");
        db.put(&Interpretation {
            id: text(&item, "id"),
            verse_id: verse_id.clone(),
            argument_id: verse.argument_id.clone(),
            question_id: verse.question_id.clone(),
            side: text(&item, "side"),
            body_md: parse(&item["bodyMd"]),
            reply_to: item["replyTo"].as_str().filter(|r| !r.is_empty()).map(str::to_string),
            author_id: users(&item["author"]),
            created_at: text(&item, "createdAt"),
            updated_at: None,
            deleted: false,
        })?;
    }
    for (kind, key) in [("verse", "votes"), ("interpretation", "interpretationVotes")] {
        for (target, ballots) in data[key].as_object().into_iter().flatten() {
            for (user_key, value) in ballots.as_object().into_iter().flatten() {
                let user = user_id(&data, user_key);
                db.put(&Vote {
                    id: format!("{kind}:{target}:{user}"),
                    target_key: format!("{kind}:{target}"),
                    user_id: user,
                    value: value.as_i64().unwrap_or(0),
                    created_at: evaluated_at.clone(),
                    updated_at: evaluated_at.clone(),
                })?;
            }
        }
    }
    // The first evaluation at a fixed time, so seed outcomes are reproducible.
    for verse in &verses {
        evaluation::run(app, &verse.id, Some(&evaluated_at))?;
    }
    db.put(&Meta { id: "seed".into(), version: SEED_VERSION })?;
    app.store.flush()
}
