//! The API as AWS Lambda functions (runtime `provided.al2023`: this binary is
//! the bootstrap). It asks the runtime API for the next event, answers it with
//! the same code as the local server, and asks again. The same binary is two
//! functions:
//!
//! - html-bible-api: events from API Gateway's HTTP API ($default, payload 2.0);
//! - html-bible-evaluator: `{ "evaluate": "<verse id>" }`, sent by the API
//!   without waiting (evaluation.rs), judged by the stronger model.
//!
//! Settings, from the environment:
//!   BIBLE_TABLE_PREFIX            the DynamoDB tables' prefix ("html-bible-")
//!   BIBLE_SITE_ORIGINS            sites allowed by CORS, comma-separated
//!   BIBLE_INVITE_KEY_PARAMETER    the SSM SecureString with the key of invitation codes
//!   BIBLE_OPENAI_KEY_PARAMETER    the SSM SecureString with the OpenAI key (none: stub models)
//!   BIBLE_REVIEW_MODEL, BIBLE_EVAL_MODEL    the models (gpt-5.4-mini, gpt-5.5)
//!   BIBLE_EVALUATOR_FUNCTION      where the API sends evaluations (none: in the request)
//!   AWS_REGION, AWS_ACCESS_KEY_ID, …   given by Lambda

use std::time::Duration;

use base64::Engine;
use html_bible_server::app::{App, Config};
use html_bible_server::dynamo::{Aws, Credentials, DynamoStore};
use html_bible_server::openai::OpenAi;
use html_bible_server::originals::Originals;
use html_bible_server::http::{Request, Response};
use html_bible_server::invites;
use serde_json::{json, Map, Value};

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn build_app() -> Result<App, String> {
    let region = env("AWS_REGION").ok_or("AWS_REGION is not set")?;
    let credentials = Credentials::from_env().ok_or("the role's credentials are not in the environment")?;
    let prefix = env("BIBLE_TABLE_PREFIX").unwrap_or_else(|| "html-bible-".into());
    let mut config = Config::default();
    if let Some(origins) = env("BIBLE_SITE_ORIGINS") {
        config.site_origins = origins.split(',').map(|o| o.trim().trim_end_matches('/').to_string()).filter(|o| !o.is_empty()).collect();
    }
    let store = DynamoStore::new(&region, &prefix, credentials.clone());
    if let Some(name) = env("BIBLE_INVITE_KEY_PARAMETER") {
        config.invite_key = store.aws().parameter(&name)?.into_bytes();
    }
    let openai = match env("BIBLE_OPENAI_KEY_PARAMETER") {
        Some(name) => {
            let key = store.aws().parameter(&name)?;
            let models = (env("BIBLE_REVIEW_MODEL").unwrap_or_else(|| "gpt-5.4-mini".into()), env("BIBLE_EVAL_MODEL").unwrap_or_else(|| "gpt-5.5".into()));
            Some((key, models))
        }
        None => None,
    };
    let mut app = App::new(config, Box::new(store));
    if let Some((key, (review, eval))) = openai {
        app.reviewer = Box::new(OpenAi::new(&key, &review, &eval));
        app.evaluator = Box::new(OpenAi::new(&key, &review, &eval));
    }
    // The verse in Hebrew or Greek for the evaluator: the texts aws.sh puts in the zip, read on first use.
    let originals = env("BIBLE_ORIGINALS_DIR").unwrap_or_else(|| format!("{}/translations", env("LAMBDA_TASK_ROOT").unwrap_or_else(|| ".".into())));
    let texts = Originals::new(originals);
    app.verse_text = Some(Box::new(move |range| texts.text(range)));
    if let Some(function) = env("BIBLE_EVALUATOR_FUNCTION") {
        let aws = Aws::new(&region, credentials);
        app.defer = Some(Box::new(move |verse_id: &str| aws.invoke_async(&function, &json!({ "evaluate": verse_id }))));
    }
    // A new database gets root (Task2.md §2); one read when it has it already.
    if invites::ensure_root(&app).map_err(|e| e.0)? {
        eprintln!("[init] made root");
    }
    Ok(app)
}

/// An HTTP API event (payload 2.0) → the core's request.
fn request(event: &Value) -> Request {
    let http = &event["requestContext"]["http"];
    let text = |v: &Value| v.as_str().unwrap_or_default().to_string();
    let body = match event["body"].as_str() {
        Some(body) if event["isBase64Encoded"].as_bool() == Some(true) => base64::engine::general_purpose::STANDARD.decode(body).unwrap_or_default(),
        Some(body) => body.as_bytes().to_vec(),
        None => Vec::new(),
    };
    Request {
        method: text(&http["method"]).to_ascii_uppercase(),
        path: text(&event["rawPath"]),
        query: text(&event["rawQueryString"]),
        headers: event["headers"].as_object().into_iter().flatten().map(|(k, v)| (k.to_ascii_lowercase(), text(v))).collect(),
        body,
        source_ip: text(&http["sourceIp"]),
    }
}

/// The core's response → what API Gateway expects back.
fn answer(response: Response) -> Value {
    let headers: Map<String, Value> = response.headers.into_iter().map(|(k, v)| (k, Value::String(v))).collect();
    match String::from_utf8(response.body) {
        Ok(body) => json!({ "statusCode": response.status, "headers": headers, "body": body, "isBase64Encoded": false }),
        Err(raw) => json!({
            "statusCode": response.status,
            "headers": headers,
            "body": base64::engine::general_purpose::STANDARD.encode(raw.into_bytes()),
            "isBase64Encoded": true,
        }),
    }
}

fn main() {
    let api = env("AWS_LAMBDA_RUNTIME_API").expect("AWS_LAMBDA_RUNTIME_API: this runs inside Lambda");
    let base = format!("http://{api}/2018-06-01/runtime");
    // No timeout: the next event may be a long time coming.
    let agent = ureq::AgentBuilder::new().build();
    let app = match build_app() {
        Ok(app) => app,
        Err(message) => {
            eprintln!("[init] {message}");
            let _ = agent.post(&format!("{base}/init/error")).send_json(json!({ "errorType": "Init", "errorMessage": message }));
            std::process::exit(1);
        }
    };
    loop {
        let next = match agent.get(&format!("{base}/invocation/next")).call() {
            Ok(next) => next,
            Err(error) => {
                eprintln!("[runtime] {error}");
                std::thread::sleep(Duration::from_millis(500));
                continue;
            }
        };
        let id = next.header("Lambda-Runtime-Aws-Request-Id").unwrap_or_default().to_string();
        let reply = match next.into_json::<Value>() {
            // The evaluator's event: judge the verse, store the verdict.
            Ok(event) if event["evaluate"].is_string() => {
                app.evaluate(event["evaluate"].as_str().unwrap_or_default());
                json!({ "ok": true })
            }
            Ok(event) => answer(app.handle(&request(&event))),
            Err(error) => {
                eprintln!("[runtime] unreadable event: {error}");
                answer(Response::error(&html_bible_server::errors::internal()))
            }
        };
        if let Err(error) = agent.post(&format!("{base}/invocation/{id}/response")).send_json(reply) {
            eprintln!("[runtime] could not answer {id}: {error}");
        }
    }
}
