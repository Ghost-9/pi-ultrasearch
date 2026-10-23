# What this fork changes in the vendored engine

`engine/` is a **renamed fork of the upstream MIT engine** (© Noah Dunnagan,
v0.2.1 — the upstream project name, version and URL are in `engine/NOTICE`,
and `engine/LICENSE` is byte-identical to upstream, md5
`0dc34369214adc92ff6442e372cd3989`). It is vendored so engine behaviour can be
changed and tested in-tree and so the source that ships is the source that is
reviewed; `engine/rebrand.sh` regenerates it deterministically from an upstream
checkout (`engine/BUILD.md` has the two post-run fixups it needs). This is the list of behavioural changes, so a
future upstream sync can re-apply them. Naming (binary, crate, socket, env
prefix) is handled separately by `engine/rebrand.sh`.

Files: `engine/src/…`. Every change keeps upstream's behaviour when nothing
new is configured: an operator who sets no environment variable and writes no
config file sees the same searches and the same index as v0.2.1.

## Testability (no runtime effect unless the variables are set)

| Change | File | Why |
|---|---|---|
| `ULTRASEARCH_DIR` / `HOME` / `SCAN_ROOT` (one name each; the pre-rebrand spellings went with the rename) | `env.rs`, `main.rs`, `mcp.rs`, `server.rs`, `walk.rs` | Run a real daemon over a fixture tree on its own socket, without touching the live index or crawling the whole disk. `SCAN_ROOT` is canonicalized: the crawl opens the root with `O_NOFOLLOW_ANY`, which refuses a path containing a symlink (`/tmp`). |
| `Index::build(…, root)` and `Index::path(0)` return the crawl root | `index.rs` | Paths must exist on disk; before this, a fixture scan root produced `/file.txt`. |
| `Index::lookup` strips the crawl root | `index.rs` | Otherwise `lookup(home)` failed under an isolated root and the content index never built. |
| `Live::to_listings` starts at the index's own root, not `/` | `live.rs` | Otherwise a `save`/compaction folded no overlay entry under an isolated root: files added since the build were silently dropped. |
| The early index's root is `/` | `engine.rs` | `folder_listings` builds a chain from `/` down, so that is that index's root. |
| FSEvents events outside `SCAN_ROOT` are dropped; `ULTRASEARCH_DEBUG_KEEP=1` logs them | `engine.rs` | The stream watches all of `/`; without the filter, changes anywhere populated the overlay and searches answered with paths outside the index's own area. |

## Ranking

| Change | File | Why |
|---|---|---|
| Hits carry their `near` and `boost` components | `engine.rs` (`Found`), `server.rs` | **The server owns proximity ranking.** One formula (`server::nearness`), documented in code: +12 in the `near` file's folder, -3 per folder of distance, clamped at 0; the `near` file itself is -20. A client that re-ranks a daemon result double-counts the same signal on a different scale (the extension's `applyProximityRanking` used +100 and is now only used for the native `find`/`rg` fallback). |

## Budgets, early exit and the counts to judge them (#16, #35)

| Change | File | Why |
|---|---|---|
| `Progress` (deadline, candidate cap, `scanned`/`considered`, `expired`) on `Query` | `query.rs` | `budget_ms` and `candidates` bound a cold or whole-disk query. `None` unless asked for, so an ordinary search pays one predictable branch per entry and no atomics. |
| Deadline checks in `Scan::full` / `Scan::selective` and at pass/round boundaries | `query.rs` | A spent budget skips the deeper typo retry, another `spread` round, another `driven` try and the `ranked` batch loop, and stops the entry scan mid-piece. Granularity is `min(4096 entries, 1/8 piece)`, and each piece also checks at its first entry — a piece shorter than the tick would otherwise never check at all. |
| `complete` / `scanned` / `considered` / `budget_ms` in a search reply; `scanned`/`considered` added to grep's reply beside `candidates`/`read` | `server.rs` | A partial answer must say so, and the work it did must be checkable. |
| `early_exit: true` (or `low_run: N`) adds a **low-score run** stop: after `N` considered entries in a row that did not improve the k-th best, the scan stops and the reply is `complete:false` with `stopped_by:"low_run"` (`LOW_RUN_DEFAULT` = 1<<20 when `early_exit` is set) | `query.rs` (`Progress::note_candidate`), `Scan::full`/`Scan::selective`, `server.rs` | #35: a cold whole-disk path scan that keeps scoring entries below the floor has a bounded tail. Off unless asked for; the deadline/cap `stopped_by` values name the other two stops. |
| `stopped_by` in a partial search reply | `server.rs` | `deadline` / `candidates` / `low_run` — an agent can tell why the top-k is partial. |

## Concurrency (helper pool)

| Change | File | Why |
|---|---|---|
| The helper pool keeps a registry of every live `run_lanes` set and each helper serves the next set with unclaimed lanes (round-robin), instead of a single "latest search" slot | `content.rs` (`Helpers`, `Lanes::claim`, `run_lanes`) | Concurrent greps must share the pool. With one slot the helpers all served the newest search; each earlier one was left with only its caller thread (one of four to six lanes) and ran near-serially. Measured before the fix: three concurrent greps used ~3.6 cores total and took 2.1–2.3× one call whatever the lane count. `concurrent_runs_share_the_helper_pool` fails on the old code. |

**End-to-end measurement status (2026-10-15, wave 2).** The instrument is
`bench/engine-concurrency.mjs` (two daemons over one fixture, raw sockets,
counterbalanced alternating rounds, medians with bootstrap CIs, per-daemon
cores). The recorded run `bench/results/engine/concurrency-2026-10-15-degraded.json`
is **degraded/unquotable**: load1 13.0 (gate max 1.5) from unrelated processes.
In that window the baseline used 5.13 cores and the treatment 5.01 cores for the
same 3-concurrent workload (ratio-to-single 1.75 vs 1.70; paired delta 8.15 ms,
CI [−32.5, +47.2], not significant). The machine is saturated (load1 14.9,
AC power), so neither arm can win wall time; the record states exactly what was
seen and **no speedup is claimed**. On an idle machine re-run the script and require the
paired ratio CI to exclude 1 before repeating the `#18` acceptance claim. The
deterministic engine test remains the evidence that the defect existed and is
fixed.

## Index health (#19, #34)

| Change | File | Why |
|---|---|---|
| `last_event_id`, `event_lag`, `staleness_ms`, `replay_in_progress` in `status`; `stale`/`stale_ms` on answers | `engine.rs`, `server.rs` | An agent must be able to tell whether a result may miss recent changes. `staleness_ms` is 0 when the index is caught up, and the window opens at a detected drop or a relist and closes on `HISTORY_DONE`/relist completion. |
| A stream started at (or past) the newest event id is not "replaying" | `engine.rs` | FSEvents sends no `HISTORY_DONE` for a stream with no history, so the window never closed and every answer was marked stale. |
| Compaction counters in `status`; a due compaction waits up to `COMPACT_DRAIN` (2 s) for in-flight queries, ignoring the pause past `COMPACT_URGENT`; churn warning after `CHURN_WARN` size-forced compactions | `engine.rs` | A compaction rebuilds the whole index and would take the cores a search is waiting on. `compact_now` is a pure function so the policy is unit-tested. |
| The save request is read, not cleared, until the compaction runs | `engine.rs` | A postponed compaction was otherwise lost entirely: the overlay may be under `COMPACT_PENDING` and the index not stale, so nothing brought it back. |

## Security boundary (#23)

| Change | File | Why |
|---|---|---|
| Fail-closed deny-list (`ULTRASEARCH_DENY`, `ULTRASEARCH_DENY_FILE`, `<index dir>/deny.txt`), enforced before any result leaves; `withheld` reported | `deny.rs`, `server.rs` | Enterprise policy above the user's request. Rules and caller roots are normalized like indexed paths, so a rule written `/var/...` still matches the `/private/var/...` the index holds. |
| Result-bearing ops refuse a denied scope; diagnostics (`ping`, `status`, `save`) stay reachable and `status` reports `deny_configured` / `deny_rules` / `deny_error` | `server.rs` | A broken policy must be visible, and "denied" must not look like "no results". |
| A request may name its allowed boundary (`root`); an escaping scope or grep `file:` is a security error, and hits outside the root are dropped | `server.rs` | The engine is the last place a path can be stopped. |

## Content coverage (#17)

| Change | File | Why |
|---|---|---|
| `coverage.json` / `ULTRASEARCH_CONTENT_*` / `ULTRASEARCH_WARM`, applied in `Scope::file` and `in_scope`, summarized in `status.content_policy` | `coverage.rs`, `content.rs`, `engine.rs` | Coverage was a fixed heuristic with no way to see or change it, so a 0-hit grep was ambiguous. A folder above a configured root still passes `in_scope` — the traversal has to reach the root — while `Scope::file` applies the rule to each file. |
| Warm folders are queued for content at start | `engine.rs` | A freshly opened repo becomes greppable without waiting for a general reconcile. |

## What the rename changes in this tree

`engine/rebrand.sh` renames the crate, binary, data directory, socket and
user-facing strings. Concretely, for anything that talks to the daemon:

| Thing | Value in this tree |
|---|---|
| Crate / binary | `ultrasearch` (`engine/target/release/ultrasearch`) |
| Default data dir | `$HOME/Library/Application Support/UltraSearch` |
| Socket | `ultrasearch.sock` (Linux: `$XDG_RUNTIME_DIR/ultrasearch.sock`, else `~/.local/share/ultrasearch/ultrasearch.sock`) |
| Install paths | `~/.local/bin/ultrasearch-daemon`, `/Applications/UltraSearch.app/Contents/MacOS/UltraSearch` |
| LaunchAgent | `com.pi.ultrasearch` (the app bundle identifier is `com.pi.ultrasearch`; ad-hoc re-signing can still change the CDHash and invalidate Full Disk Access) |
| Environment | `ULTRASEARCH_*` only |
| MCP `serverInfo` | `ultrasearch` |

The vendored source carries no upstream token outside `NOTICE`, the upstream URL
in `README.md`, `rebrand.sh` (the mapping tool) and `LICENSE`; a source-level
test enforces that (`test/mcp.test.ts`, "the vendored daemon carries no upstream
name"), because a stray token means a path, socket, package name or data
directory the rename missed.

## Known limitations (not fixed here)

* The listening socket's accept queue is the OS default (`libc::listen` is
  never called with a larger backlog), so a burst past it — empirically ~128
  simultaneous connects — is refused rather than queued. A client pool
  (`OPTIMIZATIONS.md` A5) is the right fix on the caller's side.
* `event_lag` counts every change on the volume, not the index's own, so on a
  busy machine it is a hint, not a staleness measure. `staleness_ms` is the
  measure.
* `scanned`/`considered` are 0 for a query answered by a strategy that visits
  names rather than entries (`ranked`, `driven`); they are counts of the entry
  scan, and the reply says nothing when no budget was requested.
* The low-score run was the documented #35 deferral; `early_exit`/`low_run`
  now add that stop for the entry-scan strategies (`full`, `selective`). The
  bound-driven strategies (`ranked`, `spread`) already stop when no source can
  beat the floor and ignore it. A fired run answers with the top-k of what was
  scanned — partial by contract, `complete:false`, never a fabricated hit.
