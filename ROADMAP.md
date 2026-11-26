# Pi-UltraSearch Architecture & Roadmap

This roadmap tracks the development lifecycle of `pi-ultrasearch`. It was rewritten on **2026-10-14** after a full
repository audit (`AUDIT-2026-10-14.md`). Milestone statuses now reflect what is actually reachable in a running
session, not merely what exists in the tree.

Semantic versioning (`MAJOR.MINOR.PATCH`):
- **0.1.x** — socket client, core tool bindings (released)
- **0.2.x** — resilience, worktree scoping, rebrand, license, observability foundations (released)
- **0.3.x** — git filters, ranking, multi-grep, TUI, learner, MCP server, **hardened 0.3.6 / 0.3.7** (released)
- **0.4.x** — hardening + measured performance overhaul: parallel `batch_resolve` (`protocol 1.1`) + churn tuning (current)
- **0.5.x** — interop parity, FSEvents replay reliability, cross-platform groundwork
- **1.0.0** — production gates: deterministic multi-scope benchmark suite, hermetic CI, documented SLAs

---

## Audit reality check (2026-10-14)

The first version of this roadmap declared milestones 4–6 complete at version 0.3.0 while CI had never passed, the
MCP server was registered nowhere, `.gitignore` evaluation was dead code, and the "1 M+ file" gate tested a ~25-file
repository. The audit matrix is reproduced in `AUDIT-2026-10-14.md`; the corrective work is itemised in
`OPTIMIZATIONS.md`.

Legend: ✅ shipped & reachable · 🟡 partial / limited · ❌ not delivered at that time · 🔧 corrected in 0.3.1

---

## Current milestone status

### Milestone 1 — IPC daemon & core Pi extension (v0.1.0) — ✅ released
- [x] #1 Line-buffered UNIX socket client with correlation ids (`src/client.ts`)
- [x] #2 Core tools: `ultrasearch_query`, `ultrasearch_grep`, `ultrasearch_locate`, `ultrasearch_recent`
- [x] #3 Secret scrubbing and sensitive-file masking (`src/sanitize.ts`)
- [x] #4 Upstream v0.2.1 engine, MIT © Noah Dunnagan — **renamed fork vendored in-repo at `engine/`**
      (source that ships == source reviewed; `engine/rebrand.sh` regenerates it from an upstream checkout,
      `engine/NOTICE` holds the attribution, `engine/LICENSE` is byte-identical to upstream)

### Milestone 2 — Hardening, Code Mode, resilience (v0.2.0) — ✅ released
- [x] #5 Worktree scoping via nearest-`.git` walk (cached)
- [x] #6 Code Mode TypeScript declarations (`src/codemode.ts`) — *library only*; the harness exposes tools to the
      sandbox directly, so this module is not required at runtime
- [x] #7 Reconnect watchdog + `rg`/`find` fallback

### Milestone 3 — Git engine & ranking (v0.3.0) — ✅ released
- [x] #8 `git:` query filters (`git:modified`, `git:staged`, `git:untracked`) — verified against upstream git engine
- [x] #9 `tool_execution_end` frecency hook — implemented; end-to-end regression test still missing
- [x] #10 Proximity re-ranking (`near:`)
- [x] #11 `ultrasearch_multi_grep`

### Milestone 4 — Security & ignore rules (`0.3.6` / `0.3.7`) — ✅ **shipped**
- [x] #12 🔧 `.gitignore` / `.ignore` evaluation **wired into search & grep results** (0.3.1) with a per-scope cache;
      declared rules only — built-in defaults stay opt-in
- [x] #13 Enterprise patterns (Slack, Stripe, GCP, AWS STS) + fail-closed `deny.txt` (`12` rules, `0600`), cache pruning (`purge_content`), `root` scope containment across `search` / `grep` / `recent`, UTF-8 glob panic fix (`0.3.7`), and `coverage.json` content scoping (`152.1 MiB` → `38.9 MiB`)

### Milestone 5 — MCP & interop — 🟡 **in progress**
- [x] #14 stdio MCP server (`find_files`, `grep`, `multi_grep`) wired through Magpie Hub into Claude, Antigravity, Codex, and Pi (`tools/list` verified live)
- [x] #14b Native CLI `--version` / `-V` (`0.3.7`) and `SUN_LEN`-safe engine test harness
- [ ] #14 remaining: shared cross-harness live smoke matrix in CI

### Milestone 6 — Production CI & latency gates — 🟡 **in progress**
- [x] #15 🔧 Hermetic CI + real isolated daemon `EngineHarness` suite (`143` Rust tests, `278` TS tests, `49/49` `test:engine` incl. hermetic `frecency ranking` & `coverage` tests)
- [ ] #15 remaining: real multi-scope benchmark fixtures (repo / monorepo / home / whole disk) with medians and final SLAs in `docs/sla.md`

### SLAs and release artifacts (#33)
- [x] per-scope contracts (warm path, cold/global with `budget_ms`, content grep, explicitly unmeasured scan path),
      each with the test that enforces it, in [`docs/sla.md`](docs/sla.md); thresholds derive only from `final`
      artifacts; the release workflow (`v*` tag) attaches `bench/results/release-<tag>.json` with check results and
      reference-artifact hashes, and never claims absolute runner latency
- [ ] re-run the latency suite under a passing environment gate and promote its medians from `provisional` to
      `final` in `docs/sla.md`

---

## Completed corrective release — v0.3.1 (2026-10-14)

- CI: hermetic tests + mock-socket gate; the job can pass on a clean machine and the gate now actually executes.
- Telemetry: benchmark/gate runs isolated from production audit log; single-layer audit recording (no duplicates);
  `ultrasearch_compact` rows no longer report the whole index as hits.
- Learner: `recordMistake()` now called from real empty-result, path-mismatch, DLP and CLI-bypass paths.
- Ignore rules: `loadIgnoreRules()` is production code, applied to `query`, `grep`, and `multi_grep`.
- Semantic mode wired into `ultrasearch_grep` (Pi + MCP); context/tag options exposed to Pi tools; MCP gains `near`.
- Fallback upgraded from `grep -rn` to `rg` (with `grep` fallback) and `find` max-depth cap removed.
- Auto-compaction supervisor wired into the interactive TUI lifecycle.
- MCP registered in Antigravity / VS Code / Claude Desktop (Pi excluded by design).
- Docs: README, ROADMAP, CHANGELOG rewritten against measured evidence; `OPTIMIZATIONS.md` added.

---

## Shipped in v0.4.0 & Next: v0.5.0

Full detail, evidence and measured impact in [`OPTIMIZATIONS.md`](OPTIMIZATIONS.md) and [`CHANGELOG.md`](CHANGELOG.md).

**Completed in `v0.4.0`**
- [x] **Daemon `op: "batch_resolve"` (`protocol_version: "1.1"`)**: Parallel `rayon` multi-symbol resolution (content `grep` + filename `search` fallback under shared `budget_ms`, with per-hit `deny` + `root` censoring); live socket resolves 8 symbols in `6.15 ms` (`6,150 µs`).
- [x] **LaunchAgent churn tuning (`ULTRASEARCH_COMPACT_PENDING=150000`)**: Configured in `com.pi.ultrasearch.plist` to avoid repeated `50k` -> `100k` -> `200k` compaction backoffs during active git/build sessions (`content_pending=0`, `replay_timeouts=0`).
- [x] **End-to-end hermetic `batch_resolve` gate & conformance docs**: Added `test/engine/batch-resolve.test.mjs` (`50/50` engine suite passing) and documented `batch_resolve` in `docs/protocol.md` (`1.1`).

**Next: `v0.5.0`**
1. **Tail-latency & replay follow-up (`v0.5.0`)**: Search-side streaming/incremental FSEvents recovery tuning (`replay_timeouts`), A/B prompt-token accounting harness, and multi-scope benchmark artifacts (`docs/sla.md`).

---

## Later: v0.5.0 — interop and Code Mode

- MCP parity audit across Antigravity / VS Code / Claude Desktop / Cursor; client-specific smoke tests.
- Code Mode pipeline recipes (search → grep → read in one sandbox turn) with generated declarations.
- Result deduplication across linked worktrees and multi-root scopes.
- Query history, suggestions, and per-tool token budgets.

## v1.0.0 — production gates

- Deterministic benchmark suite committed as JSON results, run on every release.
- Documented SLAs per scope (warm path, cold path, content grep) with alert thresholds.
- Cross-platform support for at least macOS + Linux, with the daemon packaged and verifiable.
