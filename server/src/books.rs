//! Canonical book ids (USFM, KJV versification) and the KJV verse counts.
//!
//! Only the 66 canonical books may appear in discussions. Deuterocanonical ids
//! are listed separately so the server can say *why* a reference is refused.

use std::collections::HashMap;
use std::sync::OnceLock;

pub const CANONICAL_BOOKS: [&str; 66] = [
    "GEN", "EXO", "LEV", "NUM", "DEU", "JOS", "JDG", "RUT", "1SA", "2SA", "1KI", "2KI", "1CH", "2CH", "EZR", "NEH",
    "EST", "JOB", "PSA", "PRO", "ECC", "SNG", "ISA", "JER", "LAM", "EZK", "DAN", "HOS", "JOL", "AMO", "OBA", "JON",
    "MIC", "NAM", "HAB", "ZEP", "HAG", "ZEC", "MAL", "MAT", "MRK", "LUK", "JHN", "ACT", "ROM", "1CO", "2CO", "GAL",
    "EPH", "PHP", "COL", "1TH", "2TH", "1TI", "2TI", "TIT", "PHM", "HEB", "JAS", "1PE", "2PE", "1JN", "2JN", "3JN",
    "JUD", "REV",
];

/// The Synodal's extra books (Task.md §2.2) plus the other USFM deuterocanonical
/// ids, so a client bug sending any of them gets `noncanonical_ref`, not a vague error.
pub const NONCANONICAL_BOOKS: [&str; 25] = [
    "TOB", "JDT", "WIS", "SIR", "LJE", "BAR", "1MA", "2MA", "3MA", "4MA", "1ES", "2ES", "ESG", "S3Y", "SUS", "BEL",
    "MAN", "PS2", "ODA", "PSS", "EZA", "5EZ", "6EZ", "DAG", "LAO",
];

/// Position in GEN … REV, or None for anything that is not a canonical book.
pub fn book_index(book: &str) -> Option<usize> {
    CANONICAL_BOOKS.iter().position(|b| *b == book)
}

pub fn is_noncanonical(book: &str) -> bool {
    NONCANONICAL_BOOKS.contains(&book)
}

/// Verses per chapter of every canonical book (data/meta/kjv-counts.json,
/// built with the KJV text). Compiled in: the server needs no data files.
fn counts() -> &'static HashMap<String, Vec<u32>> {
    static COUNTS: OnceLock<HashMap<String, Vec<u32>>> = OnceLock::new();
    COUNTS.get_or_init(|| {
        let counts: HashMap<String, Vec<u32>> =
            serde_json::from_str(include_str!("../../data/meta/kjv-counts.json")).expect("data/meta/kjv-counts.json is valid");
        assert!(CANONICAL_BOOKS.iter().all(|b| counts.get(*b).is_some_and(|c| !c.is_empty())), "kjv-counts.json lacks a book");
        counts
    })
}

pub fn chapters(book: &str) -> Option<u32> {
    counts().get(book).map(|c| c.len() as u32)
}

pub fn verses(book: &str, chapter: u32) -> Option<u32> {
    let chapters = counts().get(book)?;
    if chapter == 0 {
        return None;
    }
    chapters.get(chapter as usize - 1).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts() {
        assert_eq!(chapters("PSA"), Some(150));
        assert_eq!(verses("PSA", 119), Some(176));
        assert_eq!(verses("JHN", 3), Some(36));
        assert_eq!(verses("JHN", 22), None);
        assert_eq!(book_index("REV"), Some(65));
        assert!(is_noncanonical("TOB") && book_index("TOB").is_none());
    }
}
