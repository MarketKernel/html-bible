//! Fills the `originals` table in AWS from data/translations (originals.rs),
//! then gives the verses added before it their text and has them evaluated
//! again. Run by build_scripts/aws.sh after the stack is deployed, from the
//! deployer's computer with the deployer's credentials; a table that holds
//! these very files already is left alone.
//!
//! ```text
//! cargo run --release --bin originals --no-default-features --features aws -- ../data/translations
//! ```
//!
//! Settings, from the environment:
//!   AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN
//!                                 (`aws configure export-credentials --format env`)
//!   BIBLE_TABLE_PREFIX            the tables' prefix ("html-bible-")
//!   BIBLE_EVALUATOR_FUNCTION      the evaluator Lambda ("html-bible-evaluator")

use std::path::PathBuf;

use html_bible_server::app::{App, Config};
use html_bible_server::dynamo::{Aws, Credentials, DynamoStore};
use html_bible_server::evaluation;
use html_bible_server::originals::{self, Loaded};
use serde_json::json;

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn fail(message: String) -> ! {
    eprintln!("originals: {message}");
    std::process::exit(1)
}

fn main() {
    let dir = PathBuf::from(std::env::args().nth(1).unwrap_or_else(|| "data/translations".into()));
    let region = env("AWS_REGION").unwrap_or_else(|| fail("AWS_REGION is not set".into()));
    let credentials = Credentials::from_env().unwrap_or_else(|| fail("no AWS credentials in the environment".into()));
    let prefix = env("BIBLE_TABLE_PREFIX").unwrap_or_else(|| "html-bible-".into());
    let mut app = App::new(Config::default(), Box::new(DynamoStore::new(&region, &prefix, credentials.clone())));
    let function = env("BIBLE_EVALUATOR_FUNCTION").unwrap_or_else(|| "html-bible-evaluator".into());
    let aws = Aws::new(&region, credentials);
    app.defer = Some(Box::new(move |verse_id: &str| aws.invoke_async(&function, &json!({ "evaluate": verse_id }))));

    match originals::load(app.store.as_ref(), &dir) {
        Ok(Loaded::Written(n)) => println!("originals: {n} verses written to {prefix}originals"),
        Ok(Loaded::Unchanged) => println!("originals: {prefix}originals holds these texts already"),
        Ok(Loaded::Missing(file)) => fail(format!("{file} is missing: node tools/translations/build.mjs wlc sblgnt")),
        Err(e) => fail(e.0),
    }
    let filled = originals::backfill(&app).unwrap_or_else(|e| fail(e.0));
    for verse_id in &filled {
        // Pending until the evaluator Lambda answers with the original in its input.
        evaluation::request(&app, verse_id).unwrap_or_else(|e| fail(format!("{verse_id}: {}", e.0)));
    }
    let _ = app.store.flush();
    println!("originals: {} verse(s) of discussions got their text and went to the evaluator", filled.len());
}
