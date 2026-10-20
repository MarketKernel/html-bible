//! Automatic AI evaluation of a verse (Task.md §6, §6.1).
//!
//! Adding a verse, or adding / editing / deleting an interpretation of it,
//! marks the verse `ai.status = "pending"` and asks for an evaluation. With no
//! delay it runs right away, in the request. With a delay it runs later and
//! the client polls GET /v1/verses/{id}/rating.
//!
//! Debounce: while an evaluation of a verse is already scheduled, further
//! requests for it are not queued again — the scheduled run reads the verse and
//! its interpretations as they are *when it fires*, so several quick
//! interpretations cost one evaluation.
//!
//! Cache: a verdict is stored under inputHash + model, so an unchanged input is
//! never sent to a model twice.
//!
//! Against bias the positions are shown to models shuffled, as "A" and "B".
//! Which side is A is derived from the content: stable for one input (so the
//! cache stays valid) but not always "pro".

use std::collections::BTreeMap;
use std::sync::atomic::Ordering;
use std::sync::Mutex;

use serde_json::{json, Map, Value};

use crate::app::App;
use crate::ids::sha256_hex;
use crate::llm::{Answer, EvalArgument, EvalInput, EvalInterpretation, EvalPositions, EvalQuestion, EvalSides, EvalVerse};
use crate::model::{Argument, CachedVerdict, Interpretation, Question, Text, Verdict, Verse, VerseAi};
use crate::store::StoreResult;

/// Verses waiting for their evaluation, with when it is due (ms).
#[derive(Default)]
pub struct Scheduler {
    due: Mutex<BTreeMap<String, i64>>,
}

impl Scheduler {
    /// Schedule unless already scheduled (the debounce); true when newly scheduled.
    fn schedule(&self, verse_id: &str, at: i64) -> bool {
        let mut due = self.due.lock().unwrap_or_else(|p| p.into_inner());
        if due.contains_key(verse_id) {
            return false;
        }
        due.insert(verse_id.to_string(), at);
        true
    }

    pub fn take_due(&self, now_ms: i64) -> Vec<String> {
        let mut due = self.due.lock().unwrap_or_else(|p| p.into_inner());
        let ready: Vec<String> = due.iter().filter(|(_, at)| **at <= now_ms).map(|(id, _)| id.clone()).collect();
        for id in &ready {
            due.remove(id);
        }
        ready
    }

    pub fn pending(&self) -> Vec<String> {
        self.due.lock().unwrap_or_else(|p| p.into_inner()).keys().cloned().collect()
    }
}

pub fn live_interpretations(app: &App, verse_id: &str) -> StoreResult<Vec<Interpretation>> {
    let mut items: Vec<Interpretation> = app.db().query::<Interpretation>("verseId", verse_id)?.into_iter().filter(|i| !i.deleted).collect();
    items.sort_by(|a, b| (&a.created_at, &a.id).cmp(&(&b.created_at, &b.id)));
    Ok(items)
}

/// sha256 (hex) of the canonical JSON of the verse and its live interpretations:
/// keys sorted, no whitespace, UTF-8, interpretations ordered by id —
/// {"interpretations":[{"bodyMd","id","replyTo"?,"side"}],"verse":{"id","ref"}}.
pub fn input_hash(verse: &Verse, interpretations: &[Interpretation]) -> String {
    let mut sorted: Vec<&Interpretation> = interpretations.iter().collect();
    sorted.sort_by(|a, b| a.id.cmp(&b.id));
    let items: Vec<Value> = sorted
        .iter()
        .map(|item| {
            let mut entry = Map::new();
            entry.insert("id".into(), json!(item.id));
            entry.insert("side".into(), json!(item.side));
            entry.insert("bodyMd".into(), json!(item.body_md));
            if let Some(reply_to) = item.reply_to.as_ref().filter(|r| !r.is_empty()) {
                entry.insert("replyTo".into(), json!(reply_to));
            }
            Value::Object(entry)
        })
        .collect();
    let data = json!({ "verse": { "id": verse.id, "ref": verse.range }, "interpretations": items });
    sha256_hex(canonical_json(&data).as_bytes())
}

/// Keys sorted at every level, no whitespace, UTF-8 as is.
pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> =
                keys.iter().map(|k| format!("{}:{}", Value::String((*k).clone()), canonical_json(&map[k.as_str()]))).collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(list) => format!("[{}]", list.iter().map(canonical_json).collect::<Vec<_>>().join(",")),
        other => other.to_string(),
    }
}

/// Which side is shown to the models as "A": derived from the content only
/// (the reference and the texts, not ids or times), so the same input always
/// gets the same labelling and is still not always "pro".
pub fn side_of_a(verse: &Verse, interpretations: &[Interpretation]) -> &'static str {
    let mut texts: Vec<String> = interpretations.iter().map(|i| format!("{}:{}", i.side, i.body_md.get(&i.body_md.orig))).collect();
    texts.sort();
    let content: Vec<String> = [verse.range.from.clone(), verse.range.to.clone()].into_iter().chain(texts).collect();
    // As Python's json.dumps(list) wrote it: ", " between items.
    let encoded: Vec<String> = content.iter().map(|s| serde_json::to_string(s).expect("strings serialize")).collect();
    let digest = sha256_hex(format!("[{}]", encoded.join(", ")).as_bytes());
    let last = u32::from_str_radix(&digest[digest.len() - 1..], 16).unwrap_or(0);
    if last % 2 == 0 {
        "pro"
    } else {
        "con"
    }
}

fn other(side: &str) -> &'static str {
    if side == "pro" {
        "con"
    } else {
        "pro"
    }
}

pub fn evaluation_input(
    app: &App,
    question: Option<&Question>,
    argument: Option<&Argument>,
    verse: &Verse,
    interpretations: &[Interpretation],
    a_side: &str,
) -> EvalInput {
    let text = app.verse_text.as_ref().and_then(|f| f(&verse.range));
    let side_of = |label: &str| if label == "A" { a_side } else { other(a_side) };
    let column = |label: &str| {
        interpretations
            .iter()
            .filter(|i| i.side == side_of(label))
            .map(|i| EvalInterpretation { id: i.id.clone(), body_md: i.body_md.clone(), reply_to: i.reply_to.clone().filter(|r| !r.is_empty()) })
            .collect()
    };
    EvalInput {
        question: EvalQuestion {
            id: question.map(|q| q.id.clone()),
            title: question.map(|q| q.title.clone()),
            summary_md: question.map(|q| q.summary_md.clone()),
            positions: EvalPositions {
                A: question.map(|q| q.sides.get(side_of("A")).clone()),
                B: question.map(|q| q.sides.get(side_of("B")).clone()),
            },
        },
        argument: EvalArgument {
            id: argument.map(|a| a.id.clone()),
            title: argument.map(|a| a.title.clone()),
            summary_md: argument.map(|a| a.summary_md.clone()),
        },
        verse: EvalVerse {
            id: verse.id.clone(),
            range: verse.range.clone(),
            original: text,
        },
        interpretations: EvalSides { A: column("A"), B: column("B") },
    }
}

/// Put the position labels where the model wrote [A] / [B].
fn relabel(rationale: &Text, question: Option<&Question>, a_side: &str) -> Text {
    let fill = |lang: &str| {
        let mut text = rationale.get(lang).to_string();
        for (token, side) in [("[A]", a_side), ("[B]", other(a_side))] {
            let name = question.map(|q| q.sides.get(side).get(lang).to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| side.to_string());
            let label = if lang == "ru" { format!("«{name}»") } else { format!("“{name}”") };
            text = text.replace(token, &label);
        }
        text
    };
    Text { orig: rationale.orig.clone(), ru: fill("ru"), en: fill("en") }
}

/// Mark the verse pending and evaluate it now, or schedule it after the delay.
pub fn request(app: &App, verse_id: &str) -> StoreResult<()> {
    let Some(mut verse) = app.db().get::<Verse>(verse_id)? else {
        return Ok(());
    };
    verse.ai.status = "pending".into();
    app.db().put(&verse)?;
    if app.config.eval_delay_ms > 0 {
        app.scheduler.schedule(verse_id, app.now_ms() + app.config.eval_delay_ms);
        return Ok(());
    }
    match &app.defer {
        // Pending until the evaluator has answered; a lost event is retried by the next change.
        Some(defer) => {
            if let Err(error) = defer(verse_id) {
                eprintln!("[evaluation] could not hand {verse_id} over: {error}");
            }
            Ok(())
        }
        None => run(app, verse_id, None),
    }
}

pub fn run_logged(app: &App, verse_id: &str, at: Option<&str>) {
    if let Err(error) = run(app, verse_id, at) {
        eprintln!("[evaluation] {verse_id}: {}", error.0);
    }
}

/// Evaluate the verse with every configured model and store the verdicts.
/// `at` dates new verdicts (the seed's fixed time); otherwise now.
pub fn run(app: &App, verse_id: &str, at: Option<&str>) -> StoreResult<()> {
    let db = app.db();
    let Some(mut verse) = db.get::<Verse>(verse_id)? else {
        return Ok(());
    };
    app.evaluation_runs.fetch_add(1, Ordering::SeqCst);
    let interpretations = live_interpretations(app, verse_id)?;
    let previous = verse.ai.verdicts.clone();
    let digest = input_hash(&verse, &interpretations);
    let a_side = side_of_a(&verse, &interpretations);
    let question = db.get::<Question>(&verse.question_id)?;
    let argument = db.get::<Argument>(&verse.argument_id)?;
    let input = evaluation_input(app, question.as_ref(), argument.as_ref(), &verse, &interpretations, a_side);
    let value_of = |answer: Answer| match answer {
        Answer::A => {
            if a_side == "pro" {
                1
            } else {
                -1
            }
        }
        Answer::B => {
            if a_side == "pro" {
                -1
            } else {
                1
            }
        }
        Answer::None => 0,
    };
    let mut verdicts = Vec::new();
    for model in app.evaluator.models() {
        let cache_id = format!("{digest}:{model}");
        if let Some(cached) = db.get::<CachedVerdict>(&cache_id)? {
            verdicts.push(cached.verdict);
            continue;
        }
        match app.evaluator.evaluate(&model, &input) {
            Ok(draft) => {
                let verdict = Verdict {
                    verse_id: verse_id.to_string(),
                    model: model.clone(),
                    value: value_of(draft.answer),
                    confidence: draft.confidence,
                    rationale_md: relabel(&draft.rationale, question.as_ref(), a_side),
                    input_hash: digest.clone(),
                    created_at: at.map(str::to_string).unwrap_or_else(|| app.now_iso()),
                };
                db.put(&CachedVerdict { id: cache_id, verdict: verdict.clone() })?;
                verdicts.push(verdict);
            }
            Err(error) => {
                // A failed model keeps the last verdicts; the next change retries.
                eprintln!("[evaluation] {model} on {verse_id}: {error}");
                let status = if previous.is_empty() { "none" } else { "fresh" };
                verse.ai = VerseAi { status: status.into(), verdicts: previous, input_hash: None };
                return db.put(&verse);
            }
        }
    }
    verse.ai = VerseAi { status: "fresh".into(), verdicts, input_hash: Some(digest) };
    db.put(&verse)
}
