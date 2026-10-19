//! Validation of user text and the LocalizedText it is stored as (Task.md §2.5, §2.11).

use serde_json::Value;

use crate::errors::{validation, ApiResult};

pub const LANGS: [&str; 2] = ["ru", "en"];

pub const TITLE_MAX: usize = 200;
pub const SIDE_MAX: usize = 60;
pub const MD_MAX: usize = 5000;
pub const IMAGES_MAX: usize = 5;
pub const TAGS_MAX: usize = 10;
pub const TAG_MAX: usize = 32;
pub const NAME_MAX: usize = 40;

const LANG_MESSAGE: &str = "\"lang\" must be \"ru\" or \"en\"";

/// The body's "lang": required whenever the body carries text.
pub fn require_lang(body: &Value) -> ApiResult<String> {
    match body.get("lang").and_then(Value::as_str) {
        Some(lang) if LANGS.contains(&lang) => Ok(lang.to_string()),
        _ => Err(validation(LANG_MESSAGE, "lang")),
    }
}

/// `?lang=` is accepted and checked, but responses always carry both languages.
pub fn query_lang(lang: Option<&str>) -> ApiResult<()> {
    match lang {
        Some(lang) if !LANGS.contains(&lang) => Err(validation(LANG_MESSAGE, "lang")),
        _ => Ok(()),
    }
}

/// Python's str.isspace(), which the original server trimmed with: Unicode
/// whitespace plus the separators U+001C–U+001F.
fn is_space(ch: char) -> bool {
    ch.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&ch)
}

fn is_control(ch: char) -> bool {
    matches!(ch, '\u{0}'..='\u{8}' | '\u{b}'..='\u{1f}' | '\u{7f}')
}

/// A trimmed string of `min..=max` characters; one line unless `multiline`.
/// A missing value is `Value::Null`, which is "not a string".
pub fn clean(value: &Value, field: &str, max: usize, min: usize, multiline: bool) -> ApiResult<String> {
    let Some(raw) = value.as_str() else {
        return Err(validation(format!("\"{field}\" must be a string"), field));
    };
    let text = raw.replace("\r\n", "\n").replace('\r', "\n");
    let text = text.trim_matches(is_space);
    if !multiline && text.contains('\n') {
        return Err(validation(format!("\"{field}\" must be one line"), field));
    }
    if text.chars().any(|ch| ch != '\t' && ch != '\n' && is_control(ch)) {
        return Err(validation(format!("\"{field}\" contains control characters"), field));
    }
    let length = text.chars().count();
    if length < min || length > max {
        return Err(if min > 0 {
            validation(format!("\"{field}\" must be {min}–{max} characters"), field)
        } else {
            validation(format!("\"{field}\" must be at most {max} characters"), field)
        });
    }
    Ok(text.to_string())
}

pub fn clean_line(value: &Value, field: &str, max: usize) -> ApiResult<String> {
    clean(value, field, max, 1, false)
}

/// Markdown (Task.md §2.5): only the length and the number of images are checked.
pub fn clean_md(value: &Value, field: &str, required: bool) -> ApiResult<String> {
    let text = clean(value, field, MD_MAX, usize::from(required), true)?;
    if count_images(&text) > IMAGES_MAX {
        return Err(validation(format!("\"{field}\" may contain at most {IMAGES_MAX} images"), field));
    }
    Ok(text)
}

/// Occurrences of `![alt](`, as the regex !\[[^\]]*\]\( finds them.
fn count_images(text: &str) -> usize {
    let bytes = text.as_bytes();
    let mut count = 0;
    let mut at = 0;
    while let Some(offset) = text[at..].find("![") {
        let start = at + offset;
        let close = text[start + 2..].find(']').map(|i| start + 2 + i);
        match close {
            Some(close) if bytes.get(close + 1) == Some(&b'(') => {
                count += 1;
                at = close + 2;
            }
            _ => at = start + 1,
        }
    }
    count
}

pub fn clean_tags(value: &Value) -> ApiResult<Vec<String>> {
    let list = match value.as_array() {
        Some(list) if list.len() <= TAGS_MAX => list,
        _ => return Err(validation(format!("\"tags\" must be a list of at most {TAGS_MAX} tags"), "tags")),
    };
    let mut tags: Vec<String> = Vec::new();
    for (index, tag) in list.iter().enumerate() {
        let field = format!("tags[{index}]");
        let tag = clean_line(tag, &field, TAG_MAX)?.to_lowercase();
        if !tag.chars().all(|ch| ch.is_alphanumeric() || ch == '-') {
            return Err(validation(format!("\"{field}\" may only contain letters, digits and \"-\""), &field));
        }
        if !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    Ok(tags)
}


#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cleaning() {
        assert_eq!(clean(&json!("  Hi \u{1f}"), "title", 10, 1, false).unwrap(), "Hi");
        assert_eq!(clean(&json!("a\r\nb"), "md", 10, 1, true).unwrap(), "a\nb");
        assert_eq!(clean(&json!("a\nb"), "title", 10, 1, false).unwrap_err().message, "\"title\" must be one line");
        assert_eq!(clean(&json!("a\u{7}b"), "title", 10, 1, false).unwrap_err().message, "\"title\" contains control characters");
        assert_eq!(clean(&json!(""), "title", 10, 1, false).unwrap_err().message, "\"title\" must be 1–10 characters");
        assert_eq!(clean(&json!("ёёё"), "title", 3, 1, false).unwrap(), "ёёё");
        assert_eq!(clean(&Value::Null, "title", 3, 1, false).unwrap_err().message, "\"title\" must be a string");
    }

    #[test]
    fn images_and_tags() {
        assert_eq!(count_images("![a](x) ![b] (y) ![c](z) ![d"), 2);
        assert_eq!(clean_tags(&json!(["Baptism", "baptism", "holy-spirit"])).unwrap(), vec!["baptism", "holy-spirit"]);
        assert_eq!(clean_tags(&json!(["a b"])).unwrap_err().field.as_deref(), Some("tags[0]"));
    }
}
