//! The verse in its original language, for the evaluator (Task.md §6.1): the
//! Hebrew Masoretic text (Westminster Leningrad Codex) for the Old Testament,
//! the Greek for the New — Robinson–Pierpont 2018, with the Patriarchal text
//! of 1904 and the Textus Receptus where they read otherwise. No translation
//! is ever shown to the model: a translation carries its translator's choices.
//!
//! The texts are the site's own translation files (data/translations/*.json.gz,
//! in KJV numbering like the discussions' keys), read from the server's own
//! disk, so no member can slip in a changed text. A file is read the first
//! time a verse of its testament is evaluated, and kept.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};

use crate::books::book_index;
use crate::model::RefRange;
use crate::refs::stored_key;

/// Verses shown before and after the evaluated ones.
const CONTEXT: usize = 3;

/// (file id, short name) of each testament's editions; the first is the main one.
const HEBREW: &[(&str, &str)] = &[("hbo-wlc", "WLC")];
const GREEK: &[(&str, &str)] = &[("grc-rp2018", "RP"), ("grc-pt1904", "PT"), ("grc-tr", "TR")];

/// The first book of the New Testament in canonical order.
const MATTHEW: usize = 39;

#[derive(Deserialize)]
struct File {
    books: Vec<Book>,
}

#[derive(Deserialize)]
struct Book {
    id: String,
    chapters: Vec<Vec<String>>,
}

type Books = HashMap<String, Vec<Vec<String>>>;

/// What the model is shown of a verse, all in the original language.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Original {
    /// "hbo" (Biblical Hebrew) or "grc" (Koine Greek).
    pub lang: &'static str,
    /// The verse in the main edition, then each other edition whose wording
    /// differs; an empty text: the edition does not have the verse.
    pub editions: Vec<EditionText>,
    /// The verses around it in the main edition, one "chapter:verse text" per line.
    pub before: String,
    pub after: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct EditionText {
    pub edition: &'static str,
    pub text: String,
}

pub struct Originals {
    dir: PathBuf,
    files: HashMap<&'static str, OnceLock<Option<Books>>>,
}

impl Originals {
    /// The texts in `dir` (data/translations or a copy of it); nothing is read yet.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        let files = HEBREW.iter().chain(GREEK).map(|(id, _)| (*id, OnceLock::new())).collect();
        Originals { dir: dir.into(), files }
    }

    fn books(&self, id: &str) -> Option<&Books> {
        self.files.get(id)?.get_or_init(|| match read(&self.dir.join(format!("{id}.json.gz"))) {
            Ok(books) => Some(books),
            Err(error) => {
                eprintln!("[originals] {id}: {error}");
                None
            }
        })
        .as_ref()
    }

    /// The range in its original language; None when the main edition's file is missing.
    pub fn text(&self, range: &RefRange) -> Option<Original> {
        let (book, from_chapter, from_verse) = stored_key(&range.from);
        let (_, to_chapter, to_verse) = stored_key(&range.to);
        let (lang, editions) = if book_index(&book)? < MATTHEW { ("hbo", HEBREW) } else { ("grc", GREEK) };
        let (main_id, main_name) = editions[0];
        let chapters = self.books(main_id)?.get(&book)?;
        let order: Vec<(u32, u32)> = chapters.iter().enumerate().flat_map(|(c, verses)| (1..=verses.len() as u32).map(move |v| (c as u32 + 1, v))).collect();
        let first = order.iter().position(|&at| at == (from_chapter, from_verse))?;
        let last = order.iter().position(|&at| at == (to_chapter, to_verse))?;
        let span = &order[first..=last];
        let main = passage(chapters, span);
        let mut texts = vec![EditionText { edition: main_name, text: main.clone() }];
        for (id, name) in &editions[1..] {
            if let Some(other) = self.books(id).and_then(|b| b.get(&book)) {
                let text = passage(other, span);
                if text != main {
                    texts.push(EditionText { edition: name, text });
                }
            }
        }
        let lines = |at: &[(u32, u32)]| at.iter().map(|&(c, v)| format!("{c}:{v} {}", verse(chapters, c, v))).collect::<Vec<_>>().join("\n");
        Some(Original {
            lang,
            editions: texts,
            before: lines(&order[first.saturating_sub(CONTEXT)..first]),
            after: lines(&order[last + 1..(last + 1 + CONTEXT).min(order.len())]),
        })
    }
}

fn verse(chapters: &[Vec<String>], chapter: u32, verse: u32) -> &str {
    chapters.get(chapter as usize - 1).and_then(|c| c.get(verse as usize - 1)).map_or("", String::as_str)
}

/// One verse as it is; several, each after its "chapter:verse".
fn passage(chapters: &[Vec<String>], span: &[(u32, u32)]) -> String {
    match span {
        [(c, v)] => verse(chapters, *c, *v).to_string(),
        _ => span.iter().map(|&(c, v)| format!("{c}:{v} {}", verse(chapters, c, v))).collect::<Vec<_>>().join("\n"),
    }
}

fn read(path: &Path) -> Result<Books, String> {
    let raw = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut json = String::new();
    GzDecoder::new(raw.as_slice()).read_to_string(&mut json).map_err(|e| format!("{}: {e}", path.display()))?;
    let file: File = serde_json::from_str(&json).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(file.books.into_iter().map(|b| (b.id, b.chapters)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use serde_json::json;
    use std::io::Write;

    fn write(dir: &Path, id: &str, books: serde_json::Value) {
        let mut gz = GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(json!({ "id": id, "books": books }).to_string().as_bytes()).unwrap();
        std::fs::write(dir.join(format!("{id}.json.gz")), gz.finish().unwrap()).unwrap();
    }

    fn range(from: &str, to: &str) -> RefRange {
        RefRange { from: from.into(), to: to.into() }
    }

    #[test]
    fn the_verse_in_the_original_with_the_editions_that_differ() {
        let dir = std::env::temp_dir().join(format!("html-bible-originals-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let john = |v3: &str| json!([{ "id": "JHN", "chapters": [["a1", "a2"], ["b1", "b2", v3, "b4", "b5"]] }]);
        write(&dir, "grc-rp2018", john("οὕτως γὰρ"));
        write(&dir, "grc-pt1904", john("οὕτως γὰρ"));
        write(&dir, "grc-tr", john("Οὕτω γὰρ"));
        write(&dir, "hbo-wlc", json!([{ "id": "GEN", "chapters": [["בְּרֵאשִׁ֖ית", "x"]] }]));
        let originals = Originals::new(&dir);

        let one = originals.text(&range("JHN.2.3", "JHN.2.3")).unwrap();
        assert_eq!(one.lang, "grc");
        assert_eq!(one.editions, vec![EditionText { edition: "RP", text: "οὕτως γὰρ".into() }, EditionText { edition: "TR", text: "Οὕτω γὰρ".into() }]);
        assert_eq!((one.before.as_str(), one.after.as_str()), ("1:2 a2\n2:1 b1\n2:2 b2", "2:4 b4\n2:5 b5"));

        let two = originals.text(&range("JHN.1.2", "JHN.2.1")).unwrap();
        assert_eq!(two.editions[0].text, "1:2 a2\n2:1 b1");
        assert_eq!((two.before.as_str(), two.editions.len()), ("1:1 a1", 1));

        let hebrew = originals.text(&range("GEN.1.1", "GEN.1.1")).unwrap();
        assert_eq!((hebrew.lang, hebrew.editions[0].edition, hebrew.editions[0].text.as_str(), hebrew.before.as_str()), ("hbo", "WLC", "בְּרֵאשִׁ֖ית", ""));

        assert!(originals.text(&range("REV.1.1", "REV.1.1")).is_none(), "a book the files lack");
        assert!(Originals::new(dir.join("nope")).text(&range("JHN.2.3", "JHN.2.3")).is_none(), "no files");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The site's own files, when data/ is built (skipped otherwise, as the texts' JS tests are).
    #[test]
    fn the_real_texts() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../data/translations");
        if !GREEK.iter().chain(HEBREW).all(|(id, _)| dir.join(format!("{id}.json.gz")).exists()) {
            eprintln!("originals: no data/translations, skipped");
            return;
        }
        let originals = Originals::new(&dir);
        let names = |o: &Original| o.editions.iter().map(|e| e.edition).collect::<Vec<_>>();
        let john = originals.text(&range("JHN.3.16", "JHN.3.16")).unwrap();
        assert!(john.editions[0].text.starts_with("Οὕτως γὰρ ἠγάπησεν"));
        assert_eq!(john.before.lines().count(), 3);
        // The Comma Johanneum: the Byzantine text has not got it, PT and TR have.
        let comma = originals.text(&range("1JN.5.7", "1JN.5.7")).unwrap();
        assert_eq!(names(&comma), ["RP", "PT", "TR"]);
        assert!(!comma.editions[0].text.contains("οὐρανῷ") && comma.editions[2].text.contains("οὐρανῷ"));
        // A verse the main edition lacks: its empty text, then those that have it.
        let luke = originals.text(&range("LUK.17.36", "LUK.17.36")).unwrap();
        assert_eq!((luke.editions[0].text.as_str(), names(&luke)), ("", vec!["RP", "PT", "TR"]));
        let psalm = originals.text(&range("PSA.51.1", "PSA.51.2")).unwrap();
        assert_eq!((psalm.lang, names(&psalm)), ("hbo", vec!["WLC"]));
        assert!(psalm.editions[0].text.starts_with("51:1 ") && psalm.editions[0].text.contains("\n51:2 "));
        assert_eq!(originals.text(&range("NEH.7.68", "NEH.7.68")).unwrap().editions[0].text, "");
    }
}
