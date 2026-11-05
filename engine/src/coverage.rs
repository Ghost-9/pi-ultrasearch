//! What the content index covers, and how to change it (#17).
//!
//! The content (trigram) index does not hold every file on disk: 129 k of
//! 3.7 M entries on a typical developer Mac, because most of the disk is not
//! text anybody greps for. Upstream's policy is a fixed set of text
//! extensions, a size cap, and generated-file rules. This module makes the
//! parts an operator cares about configurable, and reports them in
//! `op: status` so a 0-hit grep is never ambiguous.
//!
//! Sources, first match wins:
//!
//! 1. `ULTRASEARCH_CONTENT_EXTS`, `ULTRASEARCH_CONTENT_MAX_BYTES`,
//!    `ULTRASEARCH_CONTENT_ROOTS`, `ULTRASEARCH_WARM` (comma or colon
//!    separated).
//! 2. `<index dir>/coverage.json`:
//!
//! ```json
//! {
//!   "extensions": ["rs", "ts", "md"],
//!   "max_file_bytes": 2097152,
//!   "roots": ["/Users/me/projects"],
//!   "warm": ["/Users/me/projects/ultra-search"]
//! }
//! ```
//!
//! All four keys are optional and independent:
//!
//! * `extensions` **replaces** the built-in text-extension list. A file is
//!   still only indexed if its bytes look like text (`is_text`), so listing
//!   a binary extension does not put binary into the index.
//! * `max_file_bytes` replaces the size cap (`MAX_FILE`, 1 MiB outside a git
//!   repo, `MAX_REPO_FILE`, 10 MiB inside one).
//! * `roots` restricts the content index to these folders; nothing outside
//!   them is ever read. Name search is unaffected.
//! * `warm` folders have their content built at daemon start, before the
//!   general reconcile, so a freshly opened repo is greppable sooner. (A
//!   folder that is only searched is warmed the same way without this: the
//!   first search for it asks for its content.)
//!
//! A policy that cannot be parsed is an error at daemon start rather than a
//! silent fallback to the defaults: a coverage rule that does not apply is
//! how a 0-hit grep gets mistaken for "the text is not on disk".

use std::path::{Path, PathBuf};

/// The content-index policy in force.
#[derive(Debug, Default, Clone)]
pub struct Policy {
    /// `None`: the built-in text extensions.
    pub extensions: Option<Vec<Vec<u8>>>,
    /// `None`: the built-in caps.
    pub max_file_bytes: Option<u64>,
    /// `None`: everywhere the name index goes.
    pub roots: Option<Vec<Vec<u8>>>,
    /// Folders whose content is built at daemon start.
    pub warm: Vec<Vec<u8>>,
    /// The file the policy came from, for `status`.
    pub source: Option<String>,
}

impl Policy {
    /// Nothing configured: upstream's behaviour.
    pub fn built_in() -> Policy {
        Policy::default()
    }

    pub fn configured(&self) -> bool {
        self.extensions.is_some() || self.max_file_bytes.is_some() || self.roots.is_some() || !self.warm.is_empty()
    }

    /// May `path` (of `size` bytes) be in the content index, on policy alone?
    /// The built-in heuristics still apply on top.
    pub fn allows(&self, path: &[u8], size: u64) -> bool {
        if let Some(roots) = &self.roots
            && !roots.iter().any(|r| crate::deny::within(path, r))
        {
            return false;
        }
        if let Some(cap) = self.max_file_bytes
            && size > cap
        {
            return false;
        }
        if let Some(exts) = &self.extensions {
            let ext = path.iter().rposition(|&b| b == b'.').filter(|&p| p > 0).map_or(&b""[..], |p| &path[p + 1..]);
            if !exts.iter().any(|x| x.eq_ignore_ascii_case(ext)) {
                return false;
            }
        }
        true
    }

    /// A summary for `op: status`: what is in force, without the paths.
    ///
    /// The configured block alone answered `null` for every field on a default
    /// install, which is useless when it matters most: a grep returns zero hits and
    /// the question is whether the text is absent or merely not indexed. `effective`
    /// reports the rules the build actually applies, so that question is answerable
    /// without reading the source.
    pub fn summary(&self) -> serde_json::Value {
        use serde_json::json;
        let built_in = crate::content::built_in_rules();
        json!({
            "configured": self.configured(),
            "source": self.source,
            "extensions": self.extensions.as_ref().map(|e| e.len()),
            "max_file_bytes": self.max_file_bytes,
            "roots": self.roots.as_ref().map(|r| r.len()),
            "warm": self.warm.len(),
            "effective": {
                // A configured cap overrides the built-in one; otherwise the
                // built-in cap is what a large file is measured against.
                "max_file_bytes": self.max_file_bytes.unwrap_or(built_in.max_file_bytes),
                "extensions": match &self.extensions {
                    Some(e) => e.iter().map(|x| String::from_utf8_lossy(x).into_owned()).collect::<Vec<_>>(),
                    None => built_in.extensions,
                },
                "indexes_files_without_extension": self.extensions.is_none(),
                "skips_generated": ["lockfiles", "json >= 100 KB", "minified or bundled js/css"],
                "skips_names": built_in.skip_dirs,
                "note": "A zero-hit grep means the text was not found in an indexed file. If the file is larger than max_file_bytes, has an extension outside extensions, or is a generated artefact, the text can be on disk and unindexed.",
            },
        })
    }

    /// Read the policy, or say why it could not be used.
    pub fn load(dir: &Path) -> Result<Policy, String> {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let file: Option<PathBuf> = env("ULTRASEARCH_COVERAGE_FILE").map(PathBuf::from).or_else(|| {
            let p = dir.join("coverage.json");
            p.exists().then_some(p)
        });
        let mut policy = match &file {
            Some(p) => {
                let text = std::fs::read_to_string(p).map_err(|e| format!("coverage: cannot read {}: {e}", p.display()))?;
                let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("coverage: {}: {e}", p.display()))?;
                let list = |k: &str| -> Result<Option<Vec<Vec<u8>>>, String> {
                    match v.get(k) {
                        None | Some(serde_json::Value::Null) => Ok(None),
                        Some(serde_json::Value::Array(a)) => {
                            let mut out = Vec::new();
                            for x in a {
                                let s = x.as_str().ok_or_else(|| format!("coverage: {k} must be a list of strings"))?;
                                if s.trim().is_empty() {
                                    continue;
                                }
                                out.push(s.trim().trim_start_matches('.').as_bytes().to_vec());
                            }
                            Ok(Some(out))
                        }
                        Some(_) => Err(format!("coverage: {k} must be a list of strings")),
                    }
                };
                Policy {
                    extensions: list("extensions")?,
                    max_file_bytes: v.get("max_file_bytes").and_then(serde_json::Value::as_u64),
                    roots: list("roots")?.map(|r| r.iter().map(|p| crate::deny::normalize(&String::from_utf8_lossy(p))).collect()),
                    warm: list("warm")?.unwrap_or_default().iter().map(|p| crate::deny::normalize(&String::from_utf8_lossy(p))).collect(),
                    source: Some(p.display().to_string()),
                }
            }
            None => Policy::built_in(),
        };
        // The environment overrides the file, field by field.
        if let Some(v) = env("ULTRASEARCH_CONTENT_EXTS") {
            let exts = split(&v);
            policy.extensions = Some(exts);
            policy.source = Some("environment".into());
        }
        if let Some(v) = env("ULTRASEARCH_CONTENT_MAX_BYTES") {
            let n: u64 = v.parse().map_err(|_| "coverage: ULTRASEARCH_CONTENT_MAX_BYTES must be a number".to_string())?;
            policy.max_file_bytes = Some(n);
            policy.source = Some("environment".into());
        }
        if let Some(v) = env("ULTRASEARCH_CONTENT_ROOTS") {
            policy.roots = Some(split(&v).iter().map(|p| crate::deny::normalize(&String::from_utf8_lossy(p))).collect());
            policy.source = Some("environment".into());
        }
        if let Some(v) = env("ULTRASEARCH_WARM") {
            policy.warm = split(&v).iter().map(|p| crate::deny::normalize(&String::from_utf8_lossy(p))).collect();
            policy.source = Some("environment".into());
        }
        Ok(policy)
    }
}

/// Split a comma/colon separated list, ignoring empties.
fn split(v: &str) -> Vec<Vec<u8>> {
    v.split([',', ':']).map(str::trim).filter(|s| !s.is_empty()).map(|s| s.trim_start_matches('.').as_bytes().to_vec()).collect()
}

/// The policy in force: read once at daemon start.
static POLICY: std::sync::OnceLock<Policy> = std::sync::OnceLock::new();

/// Install the policy (a second call is ignored: one per process).
pub fn set(p: Policy) {
    POLICY.set(p).ok();
}

/// The policy in force, or the built-in one if none was installed.
pub fn policy() -> &'static Policy {
    POLICY.get_or_init(Policy::built_in)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(json: &str) -> Policy {
        let v: serde_json::Value = serde_json::from_str(json).unwrap();
        Policy {
            extensions: v
                .get("extensions")
                .and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|s| s.as_str()).map(|s| s.as_bytes().to_vec()).collect()),
            max_file_bytes: v.get("max_file_bytes").and_then(serde_json::Value::as_u64),
            roots: None,
            warm: Vec::new(),
            source: None,
        }
    }

    #[test]
    fn extensions_replace_the_built_in_list() {
        let p = p(r#"{"extensions":["rs","md"]}"#);
        assert!(p.allows(b"/a/b.rs", 10));
        assert!(p.allows(b"/a/b.MD", 10), "case must not matter");
        assert!(!p.allows(b"/a/b.ts", 10));
        assert!(!p.allows(b"/a/b", 10), "no extension is not listed");
        assert!(p.configured());
    }

    #[test]
    fn a_size_cap_and_roots_are_independent() {
        let p = p(r#"{"max_file_bytes":100}"#);
        assert!(p.allows(b"/a/b.rs", 100));
        assert!(!p.allows(b"/a/b.rs", 101));
        let mut roots = Policy { roots: Some(vec![b"/p/one".to_vec()]), ..Policy::built_in() };
        assert!(roots.allows(b"/p/one/x.rs", 1));
        assert!(!roots.allows(b"/p/two/x.rs", 1));
        assert!(!roots.allows(b"/p/oneish/x.rs", 1), "a name prefix is not a folder");
        roots.warm = vec![b"/p/one".to_vec()];
        assert!(roots.configured());
    }

    #[test]
    fn nothing_configured_is_the_built_in_policy() {
        let p = Policy::built_in();
        assert!(!p.configured());
        assert!(p.allows(b"/anywhere/anything", 1));
    }
    /// A policy with every knob set, to exercise each refusal.
    fn strict() -> Policy {
        Policy {
            extensions: Some(vec![b"rs".to_vec(), b"md".to_vec()]),
            max_file_bytes: Some(1000),
            roots: Some(vec![b"/allowed".to_vec()]),
            source: Some("test".into()),
            warm: Vec::new(),
        }
    }

    /// Each configured knob must refuse on its own. A policy that only enforces the
    /// last check it happens to run would let a file in through a door it should have
    /// been stopped at.
    #[test]
    fn every_knob_refuses_independently() {
        let p = strict();
        assert!(p.allows(b"/allowed/a.rs", 10), "a file that satisfies every rule is allowed");

        assert!(!p.allows(b"/elsewhere/a.rs", 10), "outside the configured roots");
        assert!(!p.allows(b"/allowed/a.rs", 5000), "over the size cap");
        assert!(!p.allows(b"/allowed/a.py", 10), "extension not in the allowlist");
    }

    /// With nothing configured, nothing is refused: the built-in heuristics still apply
    /// upstream, and a policy object that refuses by default would silently empty the
    /// content index.
    #[test]
    fn an_unconfigured_policy_refuses_nothing() {
        let p = Policy::default();
        assert!(!p.configured(), "the default must report itself unconfigured");
        for path in [&b"/anything/at/all.txt"[..], b"/x", b"/a/b/c.rs"] {
            assert!(p.allows(path, 1 << 40), "an unconfigured policy must allow {path:?}");
        }
    }

    /// `configured` must be true as soon as ANY knob is set - it drives whether the
    /// summary reports a real policy or the built-in defaults, and a false negative
    /// there would describe the wrong rules in `status`.
    #[test]
    fn configured_tracks_each_knob() {
        assert!(!Policy::default().configured());
        for p in [
            Policy { extensions: Some(vec![b"rs".to_vec()]), ..Default::default() },
            Policy { max_file_bytes: Some(10), ..Default::default() },
            Policy { roots: Some(vec![b"/r".to_vec()]), ..Default::default() },
            Policy { warm: vec![b"/w".to_vec()], ..Default::default() },
        ] {
            assert!(p.configured(), "a set knob must make the policy configured");
        }
    }
}
