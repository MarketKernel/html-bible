//! The API on this computer, with the files of the site beside it:
//!
//! ```text
//! cargo run --bin local -- --port 8787 [--latency MS] [--eval-delay S] [--reset] [--static DIR]
//! ```
//!
//! /v1/… is the API (the same code as the Lambda), /data/… the repository's
//! data/ (translations, commentaries), and with --static the built site at /.
//! The store is JSON files in server/.data/, seeded with the demo topic.

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use html_bible_server::app::{App, Config};
use html_bible_server::http::{apply_cors, preflight, Request, Response};
use html_bible_server::router::owns;
use html_bible_server::seed;
use html_bible_server::store::MemoryStore;
use serde_json::json;

const MAX_BODY: usize = 1024 * 1024;
const REPO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");

struct Options {
    host: String,
    port: u16,
    latency_ms: u64,
    eval_delay_s: f64,
    reset: bool,
    static_dir: Option<PathBuf>,
    data_root: PathBuf,
    data_dir: PathBuf,
    origins: Vec<String>,
    quiet: bool,
}

const USAGE: &str = "usage: local [--port 8787] [--host 127.0.0.1] [--latency MS] [--eval-delay S] [--reset]
             [--static DIR] [--data-root DIR] [--data-dir DIR] [--allow-origin ORIGIN]… [--quiet]";

fn options() -> Options {
    let mut o = Options {
        host: "127.0.0.1".into(),
        port: 8787,
        latency_ms: 0,
        eval_delay_s: 0.0,
        reset: false,
        static_dir: None,
        data_root: Path::new(REPO).join("data"),
        data_dir: Path::new(REPO).join("server").join(".data"),
        origins: Vec::new(),
        quiet: false,
    };
    let mut args = std::env::args().skip(1);
    let fail = |message: String| -> ! {
        eprintln!("{message}\n{USAGE}");
        std::process::exit(2)
    };
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().unwrap_or_else(|| fail(format!("{name} needs a value")));
        match arg.as_str() {
            "--host" => o.host = value("--host"),
            "--port" => o.port = value("--port").parse().unwrap_or_else(|_| fail("--port: a number".into())),
            "--latency" => o.latency_ms = value("--latency").parse().unwrap_or_else(|_| fail("--latency: milliseconds".into())),
            "--eval-delay" => o.eval_delay_s = value("--eval-delay").parse().unwrap_or_else(|_| fail("--eval-delay: seconds".into())),
            "--reset" => o.reset = true,
            "--static" => o.static_dir = Some(PathBuf::from(value("--static"))),
            "--data-root" => o.data_root = PathBuf::from(value("--data-root")),
            "--data-dir" => o.data_dir = PathBuf::from(value("--data-dir")),
            "--allow-origin" => o.origins.push(value("--allow-origin")),
            "--quiet" => o.quiet = true,
            "-h" | "--help" => {
                println!("{USAGE}");
                std::process::exit(0)
            }
            other => fail(format!("unknown option {other}")),
        }
    }
    o
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "webmanifest" => "application/manifest+json",
        "txt" => "text/plain; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        // Served as the bytes they are: the page unpacks them itself, so no
        // Content-Encoding (the browser must not unpack them on the way).
        "gz" => "application/gzip",
        _ => "application/octet-stream",
    }
}

fn not_found(message: &str) -> Response {
    Response::json(404, &json!({ "error": { "code": "not_found", "message": message } }))
}

/// A file under `root` for a URL path; nothing that escapes it.
fn file(root: &Path, url_path: &str, method: &str) -> Response {
    if method != "GET" && method != "HEAD" {
        return Response::json(405, &json!({ "error": { "code": "method_not_allowed", "message": "Static files are read-only" } }));
    }
    let decoded = html_bible_server::http::decode(&url_path.replace('+', "%2B"));
    let relative = Path::new(decoded.trim_start_matches('/'));
    if decoded.contains('\0') || relative.components().any(|c| !matches!(c, Component::Normal(_))) {
        return not_found("No such file");
    }
    let mut full = root.join(relative);
    if full.is_dir() {
        full = full.join("index.html");
    }
    match std::fs::read(&full) {
        Ok(body) => Response { status: 200, headers: vec![("Content-Type".into(), content_type(&full).into()), ("Cache-Control".into(), "no-cache".into())], body },
        Err(_) => not_found("No such file"),
    }
}

fn index() -> Response {
    let page = format!(
        "<!doctype html><meta charset='utf-8'><title>html-bible server</title><body style='font:16px system-ui;padding:16px'>\
         <h1>html-bible server {}</h1><ul><li><a href='/v1/health'>/v1/health</a></li><li><a href='/v1/questions'>/v1/questions</a></li>\
         <li><a href='/data/catalog.json'>/data/</a> (static)</li></ul><p>Start with --static build/pages to serve the site here.</p>",
        html_bible_server::VERSION
    );
    Response { status: 200, headers: vec![("Content-Type".into(), "text/html; charset=utf-8".into())], body: page.into_bytes() }
}

fn serve(app: &App, o: &Options, mut incoming: tiny_http::Request) {
    let url = incoming.url().to_string();
    let (path, query) = url.split_once('?').unwrap_or((&url, ""));
    let method = incoming.method().as_str().to_ascii_uppercase();
    let headers: Vec<(String, String)> =
        incoming.headers().iter().map(|h| (h.field.as_str().as_str().to_ascii_lowercase(), h.value.as_str().to_string())).collect();
    let mut body = Vec::new();
    let too_big = incoming.body_length().is_some_and(|n| n > MAX_BODY)
        || incoming.as_reader().take(MAX_BODY as u64 + 1).read_to_end(&mut body).is_err()
        || body.len() > MAX_BODY;
    let request = Request {
        method: method.clone(),
        path: path.to_string(),
        query: query.to_string(),
        headers,
        body,
        source_ip: incoming.remote_addr().map(|a| a.ip().to_string()).unwrap_or_default(),
    };
    let mut response = if method == "OPTIONS" {
        preflight(&app.config, &request)
    } else if too_big {
        Response::json(413, &json!({ "error": { "code": "payload_too_large", "message": "Body over 1 MB" } }))
    } else if owns(path) {
        if o.latency_ms > 0 {
            std::thread::sleep(Duration::from_millis(o.latency_ms));
        }
        app.handle(&request)
    } else if let Some(rest) = path.strip_prefix("/data/") {
        file(&o.data_root, rest, &method)
    } else if let Some(dir) = &o.static_dir {
        file(dir, path, &method)
    } else if path == "/" {
        index()
    } else {
        not_found("Not found")
    };
    apply_cors(&app.config, &request, &mut response);
    if !o.quiet {
        eprintln!("{method} {url} {}", response.status);
    }
    let body = if method == "HEAD" { Vec::new() } else { response.body };
    let mut out = tiny_http::Response::from_data(body).with_status_code(response.status);
    for (name, value) in response.headers {
        if let Ok(header) = tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()) {
            out.add_header(header);
        }
    }
    let _ = incoming.respond(out);
}

fn main() {
    let o = options();
    let mut config = Config { eval_delay_ms: (o.eval_delay_s * 1000.0) as i64, ..Config::default() };
    if let Ok(key) = std::env::var("BIBLE_INVITE_KEY") {
        config.invite_key = key.into_bytes();
    }
    // Real models instead of the stubs: the key itself, or a file that holds it.
    let openai_key = std::env::var("BIBLE_OPENAI_KEY").ok().or_else(|| std::env::var("BIBLE_OPENAI_KEY_FILE").ok().and_then(|f| std::fs::read_to_string(f).ok()));
    if openai_key.is_some() && config.eval_delay_ms == 0 {
        // An evaluation takes seconds: after the response, as in AWS.
        config.eval_delay_ms = 1000;
    }
    config.site_origins.extend(o.origins.iter().cloned());
    let mut app = App::new(config, Box::new(MemoryStore::new(Some(o.data_dir.clone()))));
    if let Some(key) = openai_key.filter(|k| !k.trim().is_empty()) {
        let review = std::env::var("BIBLE_REVIEW_MODEL").unwrap_or_else(|_| "gpt-5.4-mini".into());
        let eval = std::env::var("BIBLE_EVAL_MODEL").unwrap_or_else(|_| "gpt-5.5".into());
        println!("models: {review} reviews, {eval} evaluates (OpenAI)");
        app.reviewer = Box::new(html_bible_server::openai::OpenAi::new(&key, &review, &eval));
        app.evaluator = Box::new(html_bible_server::openai::OpenAi::new(&key, &review, &eval));
    }
    let app = Arc::new(app);
    let fresh = o.reset || !seed::seeded(&app).unwrap_or(false);
    if fresh {
        app.store.clear().and_then(|_| seed::load(&app)).unwrap_or_else(|e| panic!("seeding {}: {}", o.data_dir.display(), e.0));
        println!("seeded {} with the demo topic (root/rootroot; anna, david, elena, mikhail, sarah with <login>-demo)", o.data_dir.display());
    }
    if app.config.eval_delay_ms > 0 {
        let app = Arc::clone(&app);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(200));
            app.run_due_evaluations();
        });
    }
    let server = tiny_http::Server::http((o.host.as_str(), o.port)).unwrap_or_else(|e| {
        eprintln!("cannot listen on {}:{}: {e}", o.host, o.port);
        std::process::exit(1)
    });
    println!("html-bible server {} on http://{}:{}/", html_bible_server::VERSION, o.host, o.port);
    let o = Arc::new(o);
    for incoming in server.incoming_requests() {
        let (app, o) = (Arc::clone(&app), Arc::clone(&o));
        std::thread::spawn(move || serve(&app, &o, incoming));
    }
}
