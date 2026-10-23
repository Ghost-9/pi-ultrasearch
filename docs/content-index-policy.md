# What the content index covers

Name search covers every entry the daemon can see. **Content search (grep)
covers a subset**: on a typical developer Mac 129 k of 3.7 M entries (~3.5 %),
because the rest is not text anybody greps for. That is what makes a 0-hit grep
ambiguous, so the policy is configurable and reported.

## The rules, in order

1. **Coverage policy** (below): roots, size cap, extension list.
2. Not in a `.git` directory, and not in a folder macOS guards without Full
   Disk Access.
3. Inside a git repository: up to 10 MiB (`MAX_REPO_FILE`), not a
   `binary_ext` name, not generated (lockfiles, JSON ≥ 100 KB, minified JS/CSS).
4. Outside a git repository: a built-in text extension
   (`engine/src/content.rs`, `TEXT_EXTS`), or an extensionless file up to
   256 KiB, and not one of the generated rules above.
5. `.gitignore` / `.ignore` rules, as git would apply them.
6. The bytes themselves must look like text (no NUL, not a file whose lines
   average over 1000 bytes).

A file's *name* stays findable either way; a grep of a file the index does not
hold reads it directly, so a result is never wrong — only slower.

## Configuring it

`<index dir>/coverage.json` (default `~/Library/Application Support/UltraSearch/coverage.json`):

```json
{
  "extensions": ["rs", "ts", "tsx", "md"],
  "max_file_bytes": 2097152,
  "roots": ["/Users/me/projects"],
  "warm": ["/Users/me/projects/ultra-search"]
}
```

Every key is optional and independent:

* `extensions` **replaces** the built-in list. A listed file is still only
  indexed if its bytes look like text, so listing a binary extension does not
  put binary into the index.
* `max_file_bytes` replaces the size caps above.
* `roots` restricts the content index to these folders; nothing outside them is
  ever read. Name search is unaffected.
* `warm` folders have their content built **at daemon start**, before the
  general reconcile, so a freshly opened repo is greppable sooner. Without
  `warm`, the first search inside a folder asks for its content and it is
  ready seconds later (the same mechanism, driven by a search).

Environment overrides the file, field by field: `ULTRASEARCH_CONTENT_EXTS`,
`ULTRASEARCH_CONTENT_MAX_BYTES`, `ULTRASEARCH_CONTENT_ROOTS`,
`ULTRASEARCH_WARM` (comma or colon separated), and
`ULTRASEARCH_COVERAGE_FILE` to point at another file.

A policy that cannot be parsed is an **error at daemon start**, not a silent
fallback: a coverage rule that does not apply is how a 0-hit grep gets mistaken
for "the text is not on disk".

## Seeing the policy

`op: status` carries:

```json
"content_docs": 129295,
"content_segments": 36,
"content_pending": 0,
"content_policy": {
  "configured": true, "source": "…/coverage.json",
  "extensions": 4, "max_file_bytes": 2097152, "roots": 1, "warm": 1
}
```

`content_docs` is how many files are covered, `content_pending` how many are
queued for the next batch. Both with `content_policy` answer "is this file
covered?" without guessing: if `content_docs` is 0 and a warm root is
configured, the build has not finished; if a path is outside `roots`, it will
never be covered.
