//! What the save pipeline needs from language models (Task.md §6), and
//! deterministic stand-ins for them. The OpenAI client (openai.rs) implements
//! the same two traits; the core never knows which one it talks to.
//!
//! - A Reviewer checks what is being saved — decency, and that it belongs
//!   where it is written — and translates it into the other language, in one
//!   call to a small model, while the author waits (about two seconds).
//! - An Evaluator judges one verse of a subtopic with a stronger model, after
//!   the response: the verse is "pending" meanwhile (evaluation.rs).

use serde::Serialize;

use crate::model::{Argument, Question, RefRange, Text};
use crate::originals::Original;

/// What is being saved: it decides what "belongs here" means.
pub enum Subject<'a> {
    /// A topic: about the Bible, Christian faith or theology.
    Question,
    /// A subtopic of this topic.
    Argument { question: &'a Question },
    /// An interpretation of this verse, in this subtopic, for this side.
    Interpretation { question: &'a Question, argument: &'a Argument, verse: &'a RefRange, side: &'a str },
    /// A display name: decency only, and nothing is translated.
    Name,
}

pub enum Review {
    /// The texts in the other language, in the order of the fields ("" stays "").
    Allowed(Vec<String>),
    /// The reason, in the author's language, shown in the form.
    Rejected(String),
}

/// The reviewer could not answer; the pipeline saves nothing (503).
pub struct ReviewUnavailable;

pub trait Reviewer: Send + Sync {
    /// `fields` are (name, text) in `lang`; Markdown in, Markdown out.
    fn review(&self, subject: &Subject, lang: &str, fields: &[(&str, &str)]) -> Result<Review, ReviewUnavailable>;
}

/// What a model is shown about one verse of a subtopic. The positions are
/// shuffled and labelled "A"/"B" against bias, and models never see votes.
#[derive(Serialize)]
pub struct EvalInput {
    pub question: EvalQuestion,
    pub argument: EvalArgument,
    pub verse: EvalVerse,
    pub interpretations: EvalSides,
}

#[derive(Serialize)]
pub struct EvalQuestion {
    pub id: Option<String>,
    pub title: Option<Text>,
    #[serde(rename = "summaryMd")]
    pub summary_md: Option<Text>,
    pub positions: EvalPositions,
}

#[derive(Serialize)]
#[allow(non_snake_case)]
pub struct EvalPositions {
    pub A: Option<Text>,
    pub B: Option<Text>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalArgument {
    pub id: Option<String>,
    pub title: Option<Text>,
    pub summary_md: Option<Text>,
}

/// `original`: the verse in Hebrew or Greek with ±3 verses, when the server has the texts; the stub needs none.
#[derive(Serialize)]
pub struct EvalVerse {
    pub id: String,
    #[serde(rename = "ref")]
    pub range: RefRange,
    pub original: Option<Original>,
}

#[derive(Serialize)]
#[allow(non_snake_case)]
pub struct EvalSides {
    pub A: Vec<EvalInterpretation>,
    pub B: Vec<EvalInterpretation>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalInterpretation {
    pub id: String,
    pub body_md: Text,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Answer {
    A,
    B,
    None,
}

/// A model's answer. The rationale may say "[A]" and "[B]"; the core puts the
/// position labels there and maps the answer back to 1 / -1 / 0.
pub struct Draft {
    pub answer: Answer,
    pub confidence: f64,
    pub rationale: Text,
}

pub trait Evaluator: Send + Sync {
    fn models(&self) -> Vec<String>;
    fn evaluate(&self, model: &str, input: &EvalInput) -> Result<Draft, String>;
}

/* ---------------------------------------------------------------- stubs */

pub const REJECT_WORD: &str = "__reject__";
pub const UNAVAILABLE_WORD: &str = "__unavailable__";

/// Allows everything, except two magic words that let the client test its
/// error paths; "translates" by marking the text.
pub struct StubReviewer;

impl Reviewer for StubReviewer {
    fn review(&self, subject: &Subject, lang: &str, fields: &[(&str, &str)]) -> Result<Review, ReviewUnavailable> {
        let joined = fields.iter().map(|(_, text)| *text).collect::<Vec<_>>().join("\n");
        if joined.contains(UNAVAILABLE_WORD) {
            return Err(ReviewUnavailable);
        }
        if joined.contains(REJECT_WORD) {
            let reason = if lang == "ru" {
                "Текст отклонён модерацией (тестовое слово __reject__)."
            } else {
                "The text was rejected by moderation (test word __reject__)."
            };
            return Ok(Review::Rejected(reason.to_string()));
        }
        let target = if lang == "ru" { "en" } else { "ru" };
        let translate = |text: &str| match subject {
            Subject::Name => String::new(),
            _ if text.is_empty() => String::new(),
            _ => format!("[auto-translated {lang}→{target}] {text}"),
        };
        Ok(Review::Allowed(fields.iter().map(|(_, text)| translate(text)).collect()))
    }
}

/// Per model: weight of an interpretation, weight per 100 characters, the
/// relative margin below which the verse counts as "not relevant", confidence.
const STUB_MODELS: [(&str, f64, f64, f64, f64); 2] =
    [("openai-stub-mini", 1.0, 0.5, 0.05, 0.6), ("openai-stub-large", 0.5, 1.0, 0.1, 0.8)];
const NO_TEXT_CONFIDENCE: f64 = 0.3;

/// S_side = wn·count + wl·chars/100 over each side's interpretations;
/// margin = (S_A − S_B) / (S_A + S_B); |margin| < threshold → "none",
/// otherwise the larger side. No interpretations → "none", confidence 0.3.
/// Pure counting, so adding an interpretation visibly moves the AI, and the
/// two models sometimes disagree (different weights → AI outcome null).
pub struct StubEvaluator;

impl Evaluator for StubEvaluator {
    fn models(&self) -> Vec<String> {
        STUB_MODELS.iter().map(|m| m.0.to_string()).collect()
    }

    fn evaluate(&self, model: &str, input: &EvalInput) -> Result<Draft, String> {
        let &(_, wn, wl, threshold, confidence) = STUB_MODELS.iter().find(|m| m.0 == model).ok_or(format!("unknown model {model}"))?;
        let stats = |items: &[EvalInterpretation]| {
            let chars: usize = items.iter().map(|i| i.body_md.en.chars().count()).sum();
            (items.len(), chars, wn * items.len() as f64 + wl * chars as f64 / 100.0)
        };
        let (na, ca, sa) = stats(&input.interpretations.A);
        let (nb, cb, sb) = stats(&input.interpretations.B);
        let (answer, confidence, en_end, ru_end) = if na + nb == 0 {
            (
                Answer::None,
                NO_TEXT_CONFIDENCE,
                "nobody has explained the verse yet, so it counts as not relevant for now.".to_string(),
                "толкований пока нет, поэтому стих пока считается не относящимся к теме.".to_string(),
            )
        } else {
            let margin = (sa - sb) / (sa + sb);
            if margin.abs() < threshold {
                (
                    Answer::None,
                    ((confidence - 0.2) * 100.0).round() / 100.0,
                    "the readings are evenly matched; the verse does not decide the question.".to_string(),
                    "толкования уравновешены; стих не решает вопрос.".to_string(),
                )
            } else {
                let (answer, label) = if margin > 0.0 { (Answer::A, "A") } else { (Answer::B, "B") };
                (answer, confidence, format!("the verse supports [{label}]."), format!("стих подтверждает позицию [{label}]."))
            }
        };
        let en = format!("**{model}** (stub) read {na} interpretation(s) for [A] ({ca} characters) and {nb} for [B] ({cb} characters): {en_end}");
        let ru = format!("**{model}** (заглушка) прочла толкований за [A]: {na} ({ca} знаков), за [B]: {nb} ({cb} знаков): {ru_end}");
        Ok(Draft { answer, confidence, rationale: Text { orig: "en".into(), ru, en } })
    }
}
