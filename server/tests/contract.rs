//! Contract fixtures (tests/fixtures/api/*.json): run them against the server and compare.
//!
//! Values saved by a step ("{code}") go into later paths, headers and bodies.
//!
//! Each fixture starts from a fresh, seeded, in-memory server whose clock stands
//! at FIXTURE_NOW, then runs its steps in order. Expected bodies may contain
//! placeholders for values a real server makes up (see `placeholder`);
//! everything else must match exactly, including the set of keys.
//!
//! ```text
//! cargo test --test contract                          check all fixtures
//! BIBLE_WRITE_FIXTURES=1 cargo test --test contract   refill the "response" parts
//!                                                     (review the diff: this is the contract!)
//! ```

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use html_bible_server::app::{App, Config};
use html_bible_server::auth::{is_token, open_session};
use html_bible_server::http::Request;
use html_bible_server::ids::{is_ulid, parse_iso};
use html_bible_server::model::{CachedVerdict, Question, Argument, Verse, Interpretation};
use html_bible_server::seed;
use html_bible_server::store::MemoryStore;
use serde_json::{json, Map, Value};

const FIXTURE_NOW: &str = "2026-10-18T12:00:00.000Z";

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/api")
}

fn is_iso(value: &str) -> bool {
    parse_iso(value).is_some()
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_uuid(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { *c == b'-' } else { c.is_ascii_hexdigit() && !c.is_ascii_uppercase() })
}

/// Whether `actual` fits a placeholder such as "<ulid>"; None when `expected` is no placeholder.
fn placeholder(expected: &str, actual: &Value) -> Option<bool> {
    let text = actual.as_str();
    Some(match expected {
        "<ulid>" => text.is_some_and(is_ulid),
        "<iso8601>" => text.is_some_and(is_iso),
        "<sha256>" => text.is_some_and(is_sha256),
        "<token>" => text.is_some_and(is_token),
        "<uuid>" => text.is_some_and(is_uuid),
        "<string>" => text.is_some(),
        "<number>" => actual.is_number(),
        _ => return None,
    })
}

fn same_type(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.is_f64() == y.is_f64(),
        _ => std::mem::discriminant(a) == std::mem::discriminant(b),
    }
}

fn compare(expected: &Value, actual: &Value, path: &str, problems: &mut Vec<String>) {
    if let Some(fits) = expected.as_str().and_then(|e| placeholder(e, actual)) {
        if !fits {
            problems.push(format!("{path}: {actual} is not {expected}"));
        }
        return;
    }
    match (expected, actual) {
        (Value::Object(e), Value::Object(a)) => {
            let keys: std::collections::BTreeSet<&String> = e.keys().chain(a.keys()).collect();
            for key in keys {
                match (e.get(key), a.get(key)) {
                    (Some(_), None) => problems.push(format!("{path}.{key}: missing")),
                    (None, Some(_)) => problems.push(format!("{path}.{key}: unexpected key")),
                    (Some(x), Some(y)) => compare(x, y, &format!("{path}.{key}"), problems),
                    (None, None) => {}
                }
            }
        }
        (Value::Array(e), Value::Array(a)) if e.len() == a.len() => {
            for (index, (x, y)) in e.iter().zip(a).enumerate() {
                compare(x, y, &format!("{path}[{index}]"), problems);
            }
        }
        (Value::Array(e), _) => problems.push(format!("{path}: expected a list of {}, got {}", e.len(), clip(actual))),
        (Value::Object(_), _) => problems.push(format!("{path}: expected an object, got {}", clip(actual))),
        _ => {
            if !same_type(expected, actual) || expected != actual {
                problems.push(format!("{path}: expected {expected}, got {}", clip(actual)));
            }
        }
    }
}

fn clip(value: &Value) -> String {
    value.to_string().chars().take(300).collect()
}

struct Step {
    status: u16,
    headers: Vec<(String, String)>,
    body: Value,
}

fn substitute(text: &str, saved: &HashMap<String, String>) -> String {
    let mut out = text.to_string();
    for (name, value) in saved {
        out = out.replace(&format!("{{{name}}}"), value);
    }
    out
}

fn run_fixture(fixture: &Value) -> Vec<Step> {
    let delay = fixture["server"]["evalDelay"].as_f64().unwrap_or(0.0);
    let config = Config { eval_delay_ms: (delay * 1000.0) as i64, ..Config::default() };
    let app = App::new(config, Box::new(MemoryStore::new(None))).with_fixed_clock(parse_iso(FIXTURE_NOW).unwrap());
    seed::load(&app).expect("the seed loads");
    let data = seed::data();
    let mut tokens: HashMap<String, String> = HashMap::new();
    let mut saved: HashMap<String, String> = HashMap::new();
    let mut steps = Vec::new();
    for step in fixture["steps"].as_array().expect("steps") {
        let request = &step["request"];
        let target = substitute(request["path"].as_str().expect("path"), &saved);
        let (path, query) = target.split_once('?').unwrap_or((&target, ""));
        let mut headers: Vec<(String, String)> = Vec::new();
        for (name, value) in request["headers"].as_object().into_iter().flatten() {
            // "{name}": a value saved by an earlier step (a token from sign-in).
            let mut value = substitute(value.as_str().unwrap_or_default(), &saved);
            // "<token:anna>": a valid token of that seed user.
            while let Some(start) = value.find("<token:") {
                let end = start + value[start..].find('>').expect("closing >");
                let key = value[start + 7..end].to_string();
                let token = tokens
                    .entry(key.clone())
                    .or_insert_with(|| open_session(&app, &seed::user_id(&data, &key)).expect("a session"))
                    .clone();
                value.replace_range(start..=end, &token);
            }
            headers.push((name.to_ascii_lowercase(), value));
        }
        let body = match request.get("body") {
            Some(body) => {
                headers.push(("content-type".into(), "application/json".into()));
                substitute(&serde_json::to_string(body).unwrap(), &saved).into_bytes()
            }
            None => Vec::new(),
        };
        let response = app.handle(&Request {
            method: request["method"].as_str().expect("method").to_string(),
            path: path.to_string(),
            query: query.to_string(),
            headers,
            body,
            source_ip: "127.0.0.1".into(),
        });
        let parsed = if response.header("content-type").is_some_and(|t| t.starts_with("application/json")) && !response.body.is_empty() {
            serde_json::from_slice(&response.body).expect("JSON responses parse")
        } else {
            Value::String(String::from_utf8_lossy(&response.body).into_owned())
        };
        for (name, key) in step["save"].as_object().into_iter().flatten() {
            if let Some(value) = key.as_str().and_then(|k| parsed.get(k)).and_then(Value::as_str) {
                saved.insert(name.clone(), value.to_string());
            }
        }
        steps.push(Step { status: response.status, headers: response.headers, body: parsed });
    }
    steps
}

fn fixtures() -> Vec<(PathBuf, Value)> {
    let mut paths: Vec<PathBuf> = fs::read_dir(fixture_dir()).expect("tests/fixtures/api").filter_map(|e| Some(e.ok()?.path())).collect();
    paths.retain(|p| p.extension().is_some_and(|x| x == "json"));
    paths.sort();
    paths.into_iter().map(|p| (p.clone(), serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap())).collect()
}

/// Ids and hashes the seed makes: they stay literal in the fixtures.
fn seed_values() -> (HashSet<String>, HashSet<String>, HashSet<String>) {
    let app = App::new(Config::default(), Box::new(MemoryStore::new(None)))
        .with_fixed_clock(parse_iso(FIXTURE_NOW).unwrap());
    seed::load(&app).unwrap();
    let db = app.db();
    let mut ids: HashSet<String> = HashSet::new();
    ids.extend(db.scan::<Question>().unwrap().into_iter().map(|r| r.id));
    ids.extend(db.scan::<Argument>().unwrap().into_iter().map(|r| r.id));
    ids.extend(db.scan::<Verse>().unwrap().into_iter().map(|r| r.id));
    ids.extend(db.scan::<Interpretation>().unwrap().into_iter().map(|r| r.id));
    let hashes = db.scan::<CachedVerdict>().unwrap().into_iter().map(|c| c.verdict.input_hash).collect();
    let mut users: HashSet<String> = seed::data()["users"].as_array().unwrap().iter().map(|u| u["id"].as_str().unwrap().to_string()).collect();
    users.insert(seed::ROOT_ID.to_string());
    (ids, hashes, users)
}

/// Replace what a real server makes up with placeholders.
fn generalize(value: &Value, seeds: &(HashSet<String>, HashSet<String>, HashSet<String>)) -> Value {
    match value {
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), generalize(v, seeds))).collect::<Map<_, _>>()),
        Value::Array(list) => Value::Array(list.iter().map(|v| generalize(v, seeds)).collect()),
        Value::String(text) => {
            let (ids, hashes, users) = seeds;
            if is_ulid(text) && !ids.contains(text) {
                json!("<ulid>")
            } else if text == FIXTURE_NOW {
                json!("<iso8601>")
            } else if is_sha256(text) && !hashes.contains(text) {
                json!("<sha256>")
            } else if is_token(text) {
                json!("<token>")
            } else if is_uuid(text) && !users.contains(text) {
                json!("<uuid>")
            } else {
                value.clone()
            }
        }
        _ => value.clone(),
    }
}

#[test]
fn contract_fixtures() {
    let write = std::env::var("BIBLE_WRITE_FIXTURES").is_ok_and(|v| !v.is_empty());
    let seeds = if write { Some(seed_values()) } else { None };
    let mut failures = Vec::new();
    let all = fixtures();
    assert!(!all.is_empty(), "no fixtures in {}", fixture_dir().display());
    for (path, mut fixture) in all {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let results = run_fixture(&fixture);
        if let Some(seeds) = &seeds {
            for (step, result) in fixture["steps"].as_array_mut().unwrap().iter_mut().zip(&results) {
                let mut response = json!({ "status": result.status, "body": generalize(&result.body, seeds) });
                if let Some(headers) = step["response"].get("headers") {
                    response["headers"] = headers.clone();
                }
                step["response"] = response;
            }
            fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&fixture).unwrap())).unwrap();
            println!("wrote {name}");
            continue;
        }
        for (index, (step, result)) in fixture["steps"].as_array().unwrap().iter().zip(&results).enumerate() {
            let expected = &step["response"];
            let at = format!("{name} step {}", index + 1);
            if expected["status"].as_u64() != Some(result.status as u64) {
                failures.push(format!("{at}: status {}, expected {} ({})", result.status, expected["status"], clip(&result.body)));
                continue;
            }
            let mut problems = Vec::new();
            for (header, value) in expected["headers"].as_object().into_iter().flatten() {
                let actual = result.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(header)).map(|(_, v)| json!(v)).unwrap_or(Value::Null);
                compare(value, &actual, &format!("header {header}"), &mut problems);
            }
            compare(&expected["body"], &result.body, "$", &mut problems);
            failures.extend(problems.into_iter().map(|p| format!("{at} {p}")));
        }
    }
    assert!(failures.is_empty(), "{} problem(s):\n{}", failures.len(), failures.join("\n"));
}
