//! What the store holds, one struct per table. Field names are the JSON (and
//! DynamoDB attribute) names; views.rs turns records into API responses.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// A table's record: serialized as one JSON object with a string "id".
pub trait Record: Serialize + DeserializeOwned {
    const TABLE: &'static str;
    fn id(&self) -> &str;
}

macro_rules! record {
    ($type:ty, $table:literal) => {
        impl Record for $type {
            const TABLE: &'static str = $table;
            fn id(&self) -> &str {
                &self.id
            }
        }
    };
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// LocalizedText: the author's text under `orig`, the other language translated.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Text {
    pub orig: String,
    pub ru: String,
    pub en: String,
}

impl Text {
    pub fn get(&self, lang: &str) -> &str {
        if lang == "ru" {
            &self.ru
        } else {
            &self.en
        }
    }

    /// What remains of a text deleted by its author.
    pub fn blank(&self) -> Text {
        Text { orig: self.orig.clone(), ru: String::new(), en: String::new() }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RefRange {
    pub from: String,
    pub to: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Sides {
    pub pro: Text,
    pub con: Text,
}

impl Sides {
    pub fn get(&self, side: &str) -> &Text {
        if side == "pro" {
            &self.pro
        } else {
            &self.con
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    /// The member's number: root is 1, then in the order of registration
    /// (unique through the `numbers` table). Invitation codes carry it.
    pub number: u64,
    /// Lowercase; unique through the `logins` table.
    pub login: String,
    pub display_name: String,
    pub created_at: String,
    /// "sha256$<salt>$<hash>" (auth.rs).
    pub password_hash: String,
    /// Who invited this user (an id; none for root), and with which of their codes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invited_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invite_seq: Option<u64>,
    /// Codes issued so far: the number of the last one (invites.rs).
    #[serde(default)]
    pub invites_issued: u64,
    /// How many codes may be issued in all, for now.
    #[serde(default)]
    pub invites_limit: u64,
    /// "YYYY-MM-DD": from 00:00 UTC of this day the limit may grow; set when it runs out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invites_reset_on: Option<String>,
}
record!(User, "users");

/// member number → user: the uniqueness of numbers, and finding the inviter of a code.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Number {
    pub id: String,
    pub user_id: String,
}
record!(Number, "numbers");

/// A code that was used: "<inviter number>:<seq>". The codes themselves are
/// never stored (they are computed); this only makes each one single-use.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Invite {
    pub id: String,
    pub user_id: String,
    pub redeemed_at: String,
}
record!(Invite, "invites");

/// A counter in `meta`, raised atomically (the member numbers: "userNumber").
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Counter {
    pub id: String,
    pub value: i64,
}
record!(Counter, "meta");

/// login → user: the uniqueness of logins (a conditional write in DynamoDB).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Login {
    pub id: String,
    pub user_id: String,
}
record!(Login, "logins");

/// A signed-in device. The id is the sha256 of the token: the token itself is
/// never stored, so the table is no use to whoever reads it.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub user_id: String,
    pub created_at: String,
}
record!(Session, "sessions");

/// Attempts counted in a time window (sign-in failures, registrations).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Throttle {
    pub id: String,
    pub count: u32,
    /// Milliseconds since the epoch when the window ends.
    pub reset_at: i64,
}
record!(Throttle, "throttle");

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub id: String,
    pub title: Text,
    pub summary_md: Text,
    pub sides: Sides,
    pub tags: Vec<String>,
    pub author_id: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub deleted: bool,
}
record!(Question, "questions");

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Argument {
    pub id: String,
    pub question_id: String,
    pub title: Text,
    pub summary_md: Text,
    pub author_id: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub deleted: bool,
}
record!(Argument, "arguments");

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub verse_id: String,
    pub model: String,
    pub value: i64,
    pub confidence: f64,
    pub rationale_md: Text,
    pub input_hash: String,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VerseAi {
    /// "none" | "pending" | "fresh"
    pub status: String,
    pub verdicts: Vec<Verdict>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_hash: Option<String>,
}

/// A verse of a discussion in its original language, copied from `originals`
/// when it is added (originals.rs): what the evaluator reads, and what readers
/// see beside their translation. Never anything a member sent.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Original {
    /// "hbo" (Biblical Hebrew) or "grc" (Koine Greek).
    pub lang: String,
    /// "WLC" or "SBLGNT".
    pub edition: String,
    /// One verse as it is; several, each after its "chapter:verse"; empty: the edition has not got the verse.
    pub text: String,
    /// The three verses before and after, one "chapter:verse text" per line (for the evaluator).
    pub before: String,
    pub after: String,
    /// The range is longer than originals::MAX_VERSES: `text` has its start only.
    #[serde(default, skip_serializing_if = "is_false")]
    pub cut: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Verse {
    pub id: String,
    pub argument_id: String,
    pub question_id: String,
    #[serde(rename = "ref")]
    pub range: RefRange,
    pub author_id: String,
    pub created_at: String,
    pub ai: VerseAi,
    /// None: the originals table was empty when the verse was added (filled in later, originals::backfill).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original: Option<Original>,
}
record!(Verse, "verses");

/// One verse of the original-language Bible, keyed as the discussions are
/// ("JHN.3.16", KJV numbering): the Hebrew Old Testament (WLC), the Greek New (SBLGNT).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OriginalVerse {
    pub id: String,
    pub lang: String,
    pub edition: String,
    /// Empty: the edition has not got the verse (Matt 17:21 in the SBLGNT).
    pub text: String,
}
record!(OriginalVerse, "originals");

/// What `originals` was filled from: the sha256 of the source files, so an
/// unchanged text is not written again ("originals" in `meta`).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OriginalsSource {
    pub id: String,
    pub sha256: String,
    pub verses: u64,
}
record!(OriginalsSource, "meta");

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Interpretation {
    pub id: String,
    pub verse_id: String,
    pub argument_id: String,
    pub question_id: String,
    /// "pro" | "con": the column.
    pub side: String,
    pub body_md: Text,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    pub author_id: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub deleted: bool,
}
record!(Interpretation, "interpretations");

/// A user's vote on a verse (1, -1, 0) or rating of an interpretation (1, -1).
/// The id is "<kind>:<targetId>:<userId>": one per user and target.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Vote {
    pub id: String,
    /// "verse:<id>" | "interpretation:<id>"
    pub target_key: String,
    pub user_id: String,
    pub value: i64,
    pub created_at: String,
    pub updated_at: String,
}
record!(Vote, "votes");

/// The evaluation cache: one model's verdict on one input ("<inputHash>:<model>").
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CachedVerdict {
    pub id: String,
    pub verdict: Verdict,
}
record!(CachedVerdict, "verdicts");

/// Bookkeeping, such as which seed version the local store holds.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Meta {
    pub id: String,
    pub version: u32,
}
record!(Meta, "meta");

pub const TABLES: [&str; 14] = [
    "users", "logins", "numbers", "invites", "sessions", "throttle", "questions", "arguments", "verses", "interpretations", "votes",
    "verdicts", "meta", "originals",
];
