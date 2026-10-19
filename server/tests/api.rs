//! What the contract fixtures cannot show: evaluation over time (delay,
//! debounce, cache), the seed's outcomes, sign-in limits, CORS and a store
//! that outlives the process.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use html_bible_server::app::{App, Config, Limits};
use html_bible_server::auth::open_session;
use html_bible_server::http::Request;
use html_bible_server::invites;
use html_bible_server::ids::parse_iso;
use html_bible_server::llm::{Draft, EvalInput, Evaluator, StubEvaluator};
use html_bible_server::seed;
use html_bible_server::store::MemoryStore;
use serde_json::{json, Value};

const NOW: &str = "2026-10-18T12:00:00.000Z";
const VERSE: &str = "01JAS000000000000000000V01";

fn app_with(config: Config) -> App {
    let app = App::new(config, Box::new(MemoryStore::new(None))).with_fixed_clock(parse_iso(NOW).unwrap());
    seed::load(&app).unwrap();
    app
}

fn app() -> App {
    app_with(Config::default())
}

fn token(app: &App, key: &str) -> String {
    open_session(app, &seed::user_id(&seed::data(), key)).unwrap()
}

/// A fresh invitation code of a seed user ("anna").
fn code(app: &App, key: &str) -> String {
    invites::issue(app, &seed::user_id(&seed::data(), key)).unwrap()["code"].as_str().unwrap().to_string()
}

fn register(app: &App, invite: &str, login: &str) -> (u16, Value, Vec<(String, String)>) {
    call(app, "POST", "/v1/auth/register", None, Some(json!({ "invite": invite, "login": login, "password": "long enough" })))
}

/// (status, body, headers) of one request.
fn call(app: &App, method: &str, target: &str, token: Option<&str>, body: Option<Value>) -> (u16, Value, Vec<(String, String)>) {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let mut headers = vec![("origin".to_string(), "http://localhost:5173".to_string())];
    if let Some(token) = token {
        headers.push(("authorization".into(), format!("Bearer {token}")));
    }
    let response = app.handle(&Request {
        method: method.into(),
        path: path.into(),
        query: query.into(),
        headers,
        body: body.map(|b| serde_json::to_vec(&b).unwrap()).unwrap_or_default(),
        source_ip: "10.0.0.1".into(),
    });
    let parsed = if response.body.is_empty() { Value::Null } else { serde_json::from_slice(&response.body).unwrap_or(Value::Null) };
    (response.status, parsed, response.headers)
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

/* ------------------------------------------------------------- the seed */

#[test]
fn seed_outcomes_cover_every_case() {
    let app = app();
    let (status, full, _) = call(&app, "GET", "/v1/questions/01JAS000000000000000000Q01", None, None);
    assert_eq!(status, 200);
    assert_eq!(full["question"]["tally"]["users"], json!({ "pro": 7, "con": 6, "none": 1, "open": 3 }));
    assert_eq!(full["verses"].as_array().unwrap().len(), 17);
    assert_eq!(full["interpretations"].as_array().unwrap().len(), 36);
    // A topic's tally is the sum over its subtopics.
    let mut sum = json!({ "pro": 0, "con": 0, "none": 0, "open": 0 });
    for argument in full["arguments"].as_array().unwrap() {
        for key in ["pro", "con", "none", "open"] {
            sum[key] = json!(sum[key].as_i64().unwrap() + argument["tally"]["users"][key].as_i64().unwrap());
        }
    }
    assert_eq!(sum, full["question"]["tally"]["users"]);
    let outcomes: Vec<Value> = full["verses"].as_array().unwrap().iter().map(|v| v["users"]["outcome"].clone()).collect();
    for wanted in [json!(1), json!(-1), json!(0), Value::Null] {
        assert!(outcomes.contains(&wanted), "no verse with outcome {wanted}");
    }
}

/* ----------------------------------------------------------- evaluation */

#[test]
fn delayed_evaluation_is_debounced() {
    let app = app_with(Config { eval_delay_ms: 30_000, ..Config::default() });
    let elena = token(&app, "elena");
    let runs = app.evaluation_runs.load(Ordering::SeqCst);
    for text in ["One reading.", "Another reading.", "A third one."] {
        let (status, _, _) =
            call(&app, "POST", &format!("/v1/verses/{VERSE}/interpretations"), Some(&elena), Some(json!({ "lang": "en", "side": "pro", "bodyMd": text })));
        assert_eq!(status, 201);
    }
    let (_, rating, _) = call(&app, "GET", &format!("/v1/verses/{VERSE}/rating"), None, None);
    assert_eq!(rating["ai"]["status"], "pending");
    assert_eq!(rating["argument"]["tally"]["aiStatus"], "pending");
    assert_eq!(app.scheduler.pending(), vec![VERSE.to_string()]);
    app.run_due_evaluations();
    assert_eq!(app.evaluation_runs.load(Ordering::SeqCst), runs, "not due yet");
    app.advance(30_000);
    app.run_due_evaluations();
    assert_eq!(app.evaluation_runs.load(Ordering::SeqCst), runs + 1, "three changes, one evaluation");
    let (_, rating, _) = call(&app, "GET", &format!("/v1/verses/{VERSE}/rating"), None, None);
    assert_eq!(rating["ai"]["status"], "fresh");
}

/// The stub, counting what it is asked.
struct Counting(Arc<AtomicUsize>);

impl Evaluator for Counting {
    fn models(&self) -> Vec<String> {
        StubEvaluator.models()
    }
    fn evaluate(&self, model: &str, input: &EvalInput) -> Result<Draft, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        StubEvaluator.evaluate(model, input)
    }
}

#[test]
fn verdicts_are_cached_by_input() {
    let mut app = app();
    let asked = Arc::new(AtomicUsize::new(0));
    app.evaluator = Box::new(Counting(Arc::clone(&asked)));
    let anna = token(&app, "anna");
    let (_, created, _) =
        call(&app, "POST", &format!("/v1/verses/{VERSE}/interpretations"), Some(&anna), Some(json!({ "lang": "en", "side": "con", "bodyMd": "Text." })));
    assert_eq!(asked.load(Ordering::SeqCst), 2, "two models on a new input");
    let id = created["id"].as_str().unwrap();
    call(&app, "DELETE", &format!("/v1/interpretations/{id}"), Some(&anna), None);
    assert_eq!(asked.load(Ordering::SeqCst), 2, "back to the seed's input: from the cache");
}

/* ------------------------------------------------------------ sign-in */

#[test]
fn failed_sign_ins_are_limited_per_login() {
    let limits = Limits { failures_per_login: 3, ..Limits::default() };
    let app = app_with(Config { limits, ..Config::default() });
    let wrong = json!({ "login": "anna", "password": "not her password" });
    for _ in 0..3 {
        assert_eq!(call(&app, "POST", "/v1/auth/login", None, Some(wrong.clone())).0, 401);
    }
    let (status, body, headers) = call(&app, "POST", "/v1/auth/login", None, Some(json!({ "login": "anna", "password": "anna-demo" })));
    assert_eq!((status, body["error"]["code"].as_str()), (429, Some("too_many_requests")));
    assert_eq!(header(&headers, "Retry-After"), Some("900"));
    // Others are not locked out, and the window passes.
    assert_eq!(call(&app, "POST", "/v1/auth/login", None, Some(json!({ "login": "david", "password": "david-demo" }))).0, 200);
    app.advance(15 * 60 * 1000);
    assert_eq!(call(&app, "POST", "/v1/auth/login", None, Some(json!({ "login": "anna", "password": "anna-demo" }))).0, 200);
}

#[test]
fn registrations_are_limited_per_address() {
    let limits = Limits { registrations_per_ip: 2, ..Limits::default() };
    let app = app_with(Config { limits, ..Config::default() });
    for (n, expected) in [(1, 201), (2, 201), (3, 429)] {
        assert_eq!(register(&app, &code(&app, "anna"), &format!("user{n}")).0, expected);
    }
}

#[test]
fn display_name_defaults_to_the_login_and_can_change() {
    let app = app();
    let (_, signed, _) = register(&app, &code(&app, "anna"), " Ivan.P ");
    assert_eq!((signed["user"]["login"].as_str(), signed["user"]["displayName"].as_str()), (Some("ivan.p"), Some("Ivan.P")));
    let token = signed["token"].as_str().unwrap();
    let (status, me, _) = call(&app, "PATCH", "/v1/me", Some(token), Some(json!({ "displayName": "Иван" })));
    assert_eq!((status, me["displayName"].as_str(), me["login"].as_str()), (200, Some("Иван"), Some("ivan.p")));
    // The new name is the author's everywhere at once.
    let (_, created, _) = call(&app, "POST", "/v1/questions", Some(token), Some(json!({ "lang": "ru", "title": "Вопрос" })));
    assert_eq!(created["author"]["displayName"], "Иван");
}

/* --------------------------------------------------------------- votes */

#[test]
fn mine_only_with_a_token() {
    let app = app();
    let (_, anonymous, _) = call(&app, "GET", &format!("/v1/verses/{VERSE}/rating"), None, None);
    assert!(anonymous["votes"].get("mine").is_none());
    let sarah = token(&app, "sarah");
    let (_, signed, _) = call(&app, "GET", &format!("/v1/verses/{VERSE}/rating"), Some(&sarah), None);
    assert_eq!(signed["votes"]["mine"], Value::Null);
    let (_, voted, _) = call(&app, "PUT", &format!("/v1/votes/verse/{VERSE}"), Some(&sarah), Some(json!({ "value": 0 })));
    assert_eq!(voted["votes"]["mine"], 0);
}

/* ---------------------------------------------------------------- CORS */

#[test]
fn cors() {
    let app = app();
    let preflight = |origin: &str, private: bool| {
        let mut headers = vec![("origin".to_string(), origin.to_string()), ("access-control-request-method".into(), "POST".into())];
        if private {
            headers.push(("access-control-request-private-network".into(), "true".into()));
        }
        app.handle(&Request { method: "OPTIONS".into(), path: "/v1/questions".into(), headers, ..Default::default() })
    };
    let allowed = preflight("https://bible.marketkernel.com", true);
    assert_eq!(allowed.status, 204);
    assert_eq!(allowed.header("Access-Control-Allow-Origin"), Some("https://bible.marketkernel.com"));
    assert_eq!(allowed.header("Access-Control-Allow-Headers"), Some("Authorization, Content-Type"));
    assert_eq!(allowed.header("Access-Control-Allow-Private-Network"), Some("true"));
    let refused = preflight("https://evil.example", false);
    assert_eq!((refused.header("Access-Control-Allow-Origin"), refused.header("Access-Control-Allow-Methods")), (None, None));
    let (_, _, headers) = call(&app, "GET", "/v1/health", None, None);
    assert_eq!(header(&headers, "Access-Control-Allow-Origin"), Some("http://localhost:5173"));
    assert_eq!(header(&headers, "Access-Control-Expose-Headers"), Some("Location"));
}

/* --------------------------------------------------------------- store */

#[test]
fn the_store_outlives_the_process() {
    let dir = std::env::temp_dir().join(format!("html-bible-store-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    {
        let app = App::new(Config::default(), Box::new(MemoryStore::new(Some(dir.clone()))));
        seed::load(&app).unwrap();
        assert_eq!(register(&app, &code(&app, "anna"), "kept").0, 201);
    }
    let app = App::new(Config::default(), Box::new(MemoryStore::new(Some(dir.clone()))));
    assert!(seed::seeded(&app).unwrap());
    let (status, _, _) = call(&app, "POST", "/v1/auth/login", None, Some(json!({ "login": "kept", "password": "long enough" })));
    assert_eq!(status, 200);
    app.store.clear().unwrap();
    assert!(!dir.exists() && !seed::seeded(&app).unwrap());
}

/* -------------------------------------------------------------- routes */

#[test]
fn removed_and_unknown_routes() {
    let app = app();
    for path in ["/v1/points/x", "/v1/arguments/x/points", "/v1/arguments/x/rating", "/oauth2/token", "/v1"] {
        assert_eq!(call(&app, "GET", path, None, None).0, 404, "{path}");
    }
    let (status, _, headers) = call(&app, "DELETE", "/v1/me", None, None);
    assert_eq!((status, header(&headers, "Allow")), (405, Some("GET, PATCH")));
}

/* --------------------------------------------------------- invitations */

#[test]
fn ten_codes_then_a_pause_until_midnight_utc() {
    let app = app();
    let anna = token(&app, "anna");
    for seq in 1..=10 {
        let (status, issued, _) = call(&app, "POST", "/v1/invites", Some(&anna), None);
        assert_eq!((status, issued["seq"].as_u64()), (201, Some(seq)));
    }
    let (status, refused, _) = call(&app, "POST", "/v1/invites", Some(&anna), None);
    assert_eq!((status, refused["error"]["code"].as_str(), refused["error"]["resetOn"].as_str()), (429, Some("invite_limit"), Some("2026-10-19")));
    let (_, state, _) = call(&app, "GET", "/v1/invites", Some(&anna), None);
    assert_eq!((state["issued"].as_u64(), state["limit"].as_u64(), state["available"].as_u64()), (Some(10), Some(10), Some(0)));
    app.advance(11 * 3_600_000 + 59 * 60_000); // 23:59 UTC, the same day
    assert_eq!(call(&app, "POST", "/v1/invites", Some(&anna), None).0, 429);
    app.advance(60_000); // 00:00 UTC
    let (_, state, _) = call(&app, "GET", "/v1/invites", Some(&anna), None);
    assert_eq!(state["available"].as_u64(), Some(10));
    let (status, issued, _) = call(&app, "POST", "/v1/invites", Some(&anna), None);
    assert_eq!((status, issued["seq"].as_u64()), (201, Some(11)));
    let (_, state, _) = call(&app, "GET", "/v1/invites", Some(&anna), None);
    assert_eq!((state["limit"].as_u64(), state["resetOn"].clone(), state["codes"].as_array().unwrap().len()), (Some(20), Value::Null, 11));
}

#[test]
fn a_code_is_genuine_and_single_use() {
    let app = app();
    let anna = seed::user_id(&seed::data(), "anna");
    let good = code(&app, "anna");
    let (status, check, _) = call(&app, "GET", &format!("/v1/invites/{good}"), None, None);
    assert_eq!((status, check["inviter"]["displayName"].as_str()), (200, Some("Anna")));
    // Typed carelessly, still the same code.
    let (status, signed, _) = register(&app, &format!(" {} ", good.to_lowercase().replace('-', " ")), "olga");
    assert_eq!(status, 201, "{signed}");
    assert_eq!((signed["user"]["number"].as_u64(), signed["user"]["invitedBy"]["id"].as_str()), (Some(7), Some(anna.as_str())));
    let (status, again, _) = register(&app, &good, "olga2");
    assert_eq!((status, again["error"]["code"].as_str()), (409, Some("invite_used")));
    assert_eq!(call(&app, "GET", &format!("/v1/invites/{good}"), None, None).0, 409);
    // A changed signature, a code anna has not been given yet, another key, no code at all.
    let forged = format!("{}{}", &good[..good.len() - 1], if good.ends_with('0') { '1' } else { '0' });
    let ahead = invites::code(&app.config.invite_key, 2, 5);
    let foreign = invites::code(b"another key", 2, 1);
    for (invite, status, error) in [(forged.as_str(), 403, "invalid_invite"), (&ahead, 403, "invalid_invite"), (&foreign, 403, "invalid_invite"), ("hello", 400, "validation_error")] {
        let (got, body, _) = register(&app, invite, "someone");
        assert_eq!((got, body["error"]["code"].as_str(), body["error"]["field"].as_str()), (status, Some(error), Some("invite")), "{invite}");
    }
    let (status, _, _) = call(&app, "POST", "/v1/auth/register", None, Some(json!({ "login": "nocode", "password": "long enough" })));
    assert_eq!(status, 400);
}

#[test]
fn who_invited_whom_is_public() {
    let app = app();
    let anna = seed::user_id(&seed::data(), "anna");
    let (_, signed, _) = register(&app, &code(&app, "anna"), "Olga");
    let olga = signed["user"]["id"].as_str().unwrap().to_string();
    let (status, profile, _) = call(&app, "GET", &format!("/v1/users/{anna}"), None, None);
    assert_eq!(status, 200);
    assert_eq!((profile["number"].as_u64(), profile["invitedBy"]["id"].as_str()), (Some(2), Some(seed::ROOT_ID)));
    assert_eq!(profile["invitees"], json!([{ "id": olga, "displayName": "Olga", "createdAt": NOW }]));
    assert!(profile.get("login").is_none(), "the login is half of a sign-in");
    let (_, theirs, _) = call(&app, "GET", &format!("/v1/users/{olga}"), None, None);
    assert_eq!(theirs["invitedBy"], json!({ "id": anna, "displayName": "Anna" }));
    let (_, root, _) = call(&app, "GET", &format!("/v1/users/{}", seed::ROOT_ID), None, None);
    assert_eq!((root["invitedBy"].clone(), root["invitees"].as_array().unwrap().len()), (Value::Null, 5));
    // The owner sees who used each code.
    let (_, state, _) = call(&app, "GET", "/v1/invites", Some(&token(&app, "anna")), None);
    assert_eq!(state["codes"][0]["usedBy"]["id"].as_str(), Some(olga.as_str()));
    assert_eq!(call(&app, "GET", "/v1/users/nobody", None, None).0, 404);
}

#[test]
fn a_new_database_gets_root_once() {
    let app = App::new(Config::default(), Box::new(MemoryStore::new(None))).with_fixed_clock(parse_iso(NOW).unwrap());
    assert!(invites::ensure_root(&app).unwrap());
    assert!(!invites::ensure_root(&app).unwrap(), "only once");
    let (status, signed, _) = call(&app, "POST", "/v1/auth/login", None, Some(json!({ "login": "root", "password": "rootroot" })));
    assert_eq!((status, signed["user"]["number"].as_u64()), (200, Some(1)));
    assert!(signed["user"].get("invitedBy").is_none());
    let root = signed["token"].as_str().unwrap().to_string();
    let (_, issued, _) = call(&app, "POST", "/v1/invites", Some(&root), None);
    let (status, first, _) = register(&app, issued["code"].as_str().unwrap(), "first");
    assert_eq!((status, first["user"]["number"].as_u64()), (201, Some(2)));
    // A new password replaces the first one.
    call(&app, "POST", "/v1/auth/password", Some(&root), Some(json!({ "password": "rootroot", "newPassword": "a better one" })));
    assert_eq!(call(&app, "POST", "/v1/auth/login", None, Some(json!({ "login": "root", "password": "rootroot" }))).0, 401);
}

#[test]
fn a_stale_write_loses() {
    let store = MemoryStore::new(None);
    use html_bible_server::store::Store;
    store.put("users", json!({ "id": "u", "invitesIssued": 3 })).unwrap();
    assert!(store.put_if("users", json!({ "id": "u", "invitesIssued": 4 }), "invitesIssued", &json!(3)).unwrap());
    assert!(!store.put_if("users", json!({ "id": "u", "invitesIssued": 4 }), "invitesIssued", &json!(3)).unwrap(), "read 3, but it is 4 now");
    assert_eq!((store.increment("meta", "n", "value").unwrap(), store.increment("meta", "n", "value").unwrap()), (1, 2));
}
