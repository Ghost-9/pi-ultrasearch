//! Whole-disk file search for macOS: a fuzzy name index over every entry on
//! disk, kept live from FSEvents, plus a trigram content index for text
//! files. `Engine` runs it all in-process; the `ultrasearch` binary wraps one in
//! a daemon with a JSON-lines socket.

pub mod alloc;
pub mod content;
pub mod coverage;
pub mod deny;
mod engine;
pub mod env;
mod fsevents;
pub mod index;
pub mod live;
pub mod qos;
pub mod query;
pub mod symbols;
pub mod walk;

pub use content::{Case, FileMatches, Grep, GrepResult, Hit};
pub use engine::{Engine, Found, Options, PROTOCOL_VERSION, Status, default_dir, gated, has_full_disk_access, no_materialize};
pub use query::{GrepMode, Query};
