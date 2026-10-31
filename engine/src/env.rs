//! Environment-driven configuration, shared by the daemon, the CLI and the
//! MCP server.
//!
//! Every knob is `ULTRASEARCH_*`. The pre-rebrand names went with the rename
//! (see `NOTICE` for the upstream project this fork renames), so nothing here
//! reads a second spelling: one name per knob means one thing to configure.
//!
//! The point of the scan-root and index-dir knobs is testability: a test can
//! run a real daemon over a fixture tree, on its own socket, without touching
//! the live index or walking `/`. See `engine/BUILD.md`.

use std::path::PathBuf;

/// One non-empty environment variable.
fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// The home directory paths are compared against (content scope, `~`
/// expansion, the default index location).
///
/// Resolved through `canonicalize` when it exists: the index holds real
/// paths (`/tmp` is `/private/tmp` on macOS, and a symlinked home would
/// otherwise match nothing).
pub fn home() -> String {
    let raw = var("ULTRASEARCH_HOME")
        .or_else(|| std::env::var("HOME").ok().filter(|v| !v.is_empty()))
        .unwrap_or_else(|| "/".into());
    canonical(&raw)
}

/// A path as the index holds it: absolute and symlink-free, when it exists.
fn canonical(p: &str) -> String {
    std::fs::canonicalize(p).map_or_else(|_| p.to_string(), |c| c.to_string_lossy().into_owned())
}

/// Where the index lives: `index.bin`, `content/`, `ultrasearch.sock`.
pub fn data_dir() -> PathBuf {
    match var("ULTRASEARCH_DIR") {
        Some(d) => PathBuf::from(d),
        None => crate::engine::default_dir(&home()),
    }
}

/// The directory the first full crawl lists: the home directory unless
/// overridden. A test points this at a fixture tree so a daemon start is
/// milliseconds and deterministic instead of a whole-disk crawl.
///
/// `/` used to be the default. It is the wrong default for a personal
/// machine: it spends roughly half the index on operating-system entries the
/// user never searches (~1.1M of 2.3M here), and the FSEvents stream then
/// reports changes for the whole machine, which on a busy laptop is how the
/// daemon is driven into a permanent recompaction loop (see the churn warning
/// in `engine.rs`). Home is the default; `ULTRASEARCH_SCAN_ROOT=/` restores
/// the whole-disk behaviour.
///
/// Canonicalized for the same reason as `home`: the crawl opens the root
/// with `O_NOFOLLOW_ANY`, which refuses a path with any symlink in it.
pub fn scan_root() -> Vec<u8> {
    match var("ULTRASEARCH_SCAN_ROOT") {
        Some(p) => {
            let p = canonical(p.trim_end_matches('/'));
            let p = p.trim_end_matches('/');
            if p.is_empty() { b"/".to_vec() } else { p.as_bytes().to_vec() }
        }
        None => {
            let h = home();
            // `home()` falls back to `/` when HOME is unset, which keeps the
            // old behaviour rather than inventing a root.
            if h.is_empty() || h == "/" { b"/".to_vec() } else { h.into_bytes() }
        }
    }
}

/// The overlay size that forces a compaction, in entries.
///
/// `ULTRASEARCH_COMPACT_PENDING` raises it for a machine whose indexed area
/// changes faster than the default between passes. The daemon's own churn
/// warning names this knob, so it has to be reachable from outside the build:
/// as a compile-time constant the advice it printed could not be followed.
/// Values under 1,000 are ignored (a bar that low compacts on every keystroke).
pub fn compact_pending() -> usize {
    const DEFAULT: usize = 50_000;
    var("ULTRASEARCH_COMPACT_PENDING")
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|n| *n >= 1_000)
        .unwrap_or(DEFAULT)
}

/// Extra directory names to keep out of the name index, comma- or
/// colon-separated, lowercased. Added to the built-in cache list in `walk.rs`
/// rather than replacing it: an operator naming one more folder should not
/// silently start indexing `node_modules` again.
///
/// This is the name index's only exclude mechanism. `ULTRASEARCH_DENY` filters
/// results after the fact and `.gitignore` reaches the content index only, so
/// before this there was no way to stop a noisy tree costing index memory.
pub fn exclude_names() -> Vec<Vec<u8>> {
    var("ULTRASEARCH_EXCLUDE_NAMES")
        .map(|v| {
            v.split([',', ':'])
                .map(|s| s.trim().to_ascii_lowercase().into_bytes())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// An advisory ceiling on indexed entries (`ULTRASEARCH_MAX_ENTRIES`).
///
/// Exceeding it does **not** truncate the index: dropping entries would silently
/// hide real files, which is worse than a large index. It logs a prominent
/// warning naming the two remedies that actually work — narrow the scan root, or
/// add the noisy folder to `ULTRASEARCH_EXCLUDE_NAMES`.
pub fn max_entries() -> Option<usize> {
    var("ULTRASEARCH_MAX_ENTRIES")
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|n| *n >= 1_000)
}

/// Force the consent-gated folder skip list even with Full Disk Access.
pub fn restrict() -> bool {
    var("ULTRASEARCH_RESTRICT").is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Empty is not a value: the daemon must not start with `HOME=""` or an
    /// empty index directory.
    #[test]
    fn an_empty_variable_is_not_a_value() {
        // SAFETY: single-threaded test, and the name is test-specific.
        unsafe {
            std::env::set_var("ULTRASEARCH_TEST_A", "value");
            assert_eq!(var("ULTRASEARCH_TEST_A").as_deref(), Some("value"));
            std::env::set_var("ULTRASEARCH_TEST_A", "");
            assert_eq!(var("ULTRASEARCH_TEST_A"), None);
            std::env::remove_var("ULTRASEARCH_TEST_A");
            assert_eq!(var("ULTRASEARCH_TEST_A"), None);
        }
    }

    /// A trailing slash on the scan root would make the crawl skip the
    /// folder itself (an empty name component).
    #[test]
    fn scan_root_trims_trailing_slash() {
        // SAFETY: see above.
        unsafe {
            std::env::set_var("ULTRASEARCH_SCAN_ROOT", "/nonexistent-fixture/");
            assert_eq!(scan_root(), b"/nonexistent-fixture");
            std::env::remove_var("ULTRASEARCH_SCAN_ROOT");
        }
    }

    /// Unset means home, not `/`: indexing the operating system is what put
    /// the daemon in a recompaction loop on a busy machine, and it is not what
    /// a personal search index is for. `/` stays reachable explicitly.
    #[test]
    fn scan_root_defaults_to_home_not_the_whole_disk() {
        // SAFETY: see above.
        unsafe {
            std::env::remove_var("ULTRASEARCH_SCAN_ROOT");
            let d = scan_root();
            assert_ne!(d, b"/", "the default must not be the whole disk");
            assert_eq!(d, home().into_bytes(), "the default is the home directory");

            std::env::set_var("ULTRASEARCH_SCAN_ROOT", "/");
            assert_eq!(scan_root(), b"/", "whole-disk stays available on request");
            std::env::remove_var("ULTRASEARCH_SCAN_ROOT");
        }
    }

    /// The churn warning tells operators to raise `COMPACT_PENDING`; it has to
    /// be readable from the environment or that advice is unfollowable.
    #[test]
    fn compact_pending_is_configurable() {
        // SAFETY: see above.
        unsafe {
            std::env::remove_var("ULTRASEARCH_COMPACT_PENDING");
            assert_eq!(compact_pending(), 50_000, "the documented default");

            std::env::set_var("ULTRASEARCH_COMPACT_PENDING", "250000");
            assert_eq!(compact_pending(), 250_000);

            std::env::set_var("ULTRASEARCH_COMPACT_PENDING", " 120000 ");
            assert_eq!(compact_pending(), 120_000, "surrounding space is tolerated");

            // A bar low enough to compact on every keystroke is not a value.
            std::env::set_var("ULTRASEARCH_COMPACT_PENDING", "999");
            assert_eq!(compact_pending(), 50_000, "under 1,000 is ignored");

            std::env::set_var("ULTRASEARCH_COMPACT_PENDING", "not-a-number");
            assert_eq!(compact_pending(), 50_000, "unparseable falls back");

            std::env::set_var("ULTRASEARCH_COMPACT_PENDING", "");
            assert_eq!(compact_pending(), 50_000, "empty is not a value");

            std::env::remove_var("ULTRASEARCH_COMPACT_PENDING");
        }
    }

    /// The advisory ceiling is optional and ignores nonsense, so a typo cannot
    /// silently disable the warning.
    #[test]
    fn max_entries_is_optional_and_validated() {
        // SAFETY: see above.
        unsafe {
            std::env::remove_var("ULTRASEARCH_MAX_ENTRIES");
            assert_eq!(max_entries(), None, "unset means no ceiling");

            std::env::set_var("ULTRASEARCH_MAX_ENTRIES", "1500000");
            assert_eq!(max_entries(), Some(1_500_000));

            std::env::set_var("ULTRASEARCH_MAX_ENTRIES", " 250000 ");
            assert_eq!(max_entries(), Some(250_000), "surrounding space is tolerated");

            std::env::set_var("ULTRASEARCH_MAX_ENTRIES", "999");
            assert_eq!(max_entries(), None, "under 1,000 is not a useful ceiling");

            std::env::set_var("ULTRASEARCH_MAX_ENTRIES", "many");
            assert_eq!(max_entries(), None, "unparseable is ignored");

            std::env::remove_var("ULTRASEARCH_MAX_ENTRIES");
        }
    }

    /// A path with a symlink in it is resolved: the crawl opens the root with
    /// `O_NOFOLLOW_ANY`, which refuses `/tmp/...` (a link to `/private/tmp`).
    #[test]
    fn scan_root_resolves_symlinks() {
        // SAFETY: see above.
        #[cfg(target_os = "macos")]
        unsafe {
            std::env::set_var("ULTRASEARCH_SCAN_ROOT", "/tmp");
            assert_eq!(scan_root(), b"/private/tmp");
            std::env::remove_var("ULTRASEARCH_SCAN_ROOT");
        }
    }
}
