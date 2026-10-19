//! The discussions API of html-bible (docs/api.md): one AWS Lambda in
//! production, the same code as a local server (bin/local.rs) and in tests.

pub mod app;
pub mod auth;
pub mod books;
#[cfg(feature = "aws")]
pub mod dynamo;
pub mod errors;
pub mod evaluation;
pub mod handlers;
pub mod http;
pub mod invites;
pub mod ids;
pub mod llm;
pub mod model;
#[cfg(feature = "net")]
pub mod openai;
pub mod pipeline;
pub mod ratings;
pub mod refs;
pub mod router;
pub mod seed;
pub mod store;
pub mod text;
pub mod views;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
