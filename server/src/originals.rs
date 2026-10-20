//! The Bible in its original languages, on the server (Task.md §6.1): one
//! edition per testament, the oldest and fullest we have — the Hebrew
//! Masoretic text of the Leningrad Codex (WLC) for the Old Testament, the
//! SBL Greek New Testament, a critical text made from the oldest papyri and
//! codices, for the New.
//!
//! The table `originals` holds one item per verse, keyed as the discussions
//! are (KJV numbering). It is filled from the site's own files
//! (data/translations/hbo-wlc, grc-sblgnt) by `load`: the local server at
//! launch, the `originals` binary in AWS (build_scripts/aws.sh). When a verse
//! is added to a discussion its text is copied from here into it (`lookup`),
//! so the evaluator reads the original from the server's own table and never
//! a text a member sent, and readers see it beside their translation.

use std::io::Read;
use std::path::Path;

use flate2::read::GzDecoder;
use serde::Deserialize;

use crate::app::App;
use crate::books::{book_index, verses};
use crate::ids::sha256_hex;
use crate::model::{Original, OriginalVerse, OriginalsSource, RefRange, Verse};
use crate::refs::stored_key;
use crate::store::{Db, Store, StoreError, StoreResult, Write};

/// (file id in data/translations, language, edition): the Old Testament's, then the New's.
pub const SOURCES: [(&str, &str, &str); 2] = [("hbo-wlc", "hbo", "WLC"), ("grc-sblgnt", "grc", "SBLGNT")];

/// Verses shown before and after the range.
const CONTEXT: usize = 3;

/// A longer range keeps only its start: a stone is a verse or a passage, not a book.
pub const MAX_VERSES: usize = 100;

/// The first book of the New Testament in canonical order.
const MATTHEW: usize = 39;

/// The marker's id in `meta`.
const SOURCE_ID: &str = "originals";

/// Items per write: TransactWriteItems takes at most 100.
const CHUNK: usize = 100;

#[derive(Deserialize)]
struct File {
    books: Vec<Book>,
}

#[derive(Deserialize)]
struct Book {
    id: String,
    chapters: Vec<Vec<String>>,
}

/// (chapter, verse) from `from` to `to` within one book, by the KJV counts.
fn span(book: &str, from: (u32, u32), to: (u32, u32)) -> Vec<(u32, u32)> {
    let mut out = Vec::new();
    for chapter in from.0..=to.0 {
        let first = if chapter == from.0 { from.1 } else { 1 };
        let last = if chapter == to.0 { to.1 } else { verses(book, chapter).unwrap_or(0) };
        out.extend((first..=last).map(|v| (chapter, v)));
    }
    out
}

/// Up to `n` verses before `at` in its book.
fn before(book: &str, at: (u32, u32), n: usize) -> Vec<(u32, u32)> {
    let mut out = Vec::new();
    let (mut chapter, mut verse) = at;
    while out.len() < n {
        if verse > 1 {
            verse -= 1;
        } else if chapter > 1 {
            chapter -= 1;
            verse = verses(book, chapter).unwrap_or(0);
            if verse == 0 {
                break;
            }
        } else {
            break;
        }
        out.push((chapter, verse));
    }
    out.reverse();
    out
}

/// Up to `n` verses after `at` in its book.
fn after(book: &str, at: (u32, u32), n: usize) -> Vec<(u32, u32)> {
    let mut out = Vec::new();
    let (mut chapter, mut verse) = at;
    while out.len() < n {
        if verse < verses(book, chapter).unwrap_or(0) {
            verse += 1;
        } else if verses(book, chapter + 1).is_some() {
            chapter += 1;
            verse = 1;
        } else {
            break;
        }
        out.push((chapter, verse));
    }
    out
}

/// The range in its original language with the verses around it; None while
/// the table has not got it (not filled yet).
pub fn lookup(db: &Db, range: &RefRange) -> StoreResult<Option<Original>> {
    let (book, from_chapter, from_verse) = stored_key(&range.from);
    let (_, to_chapter, to_verse) = stored_key(&range.to);
    let Some(index) = book_index(&book) else {
        return Ok(None);
    };
    let (_, lang, edition) = if index < MATTHEW { SOURCES[0] } else { SOURCES[1] };
    let mut keys = span(&book, (from_chapter, from_verse), (to_chapter, to_verse));
    let cut = keys.len() > MAX_VERSES;
    keys.truncate(MAX_VERSES);
    let Some(&last) = keys.last() else {
        return Ok(None);
    };
    let text = |&(chapter, verse): &(u32, u32)| -> StoreResult<Option<String>> {
        Ok(db.get::<OriginalVerse>(&format!("{book}.{chapter}.{verse}"))?.map(|item| item.text))
    };
    let mut texts = Vec::new();
    for key in &keys {
        match text(key)? {
            Some(found) => texts.push(found),
            None => return Ok(None),
        }
    }
    let lines = |at: Vec<(u32, u32)>| -> StoreResult<String> {
        let mut out = Vec::new();
        for key in at {
            if let Some(found) = text(&key)? {
                out.push(format!("{}:{} {found}", key.0, key.1));
            }
        }
        Ok(out.join("\n"))
    };
    let joined = match keys.as_slice() {
        [_] => texts.remove(0),
        _ => keys.iter().zip(&texts).map(|((c, v), t)| format!("{c}:{v} {t}")).collect::<Vec<_>>().join("\n"),
    };
    Ok(Some(Original {
        lang: lang.into(),
        edition: edition.into(),
        text: joined,
        before: lines(before(&book, keys[0], CONTEXT))?,
        after: if cut { String::new() } else { lines(after(&book, last, CONTEXT))? },
        cut,
    }))
}

/// What `load` did.
#[derive(Debug, PartialEq)]
pub enum Loaded {
    /// The source files are not there (a server without data/): nothing written.
    Missing(String),
    /// The table already holds these very files.
    Unchanged,
    /// This many verses written.
    Written(usize),
}

fn read(path: &Path) -> Result<Vec<Book>, String> {
    let raw = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut json = String::new();
    GzDecoder::new(raw.as_slice()).read_to_string(&mut json).map_err(|e| format!("{}: {e}", path.display()))?;
    let file: File = serde_json::from_str(&json).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(file.books)
}

/// Fill `originals` from `dir` (data/translations): every verse of both
/// editions, empty ones too, so a verse an edition lacks is told from a table
/// not filled. Skipped when the files are those it was filled from.
pub fn load(store: &dyn Store, dir: &Path) -> StoreResult<Loaded> {
    let paths: Vec<_> = SOURCES.iter().map(|(id, _, _)| dir.join(format!("{id}.json.gz"))).collect();
    if let Some(missing) = paths.iter().find(|p| !p.exists()) {
        return Ok(Loaded::Missing(missing.display().to_string()));
    }
    let mut bytes = Vec::new();
    for path in &paths {
        bytes.extend(std::fs::read(path).map_err(|e| StoreError(format!("{}: {e}", path.display())))?);
    }
    let digest = sha256_hex(&bytes);
    let db = Db(store);
    if db.get::<OriginalsSource>(SOURCE_ID)?.is_some_and(|s| s.sha256 == digest) {
        return Ok(Loaded::Unchanged);
    }
    let mut items = Vec::new();
    for ((_, lang, edition), path) in SOURCES.iter().zip(&paths) {
        for book in read(path).map_err(StoreError)? {
            for (c, chapter) in book.chapters.iter().enumerate() {
                for (v, text) in chapter.iter().enumerate() {
                    let id = format!("{}.{}.{}", book.id, c + 1, v + 1);
                    items.push(OriginalVerse { id, lang: lang.to_string(), edition: edition.to_string(), text: text.clone() });
                }
            }
        }
    }
    for chunk in items.chunks(CHUNK) {
        let writes = chunk.iter().map(Write::put).collect::<StoreResult<Vec<_>>>()?;
        // A busy table refuses a transaction now and then: the writes are plain puts, so again is safe.
        let mut attempt = 0;
        loop {
            match store.transact(&writes) {
                Ok(_) => break,
                Err(error) if attempt < 5 => {
                    attempt += 1;
                    eprintln!("[originals] {} (again, {attempt})", error.0);
                    std::thread::sleep(std::time::Duration::from_millis(200 << attempt));
                }
                Err(error) => return Err(error),
            }
        }
    }
    db.put(&OriginalsSource { id: SOURCE_ID.into(), sha256: digest, verses: items.len() as u64 })?;
    store.flush()?;
    Ok(Loaded::Written(items.len()))
}

/// Give the original to the verses added while the table was empty; their ids.
pub fn backfill(app: &App) -> StoreResult<Vec<String>> {
    let db = app.db();
    let mut filled = Vec::new();
    for mut verse in db.scan::<Verse>()?.into_iter().filter(|v| v.original.is_none()) {
        if let Some(original) = lookup(&db, &verse.range)? {
            verse.original = Some(original);
            db.put(&verse)?;
            filled.push(verse.id);
        }
    }
    app.store.flush()?;
    Ok(filled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::MemoryStore;
    use flate2::write::GzEncoder;
    use serde_json::json;
    use std::io::Write as _;

    fn write(dir: &Path, id: &str, books: serde_json::Value) {
        let mut gz = GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(json!({ "id": id, "books": books }).to_string().as_bytes()).unwrap();
        std::fs::write(dir.join(format!("{id}.json.gz")), gz.finish().unwrap()).unwrap();
    }

    fn range(from: &str, to: &str) -> RefRange {
        RefRange { from: from.into(), to: to.into() }
    }

    /// John 1–3 (51, 25, 36 verses) and Genesis 1 (31) as "<chapter>:<verse>" in each language.
    fn sources(dir: &Path) {
        let chapters = |counts: &[u32], mark: &str| -> serde_json::Value {
            counts.iter().enumerate().map(|(c, n)| (1..=*n).map(|v| format!("{mark}{}:{v}", c + 1)).collect::<Vec<_>>()).collect()
        };
        let mut john = chapters(&[51, 25, 36], "λ");
        john[2][15] = json!("οὕτως γὰρ");
        john[1][4] = json!("");
        write(dir, "grc-sblgnt", json!([{ "id": "JHN", "chapters": john }]));
        write(dir, "hbo-wlc", json!([{ "id": "GEN", "chapters": chapters(&[31], "ב") }]));
    }

    #[test]
    fn filled_once_then_read_by_verse_with_its_context() {
        let dir = std::env::temp_dir().join(format!("html-bible-originals-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = MemoryStore::new(None);
        assert!(matches!(load(&store, &dir.join("nope")).unwrap(), Loaded::Missing(_)));
        sources(&dir);
        assert_eq!(load(&store, &dir).unwrap(), Loaded::Written(51 + 25 + 36 + 31));
        assert_eq!(load(&store, &dir).unwrap(), Loaded::Unchanged);
        let db = Db(&store);

        let one = lookup(&db, &range("JHN.3.16", "JHN.3.16")).unwrap().unwrap();
        assert_eq!((one.lang.as_str(), one.edition.as_str(), one.text.as_str()), ("grc", "SBLGNT", "οὕτως γὰρ"));
        assert_eq!((one.before.as_str(), one.after.as_str()), ("3:13 λ3:13\n3:14 λ3:14\n3:15 λ3:15", "3:17 λ3:17\n3:18 λ3:18\n3:19 λ3:19"));

        // Across a chapter, the context too; an empty verse is the edition's gap.
        let two = lookup(&db, &range("JHN.1.51", "JHN.2.1")).unwrap().unwrap();
        assert_eq!((two.text.as_str(), two.after.as_str()), ("1:51 λ1:51\n2:1 λ2:1", "2:2 λ2:2\n2:3 λ2:3\n2:4 λ2:4"));
        assert_eq!(lookup(&db, &range("JHN.2.5", "JHN.2.5")).unwrap().unwrap().text, "");
        assert_eq!(lookup(&db, &range("JHN.3.36", "JHN.3.36")).unwrap().unwrap().after, "", "John 4 is not in the table");

        let hebrew = lookup(&db, &range("GEN.1.1", "GEN.1.1")).unwrap().unwrap();
        assert_eq!((hebrew.lang.as_str(), hebrew.edition.as_str(), hebrew.text.as_str(), hebrew.before.as_str()), ("hbo", "WLC", "ב1:1", ""));

        let long = lookup(&db, &range("JHN.1.1", "JHN.3.36")).unwrap().unwrap();
        assert!(long.cut && long.text.lines().count() == MAX_VERSES && long.after.is_empty());
        assert!(lookup(&db, &range("REV.1.1", "REV.1.1")).unwrap().is_none(), "not in the table");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The site's own files, when data/ is built (skipped otherwise, as the texts' JS tests are).
    #[test]
    fn the_real_texts() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../data/translations");
        let store = MemoryStore::new(None);
        match load(&store, &dir).unwrap() {
            Loaded::Missing(file) => return eprintln!("originals: no {file}, skipped"),
            loaded => assert_eq!(loaded, Loaded::Written(23145 + 7957)),
        }
        let db = Db(&store);
        let get = |from: &str, to: &str| lookup(&db, &range(from, to)).unwrap().unwrap();
        assert!(get("JHN.1.1", "JHN.1.1").text.starts_with("Ἐν ἀρχῇ ἦν ὁ λόγος"));
        assert_eq!(get("MAT.17.21", "MAT.17.21").text, "", "not in the oldest manuscripts");
        assert!(!get("1JN.5.7", "1JN.5.7").text.contains("οὐρανῷ"), "no Comma Johanneum");
        let psalm = get("PSA.51.1", "PSA.51.2");
        assert_eq!((psalm.lang.as_str(), psalm.edition.as_str()), ("hbo", "WLC"));
        assert!(psalm.text.starts_with("51:1 ") && psalm.text.contains("\n51:2 "));
        assert_eq!(get("NEH.7.68", "NEH.7.68").text, "");
    }
}
