//! The application object: settings, storage, models, clock, the evaluation
//! queue. One per process: the Lambda builds it on a cold start, the local
//! server at launch, tests per case.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::Mutex;

use crate::evaluation::Scheduler;
use crate::http::{Request, Response};
use crate::ids::{iso, random_bytes, system_now_ms, ulid};
use crate::llm::{Evaluator, Reviewer, StubEvaluator, StubReviewer};
use crate::model::RefRange;
use crate::store::{Db, Store};

/// Attempts allowed per window before `429 too_many_requests`.
#[derive(Clone, Debug)]
pub struct Limits {
    pub window_ms: i64,
    /// Failed sign-ins (and password changes) per login.
    pub failures_per_login: u32,
    /// Sign-in attempts per client address.
    pub sign_ins_per_ip: u32,
    /// New accounts per client address.
    pub registrations_per_ip: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { window_ms: 15 * 60 * 1000, failures_per_login: 10, sign_ins_per_ip: 50, registrations_per_ip: 10 }
    }
}

/// Codes signed with it are good only on a development server.
pub const DEV_INVITE_KEY: &[u8] = b"html-bible-dev-invite-key-not-for-production";

#[derive(Clone, Debug)]
pub struct Config {
    /// 0 evaluates in the request; otherwise the evaluation runs this much later.
    pub eval_delay_ms: i64,
    /// Sites allowed by CORS besides "null" (file://) and any http://localhost port.
    pub site_origins: Vec<String>,
    pub limits: Limits,
    /// The key that signs invitation codes (invites.rs): SSM in AWS, an
    /// environment variable or the development key here.
    pub invite_key: Vec<u8>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            eval_delay_ms: 0,
            site_origins: vec!["https://bible.marketkernel.com".to_string()],
            limits: Limits::default(),
            invite_key: DEV_INVITE_KEY.to_vec(),
        }
    }
}

impl Config {
    /// CORS allow-list: pages from file:// ("null"), any local port, the sites.
    pub fn origin_allowed(&self, origin: &str) -> bool {
        if origin == "null" {
            return true;
        }
        let origin = origin.trim_end_matches('/');
        let local = ["http://localhost", "http://127.0.0.1"].iter().any(|host| {
            origin.strip_prefix(host).is_some_and(|rest| {
                rest.is_empty() || rest.strip_prefix(':').is_some_and(|port| (1..=5).contains(&port.len()) && port.bytes().all(|b| b.is_ascii_digit()))
            })
        });
        local || self.site_origins.iter().any(|site| site == origin)
    }
}

/// The system clock, or one that stands still until moved (tests).
pub enum Clock {
    System,
    Fixed(AtomicI64),
}

/// Sends "evaluate this verse" away; an error leaves the verse pending until its next change.
pub type Defer = Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

/// The KJV text of a range and its ±3 verses, for the evaluator: (text, context).
pub type VerseText = Box<dyn Fn(&RefRange) -> Option<(String, String)> + Send + Sync>;

pub struct App {
    pub config: Config,
    pub store: Box<dyn Store>,
    pub clock: Clock,
    /// Checks and translates what is saved, in the request (llm.rs).
    pub reviewer: Box<dyn Reviewer>,
    pub evaluator: Box<dyn Evaluator>,
    /// None until the server has the KJV text; the stub evaluator needs none.
    pub verse_text: Option<VerseText>,
    pub scheduler: Scheduler,
    /// Hands an evaluation to someone else, after the response (in AWS: an
    /// asynchronous call of the evaluator Lambda). None: in the request, or by
    /// the local server's timer when there is a delay.
    pub defer: Option<Defer>,
    /// Evaluations actually performed (tests check the debounce).
    pub evaluation_runs: AtomicUsize,
    /// One request at a time. The local server is a development tool and a
    /// Lambda instance serves one request at a time anyway; between Lambda
    /// instances, conditional writes in the store keep the data consistent.
    lock: Mutex<()>,
}

impl App {
    pub fn new(config: Config, store: Box<dyn Store>) -> Self {
        App {
            config,
            store,
            clock: Clock::System,
            reviewer: Box::new(StubReviewer),
            evaluator: Box::new(StubEvaluator),
            verse_text: None,
            scheduler: Scheduler::default(),
            defer: None,
            evaluation_runs: AtomicUsize::new(0),
            lock: Mutex::new(()),
        }
    }

    pub fn with_fixed_clock(mut self, now_ms: i64) -> Self {
        self.clock = Clock::Fixed(AtomicI64::new(now_ms));
        self
    }

    pub fn now_ms(&self) -> i64 {
        match &self.clock {
            Clock::System => system_now_ms(),
            Clock::Fixed(now) => now.load(Ordering::SeqCst),
        }
    }

    /// Move a fixed clock forward (tests).
    pub fn advance(&self, ms: i64) {
        if let Clock::Fixed(now) = &self.clock {
            now.fetch_add(ms, Ordering::SeqCst);
        }
    }

    pub fn now_iso(&self) -> String {
        iso(self.now_ms())
    }

    pub fn new_id(&self) -> String {
        ulid(self.now_ms(), random_bytes())
    }

    pub fn db(&self) -> Db<'_> {
        Db(self.store.as_ref())
    }

    /// Answer one API request. A panic becomes a 500, as an exception did in
    /// the Python stub: the process keeps serving.
    pub fn handle(&self, request: &Request) -> Response {
        let _guard = self.lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let response = catch_unwind(AssertUnwindSafe(|| crate::router::handle(self, request)))
            .unwrap_or_else(|_| Response::error(&crate::errors::internal()));
        if let Err(error) = self.store.flush() {
            eprintln!("[store] {}", error.0);
        }
        response
    }

    /// Run the evaluations whose delay has passed (the local server's timer).
    pub fn run_due_evaluations(&self) {
        let _guard = self.lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        for verse_id in self.scheduler.take_due(self.now_ms()) {
            crate::evaluation::run_logged(self, &verse_id, None);
        }
        let _ = self.store.flush();
    }

    /// Evaluate one verse now: the evaluator Lambda's event.
    pub fn evaluate(&self, verse_id: &str) {
        let _guard = self.lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        crate::evaluation::run_logged(self, verse_id, None);
        let _ = self.store.flush();
    }

    /// Run every scheduled evaluation now (tests).
    pub fn flush_evaluations(&self) {
        let _guard = self.lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        for verse_id in self.scheduler.take_due(i64::MAX) {
            crate::evaluation::run_logged(self, &verse_id, None);
        }
        let _ = self.store.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins() {
        let config = Config::default();
        for ok in ["null", "http://localhost:8787", "http://127.0.0.1", "https://bible.marketkernel.com", "https://bible.marketkernel.com/"] {
            assert!(config.origin_allowed(ok), "{ok}");
        }
        for bad in ["https://evil.example", "http://localhost.evil.example", "http://localhost:123456", "https://localhost:8787", ""] {
            assert!(!config.origin_allowed(bad), "{bad}");
        }
    }
}
