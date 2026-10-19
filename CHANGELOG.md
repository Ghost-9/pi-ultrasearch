# Changelog

All notable changes to `pi-ultrasearch` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Entries up to and including 0.3.1 are kept as written, with one retrospective edit: historical
> `fsearch_*` tool names were renamed to today's `ultrasearch_*` so the file reads consistently.
> Upstream-engine references (the upstream project URL, `~/.cache/fsearch`, MIT © Noah Dunnagan)
> are unchanged — they are attribution, not rebranding.

---

## [2026-10-20] — scan-mode grep stops reading what git ignores
### Added — file-scoped grep, regex fallback, `us-rg`
- **A named file is read directly.** `file` is now on the client, Pi tool, MCP schema and CLI
  (`ultrasearch grep <pattern> --file <path>`); `case` is exposed alongside it. This implements the
  behaviour upstream PR #34 exists for without taking its index-format patch: 1,062 of 6,966 native
  searches in the session audit are file-scoped, and the content index may skip their text.
- **Regex-engine gaps fall back to ripgrep.** Look-around and backreferences are valid `rg --pcre2`
  patterns but not valid in the engine's regex crate; the client now retries those with the real
  ripgrep instead of returning a silent zero. Literal fallbacks pass `--fixed-strings` so they do not
  silently change meaning.
- **`scripts/us-rg`**: conservative ripgrep front-end. Accelerates only plain literal directory/file
  searches; `--files`, `-l`, `-c`, `--json`, globs, types, context and regex go to the real ripgrep.
  Does not shadow `rg`; requires ripgrep installed; exit codes match rg.
- Tests: 277 npm (new file-scope control), 44 engine, 39 + 9 Rust.

### Upstream check (noahdunnagan/fsearch)
- **No new upstream commits:** `origin/main` is still `v0.2.1` (`88e63fd`, 2026-10-12, 2,147 stars).
- **Ported PR #33** (15 lines, `src/engine.rs`): when fseventsd re-bases its journal, a saved event id can sit *ahead* of the new head; a stream created `since` it replays nothing and every change made while the daemon was away is lost silently. The loader now re-stamps the head and relists changed folders. Attribution kept in the code comment. Build + 39 Rust / 44 engine / 276 npm tests pass.
- **PR #34 is the next port** (304 lines, 5 files): greps that name a single file still read it even when the content index skips its text (large JSON, lockfiles, minified files, logs). This matters: in the session audit, 1,062 of 6,966 native searches are file-scoped, and UltraSearch cannot serve them today.
- Upstream issue #35 (display current version) is cosmetic.

### Evaluation (session audit, 2026-10-20)
- 462 Pi sessions: 6,721 shell search calls, 2,564,262 tool-output tokens (4 chars/token), median 181 ms, p95 43.8 s.
- 38 Codex sessions: 245 search calls, 336,942 tokens, median 226 ms.
- Only **20.9 %** of that output (606,762 tokens) is a clearly addressable directory/path search; 17.7 % is file-scoped, 14.1 % external/piped, 33.6 % missing scope.
- Replay of 48 real directory commands: 41.7 % returned nothing where native returned output; where both returned (n=27), the median output ratio is **1.48× [0.745, 1.95]** — not a proven token win. Native median 33 ms vs 1.35 ms in-process; the latency difference is real but the comparison excludes agent tool overhead.
- Product usage in those sessions: **13 calls in 6 sessions** (0.19 % of searches); 0 in Codex, 0 in Claude. The 672 audit rows are mostly CLI/dev runs (`harness: none`), and their 2.35 M `tokensSaved` is the legacy formula, not a measurement.



### Fixed
- **A scan-mode grep read gitignored trees before filtering them (#59).** When the content index does
  not hold a scope (a linked worktree, a fresh checkout, any folder outside `HOME`), the engine scans
  the live name index, which holds ignored trees. `ignored: false` was applied *after* the files were
  read, and the old server-side filter depended on `git status`, which a linked worktree may not have
  loaded — so ignored rows crossed the socket and the client dropped them. The scan now prunes with
  the folder's `.gitignore` rules before the reads, and the client asks for `ignored: false` instead
  of filtering after the response.

  Measured (`bench/results/wave59-ignore-prune.json`): **1.09 ms vs 44.83 ms** median, **39.6×
  [35.0, 42.1]**, n=30 alternating pairs, same binary and request, scan mode, 1,500 ignored files;
  tool-visible output identical, 0 ignored rows returned (90 in the unpruned arm). `status:
  provisional` — AC power but load1 5.86, above the 1.5 gate; the paired ratio is robust, the
  absolute p50 is not a final SLA number.
- **The ignore rules were invisible in a scan rooted at the scope.** `Scope` only consulted a repo
  when the folder was not its "home"; a scan rooted at the repo therefore skipped `.gitignore`. The
  scan now roots the scope one folder above the repo, and the glob reader falls back to the disk for
  dotfiles the name index does not carry.

### Added
- Regression test `test/engine/ignore-scan.test.mjs` (the control proves the ignored file is in the
  index; the assertion proves it does not cross the socket) and a Rust unit test for the prune.

### Changed
- **Judgment-set integrity coverage (#61):** the pin now governs the equivalence golden (the frozen
  30-query instrument cited as final by `docs/sla.md`), the wave scorecards and the verification
  summaries — 26 files, not 15. The golden was overwritten in `4bc510e` while the gate stayed silent
  because it only matched `*-baseline.json`. Dated latency artifacts stay outside the pin by design.
- **Live daemon promoted** to the 2026-10-20 engine build: `protocol_version` is now `1.0` in
  `status`, Full Disk Access retained, staleness 0. Re-signed with the identifier-only designated
  requirement; backups at `/tmp/ultrasearch-daemon.20261017-audit.bak` and
  `/tmp/UltraSearch.20261017-audit.bak`.

### Verified
- 276 npm tests, 44 engine integration tests, 39 + 9 Rust tests, gate 8/8, integrity 12/12.
- Benchmark artifact: `bench/results/wave59-ignore-prune.json` (method, fixture, load, CI included).

### Not done, on purpose
- #54–#58 (shards/postings/planner, block cache, journal, parallelism, auto-hybrid) remain the
  architectural programme; this change removes the scan's biggest avoidable cost, it does not make
  the content index cover new scopes (#60) or reach the 5× monorepo target.
- #62 (checkout-dependent token/zero-result baselines) and #63 (gate 3 is n=5 with a CI lower bound
  below threshold) are still open.

---

## [2026-10-17] — honest claims, a governed scorecard, semantic behind an opt-in

### Fixed
- **`rg --files` returned nothing, everywhere, silently.** Not this project's code: the
  `~/.local/bin/rg` shim on this machine discarded every flag it did not recognise and always exited
  0, so `rg --files` produced no output with a success status. pi-ultrasearch's own native fallback
  calls `rg --files --glob ... --iglob ...`, so its fallback path was dead and 2 tests in
  `test/fallback.test.ts` failed **on `main`**, not on any branch. The shim now passes any
  output-shaping flag (`--files`, `-l`, `-c`, `--json`, `-g`, `-t`) through to the real ripgrep and
  accelerates only a bare content search. Measured: the suite went from 260/262 to **275/275**.

### Added
- **Judgment-set integrity gate.** `bench/judgments/INTEGRITY.json` pins a checksum per governed
  file; `npm run judgments:integrity` fails on any unamended edit, on a governed file the pin does
  not cover, on a deletion, and on a missing manifest, and an amendment requires a written reason.
  Wired into CI. This closes the failure mode this project's own history records - a gate closed by
  amending what it measures. 8 tests, 6 of which assert the gate *rejects* a specific violation.
- `.corpus-meta.json` is now written **beside** the corpus root instead of inside it, so it can no
  longer be returned as a search hit. Includes a CONTROL test: with the metadata in-root it *is*
  returned for the same query.

### Changed
- **`semantic` mode is gated off by default** (`ULTRASEARCH_EXPERIMENTAL_SEMANTIC=1` re-enables it).
  It is intent keyword expansion, not vector search, and it does not perform: semantic nDCG@10
  **0.194**, paraphrase recall@10 **0.175**, success@3 0.10, **false-positive rate 1.00**. It was
  listed alongside `literal`/`regex`/`symbol` in the README and in the MCP tool schema with no
  qualification, so an agent had no way to know it was the one mode that does not work. Not removed -
  closing a 0.194 nDCG is research, not a patch - but unreachable by accident, and the refusal names
  the numbers and the alternatives.
- `enforceExactQuery` no longer turns every word of a query into an exact conjunct, which made
  `format grep files` return 0 results. Exactness now applies only to genuine selectors.

### Changed - housekeeping
- Reclaimed **1.4 GiB** of `engine/target` (gitignored cargo output; verified 0 tracked files and a
  clean `cargo build --release` from scratch in 1 m 12 s). Checkout 1.2 GB -> 48 MB.

### Not changed, on purpose
- No file under `bench/judgments/` and no `*-baseline.json` was edited. The vault recorded that 12
  `judgments.*` rows were marked `verified` while comparing a byte-identical file with itself; that
  was checked against this tree and **F10 is already repaired** (`8901916`, "F10 repair"). Of the 13
  rows marked verified, 0 are self-comparing and 12 carry a non-zero delta. Relabelling them on the
  stale note would have introduced a false finding.
- Semantic quality was not tuned to move a number.

---

## [Unreleased] — UltraSearch-only naming, build/distribution, MCP conformance

### Changed (breaking)
- **One name, end to end.** The extension tools are `ultrasearch_query`, `ultrasearch_grep`,
  `ultrasearch_multi_grep`, `ultrasearch_locate`, `ultrasearch_recent`, `ultrasearch_metrics`;
  the `/fsearch` slash command is removed (only `/ultrasearch` remains); `bin/mcp-server.ts` exposes exactly
  one `ultrasearch_*` tool surface and the `fsearch_*` aliases are gone from MCP `tools/list` and from the
  Code Mode declarations. MCP clients that hard-coded `fsearch_*` names must switch to `ultrasearch_*`.
- **Daemon socket and state paths.** macOS `~/Library/Application Support/UltraSearch/ultrasearch.sock`;
  Linux `$XDG_RUNTIME_DIR/ultrasearch.sock`, else `~/.local/share/ultrasearch/ultrasearch.sock`;
  Windows `\\.\pipe\ultrasearch`. Environment overrides remain `PI_ULTRASEARCH_*` only.
- **Engine and daemon binary** are now the rebranded `ultrasearch` (installed as `ultrasearch-daemon`),
  produced by `engine/rebrand.sh` from upstream fsearch v0.2.1 (MIT, © Noah Dunnagan — see `NOTICE`).
  `trySpawnDaemon()` candidates are `UltraSearch.app` and `ultrasearch-daemon` only.

### Added
- **#43 build & distribution** — `npm run build` compiles TypeScript to `dist/` (ESM with `.ts` import
  specifiers rewritten to `.js`); `bin` entries point at built JavaScript; `engines.node >= 22.18` and `.nvmrc`;
  an explicit `files` allowlist; `typebox` declared as an optional peer dependency with a README note; CI adds a
  `npm pack` + packed-CLI `--help` smoke step.
- **#44 MCP conformance** — `test/mcp.test.ts` covers the initialize/initialized lifecycle, protocol-version
  negotiation, `tools/list` (single prefix, unique names, schemas, Pi-parity), `tools/call` for all six tools,
  malformed params, tool-level errors, unknown method (-32601), invalid request (-32600), parse error (-32700),
  pre-initialize rejection (-32002), notifications-never-answered, and stdio framing (split writes, batched
  messages, CRLF, blank lines). `src/mcp.ts` enforces that contract instead of the previous ad-hoc responses.
- **#51 harness init** — `ultrasearch init` (`src/harness-registry.ts`, `src/harness-init.ts`,
  `src/config-edit.ts`) detects and patches the MCP config of Codex CLI, Claude Code, Claude Desktop,
  Cursor, Windsurf, Zed, VS Code and Antigravity, plus a documented *skip* for Pi (native extension).
  Edits are surgical textual splices over a validated document (JSON key-path editing; JSONC keeps
  comments and trailing commas; TOML table upsert/remove refuses inline `mcp_servers`), plans unless
  `--write` is passed, writes a timestamped backup first, verifies by reading the entry back and
  restores on failure, is idempotent, preserves unmanaged keys, and prints the diff plus the exact
  revert command. `--list`, `--harness`, `--remove`, `--dry-run`, `--json` included.
- **#52 harness smoke matrix** — `bench/harness-smoke.mjs` records one artifact per harness
  (`bench/harness-smoke/<id>.json`, committed): a protocol arm (initialize at the harness's revision,
  `tools/list` = the six canonical tools, one `tools/call` against a hermetic mock daemon) and a
  native arm where the harness has a non-interactive CLI (Claude Code through a recording MCP proxy —
  which measured its protocol revision at 2025-11-25 — Codex CLI in a temp `CODEX_HOME`, the Pi
  interop suite). `bench/harness-matrix.mjs` renders `docs/harness-matrix.md` and fails on a missing
  row, a failed arm, a reasonless skip or (with `--require-fresh`) stale evidence. CI runs both.
- `NOTICE` (upstream MIT attribution) and `docs/engine-rebrand.md` (migration + rollback runbook).
- `engine/rebrand.sh <src-dir> <dst-dir>` — deterministic, idempotent rebrand of an upstream engine checkout
  (LICENSE and upstream URLs are never rewritten).

### Fixed
- `npm run build` surfaced four latent type errors that `tsc` had never checked because `tsconfig.json`
  only listed ten files: `bin/cli.ts` (`recent` iterated a response object; `metrics` passed an array where a
  limit was expected) and `src/compactor.ts` (possibly-undefined `status.overlay` / `status.removed`).

---

## [0.3.1] - 2026-10-14

Honesty + reliability release driven by the full repository audit (`AUDIT-2026-10-14.md`).

### Fixed
- **CI**: daemon-dependent integration tests now skip cleanly on a bare runner and a **hermetic mock-socket latency gate** runs everywhere, so the GitHub Actions job can pass and the benchmark gate actually executes. Previously 18/18 runs failed and the gate step was unreachable.
- **Telemetry integrity**: benchmark-gate runs are isolated with `PI_ULTRASEARCH_TEST=1`; audit rows are recorded in a **single layer** (client) instead of client + tool wrapper duplicates; `ultrasearch_compact` rows no longer report the whole index as `hitCount`.
- **Recursive learning**: `recordMistake()` is invoked by real failure paths (empty results, path mismatch, DLP interception, CLI bypass) instead of only tests.
- **`.gitignore` / `.ignore` evaluation** was dead code; it is now applied to `query`, `grep`, and `multi_grep` results for the declared scope, with a 60-second per-scope cache.
- **Fallback quality**: native fallback prefers `rg` (with `grep` fallback) and the `find` max-depth cap was removed.
- **Rich results**: `ultrasearch_grep` no longer requests and discards context lines; optional `context` and `tag_symbols` parameters are exposed to Pi and MCP clients.
- **MCP registration**: registered in Antigravity (`~/.gemini/antigravity/mcp_config.json`, `~/.gemini/config/mcp_config.json`), VS Code user `mcp.json`, and Claude Desktop. Pi deliberately keeps the native extension rather than a duplicate MCP tool surface.
- Documentation: README and ROADMAP rewritten against measured evidence; `OPTIMIZATIONS.md` added; version metadata reconciled to 0.3.1.

### Added
- `mode: "semantic"` in `ultrasearch_grep` (Pi + MCP) wiring the intent-expansion module into a reachable path.
- `near` parameter on the MCP `ultrasearch_query` tool.
- Auto-compaction supervisor started/stopped with the interactive TUI lifecycle.

---

## [0.3.0] - 2026-10-13

Retroactive entry for work that shipped after 0.2.2 without a changelog update.

### Added
- Interactive observability TUI (`src/tui.ts`, `bin/tui.ts`): live metrics, audit inspector, learning store, one-key LSM compaction, FDA helper.
- LSM compaction supervisor (`src/compactor.ts`) with manual and automated modes and compaction history.
- Recursive learning store (`src/recursive-learning.ts`) with typo remappings, mistake patterns, and CLI bypass/DLP counters.
- Semantic intent expansion (`src/semantic.ts`) — concept dictionary to code-token expansion.
- Rich grep results: code context windows (`-C`), AST symbol tags, and MCP support (`src/formatter.ts`, `src/mcp.ts`).
- Daemon management: launchd `com.pi.ultrasearch` LaunchAgent with `KeepAlive`, `authorize` command, and unified `UltraSearch.app` branding for stable Full Disk Access attribution.
- Dynamic native fallback for consent-gated workspaces (Downloads/Documents/Desktop).
- CLI surface (`bin/cli.ts`): `query`, `grep`, `metrics`, `audit`, `compact`, `learnings`, `tui`.

---

## [0.2.2] - 2026-10-13

### Changed
- **License Conversion to GNU AGPLv3**: Relicensed project from MIT to the **GNU Affero General Public License v3.0 (AGPL-3.0-or-later)** to guarantee copyleft protection and close the remote network SaaS loophole (Section 13). Updated `LICENSE`, `package.json`, and `README.md`.
- **Extension & Repository Rebranding**: Formally renamed extension to `pi-ultrasearch` across all documentation, metadata, type definitions, MCP server declarations (`pi-ultrasearch-mcp`), and package repository manifests (`https://github.com/Ghost-9/pi-ultrasearch.git`).
- **Slash Commands**: Registered `/ultrasearch` command for inspecting real-time metrics, telemetry audits, and status, retaining `/ultrasearch` as backwards-compatible alias.
- **Cache Path Alignment**: Telemetry logs default to `~/.pi/agent/cache/pi-ultrasearch/audit.jsonl` with seamless migration from existing audit files.

---

## [0.2.1] - 2026-10-13

### Changed
- **Zero Typo Tolerance Enforced**: Completely eliminated all fuzzy typo forgiveness across `ultrasearch_query` and fallback search. Plain query terms are transformed into strict exact match mode (`Mode::Exact`), guaranteeing zero false positives and deterministic resolution.

### Added
- **Full Hybrid Observability System**:
  - Persistent JSONL append-only audit logger in `~/.pi/agent/cache/pi-ultrasearch/audit.jsonl`.
  - **Toolchain Shadow Detector** (`src/observer.ts`): Intercepts `bash` and `powershell` execution to flag CLI search bypasses (`find`, `rg`) where indexed search would be 12–45× faster.
  - **Diagnostic Analyzer**: Provides actionable corrective guidance on 0-hit queries (detects whether exact matches exist under different directories or advises on exact matching).
  - **Profiler Tool & Slash Command**: Registered `ultrasearch_metrics` tool and `/ultrasearch` (and `/ultrasearch`) slash command (`metrics`, `audit`, `reset`, `status`) to observe p50/p90/p95 latency and anti-patterns.

---

## [0.2.0] - 2026-10-13

### Fixed
- **Extension Tool Registration**: Fixed `pi.defineTool is not a function` runtime error by migrating to `pi.registerTool(...)` API with unified loader fallback across Pi Agent runtimes.
- **Git Worktree Isolation (#5)**: Added `resolveWorktreeRoot` using `git rev-parse --show-toplevel` to prevent search results from leaking across sibling Git worktrees.
- **Resilience Watchdog & Fail-Open Fallback (#7)**: Implemented auto-reconnecting socket watchdog with exponential backoff and seamless fallback to native `ripgrep`/`find` on daemon disconnection.

### Added
- **QuickJS WASM Code Mode Declarations (#6)**: Exported `renderUltraSearchDeclarations()` and `getUltraSearchCodemodeTools()` in `src/codemode.ts` for zero-shot single-turn agent workflows in `@earendil-works/pi-codemode`.
- **Git Status Query Filters (#8)**: Native support for `git:modified`, `git:staged`, and `git:untracked` query filters directly in `ultrasearch_query`.
- **Frecency Lifecycle Tracking (#9)**: Automated hook into `tool_execution_end` tracking file operations (`read`, `edit`, `write`, `view_file`) and forwarding touches to daemon `{"op": "open"}`.
- **Proximity Re-Ranking (#10)**: Directory-distance scoring algorithm (`near: <path>` / `near` option) prioritizing files closer in tree hierarchy to active editing context.
- **Multi-Pattern Disjunction Grep (#11)**: Registered `ultrasearch_multi_grep` for concurrent multi-symbol retrieval in a single IPC pass.
- **Dynamic Ignore Rules (#12)**: Trie-based pattern matcher in `src/sanitize.ts` evaluating `.gitignore` and `.ignore` outside git repositories.
- **Enterprise Credential Scrubbing (#13)**: Hardened regex scrubbing covering Slack tokens, Stripe live keys, AWS temporary credentials (STS), GCP API keys, fine-grained GitHub PATs, and path traversal (`../`) protection.
- **Model Context Protocol (MCP) Server (#14)**: Native stdio JSON-RPC 2.0 server in `src/mcp.ts` and executable `bin/mcp-server.ts` for universal integration with T3 Code and Antigravity.
- **Latency CI Regression Gate (#15)**: Automated test suite `test/benchmark-gate.test.ts` enforcing strict sub-10ms p95 search latency and sub-5ms p95 grep latency in GitHub Actions CI.

---

## [0.1.0] - 2026-10-13

### Added
- **Line-Buffered UNIX Socket Client (#1)**: Implemented `UltraSearchClient` in `src/client.ts` communicating with `~/Library/Application Support/UltraSearch/ultrasearch.sock`. Uses Node.js `readline` to guarantee clean message boundaries.
- **Pi Agent Tools (#2)**: Registered `ultrasearch_query`, `ultrasearch_grep`, `ultrasearch_locate`, and `ultrasearch_recent`.
- **Security Scrubbing (#3)**: Built-in credential redactor removing GitHub tokens, AWS keys, JWTs, and private keys.
- **Upstream fsearch Engine Update (#4)**: UltraSearch v0.2.1 engine update with 37% smaller index and 1.3ms live edit-to-grep sync.
