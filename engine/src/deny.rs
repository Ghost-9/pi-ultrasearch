//! The deny-list: paths that must never reach a client (#23).
//!
//! Enterprise deployments need a policy boundary above the user's request:
//! some directories simply must not be searchable, whatever an agent asks for.
//!
//! Sources, first one that is configured wins:
//!
//! 1. `ULTRASEARCH_DENY` — absolute path prefixes, `:`-separated.
//! 2. `ULTRASEARCH_DENY_FILE` — a file to read the same list from.
//! 3. `<index dir>/deny.txt` — read when it exists.
//!
//! A list file is one absolute path prefix per line; blank lines and lines
//! starting with `#` are ignored.
//!
//! **Fail-closed.** A configured source that is missing, unreadable, or holds
//! a line that is not an absolute path is an error: the daemon answers with a
//! security error rather than returning unfiltered results. A daemon with no
//! source configured denies nothing (the upstream default).
//!
//! Matching is by whole path components (`/p/secret` blocks `/p/secret/x` but
//! not `/p/secretary`), on the *normalized* path: symlinks are resolved when
//! the path exists, so a link that points into a denied tree does not open a
//! side door.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// A compiled deny-list.
#[derive(Debug, Default)]
pub struct DenyList {
    prefixes: Vec<Vec<u8>>,
    /// A source was configured (so `blocked` is meaningful even when empty).
    configured: bool,
}

impl DenyList {
    /// Nothing denied: what a daemon without any deny source uses.
    pub fn none() -> DenyList {
        DenyList::default()
    }

    /// True when a deny source is configured (even if it lists nothing).
    pub fn configured(&self) -> bool {
        self.configured
    }

    pub fn len(&self) -> usize {
        self.prefixes.len()
    }

    /// True when no rule is configured, so `blocked` can only answer from the
    /// built-in list. Paired with `len` because clippy is right that a public
    /// length without this invites `if list.len() == 0`.
    pub fn is_empty(&self) -> bool {
        self.prefixes.is_empty()
    }

    /// Is `path` denied, by itself or because it is inside a denied folder?
    pub fn blocked(&self, path: &[u8]) -> bool {
        self.prefixes.iter().any(|p| within(path, p))
    }

    /// Drop everything `path_of` says is denied; the number withheld.
    pub fn retain<T>(&self, items: &mut Vec<T>, path_of: impl Fn(&T) -> &[u8]) -> usize {
        if self.prefixes.is_empty() {
            return 0;
        }
        let before = items.len();
        items.retain(|i| !self.blocked(path_of(i)));
        before - items.len()
    }

    /// Parse a list: one absolute path prefix per line (`#` comments).
    fn parse(text: &str, what: &str) -> Result<DenyList, String> {
        let mut prefixes = Vec::new();
        for (n, line) in text.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if !line.starts_with('/') {
                // Fail closed: a rule we cannot understand must not silently
                // allow what it was meant to block.
                return Err(format!("security: {what}:{}: not an absolute path: {line:?}", n + 1));
            }
            let p = line.trim_end_matches('/');
            let p = if p.is_empty() { "/" } else { p };
            prefixes.push(normalize(p));
        }
        Ok(DenyList { prefixes, configured: true })
    }

    /// The configured list, or the reason it could not be used. Never returns
    /// a partial list: an unusable source is an error (see the module docs).
    pub fn load(dir: &Path) -> Result<DenyList, String> {
        if let Some(v) = std::env::var_os("ULTRASEARCH_DENY") {
            return DenyList::parse(&v.to_string_lossy(), "ULTRASEARCH_DENY");
        }
        let file = std::env::var_os("ULTRASEARCH_DENY_FILE").map(PathBuf::from).unwrap_or_else(|| dir.join("deny.txt"));
        if !file.exists() {
            // A file named explicitly but missing is a misconfiguration; the
            // implicit `<dir>/deny.txt` simply may not exist.
            let explicit = std::env::var_os("ULTRASEARCH_DENY_FILE").is_some();
            return if explicit { Err(format!("security: deny-list file {} does not exist", file.display())) } else { Ok(DenyList::none()) };
        }
        let text = std::fs::read_to_string(&file).map_err(|e| format!("security: cannot read deny-list {}: {e}", file.display()))?;
        DenyList::parse(&text, &file.display().to_string())
    }
}

/// A small cache so an unchanged deny file is read once (#23). The mtime of
/// the source is checked per request: one `stat`, not one read.
pub struct DenyCache {
    dir: PathBuf,
    cached: std::sync::Mutex<Option<(SystemTime, std::sync::Arc<DenyList>)>>,
}

impl DenyCache {
    pub fn new(dir: PathBuf) -> DenyCache {
        DenyCache { dir, cached: std::sync::Mutex::new(None) }
    }

    /// The current list, or the reason it is unusable (fail closed).
    ///
    /// The source's mtime is checked per request (one `stat`); the list is
    /// re-read only when it changed. An unparsable source is never cached, so
    /// every request keeps failing rather than falling back to the last good
    /// list — a policy file that has been broken must not silently open.
    pub fn get(&self) -> Result<std::sync::Arc<DenyList>, String> {
        let src = self.source();
        let stamp = src.as_deref().and_then(|p| std::fs::metadata(p).ok()).and_then(|m| m.modified().ok());
        let key = stamp.unwrap_or(SystemTime::UNIX_EPOCH);
        {
            let c = self.cached.lock().unwrap_or_else(|p| p.into_inner());
            if let Some((at, list)) = c.as_ref()
                && *at == key
            {
                return Ok(list.clone());
            }
        }
        let list = std::sync::Arc::new(DenyList::load(&self.dir)?);
        *self.cached.lock().unwrap_or_else(|p| p.into_inner()) = Some((key, list.clone()));
        Ok(list)
    }

    /// The file the list would come from, when it is file-based.
    fn source(&self) -> Option<PathBuf> {
        if std::env::var_os("ULTRASEARCH_DENY").is_some() {
            return None;
        }
        Some(std::env::var_os("ULTRASEARCH_DENY_FILE").map(PathBuf::from).unwrap_or_else(|| self.dir.join("deny.txt")))
    }
}

/// Resolve a policy path the way the index holds paths: absolute and
/// symlink-free.
///
/// The index stores *real* paths (`/tmp` is `/private/tmp` on macOS). A rule
/// or a caller root written the other way (`/var/folders/...`) would match
/// nothing, which for a deny-list means silently allowing what it named. The
/// longest existing prefix is resolved, so a rule may name a folder that does
/// not exist yet.
pub fn normalize(p: &str) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    let mut head = PathBuf::from(p);
    let mut tail: Vec<Vec<u8>> = Vec::new();
    loop {
        if let Ok(c) = std::fs::canonicalize(&head) {
            let mut out = c.as_os_str().as_bytes().to_vec();
            for comp in tail.iter().rev() {
                if out.len() > 1 {
                    out.push(b'/');
                }
                out.extend_from_slice(comp);
            }
            return out;
        }
        let Some(name) = head.file_name().map(|n| n.as_bytes().to_vec()) else { return p.as_bytes().to_vec() };
        tail.push(name);
        if !head.pop() {
            return p.as_bytes().to_vec();
        }
    }
}

/// Is `path` `dir` or inside it, by whole components? (`/p/abc` is not in `/p/a`.)
pub fn within(path: &[u8], dir: &[u8]) -> bool {
    path.starts_with(dir) && (path.len() == dir.len() || dir.ends_with(b"/") || path.get(dir.len()) == Some(&b'/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(text: &str) -> DenyList {
        DenyList::parse(text, "test").unwrap()
    }

    #[test]
    fn blocks_folders_not_name_prefixes() {
        let d = list("/p/secret\n# a comment\n\n/p/other/\n");
        assert!(d.blocked(b"/p/secret"));
        assert!(d.blocked(b"/p/secret/keys.pem"));
        assert!(d.blocked(b"/p/other/x"));
        assert!(!d.blocked(b"/p/secretary/x"), "a name prefix is not a folder");
        assert!(!d.blocked(b"/p/secure"));
        assert!(d.configured());
        assert_eq!(d.len(), 2);
    }

    #[test]
    fn a_rule_that_is_not_absolute_fails_the_whole_list() {
        let e = DenyList::parse("/ok\nrelative/path\n", "test").unwrap_err();
        assert!(e.contains("not an absolute path"), "{e}");
    }

    #[test]
    fn retain_counts_what_it_withheld() {
        let d = list("/p/secret\n");
        let mut v: Vec<Vec<u8>> = [&b"/p/secret/a"[..], b"/p/open/b", b"/p/secret/c/d"].iter().map(|p| p.to_vec()).collect();
        let n = d.retain(&mut v, |p| p);
        assert_eq!(n, 2);
        assert_eq!(v, vec![b"/p/open/b".to_vec()]);
    }

    /// A rule written through a symlink matches the real path the index
    /// holds, or it would deny nothing at all.
    #[test]
    #[cfg(target_os = "macos")]
    fn a_rule_is_resolved_like_a_path() {
        let d = list("/tmp\n");
        assert!(d.blocked(b"/private/tmp/anything"), "{:?}", d.prefixes);
    }

    #[test]
    fn no_source_denies_nothing() {
        let d = DenyList::none();
        assert!(!d.configured());
        assert!(!d.blocked(b"/anything"));
    }

    /// A configured file that cannot be read must be an error, never an
    /// empty allow-list.
    #[test]
    fn a_missing_explicit_file_is_an_error() {
        // SAFETY: test-local variable names.
        unsafe {
            std::env::remove_var("ULTRASEARCH_DENY");
            std::env::set_var("ULTRASEARCH_DENY_FILE", "/nonexistent/us-deny-file");
        }
        let e = DenyList::load(Path::new("/tmp")).unwrap_err();
        assert!(e.contains("does not exist"), "{e}");
        // SAFETY: see above.
        unsafe { std::env::remove_var("ULTRASEARCH_DENY_FILE") };
    }
}
