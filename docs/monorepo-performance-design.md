# Monorepo performance design — beating native `rg`/`find` decisively

Status: design · 2026-10-15 · owner: engine wave · evidence: `bench/verification/`, `bench/results/`

## Where we are (measured, not assumed)

| Scope | Operation | UltraSearch | Native | Ratio (95% CI) |
|:--|:--|--:|--:|:--|
| repo | path search | 0.766 ms | `rg --files` 7.19 ms | **9.4×** |
| repo | grep | 1.83 ms | `rg -l` 8.20 ms | **4.5×** |
| monorepo (2,081 files) | grep | 23.0 ms | `rg -l` 28.5 ms | **1.24× [1.20, 1.27]** |
| home (4,504 files) | grep | 52.1 ms | `rg -l` 51.6 ms | 0.99× [0.95, 1.02] — tie |

Reading: path search is already decisively faster. Content grep wins only while the candidate set is
small and the content index is warm; at home scale the daemon is reading and verifying roughly what
`rg` would read, so the ratio collapses to parity. The bottleneck is **candidate selection and bytes
read**, not the daemon or the socket.

## Target

| Scope | Operation | Today | Target | Evidence required |
|:--|:--|--:|--:|:--|
| 100 k-file monorepo, warm | grep p50 | ~1.2× rg | **≥ 5×** | alternating A/B, n≥30, BCa CI excluding 0, output equivalence |
| 100 k-file monorepo, warm | grep p95 | — | **≤ 5 ms** | same |
| 100 k-file monorepo | path p95 | — | **≤ 3 ms** | same |
| Cold index (first grep after edit) | edit → greppable | ~1.3 s (upstream v0.2.1) | **≤ 50 ms** | journal + FSEvents test |
| Any scope | bytes read / query | 78–81 reads (measured on the clean corpus) | **≤ 10 candidate files** | daemon read counter |

## Architecture

### 1 · Per-repo shards, not one whole-disk index

A shard is self-contained: name trie, trigram postings, symbol column, content cache, and a header
carrying `{repo generation, git HEAD, mtime epoch, build watermark}`. A monorepo query never touches
another repo's postings; a whole-disk query fans out across shards and merges. This removes the
contention that currently makes a home-scale grep behave like a cold scan.

### 2 · Postings as compressed integer sets

- Doc ids are integers; paths live in an FST dictionary (prefix-compressed, mmap'd).
- Per-trigram postings are **roaring bitmaps**, block-compressed, memory-mapped.
- **Per-directory bloomers** (3-bit per trigram, one per 256 docs) let the planner skip whole
  directories before touching postings.
- A query's literal runs are intersected in increasing-cardinality order; the final candidate count
  is known before any file is read — the planner can therefore refuse an unbounded scan and route to
  a budgeted partial answer instead.

### 3 · Query planner

1. Parse the query into literal runs and regex segments.
2. Literals: trigram AND → postings → candidate doc ids. Regex: extract the longest literal prefix,
   use it for candidates, verify the rest with a lazy DFA (`regex-automata`).
3. Rank candidate buckets by expected hit density (`defines`, symbol hits, path proximity, frecency)
   before reading, so a `limit` query reads only the most promising files.
4. Stop when the top-k heap is provably safe (no unread bucket can beat the k-th score) — this is
   the #35 early-exit generalised to the content path.

### 4 · Cold-data-avoiding verify

- Candidates are read through a **content-addressed block cache** (blake3 id, ZSTD blocks, LRU with a
  per-repo memory budget); recently edited files are `MADV_WILLNEED`-ed after the journal append.
- Verify with SIMD literal search (memchr/teddy-class) over 64 KB blocks; never load a whole file for
  a literal that fails block 0.
- Byte counters per query are exposed in `meta` so “reads ≤ 10” is testable, not aspirational.

### 5 · Incremental updates

- FSEvents appends to a journal with `{path, mtime, size, hash?}`; grep freshness is derived from the
  journal watermark rather than a full reindex (staleness already reported — #19).
- Postings are updated by appending to a delta segment; background compaction merges segments while
  pausing under in-flight queries (already implemented — #34).
- Target: a save makes a file grep-visible within 50 ms for files under 1 MB; larger files stream.

### 6 · Symbol column (already first-class)

Tree-sitter spans + `def` score stay in the index; ranking is `defines → matches → source over prose`
(the Wave-3 fix). A structure-aware mode can additionally answer “declaration + N lines” without
reading beyond the block containing the declaration.

### 7 · Parallelism with a query budget

- A rayon pool sized to performance cores; work-stealing across candidate blocks.
- One helper-pool registry for concurrent queries (fixed in Wave 2) plus a per-query lane budget, so
  three parallel greps share cores instead of serialising (the #18 defect) or starving each other.
- Reject more than N concurrent full-content queries with a clear `busy` status rather than queueing
  unboundedly.

### 8 · Hybrid recall without breaking the pinned lanes

Path mode stays exact (RS01). A separate `mode: "auto"` may, only when a plain-token path query
returns nothing and a cheap evidence test passes, consult content candidates and label them
`[content]`. This is additive: the path lane's invariant test must still pass unchanged.

## Benchmarks that prove it

- Fixtures: 10 k / 100 k / 1 M files, generated; plus a real monorepo.
- Alternating A/B against `rg -l`, `rg -uu`, `find`; report p50/p95/p99, CPU time, bytes read, peak
  RSS, and equivalence diff; n ≥ 30, BCa CI; commit JSON per run.
- A regression gate on the 100 k fixture (hermetic), and a nightly/non-blocking large-fixture run.
- Every claim in the README must cite one of these artifacts.

## Phases

| Phase | Work | Effort | Gate |
|:--|:--|:--|:--|
| 1 | Postings + bloomers + planner (integer doc ids, FST paths) | M | 100 k grep p50 ≥ 2× rg, bytes read ≤ 25 |
| 2 | Block cache + verify SIMD + read counters | M | 100 k grep p50 ≥ 3× rg, bytes ≤ 15 |
| 3 | Journal + delta segments + 50 ms edit-to-grep | M | edit→grep ≤ 50 ms, staleness correct |
| 4 | Budgeted parallelism + top-k stopping | S | p95 ≤ 5 ms; 3 concurrent queries ≈ max(t) |
| 5 | Auto-hybrid mode | S | path-lane RS01 test unchanged; recall@10 ↑ on the audited set |
| 6 | Linux io_uring + shard distribution (#32) | L | Linux daemon compiles and passes the gate |

## Security and resource posture

- **Local-only by construction**: the daemon binds a UNIX socket, never a network port; no cloud
  dependency, no telemetry egress. The only external process is `rg`/`find` in the fallback path.
- **Least privilege**: Full Disk Access is granted only to the daemon app bundle; the client processes
  need no special permission. The default ad-hoc signature can lose its grant after a re-sign, so the
  optional persistent Keychain identity and guarded-path check are documented in `docs/engine-rebrand.md`.
- **Secrets pre-prompt**: DLP scrubbing, fail-closed deny-lists and scope containment stay in the
  engine so every surface inherits them; audit rows are local and redacted.
- **Resource bounds as a control**: per-query budgets, a candidate cap, a memory budget for the block
  cache and an index size cap make denial-of-service from a pathological query a bounded condition
  rather than a machine-wide event. Exceeding a bound returns `complete:false` with counters, never a
  silent stall.

## Risks

| Risk | Mitigation |
|:--|:--|
| Index staleness after mass edits | journal watermark + `staleness_ms` + replay status; queries can state their freshness |
| Memory growth (postings + cache) | block compression, LRU budget, per-shard caps, `index_bytes` in status |
| Correctness drift from optimisation | equivalence gates on every benchmark run; top-k equivalence tests |
| Planner regressions on exotic regex | fall back to the scan path with a documented reason; budget applies either way |
| Complexity | each phase ships behind a gate with a measurable target; a phase that fails its gate is reverted, not carried |
