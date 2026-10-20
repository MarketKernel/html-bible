//! OpenAI's models behind the two traits of llm.rs, over Chat Completions with
//! strict JSON schemas: a small model reviews what is saved (decency,
//! relevance, translation) while the author waits; a stronger one evaluates a
//! verse after the response.
//!
//! The prompts are built by plain functions, so tests check them without the network.

use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::llm::{Answer, Draft, EvalInput, Evaluator, Review, ReviewUnavailable, Reviewer, Subject};
use crate::model::Text;

const ENDPOINT: &str = "https://api.openai.com/v1/chat/completions";

pub struct OpenAi {
    key: String,
    pub review_model: String,
    pub eval_model: String,
    /// The author waits for a review: it must answer well within the API's 30 s.
    quick: ureq::Agent,
    /// An evaluation runs after the response, in the evaluator Lambda.
    patient: ureq::Agent,
}

fn language(lang: &str) -> &'static str {
    if lang == "ru" {
        "Russian"
    } else {
        "English"
    }
}

/// "sides.pro" → "sides_pro": schema property names stay plain.
fn key_of(field: &str) -> String {
    field.replace('.', "_")
}

/// The system prompt, the user message and the schema of one review.
pub fn review_request(subject: &Subject, lang: &str, fields: &[(&str, &str)]) -> (String, String, Value) {
    let other = if lang == "ru" { "en" } else { "ru" };
    let (what, relevance) = match subject {
        Subject::Question => (
            "a new topic: a question about the Bible with two positions to weigh (its title, summary and the two positions)".to_string(),
            "it has nothing to do with the Bible, Christian faith or theology.".to_string(),
        ),
        Subject::Argument { question } => (
            format!(
                "a subtopic of the topic «{}» (positions: «{}» / «{}»)",
                question.title.get(lang),
                question.sides.pro.get(lang),
                question.sides.con.get(lang)
            ),
            "it has nothing to do with that topic.".to_string(),
        ),
        Subject::Interpretation { question, argument, verse, side } => {
            let position = question.sides.get(side).get(lang);
            let range = if verse.from == verse.to { verse.from.clone() } else { format!("{}–{}", verse.from, verse.to) };
            (
                format!(
                    "an interpretation of the verse {range} (USFM book id, KJV numbering) in the subtopic «{}» of the topic «{}», \
                     written for the position «{position}»",
                    argument.title.get(lang),
                    question.title.get(lang)
                ),
                "it is not about that verse or that subtopic (a short remark on the verse is fine).".to_string(),
            )
        }
        Subject::Name => ("a member's display name".to_string(), "never: a name needs no relevance.".to_string()),
    };
    let translating = !matches!(subject, Subject::Name);
    let translation = if translating {
        format!(
            "\n\nTranslate every field from {from} into {to} (`translations`, the same keys). Keep the Markdown, line breaks, \
             links and URLs as they are; write verse references the way {to} readers do (Ин 3:16 ↔ John 3:16). Translate \
             faithfully: do not shorten, soften or improve. An empty field stays empty.",
            from = language(lang),
            to = language(other)
        )
    } else {
        String::new()
    };
    let system = format!(
        "You review what a member is about to publish on a site where people discuss questions about the Bible: topics \
         (a question with two positions), subtopics, and interpretations of verses, each written for one position.\n\n\
         The text is {what}.\n\n\
         Refuse it only if:\n\
         1. it has profanity, obscenity, insults or mockery of people, or contempt for anyone's faith; or\n\
         2. {relevance}\n\
         Disagreement, criticism of a doctrine and any theological position are allowed: do not judge whether the text is \
         right, only these two rules. When unsure, allow.\n\n\
         If you refuse, write `reason` in {author}: one or two short sentences to the author saying what to change. If you \
         allow, leave `reason` empty.{translation}",
        author = language(lang)
    );
    let user = serde_json::to_string_pretty(&Value::Object(fields.iter().map(|(name, text)| (key_of(name), json!(text))).collect()))
        .expect("strings serialize");
    let mut properties = Map::new();
    properties.insert("allowed".into(), json!({ "type": "boolean" }));
    properties.insert("reason".into(), json!({ "type": "string" }));
    let mut required = vec![json!("allowed"), json!("reason")];
    if translating {
        let keys: Vec<String> = fields.iter().map(|(name, _)| key_of(name)).collect();
        properties.insert(
            "translations".into(),
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": keys,
                "properties": keys.iter().map(|k| (k.clone(), json!({ "type": "string" }))).collect::<Map<_, _>>(),
            }),
        );
        required.push(json!("translations"));
    }
    let schema = json!({ "type": "object", "additionalProperties": false, "required": required, "properties": properties });
    (system, user, schema)
}

/// A review's answer → the pipeline's Review; None when it does not fit the request.
pub fn read_review(subject: &Subject, fields: &[(&str, &str)], answer: &Value) -> Option<Review> {
    if !answer["allowed"].as_bool()? {
        let reason = answer["reason"].as_str().unwrap_or_default().trim().to_string();
        return Some(Review::Rejected(reason));
    }
    if matches!(subject, Subject::Name) {
        return Some(Review::Allowed(vec![String::new(); fields.len()]));
    }
    let translations = &answer["translations"];
    fields
        .iter()
        .map(|(name, text)| if text.is_empty() { Some(String::new()) } else { translations[key_of(name)].as_str().map(|t| t.trim().to_string()) })
        .collect::<Option<Vec<_>>>()
        .map(Review::Allowed)
}

const EVALUATION: &str = "You weigh one Bible verse in a discussion. A topic asks a question with two positions, labelled A \
and B (the labels are shuffled: A is not always the first position). A subtopic narrows the question. Members explain \
the verse in two columns, one for each position; you are given the whole topic and every interpretation of both columns, \
each in the language its author wrote (Russian or English).\n\n\
The verse is given only in its original language, on purpose, and never in a translation: Hebrew (the Masoretic text, \
Westminster Leningrad Codex; *written (read) marks a ketiv and its qere) for the Old Testament, Greek for the New \
(Robinson–Pierpont 2018, the Byzantine text; where the Patriarchal text of 1904 (PT) or the Textus Receptus (TR) \
words the verse otherwise, their wording follows, and an empty text means the edition does not have the verse). The \
three verses before and after it are given too. If no text is given, recall the original yourself.\n\n\
What counts is the text of the verse itself, in the original: its words, their meaning in the language of the time, \
their grammar and syntax, and the context around it. Read it without leaning on established traditions, confessional \
readings, commentaries or familiar translations: a translation carries its translator's choices, and a tradition its \
own conclusions, so neither is evidence of what the text says. Where a member's argument rests on a translation's \
wording or on an authority, check it against the original; where the original allows more than one reading, say so \
rather than pick the customary one. Do not take a member's quotation as the text.\n\n\
Decide what the verse itself, read this way, supports in this subtopic: position A, position B, or neither (`none`: it \
is not relevant here, or it is genuinely balanced). The interpretations are arguments to weigh, not votes: one sound \
reading outweighs many weak ones; ignore rhetoric, insults and appeals to numbers or authority.\n\n\
Answer with `answer` (A, B or none), `confidence` from 0 to 1, and a rationale of two to four sentences in English \
(`rationale_en`) and the same in Russian (`rationale_ru`). In the rationale, name the positions only as [A] and [B]; \
quote the original words the decision rests on.";

/// A text as its author wrote it, with the language: translations lose shades.
fn original(text: &Text) -> Value {
    json!({ "lang": text.orig, "text": text.get(&text.orig) })
}

/// The user message of an evaluation: the whole topic and both columns, in the
/// authors' own words; the positions as A and B; the verse by reference and,
/// from the server's own files, in its original language only.
pub fn evaluation_request(input: &EvalInput) -> String {
    let own = |text: &Option<Text>| text.as_ref().map(original).unwrap_or(Value::Null);
    let column = |items: &[crate::llm::EvalInterpretation]| {
        items
            .iter()
            .map(|i| {
                let mut out = json!({ "id": i.id, "lang": i.body_md.orig, "text": i.body_md.get(&i.body_md.orig) });
                if let Some(reply_to) = &i.reply_to {
                    out["replyTo"] = json!(reply_to);
                }
                out
            })
            .collect::<Vec<_>>()
    };
    let verse = &input.verse.range;
    let message = json!({
        "topic": { "title": own(&input.question.title), "summary": own(&input.question.summary_md) },
        "positions": { "A": own(&input.question.positions.A), "B": own(&input.question.positions.B) },
        "subtopic": { "title": own(&input.argument.title), "summary": own(&input.argument.summary_md) },
        "verse": if verse.from == verse.to { verse.from.clone() } else { format!("{}–{}", verse.from, verse.to) },
        "original": input.verse.original,
        "interpretations": { "A": column(&input.interpretations.A), "B": column(&input.interpretations.B) },
    });
    serde_json::to_string_pretty(&message).expect("JSON values serialize")
}

fn evaluation_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["answer", "confidence", "rationale_en", "rationale_ru"],
        "properties": {
            "answer": { "type": "string", "enum": ["A", "B", "none"] },
            "confidence": { "type": "number" },
            "rationale_en": { "type": "string" },
            "rationale_ru": { "type": "string" },
        },
    })
}

pub fn read_evaluation(answer: &Value) -> Option<Draft> {
    let choice = match answer["answer"].as_str()? {
        "A" => Answer::A,
        "B" => Answer::B,
        "none" => Answer::None,
        _ => return None,
    };
    let confidence = (answer["confidence"].as_f64()?.clamp(0.0, 1.0) * 100.0).round() / 100.0;
    Some(Draft {
        answer: choice,
        confidence,
        rationale: Text { orig: "en".into(), en: answer["rationale_en"].as_str()?.trim().into(), ru: answer["rationale_ru"].as_str()?.trim().into() },
    })
}

impl OpenAi {
    pub fn new(key: &str, review_model: &str, eval_model: &str) -> Self {
        let agent = |seconds| ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(5)).timeout(Duration::from_secs(seconds)).build();
        OpenAi { key: key.trim().into(), review_model: review_model.into(), eval_model: eval_model.into(), quick: agent(22), patient: agent(110) }
    }

    /// One structured completion: the parsed JSON the schema promises.
    fn complete(&self, agent: &ureq::Agent, model: &str, effort: &str, system: &str, user: &str, schema: Value) -> Result<Value, String> {
        let body = json!({
            "model": model,
            "reasoning_effort": effort,
            "max_completion_tokens": 8000,
            "messages": [{ "role": "system", "content": system }, { "role": "user", "content": user }],
            "response_format": { "type": "json_schema", "json_schema": { "name": "answer", "strict": true, "schema": schema } },
        });
        let response = match agent.post(ENDPOINT).set("authorization", &format!("Bearer {}", self.key)).send_json(&body) {
            Ok(response) => response,
            Err(ureq::Error::Status(status, response)) => {
                let detail: Value = response.into_json().unwrap_or(Value::Null);
                return Err(format!("{model}: HTTP {status} {}", detail["error"]["message"].as_str().unwrap_or("")));
            }
            Err(error) => return Err(format!("{model}: {error}")),
        };
        let reply: Value = response.into_json().map_err(|e| format!("{model}: {e}"))?;
        let choice = &reply["choices"][0];
        if let Some(refusal) = choice["message"]["refusal"].as_str() {
            return Err(format!("{model} refused: {refusal}"));
        }
        if choice["finish_reason"] == "length" {
            return Err(format!("{model}: the answer was cut off"));
        }
        let content = choice["message"]["content"].as_str().ok_or(format!("{model}: no content"))?;
        serde_json::from_str(content).map_err(|e| format!("{model}: {e}"))
    }
}

impl Reviewer for OpenAi {
    fn review(&self, subject: &Subject, lang: &str, fields: &[(&str, &str)]) -> Result<Review, ReviewUnavailable> {
        let (system, user, schema) = review_request(subject, lang, fields);
        let answer = self.complete(&self.quick, &self.review_model, "low", &system, &user, schema).map_err(|error| {
            eprintln!("[review] {error}");
            ReviewUnavailable
        })?;
        read_review(subject, fields, &answer).ok_or_else(|| {
            eprintln!("[review] {}: an answer that does not fit: {answer}", self.review_model);
            ReviewUnavailable
        })
    }
}

impl Evaluator for OpenAi {
    fn models(&self) -> Vec<String> {
        vec![self.eval_model.clone()]
    }

    fn evaluate(&self, model: &str, input: &EvalInput) -> Result<Draft, String> {
        let answer = self.complete(&self.patient, model, "medium", EVALUATION, &evaluation_request(input), evaluation_schema())?;
        read_evaluation(&answer).ok_or_else(|| format!("{model}: an answer that does not fit: {answer}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Argument, Question, RefRange, Sides};

    fn text(ru: &str, en: &str) -> Text {
        Text { orig: "ru".into(), ru: ru.into(), en: en.into() }
    }

    fn question() -> Question {
        Question {
            id: "Q".into(),
            title: text("Соответствует ли учение о Троице Библии?", "Is the Trinity biblical?"),
            summary_md: text("", ""),
            sides: Sides { pro: text("Соответствует", "Consistent"), con: text("Не соответствует", "Not consistent") },
            tags: vec![],
            author_id: "u".into(),
            created_at: "2026-10-19T00:00:00.000Z".into(),
            updated_at: None,
            deleted: false,
        }
    }

    #[test]
    fn a_review_asks_for_each_field() {
        let q = question();
        let (system, user, schema) = review_request(&Subject::Argument { question: &q }, "ru", &[("title", "Святой Дух"), ("summaryMd", "")]);
        assert!(system.contains("«Соответствует ли учение о Троице Библии?»") && system.contains("from Russian into English"));
        assert_eq!(serde_json::from_str::<Value>(&user).unwrap(), json!({ "title": "Святой Дух", "summaryMd": "" }));
        assert_eq!(schema["properties"]["translations"]["required"], json!(["title", "summaryMd"]));
        let (system, _, schema) = review_request(&Subject::Question, "en", &[("sides.pro", "Yes")]);
        assert!(system.contains("into Russian") && schema["properties"]["translations"]["properties"].get("sides_pro").is_some());
        let (system, _, schema) = review_request(&Subject::Name, "en", &[("displayName", "Anna")]);
        assert!(!system.contains("Translate") && schema["properties"].get("translations").is_none());
        let a = Argument {
            id: "A".into(),
            question_id: "Q".into(),
            title: text("Божество Иисуса", "The deity of Jesus"),
            summary_md: text("", ""),
            author_id: "u".into(),
            created_at: String::new(),
            updated_at: None,
            deleted: false,
        };
        let range = RefRange { from: "JHN.1.1".into(), to: "JHN.1.2".into() };
        let (system, _, _) = review_request(&Subject::Interpretation { question: &q, argument: &a, verse: &range, side: "con" }, "en", &[("bodyMd", "x")]);
        assert!(system.contains("JHN.1.1–JHN.1.2") && system.contains("«Not consistent»") && system.contains("«The deity of Jesus»"));
    }

    #[test]
    fn an_evaluation_sees_the_whole_topic_in_the_authors_words_and_the_verse_in_the_original() {
        use crate::llm::{EvalArgument, EvalInterpretation, EvalPositions, EvalQuestion, EvalSides, EvalVerse};
        use crate::originals::{EditionText, Original};
        let q = question();
        let input = EvalInput {
            question: EvalQuestion {
                id: Some("Q".into()),
                title: Some(q.title.clone()),
                summary_md: Some(text("Взвесим тексты.", "Weigh the texts.")),
                positions: EvalPositions { A: Some(q.sides.con.clone()), B: Some(q.sides.pro.clone()) },
            },
            argument: EvalArgument { id: Some("A".into()), title: Some(text("Божество Иисуса", "The deity of Jesus")), summary_md: None },
            verse: EvalVerse {
                id: "V".into(),
                range: RefRange { from: "JHN.1.1".into(), to: "JHN.1.1".into() },
                original: Some(Original {
                    lang: "grc",
                    editions: vec![EditionText { edition: "RP", text: "Ἐν ἀρχῇ ἦν ὁ λόγος".into() }],
                    before: String::new(),
                    after: "1:2 Οὗτος ἦν ἐν ἀρχῇ πρὸς τὸν θεόν.".into(),
                }),
            },
            interpretations: EvalSides {
                A: vec![EvalInterpretation { id: "T1".into(), body_md: Text { orig: "en".into(), ru: "перевод".into(), en: "Original.".into() }, reply_to: None }],
                B: vec![EvalInterpretation { id: "T2".into(), body_md: text("Слово было Бог.", "The Word was God."), reply_to: Some("T1".into()) }],
            },
        };
        let message: Value = serde_json::from_str(&evaluation_request(&input)).unwrap();
        assert_eq!(message["topic"]["summary"], json!({ "lang": "ru", "text": "Взвесим тексты." }));
        assert_eq!(message["positions"]["A"]["text"], "Не соответствует");
        assert_eq!(message["interpretations"]["A"][0], json!({ "id": "T1", "lang": "en", "text": "Original." }));
        assert_eq!(message["interpretations"]["B"][0]["text"], "Слово было Бог.");
        assert_eq!(message["interpretations"]["B"][0]["replyTo"], "T1");
        assert_eq!(message["verse"], "JHN.1.1");
        assert_eq!(message["original"]["lang"], "grc");
        assert_eq!(message["original"]["editions"], json!([{ "edition": "RP", "text": "Ἐν ἀρχῇ ἦν ὁ λόγος" }]));
        assert_eq!(message["original"]["after"], "1:2 Οὗτος ἦν ἐν ἀρχῇ πρὸς τὸν θεόν.");
        assert!(EVALUATION.contains("only in its original language") && EVALUATION.contains("without leaning on established traditions"));
    }

    #[test]
    fn answers_are_read_strictly() {
        let fields = [("title", "Святой Дух"), ("summaryMd", "")];
        let q = question();
        let subject = Subject::Argument { question: &q };
        match read_review(&subject, &fields, &json!({ "allowed": true, "reason": "fine", "translations": { "title": " The Holy Spirit ", "summaryMd": "x" } })) {
            Some(Review::Allowed(t)) => assert_eq!(t, vec!["The Holy Spirit".to_string(), String::new()]),
            _ => panic!("allowed"),
        }
        match read_review(&subject, &fields, &json!({ "allowed": false, "reason": "Уберите оскорбление.", "translations": {} })) {
            Some(Review::Rejected(reason)) => assert_eq!(reason, "Уберите оскорбление."),
            _ => panic!("rejected"),
        }
        assert!(read_review(&subject, &fields, &json!({ "allowed": true, "reason": "", "translations": {} })).is_none(), "a missing translation");
        let draft = read_evaluation(&json!({ "answer": "B", "confidence": 1.7, "rationale_en": "[B] holds.", "rationale_ru": "[B] верна." })).unwrap();
        assert_eq!((draft.answer, draft.confidence, draft.rationale.ru.as_str()), (Answer::B, 1.0, "[B] верна."));
        assert!(read_evaluation(&json!({ "answer": "C", "confidence": 0.5, "rationale_en": "", "rationale_ru": "" })).is_none());
    }
}
