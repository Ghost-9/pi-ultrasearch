# Session evaluation — 2026-10-20

What agents on this machine actually ran, what UltraSearch would have covered, and what the
counterfactual replay measured. Aggregates only; no commands or paths are retained.

## Sources

| Agent | Session files | Search calls | Tool-output tokens | Median | p95 |
|:--|--:|--:|--:|--:|--:|
| Pi | 462 | 6,721 | 2,564,262 | 181 ms | 43.8 s |
| Codex | 38 | 245 | 336,942 | 226 ms | 6.2 s |
| Claude Code | 45 | 0 | 0 | — | — |
| OpenCode | — | — | — | — | — |

Claude Code's 45 files contain title/attachment turns with no tool calls. OpenCode's database is
excluded by the local safety policy (sensitive path) and was not read. Pi's `fabric_exec` (19,346
calls) is a code wrapper; embedded searches were not decomposed, so the native volume is a lower
bound. Counts use the documented 4-characters-per-token estimator.

## Where the output goes

| Class | Pi tokens | Codex tokens | Combined share |
|:--|--:|--:|--:|
| missing scope (old paths) | 861,006 | 155,511 | 35.0 % |
| file-scoped grep | 454,816 | 32,951 | 16.8 % |
| unknown shape (complex/pipes) | 368,149 | 56,997 | 14.7 % |
| external/pipeline (curl, strings) | 360,651 | 4,361 | 12.6 % |
| path search (`find`, `rg --files`) | 268,300 | 1,645 | 9.3 % |
| dir grep, filtered (`--include`, globs) | 170,408 | 33,758 | 7.0 % |
| dir grep, simple | 68,648 | 49,522 | 4.1 % |
| cwd default | 12,284 | 2,197 | 0.5 % |

**Addressable** (directory/path searches) is 606,762 of 2,901,204 tokens — **20.9 %**. File-scoped
greps (16.8 %) are not supported by the client today; that is upstream PR #34.

## Replay

The 60 dir-scoped commands with the largest native output were replayed: the native shell command and
an UltraSearch `grep` on the same scope, same machine.

| Measure | Result |
|:--|--:|
| commands measured | 48 |
| both returned output | 27 |
| UltraSearch returned nothing where native did | 41.7 % |
| token ratio where both returned | **1.48× [0.745, 1.95]** (BCa) |
| UltraSearch output larger | 11 / 27 |
| native median / client median | 33.0 ms / 1.35 ms |

The token interval includes 1: **this replay does not show a token win** on arbitrary session
queries. The latency difference is large but the native side includes process/shell overhead while
the client side is in-process, so it is not a clean end-to-end speedup claim. The high miss rate is
the more important result: regex lookarounds, file scopes, and shaped pipelines are common and not
served by the current tool.

## Adoption

- **13 UltraSearch calls in 6 of 462 Pi sessions** (0.19 % of 6,721 searches), 2,273 tokens, 47 ms median.
- 0 calls in Codex and Claude Code.
- The audit log has 672 rows, but most are CLI/dev runs (`harness: none`); its 2.35 M `tokensSaved`
  is the legacy `150 + 75×hits` formula, not a measurement.

## What this means

1. The 75.5 % token saving measured on crafted paired tasks does **not** transfer to real session
   traffic. A conservative bound on addressable tokens is ~0.1–0.2 M (≈4–7 % of native search
   output), with a CI that includes zero.
2. The product's demonstrated advantage is latency on indexed scopes and path search, not output
   compression on arbitrary greps.
3. To be usable "everywhere", it needs file scopes (PR #34), regex parity or a real-rg fallback, and
   harness adoption. Without those, 42 % of real queries are out of reach or return nothing.

## Upstream

`noahdunnagan/fsearch` is dormant: `origin/main` is `v0.2.1` (`88e63fd`, 2026-10-12, 2,147 stars),
0 commits since the tag. PR #33 (FSEvents re-base recovery, 15 lines) is ported in `b71b710`.
PR #34 (file-scoped grep, 304 lines, 5 files) is the next port.
