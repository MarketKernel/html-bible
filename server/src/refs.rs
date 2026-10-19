//! Canonical verse keys ("JHN.3.16") and ranges ({ from, to }).
//!
//! Discussions only ever hold canonical references (KJV versification); anything
//! else is refused here, at the edge, with a code the client can explain.

use serde_json::Value;

use crate::books::{book_index, chapters, is_noncanonical, verses};
use crate::errors::{repr, ApiError, ApiResult};
use crate::model::RefRange;

pub type Key = (String, u32, u32);

pub fn invalid_ref(message: impl Into<String>, field: &str) -> ApiError {
    ApiError::new(400, "invalid_ref", message).field(field)
}

pub fn noncanonical_ref(book: &str, field: &str) -> ApiError {
    ApiError::new(400, "noncanonical_ref", format!("{book} is not a canonical book; discussions only cite the 66 canonical books"))
        .field(field)
}

/// Three characters: a digit 1–9 or a capital, then capitals or digits ("JHN", "1CO").
pub fn is_book_id(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 3
        && (matches!(b[0], b'1'..=b'9') || b[0].is_ascii_uppercase())
        && b[1..].iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

pub fn check_book(book: &str, field: &str) -> ApiResult<()> {
    if book_index(book).is_some() {
        Ok(())
    } else if is_noncanonical(book) {
        Err(noncanonical_ref(book, field))
    } else {
        Err(invalid_ref(format!("Unknown book id {}", repr(book)), field))
    }
}

/// 1–999 written without leading zeros.
fn number(part: &str) -> Option<u32> {
    let b = part.as_bytes();
    if b.is_empty() || b.len() > 3 || b[0] == b'0' || !b.iter().all(u8::is_ascii_digit) {
        return None;
    }
    part.parse().ok()
}

fn split_key(value: &str) -> Option<(&str, u32, u32)> {
    let mut parts = value.split('.');
    let (book, chapter, verse) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || !is_book_id(book) {
        return None;
    }
    Some((book, number(chapter)?, number(verse)?))
}

/// A key as the client sends it; `check_counts` also holds it to the KJV counts.
pub fn parse_key(value: &Value, field: &str, check_counts: bool) -> ApiResult<Key> {
    let Some(text) = value.as_str() else {
        return Err(invalid_ref("A verse key must be a string like JHN.3.16", field));
    };
    let Some((book, chapter, verse)) = split_key(text) else {
        let book = text.split('.').next().unwrap_or("");
        if is_noncanonical(book) {
            return Err(noncanonical_ref(book, field));
        }
        return Err(invalid_ref(format!("{} is not a canonical verse key like JHN.3.16", repr(text)), field));
    };
    check_book(book, field)?;
    if check_counts {
        if let Some(count) = chapters(book) {
            if chapter > count {
                return Err(invalid_ref(format!("{book} has {count} chapters"), field));
            }
        }
        if let Some(count) = verses(book, chapter) {
            if verse > count {
                return Err(invalid_ref(format!("{book} {chapter} has {count} verses"), field));
            }
        }
    }
    Ok((book.to_string(), chapter, verse))
}

/// A key the server stored itself: valid by construction.
pub fn stored_key(value: &str) -> Key {
    let (book, chapter, verse) = split_key(value).unwrap_or(("GEN", 1, 1));
    (book.to_string(), chapter, verse)
}

pub fn format_key(key: &Key) -> String {
    format!("{}.{}.{}", key.0, key.1, key.2)
}

/// Validate one RefRange and return it as a fresh { from, to }.
pub fn parse_range(value: &Value, field: &str) -> ApiResult<RefRange> {
    let (Some(from), Some(to)) = (value.get("from"), value.get("to")) else {
        return Err(invalid_ref("A reference must be an object { from, to }", field));
    };
    if !value.is_object() {
        return Err(invalid_ref("A reference must be an object { from, to }", field));
    }
    let start = parse_key(from, &format!("{field}.from"), true)?;
    let end = parse_key(to, &format!("{field}.to"), true)?;
    if start.0 != end.0 {
        return Err(invalid_ref("A range must stay within one book", field));
    }
    if (start.1, start.2) > (end.1, end.2) {
        return Err(invalid_ref("A range must not end before it starts", field));
    }
    Ok(RefRange { from: format_key(&start), to: format_key(&end) })
}

/// The verse numbers of `book chapter` that the range covers (ranges may span chapters).
pub fn verses_in_chapter(range: &RefRange, book: &str, chapter: u32) -> Vec<u32> {
    let (from_book, from_chapter, from_verse) = stored_key(&range.from);
    let (_, to_chapter, to_verse) = stored_key(&range.to);
    if from_book != book || !(from_chapter..=to_chapter).contains(&chapter) {
        return Vec::new();
    }
    let first = if chapter == from_chapter { from_verse } else { 1 };
    let last = if chapter == to_chapter { to_verse } else { verses(book, chapter).unwrap_or(176) };
    (first..=last).collect()
}

/// Canonical order: book (GEN … REV), chapter, verse.
pub fn sort_key(key: &str) -> (usize, u32, u32) {
    let (book, chapter, verse) = stored_key(key);
    (book_index(&book).unwrap_or(usize::MAX), chapter, verse)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn code(result: ApiResult<RefRange>) -> (String, Option<String>) {
        let error = result.unwrap_err();
        (error.code.to_string(), error.field)
    }

    #[test]
    fn ranges() {
        let r = parse_range(&json!({ "from": "JHN.3.36", "to": "JHN.4.2" }), "ref").unwrap();
        assert_eq!((r.from.as_str(), r.to.as_str()), ("JHN.3.36", "JHN.4.2"));
        assert_eq!(code(parse_range(&json!({ "from": "TOB.1.1", "to": "TOB.1.1" }), "ref")), ("noncanonical_ref".into(), Some("ref.from".into())));
        assert_eq!(code(parse_range(&json!({ "from": "JHN.03.16", "to": "JHN.3.16" }), "ref")), ("invalid_ref".into(), Some("ref.from".into())));
        assert_eq!(code(parse_range(&json!({ "from": "JHN.3.37", "to": "JHN.3.37" }), "ref")), ("invalid_ref".into(), Some("ref.from".into())));
        assert_eq!(code(parse_range(&json!({ "from": "JHN.3.2", "to": "JHN.3.1" }), "ref")), ("invalid_ref".into(), Some("ref".into())));
        assert_eq!(code(parse_range(&json!({ "from": "JHN.3.2", "to": "ACT.3.1" }), "ref")), ("invalid_ref".into(), Some("ref".into())));
        assert_eq!(code(parse_range(&json!("JHN.3.16"), "ref")), ("invalid_ref".into(), Some("ref".into())));
    }

    #[test]
    fn chapters_of_a_range() {
        let r = RefRange { from: "JHN.3.35".into(), to: "JHN.4.2".into() };
        assert_eq!(verses_in_chapter(&r, "JHN", 3), vec![35, 36]);
        assert_eq!(verses_in_chapter(&r, "JHN", 4), vec![1, 2]);
        assert!(verses_in_chapter(&r, "JHN", 5).is_empty());
        assert!(sort_key("JHN.3.2") < sort_key("JHN.3.16"));
    }
}
