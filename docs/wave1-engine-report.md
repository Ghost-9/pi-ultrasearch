# Wave 1 — engine + security: final report

**Branch:** `wave1/engine` · **HEAD when this was written:** `d50249a` · **Base:** `0a16e50` (main)
**Worktree:** `/Users/batra/ultrasearch-waves/engine` · **Base repo:** `Ghost-9/pi-ultrasearch`

## What is in the branch

56 files, +23 142 / −22 lines. Six commits:

| Commit | Content |
|---|---|
| `4f90164` | Vendor upstream `fsearch` v0.2.1 under `engine/` + `NOTICE`, `BUILD.md` |
| `2abd752` | Isolation env knobs, crawl-root correctness, `status` freshness + compaction metrics, single-owner ranking |
| `b4fcdd5` | Engine deny-list + caller `root` containment (#23, engine half) |
| `dfa265f` | PEM regex, line-wise key bodies, DLP on paths, query scopes (#23, client half) |
| `8a591f5` | `budget_ms` + candidate cap + counts (#16, #35) |
| `d50249a` | Content coverage policy + warm-up + `content_policy` in `status` (#17) |

New engine modules: `engine/src/env.rs`, `engine/src/deny.rs`, `engine/src/coverage.rs`.
New docs: `docs/engine-changes.md`, `docs/security-deny-list.md`, `docs/content-index-policy.md`.
New benchmark: `bench/engine-ab.mjs`, raw sample in `bench/results/engine/`.
New tests: `test/engine/{harness,security,search,status,coverage}.test.mjs`, `test/sanitize.test.ts`.

## Verification (all commands run at `d50249a`)

| Command | Result |
|---|---|
| `cargo test --release` | **39 pass, 0 fail** (30 lib + 9 bin) |
| `npm run typecheck` | pass |
| `npm test` (`client.test.ts` + `sanitize.test.ts`) | **36 pass, 0 fail** |
| `npm run test:engine` (26 integration tests, real daemon per test) | **26 pass, 0 fail** |
| `npm run test:gate` | **3 pass, 1 fail** — see *Blockers*; proven environmental, not a regression |

## Per-issue status

### #23 — security batch — **delivered, both halves**

| Acceptance criterion | Evidence |
|---|---|
| Multi-line PEM fixture is fully redacted | `test/sanitize.test.ts`: "a whole multi-line block is redacted, body included"; "scrubbing line by line redacts the whole body"; "the EC and OpenSSH variants are redacted too" |
| Escaping scopes return a security error for every tool | `test/engine/security.test.mjs`: `search` with `in:`, `glob` with an absolute pattern, `grep` with `in:`, a `git:` filter whose `cwd` escapes — all four refused; plus a `grep file:` outside the root. Client side: `unsafeQueryScope` is checked before dispatch and `root` is sent so the daemon refuses it again |
| Deny-list test proves blocked paths never reach output | `test/engine/security.test.mjs`: hits and grep files filtered, `withheld: 2` reported, a *sub*-denial hides only what it names, a denied scope is refused outright, no policy denies nothing, a malformed rule and a missing explicit file each fail every result request closed (with `status` still answering and reporting `deny_error`) |

Extra beyond the issue: the PEM bug is fixed at the root, not just the regex. `[[\s\S]*?` was a
malformed character class that *happened* to match; the real leak was that grep output is scrubbed
line by line, where a whole-block pattern can never match. Added `SecretGuard` (PEM state across
the lines of one file's results, bounded so a stray `BEGIN` cannot blank a result set), an
armour-line pattern, and a narrow bare-body rule (whole line, base64, ≥64 chars, not a hex digest —
so git SHAs and checksums are untouched). The negative test is explicit: a corpus of ordinary code,
paths, git SHAs, data URIs and URLs must never be scrubbed.

The engine is the last place a path can be stopped, so the policy lives there: `deny.txt` /
`ULTRASEARCH_DENY` / `ULTRASEARCH_DENY_FILE`, rules and caller roots normalized like indexed paths
(a rule written `/var/...` matches the `/private/var/...` the index holds), matched by whole path
components, enforced before a result is written, with `withheld` reported rather than silent drops.
Diagnostics (`ping`, `status`, `save`) stay reachable when the policy is broken, and `status`
explains why.

### #16 — `budget_ms` — **engine half delivered**

* `op: search` accepts `budget_ms`; the reply carries `complete`, `scanned`, `considered`,
  `budget_ms`.
* `grep` already had a budget and `complete`; it now reports `scanned`/`considered` in the same
  vocabulary beside its own `candidates`/`read`.
* Deterministic Rust tests: a spent budget marks the answer partial; an ample budget is
  *equivalent to no budget* (same hits, same order, same count); counts are reported without a
  deadline; a grep replies `complete: true` with the counts.
* Reliability detail: a `top_k` piece splits a whole-disk scan into ~40 ranges, so a
  4096-entry tick never fired inside a piece and the deadline was never checked. The check now
  fires at each piece's first entry and every `min(4096, piece/8)` entries, so an expired budget
  bounds the query instead of one scan.
* Client plumbing (pool/budget wiring in `src/client.ts`) is deliberately left to the measure wave.

### #35 — early termination / score budgets — **partially delivered, honestly scoped**

* A configurable candidate budget (`candidates`) that stops scoring: `complete: false`.
* Deadline-driven early exit at pass and round boundaries too: a spent budget skips the deeper
  typo retry, a second `spread` round, another `driven` try, and the `ranked` batch loop.
* `scanned`/`considered` reported, so the work is checkable.
* Top-k equivalence: proven in Rust (ample budget ≡ no budget) and end-to-end
  (`test/engine/search.test.mjs` compares digest of `path|score|kind|size` with the unbudgeted run;
  a partial result must be a subset of the full set).
* **Not delivered:** a discrete "runs of low-score matches" heuristic. The early exit here is a
  deadline, a candidate cap, and the existing floor-based pruning in `top_k`. Say so in the issue.
* `scanned`/`considered` are `0` for a query answered by a strategy that visits names rather than
  entries (`ranked`, `driven`); they count the entry scan and nothing is claimed when no budget was
  requested.

### #34 — compaction pause + metrics — **delivered**

* `status` exposes `compactions`, `last_compact_ms`, `last_compact_bytes`, `last_compact_entries`,
  `last_compact_secs_ago`, `compactions_postponed`, `queries_in_flight`.
* A due compaction waits up to `COMPACT_DRAIN` (2 s) for in-flight queries, ignoring the pause past
  `COMPACT_URGENT` (400 k pending). The policy is a pure function (`compact_now`) with a unit test.
* Churn: `CHURN_WARN` (4) compactions in a row forced by overlay size logs a warning.
* Test evidence: `test/engine/status.test.mjs` holds a query in flight with a budgeted grep
  (deterministic ~1.4 s window), requests a compaction, and asserts `compactions` stays 0 and
  `compactions_postponed ≥ 1` while the query runs, then that the compaction happens after it
  drains.
* **Two real bugs found and fixed while testing this:** a postponed compaction was *lost* because
  the save request was consumed before the pause; and `Live::to_listings` built paths from `/`, so a
  compaction folded no overlay entry when the crawl root was not `/` — a file added since the build
  vanished on `save`.

### #17 — content coverage config + warm-up — **delivered (policy + warm-up + status)**

* `coverage.json` (or `ULTRASEARCH_CONTENT_EXTS` / `_MAX_BYTES` / `_ROOTS` / `ULTRASEARCH_WARM` /
  `ULTRASEARCH_COVERAGE_FILE`): extensions (replacing the built-in list), size cap, content roots,
  warm folders. All optional and independent.
* A policy that cannot be parsed is an **error at daemon start**, not a silent fallback.
* `status.content_policy` reports configured/source/extension count/cap/root count/warm count beside
  `content_docs` and `content_pending`.
* Warm folders are queued for content at start, before the general reconcile: a freshly opened repo
  is greppable within the documented window (the test waits for `content_docs` with
  `content_pending == 0`).
* Documented policy: `docs/content-index-policy.md` (the six rules in order, the file format, how to
  read `status`).
* **Note for the issue:** `root`/`SCAN_ROOT` isolation is a *test and single-instance* knob, not a
  security boundary; the deny-list is. Documented in `docs/engine-changes.md`.

### #19 — staleness metrics — **delivered**

* `status`: `last_event_id`, `event_lag`, `staleness_ms`, `replay_in_progress`.
* Answers carry `stale`/`stale_ms` while a replay window is open; the extension appends a one-line
  freshness warning when it sees one.
* **Definition, so nobody misreads it:** `staleness_ms` is `0` when the index is caught up and
  otherwise the age of the replay/relist window (opened by a detected drop or a relist, closed on
  `HISTORY_DONE` or relist completion). It is *not* "time since the last change" — an idle index is
  not stale, and the test asserts exactly that (`staleness_ms == 0` after idling).
  `event_lag` counts every change on the volume, so it is a hint, not a measure.
* **Real bug found and fixed:** FSEvents sends no `HISTORY_DONE` for a stream started at the current
  event id, so `replay_in_progress` stayed true forever and every answer was marked stale. A stream
  started at (or past) the newest id is no longer treated as replaying.

### #22 — e2e prerequisites (engine side) — **delivered**

* Two linked worktrees (`git worktree add`) with the same filename in each: a scoped search in one
  returns only its own paths, both for name search and grep, and the main checkout's copy never
  leaks in. The daemon reports real paths, so the test compares canonical paths.
* Frecency: an *opened* file (via `op: open`, the same call the `tool_execution_end` hook makes)
  outranks an identical file that was never opened, `boost` is reported on the winner, and the
  untouched file's boost is strictly lower (a fresh mtime counts as one more open, so it is not
  zero — the ordering is the claim).
* The ignore-rule and semantic-mode halves of #22 are client-side and belong to the measure/
  foundation waves; not touched here.

## Benchmark — #16/#35/#34 regression check

`node bench/engine-ab.mjs --n 20 --files 4000` — two **real daemons** (baseline = `f84ce92`, the
commit before the budget work, built into a throwaway checkout; B = this branch), alternating A/B
within each round, medians with a 95 % bootstrap CI (2000 resamples, seeded), and an exact
output-equivalence digest per query. Raw samples: `bench/results/engine/budget-vs-baseline-*.json`.

| Query | A p50 (CI) | B p50 (CI) | Δ median (CI) | p95 A → B | Output |
|---|---|---|---|---|---|
| `path-search` (`file-*`, limit 30) | 0.36 ms (0.32–0.44) | 0.39 ms (0.33–0.55) | +0.02 ms (−0.08–0.08) | 0.82 → 0.67 ms | identical |
| `path-search` + `budget_ms 60000` | 0.40 ms (0.31–0.46) | 0.32 ms (0.29–0.40) | +0.01 ms (−0.03–0.09) | 0.78 → 1.08 ms | identical |
| `path-narrow` (`file-0000*`) | 0.26 ms (0.20–0.43) | 0.27 ms (0.21–0.31) | −0.00 ms (−0.03–0.09) | 0.59 → 0.54 ms | identical |
| `grep NEEDLE_3` | 1.82 ms (1.68–2.11) | 1.68 ms (1.56–2.06) | +0.03 ms (−0.11–0.21) | 2.45 → 2.63 ms | identical |

**Reading:** every Δ median's CI straddles 0 and every result set is byte-identical, so the budget
machinery, the counters, the compaction pause and the coverage policy did **not** change the
unbudgeted common path. **This run is not quotable as a latency claim:** the 1-minute load average
during it was **3.99** (gate: ≤1.5), and the whole session ran under heavy external load (load
average peaked at **278**, and the same fixture creation took 10 s vs 28 s at different moments).
The script prints `NOT QUOTABLE` and records `"quotable": false` for exactly this reason. Re-run on
a quiet machine before citing any number; the harness and the raw samples are committed.

The budget's *effect* (bounding a large tail) is asserted in tests rather than benchmarked: with a
1 ms budget over a 20 000-file fixture the search returns `complete: false`, and a candidate cap
stops scoring (`considered` far below the fixture size).

## Blockers / deferred

1. **`npm run test:gate`: 1 of 4 fails — pre-existing, environmental, not a regression.**
   `Live CI Gate: daemon-backed p95 trigram grep < 5 ms` measures **8.10 ms**. The **raw daemon
   socket, with no client involved at all** measures p50 7.13 ms / p95 7.95 ms on the same machine
   (`/tmp/raw-grep-bench.mjs`, n=60). The 5 ms gate is below what the live production daemon
   delivers here; `AUDIT-2026-10-14.md` §3.2 already recorded real grep p50 13.4 ms and called this
   gate misdescribed. My changes cannot affect that path (the measurement bypasses the extension).
   Fixing or re-scoping the gate is a decision for the foundation/measure waves.
2. **Not quotable latency numbers** (above). No speed claim is made in this report; only
   equivalence and non-regression *within a noisy window*.
3. **#35's "runs of low-score matches" heuristic was not implemented** (time/scope). The deadline,
   the candidate cap and the existing floor pruning are what exist; see the issue.
4. **`scanned`/`considered` are 0 for name-visiting strategies** (`ranked`, `driven`), and the reply
   omits them entirely when no budget was requested. Documented in `docs/engine-changes.md`.
5. **The daemon's unix-socket accept queue is the OS default** (`libc::listen` is never called with a
   larger backlog): a burst past ~128 simultaneous connects is *refused*, not queued. Found while
   writing the #34 burst test. A client pool (measure wave, `OPTIMIZATIONS.md` A5) is the right fix.
6. **The engine test suite is not in CI.** It needs `cargo build --release` (binary `ultrasearch`); the CI workflow is not
   mine to change. `npm run test:engine` runs it locally; `test/engine/harness.mjs` has
   `ensureEngineBuilt()` so a CI job would only need cargo + a longer timeout.
7. **No upstream sync tooling** beyond `docs/engine-changes.md`: the file lists every local change so
   a future v0.2.2 merge can re-apply them. `engine/rebrand.sh` (foundation) is expected to run on
   top of this source; the local changes are behavioural and do not depend on upstream names.
8. **Content-index warm-up is best-effort per folder**: `warm` folders are queued at start and
   indexed by the content worker, so the window is "seconds", not a guaranteed deadline. The test
   asserts the folder becomes searchable with `content_pending == 0`, not a time bound.

## Follow-up: rebase onto main + the engine becomes canonical in-repo

Rebased onto `origin/main` (`bf1949b`: the UltraSearch rename, daemon migration, verifier baseline and
the measure wave). Conflicts were resolved by re-applying this wave's delta onto main's renamed code —
keeping measure's `budget_ms` end-to-end, `meta`, IPC lanes, async fallback, telemetry views and
ignore-density over-fetch, and foundation's naming and six-tool MCP surface — rather than by hand-merging
markers. `src/types.ts` and `src/client.ts` auto-merged in part; `index.ts`, `package.json`, `src/sanitize.ts`,
`src/formatter.ts`, `README.md` needed real resolution. `SearchOptions.sort` was **removed**: main forwarded
it, the engine has no `sort` request field (unknown keys are ignored by `Query::filter`), and the test that
asserted forwarding now asserts the removal and that the real ranking inputs (`near`) still go out.

The vendored engine was then rebranded with `engine/rebrand.sh` and installed as the in-repo canonical source:
crate/binary `ultrasearch`, data dir `UltraSearch`, socket `ultrasearch.sock`, `ULTRASEARCH_*` only.

| Rebrand evidence | Value |
|---|---|
| `engine/LICENSE` md5 (must stay byte-identical) | `0dc34369214adc92ff6442e372cd3989` — equal to upstream and to the pre-rebrand copy |
| Token scan (`fsearch`, any case, all file types) | **0** outside `NOTICE`, the upstream URL in `README.md`, `rebrand.sh` (the mapping tool) and `LICENSE` |
| Idempotency | second run over its own output == third run (diff clean); **the first pass is not its own fixpoint** — see below |
| Attribution | `engine/NOTICE` keeps upstream project, version `0.2.1`, author, URL and licence terms, and now also lists the local change set |
| Guard | `test/mcp.test.ts` "the vendored daemon carries no upstream name" walks `engine/` and asserts the four exceptions explicitly, so a stray token (a path, socket, package name or data dir the rename missed) fails the suite |

`engine/rebrand.sh` has two ordering defects that leave the *first* pass slightly wrong (both in `README.md`
only): it prepends its fork header before the token swap, so the header names the fork after itself
("rebranded ultrasearch fork"), and the `.local/bin/<binary>` rewrite lands a pass after the header is
written. Both are documented in `engine/BUILD.md` with the repair, and the tree in this branch is the
converged, corrected output. Worth fixing upstream of the script.

### Daemon install (performed on this machine)

Backups were taken **and a restore drill run** (the backed-up binary executed and printed its usage)
before anything was replaced: `/Applications/UltraSearch.app.bak-engine-20261015-040820`,
`~/.local/bin/ultrasearch-daemon.bak-engine-20261015-040820`,
`~/Library/LaunchAgents/com.pi.ultrasearch.plist.bak-engine-20261015-040820`, with a rollback script that
restores all three, re-signs and re-bootstraps.

The 2026-10-15 install used the identifier-only designated requirement from the then-current
`docs/engine-rebrand.md` §2 and the grant survived that re-sign. This is a historical observation, not a
guarantee for later ad-hoc re-signs: the CDHash can change while the bundle identifier remains the same.
The current installer documents an optional persistent signing identity and provides `scripts/verify-fda.sh`.

| Post-install evidence | Value |
|---|---|
| launchd | `state = running`, `pid 8887` stable over repeated checks, **`last exit code = (never exited)`** — no crash or KeepAlive loop |
| Full Disk Access | **`full_disk_access: true` at that install** — the grant survived that one re-sign; later ad-hoc re-signs can invalidate it |
| Index | reused, not rebuilt: `entries 3,879,791`, `content_docs 145,620`, `index_bytes 120 MB` |
| New fields answering live | `staleness_ms 0`, `replay_in_progress false`, `last_event_id`/`event_lag`, `compactions 1` with `last_compact_ms 1560` (**a real production compaction, now visible**), `compactions_postponed`, `queries_in_flight 0`, `content_policy`, `deny_configured`/`deny_rules` |
| Binary identity | installed app binary vs build artefact: after removing signatures both are 4,572,992 bytes and differ in exactly **2 header bytes** (Mach-O UUID); identical from byte 4096 to EOF |
| Back-compat | the pre-rename socket symlink (`.../FSearch/fsearch.sock`) still answers `{"ok":true}` |
| Live query smoke | `op: search` p50 ~6 ms on the 3.88 M-entry index; `op: grep` returns the new `scanned`/`considered` vocabulary |

### Validation on the rebased branch

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run build` | pass (`dist/` emitted) |
| `npm test` (merged list: client, sanitize, mcp, client-features, ipc-lanes, fallback, telemetry-views, e2e-regressions) | **95 pass, 0 fail** |
| `npm run test:engine` | **26 pass, 0 fail** |
| `cargo test --release` (the renamed engine) | **39 pass, 0 fail** |
| `npm run test:gate` | **4/4 pass** |

The `test:gate` live-grep threshold (< 5 ms p95) is a load- and state-sensitive tripwire, not an SLA. It
failed earlier in this session (p95 8.10 ms) and passes now on the freshly restarted daemon. The
**raw-daemon-only** measurement taken with no client involved, at the same load, reads p50 8.61 ms /
p95 10.74 ms for a broader grep (`FSearchClient`, 17 files read) than the gate's own query
(`UltraSearchClient`, `limit 10`). Both earlier and now, the floor belongs to the daemon and the machine's
load, not to the client: the gate's outcome tracks overlay size, daemon uptime and load average rather than
a code change.

## Notes for the other waves

* The engine now reports the rerank components (`near`, `boost`) and **owns proximity ranking** — the
  measure wave should stop client post-ranking for daemon-backed results (this branch already stopped
  calling it there; `applyProximityRanking` remains for the native fallback only, and its unit test
  still passes).
* `SearchOptions.sort` is **dead**: `"score" | "mtime" | "path" | "frecency"` is declared in
  `src/types.ts` and never sent to the engine, and the engine's request protocol has no `sort` field
  (ranking is always the match score, with `boost`/`near` components). The client can drop the
  option, or the field can be added to the protocol as a separate piece of work.
* The deny-list and `root` containment are enforced in the engine, so a caller that forgets them is
  still bounded; the client checks exist to give the agent an actionable error.
* `engine/BUILD.md` documents the isolation knobs; `test/engine/harness.mjs` is the shared way to run
  a real daemon over a fixture (used by 26 tests).
