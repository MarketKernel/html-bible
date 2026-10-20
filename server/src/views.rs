//! Stored records → API JSON (field names exactly as docs/api.md and
//! src/core/api-types.ts). Outcomes and tallies are computed on read, so they
//! can never drift from the votes and verdicts they come from.

use std::cell::RefCell;
use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::app::App;
use crate::model::{Argument, Interpretation, Question, User, Verse, Vote};
use crate::ratings;
use crate::refs::sort_key;
use crate::store::StoreResult;

/// The signed-in user as they see themselves: with the login, unlike the public profile.
pub fn user_view(app: &App, user: &User) -> StoreResult<Value> {
    let mut out = json!({
        "id": user.id,
        "number": user.number,
        "login": user.login,
        "displayName": user.display_name,
        "createdAt": user.created_at,
    });
    if let Some(inviter) = crate::invites::inviter_of(app, user)? {
        out["invitedBy"] = inviter;
    }
    Ok(out)
}

/// Canonical Bible order: book (GEN…REV), chapter, verse, then where the range ends.
fn verse_order(verse: &Verse) -> ((usize, u32, u32), (usize, u32, u32), String, String) {
    (sort_key(&verse.range.from), sort_key(&verse.range.to), verse.argument_id.clone(), verse.id.clone())
}

fn stamps(out: &mut Map<String, Value>, updated_at: &Option<String>, deleted: bool) {
    if let Some(updated_at) = updated_at.as_ref().filter(|u| !u.is_empty()) {
        out.insert("updatedAt".into(), json!(updated_at));
    }
    if deleted {
        out.insert("deleted".into(), json!(true));
    }
}

/// Renders for one viewer (None = anonymous: no `votes.mine`).
pub struct View<'a> {
    app: &'a App,
    viewer: Option<String>,
    authors: RefCell<HashMap<String, Value>>,
}

impl<'a> View<'a> {
    pub fn new(app: &'a App, viewer: Option<&str>) -> Self {
        View { app, viewer: viewer.map(str::to_string), authors: RefCell::new(HashMap::new()) }
    }

    fn author(&self, user_id: &str) -> StoreResult<Value> {
        if let Some(found) = self.authors.borrow().get(user_id) {
            return Ok(found.clone());
        }
        let name = self.app.db().get::<User>(user_id)?.map(|u| u.display_name).unwrap_or_else(|| "—".into());
        let author = json!({ "id": user_id, "displayName": name });
        self.authors.borrow_mut().insert(user_id.to_string(), author.clone());
        Ok(author)
    }

    fn mine(&self, votes: &[Vote]) -> Option<i64> {
        votes.iter().find(|v| Some(&v.user_id) == self.viewer.as_ref()).map(|v| v.value)
    }

    /* ---------------- verses ---------------- */

    pub fn verse(&self, verse: &Verse) -> StoreResult<Value> {
        let votes = self.app.db().query::<Vote>("targetKey", &format!("verse:{}", verse.id))?;
        let values: Vec<i64> = votes.iter().map(|v| v.value).collect();
        let mut out = json!({
            "id": verse.id,
            "argumentId": verse.argument_id,
            "questionId": verse.question_id,
            "ref": verse.range,
            "author": self.author(&verse.author_id)?,
            "createdAt": verse.created_at,
            "votes": ratings::verse_votes(&values, self.mine(&votes), self.viewer.is_some()),
            "users": { "outcome": ratings::outcome(values.iter().copied()) },
            "ai": {
                "outcome": ratings::outcome(verse.ai.verdicts.iter().map(|v| v.value)),
                "status": verse.ai.status,
                "verdicts": verse.ai.verdicts,
            },
        });
        // What readers see beside their translation; the context is the evaluator's only.
        if let Some(original) = &verse.original {
            let mut shown = json!({ "lang": original.lang, "edition": original.edition, "text": original.text });
            if original.cut {
                shown["cut"] = json!(true);
            }
            out["original"] = shown;
        }
        Ok(out)
    }

    pub fn verses_of(&self, field: &str, value: &str) -> StoreResult<Vec<Verse>> {
        let mut verses = self.app.db().query::<Verse>(field, value)?;
        verses.sort_by_key(verse_order);
        Ok(verses)
    }

    fn rendered_verses(&self, field: &str, value: &str) -> StoreResult<Vec<Value>> {
        self.verses_of(field, value)?.iter().map(|v| self.verse(v)).collect()
    }

    pub fn interpretation(&self, item: &Interpretation) -> StoreResult<Value> {
        let mut out = Map::new();
        out.insert("id".into(), json!(item.id));
        out.insert("verseId".into(), json!(item.verse_id));
        out.insert("argumentId".into(), json!(item.argument_id));
        out.insert("questionId".into(), json!(item.question_id));
        out.insert("side".into(), json!(item.side));
        out.insert("bodyMd".into(), json!(item.body_md));
        if let Some(reply_to) = item.reply_to.as_ref().filter(|r| !r.is_empty()) {
            out.insert("replyTo".into(), json!(reply_to));
        }
        out.insert("author".into(), self.author(&item.author_id)?);
        out.insert("createdAt".into(), json!(item.created_at));
        stamps(&mut out, &item.updated_at, item.deleted);
        out.insert("votes".into(), self.interpretation_votes(item)?);
        Ok(Value::Object(out))
    }

    /// + / − counts. A soft-deleted interpretation keeps its votes stored but
    /// shows zeros: its text is gone, so the counts would mean nothing.
    pub fn interpretation_votes(&self, item: &Interpretation) -> StoreResult<Value> {
        let viewer = self.viewer.is_some();
        if item.deleted {
            return Ok(ratings::updown_votes(&[], None, viewer));
        }
        let votes = self.app.db().query::<Vote>("targetKey", &format!("interpretation:{}", item.id))?;
        let values: Vec<i64> = votes.iter().map(|v| v.value).collect();
        Ok(ratings::updown_votes(&values, self.mine(&votes), viewer))
    }

    /* ---------------- tallies ---------------- */

    pub fn argument_tally(&self, argument_id: &str) -> StoreResult<Value> {
        Ok(ratings::tallies(&self.rendered_verses("argumentId", argument_id)?))
    }

    /// The sum over the topic's subtopics = the tally of all its verses.
    pub fn question_tally(&self, question_id: &str) -> StoreResult<Value> {
        Ok(ratings::tallies(&self.rendered_verses("questionId", question_id)?))
    }

    /// What changes along with one verse: its subtopic's and topic's tallies.
    fn context(&self, verse: &Verse, out: &mut Map<String, Value>) -> StoreResult<()> {
        out.insert("argument".into(), json!({ "id": verse.argument_id, "tally": self.argument_tally(&verse.argument_id)? }));
        out.insert("question".into(), json!({ "id": verse.question_id, "tally": self.question_tally(&verse.question_id)? }));
        Ok(())
    }

    /* ---------------- entities ---------------- */

    pub fn argument(&self, argument: &Argument, rendered: Option<&[Value]>) -> StoreResult<Value> {
        let mut out = Map::new();
        out.insert("id".into(), json!(argument.id));
        out.insert("questionId".into(), json!(argument.question_id));
        out.insert("title".into(), json!(argument.title));
        out.insert("summaryMd".into(), json!(argument.summary_md));
        out.insert("author".into(), self.author(&argument.author_id)?);
        out.insert("createdAt".into(), json!(argument.created_at));
        stamps(&mut out, &argument.updated_at, argument.deleted);
        let tally = match rendered {
            Some(verses) => ratings::tallies(verses),
            None => self.argument_tally(&argument.id)?,
        };
        out.insert("tally".into(), tally);
        Ok(Value::Object(out))
    }

    pub fn question(&self, question: &Question, with_counts: bool, rendered: Option<&[Value]>) -> StoreResult<Value> {
        let mut out = Map::new();
        out.insert("id".into(), json!(question.id));
        out.insert("title".into(), json!(question.title));
        out.insert("summaryMd".into(), json!(question.summary_md));
        out.insert("sides".into(), json!(question.sides));
        out.insert("tags".into(), json!(question.tags));
        out.insert("author".into(), self.author(&question.author_id)?);
        out.insert("createdAt".into(), json!(question.created_at));
        stamps(&mut out, &question.updated_at, question.deleted);
        let owned;
        let verses = match rendered {
            Some(verses) => verses,
            None => {
                owned = self.rendered_verses("questionId", &question.id)?;
                &owned
            }
        };
        out.insert("tally".into(), ratings::tallies(verses));
        if with_counts {
            let arguments = self.app.db().query::<Argument>("questionId", &question.id)?;
            out.insert("argumentCount".into(), json!(arguments.iter().filter(|a| !a.deleted).count()));
            out.insert("verseCount".into(), json!(verses.len()));
        }
        Ok(Value::Object(out))
    }

    /// QuestionFull: arguments by createdAt, verses in canonical order;
    /// interpretations grouped by verse (in the verses' order) and side (pro,
    /// con), and within a verse and side by score (up − down) descending, then
    /// createdAt ascending.
    pub fn question_full(&self, question: &Question) -> StoreResult<Value> {
        let db = self.app.db();
        let mut arguments = db.query::<Argument>("questionId", &question.id)?;
        arguments.sort_by(|a, b| (&a.created_at, &a.id).cmp(&(&b.created_at, &b.id)));
        let verses = self.rendered_verses("questionId", &question.id)?;
        let position: HashMap<&str, usize> = verses.iter().enumerate().map(|(n, v)| (v["id"].as_str().unwrap_or(""), n)).collect();
        let mut rendered: Vec<Value> =
            db.query::<Interpretation>("questionId", &question.id)?.iter().map(|i| self.interpretation(i)).collect::<StoreResult<_>>()?;
        let order = |i: &Value| {
            let score = i["votes"]["up"].as_i64().unwrap_or(0) - i["votes"]["down"].as_i64().unwrap_or(0);
            (
                position.get(i["verseId"].as_str().unwrap_or("")).copied().unwrap_or(position.len()),
                usize::from(i["side"] != "pro"),
                -score,
                i["createdAt"].as_str().unwrap_or("").to_string(),
                i["id"].as_str().unwrap_or("").to_string(),
            )
        };
        rendered.sort_by_key(order);
        let arguments: Vec<Value> = arguments
            .iter()
            .map(|a| {
                let own: Vec<Value> = verses.iter().filter(|v| v["argumentId"] == a.id.as_str()).cloned().collect();
                self.argument(a, Some(&own))
            })
            .collect::<StoreResult<_>>()?;
        Ok(json!({
            "question": self.question(question, false, Some(&verses))?,
            "arguments": arguments,
            "verses": verses,
            "interpretations": rendered,
        }))
    }

    pub fn verse_rating(&self, verse: &Verse) -> StoreResult<Value> {
        let rendered = self.verse(verse)?;
        let mut out = Map::new();
        out.insert("votes".into(), rendered["votes"].clone());
        out.insert("users".into(), rendered["users"].clone());
        out.insert("ai".into(), rendered["ai"].clone());
        self.context(verse, &mut out)?;
        Ok(Value::Object(out))
    }

    pub fn vote_result(&self, verse: &Verse) -> StoreResult<Value> {
        let rendered = self.verse(verse)?;
        let mut out = Map::new();
        out.insert("votes".into(), rendered["votes"].clone());
        out.insert("users".into(), rendered["users"].clone());
        self.context(verse, &mut out)?;
        Ok(Value::Object(out))
    }
}
