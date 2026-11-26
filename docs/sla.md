# Latency SLAs and release artifacts (issue #33)

Owner: platform/quality-gates wave. Every threshold here is either enforced by a
test that runs in CI (`npm run test:gate`, `npm run test:engine`) or explicitly
marked **unmeasured**. No number in this document is sourced from an artifact
whose `status` is `provisional` or `degraded`; those are quoted only in the
"reference measurements" table with their status intact, as history.

## 1. What is promised

| # | Scope | Path | Contract | Where it is enforced |
|:--|:---|:---|:---|:---|
| S1 | Warm index search / grep, index-resident (`source:"index"`) | client search/grep | **client p50 ≤ raw daemon p50 + 3 ms**, **client p95 ≤ max(12 ms, raw p95 × 2 + 1)** — the raw leg is measured on the same daemon in the same run, so the SLA is relative to the machine, not an absolute ms promise | `npm run test:gate` (live tests; `gateDecision` unit-tested) |
| S2 | Cold / whole-disk path query with `budget_ms` | `ultrasearch_query` | answer within the budget plus the client slack (**budget + 400 ms**); a partial answer carries `complete:false` | `test/engine/topk-equivalence.test.mjs`, `engine/src/query.rs` tests |
| S3 | Content grep in the index, with `budget_ms` | `ultrasearch_grep` (default budget 2500 ms) | answer within the budget + slack; `complete:false` when the budget expires; the tail is bounded by the budget | `test/benchmark-gate.test.ts`, engine tests |
| S4 | Content grep outside the content index (`source:"scan"`) | `ultrasearch_grep` | **no SLA** — a scan reads files directly and depends on the disk; the source is reported so a caller can tell | — (reported, not promised) |
| S5 | Correctness alongside every latency claim | all | the top-k of an unbounded query is exact; an out-of-reach `early_exit`/`low_run` is output-identical; a fired one is `complete:false` and never invents hits | `test/engine/topk-equivalence.test.mjs` |

A cold or replaying index (`status.replay_in_progress`, `staleness_ms > 0`,
`uptime_ms < 30 s`) may excuse **S1's absolute ceiling only**, up to a hard cap of
`raw p95 × 4 + 10 ms`; the client-overhead assertion runs unconditionally. See
`docs/decisions/0012-live-gate-floor.md`.

## 2. Reference measurements (this machine, labelled)

| Measurement | Value | Artifact | Status |
|:---|:---|:---|:---|
| Raw daemon socket, grep `UltraSearchClient` | p50 7.17 ms, p95 7.65 ms | `bench/verification/after/checks-gate-floor.json` | **final** (n=60, load1 3.26 recorded; daemon block: 3,879,170 entries, 145,652 content docs) |
| Client leg, same call | p50 7.88 ms, p95 8.59 ms | same | final (client overhead p50 0.71 ms) |
| Equivalence (30 queries) | frozen set diffs | `bench/verification/after/equivalence-golden.json` | **final** |
| Token output (10 tasks) | frozen per-task chars | `bench/verification/after/tokens-baseline.json` | **final** |
| Zero-result / fallback | absent 1.0, present 0.0, 0 fallbacks | `bench/verification/after/zeroresult-baseline.json` | **final** |
| Full latency suite (n=30, all scopes) | medians per scope | `bench/verification/after/latency-2026-10-15.json` | **provisional** — load1 4.9–13.9 during the run; **not an SLA basis** |
| Judgment scoring | recall@10 0.674, nDCG@10 0.705 | `bench/verification/after/judgments-baseline.json` | **provisional / needs re-run** (verifier F10) |
| v0.5.0 multi-scope A/B (`small`/`monorepo`/`home`, n=30 each) | `home-path-exact` p50 `5.59 ms` vs `12.89 ms` find (`2.31x`); `100%` equivalent (`0.0%` miss across all 9 cells) | `bench/results/scopes-2026-11-26-degraded.json` (gitignored) | **degraded** — Battery Power, `load1m 4.401`; **not an SLA basis** |
| v0.5.0 prompt-token A/B (`6` tasks × `5` pairs) | grep tasks `85.3%` / `86.0%` / `93.9%` smaller (`975t`/`604t`/`1388t` vs `6646t`/`4308t`/`22934t`); header overhead on 1-hit locate | `bench/results/TOKENS.md` | **degraded** — Battery Power, `load1m 4.401`; **not an SLA basis** |

The rendered README/ROADMAP summary numbers stay sourced from the final artifacts
above. When the latency suite is re-run under a passing gate, its medians may be
added to this table as `final`; until then it stays provisional on purpose.

## 3. Measurement method

1. **Verifier-owned harness** (`bench/baseline/*.mjs`, `bench/verification/**`):
   the author of a change does not produce the number that certifies it
   (`docs/decisions/0007-verifier-owned-harness.md`).
2. **Environment gate**: AC power, 1-minute load < 1.5, no `cargo`/`rustc`
   (`VERIFICATION-PROTOCOL.md` §2). Artifacts carry `meta.status`; only a full
   suite run with a passing gate is `final`.
3. **Statistics**: median over mean; seeded percentile-bootstrap 95% CI of the
   median; latency claims n ≥ 30; performance deltas are paired (alternating
   A/B) and must clear a decision floor, not just the CI.
4. **Output equivalence** alongside speed: a latency win with a changed result
   set is not a win.
5. **The gate formula** (S1) is `ceiling = max(12 ms, rawP95 × 2 + 1)` with an
   unconditional `clientP50 − rawP50 < 3 ms`; `gateDecision()` is pure and
   unit-tested so the rule is reviewable and a cold window cannot mask a
   regression.
6. **Daemon churn**: every measurement records the daemon block
   (pid, entries, event_id). No daemon rebuild/reinstall while a measurement
   window is open; see `docs/daemon-single-instance.md`.

## 4. Release artifacts

`.github/workflows/release.yml` runs on a `v*` tag and attaches
`bench/results/release-<tag>.json` plus the npm tarball to the GitHub release.
The JSON contains:

* the exact commit, dirty flag, package version and runner platform;
* each check that ran (`npm test`, `cargo test --release`,
  `npm run test:engine`, `npm run test:gate`) with its exit status and duration;
* the SHA-256 of every frozen reference measurement, with that artifact's own
  `status` copied **verbatim** (`bench/release-artifact.mjs` never upgrades a
  status).

It deliberately does **not** contain absolute latency numbers: a hosted runner
is not the reference machine. A release that claims ms figures must cite a
`final` artifact from the reference machine.

## 5. Revision policy

Nothing here is promised on hardware that has not been measured. A threshold
change requires: the measured floor it is derived from, the margin chosen, and
the reason, appended to `docs/decisions/` (supersede, do not rewrite). The
hermetic mock gate (p95 < 10 ms search, < 5 ms grep) is absolute and stays
strict because its service time is fixed.
