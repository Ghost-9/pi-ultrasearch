# pi-ultrasearch

> Whole-disk filesystem search, trigram content grep, and git-aware code discovery for **Pi Agent**, **T3 Code**, and MCP clients — backed by a persistent resident Rust daemon (`ultrasearch`).

[![Version](https://img.shields.io/badge/version-0.3.5-blue.svg)](CHANGELOG.md)
[![License: AGPL 3.0](https://img.shields.io/badge/License-AGPL%203.0-purple.svg)](LICENSE)
[![CI](https://github.com/Ghost-9/pi-ultrasearch/actions/workflows/ci.yml/badge.svg)](https://github.com/Ghost-9/pi-ultrasearch/actions/workflows/ci.yml)
[![Platform: macOS Apple Silicon](https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-black.svg)]()

> **Honesty note.** Earlier versions of this README quoted best-case warm-cache micro-benchmarks as if they were
> session-level numbers, and claimed a green CI that never existed. Every figure below is now labelled with its
> measurement scope, and the full audit (`AUDIT-2026-10-14.md`) lists what was inflated and what changed.
> Live performance, limits and open gaps are documented rather than omitted.

---

## Versions

Two artifacts version independently, and that is deliberate:

| Artifact | Where | Current |
|---|---|---|
| **Engine + app** | `engine/Cargo.toml` — the daemon, the CLI and the MCP server | `0.2.1` |
| **Pi extension** | `package.json` — the native tool surface Pi loads | `0.3.3` |

`install.sh` reads the engine version from `Cargo.toml` and writes it into both
`CFBundleShortVersionString` and `CFBundleVersion`, so the app bundle, the crate
and the MCP `serverInfo` always agree. The extension is a separate npm package
with its own release line; `init --list` reports it as `extension` rather than
`no`, because Pi takes the tools natively instead of through an MCP entry.

## What it is

Agents lose time and context to `find`, `rg`, and `grep -rn` subprocesses. `pi-ultrasearch` keeps a resident index
of the filesystem (paths + trigram content) and answers those questions over a UNIX socket in **0.03–0.5 ms** while
staying inside the workspace boundary.

It ships as:

- a **Pi Agent extension** (6 tools + metrics tool + `/ultrasearch` commands),
- a **standalone CLI** (`ultrasearch query|grep|metrics|tui|compact`),
- a **stdio MCP server** for Antigravity, VS Code, Claude Desktop, and any MCP client,
- **QuickJS Code Mode** compatible tools (the Pi harness exposes registered tools to the sandbox).

### Naming and sockets

Everything user-facing is UltraSearch-only: the tools are `ultrasearch_query`, `ultrasearch_grep`,
`ultrasearch_multi_grep`, `ultrasearch_locate`, `ultrasearch_recent`, `ultrasearch_metrics`; the slash command is
`/ultrasearch`; the CLI is `ultrasearch` / `ultrasearch-tui` / `ultrasearch-mcp`. No `fsearch_*` alias is registered
on any surface. Remaining `fsearch` references are upstream attribution, legacy socket compatibility, or historical
audit records; the upstream MIT notice is preserved in `NOTICE`.

| Platform | Default daemon socket |
|:---|:---|
| macOS | `~/Library/Application Support/UltraSearch/ultrasearch.sock` |
| Linux | `$XDG_RUNTIME_DIR/ultrasearch.sock`, else `~/.local/share/ultrasearch/ultrasearch.sock` |
| Windows | `\\.\pipe\ultrasearch` |

Client and harness settings use the `PI_ULTRASEARCH_*` prefix. The Rust daemon also accepts `ULTRASEARCH_*`
variables for its index, scan root and content policy (see [`engine/BUILD.md`](engine/BUILD.md)).

---

## Measured performance (live, 2026-10-14, Apple Silicon)

### Warm socket micro-benchmarks (resident daemon, repeated calls)

> **Scope matters more than the machine here.** The figures below are from 2026-10-14 and are
> labelled by the scope they were taken against; "small repo" is a few thousand files. The
> deployment these were re-checked on (2026-11-17, same M1 Pro) indexes the whole disk:
> **930,961 entries and 81,321 content documents.** These are figures for a **compacted** index:
> a daemon keeps new and changed paths in an overlay until it reaches the compaction bar
> (50,000 entries by default, `ULTRASEARCH_COMPACT_PENDING`), so a long-running daemon answers
> slower than this. Measured on the live daemon 126 minutes after a restart, with a 43,745-entry
> overlay and nothing else of mine running: path search `soak.py` p50 **3.57 ms**, `README`
> **15.25 ms**, `status` **0.64 ms** - a few milliseconds rather than a few tenths, and still
> single-digit for the common case. Measured there, one warm connection, no
> concurrency: IPC ping p50 **0.423 ms** / p95 2.56 ms over 100 calls; path search `soak.py`
> p50 **0.40 ms** / p95 1.55 ms; path search `README` (very many matches) p50 **3.22 ms** /
> p95 21.6 ms; trigram grep `fn main` p50 **4.23 ms** / p95 15.7 ms. Still single-digit
> milliseconds against 930k paths, but an order of magnitude above the small-scope numbers
> below - which is the difference between the corpus sizes, not a regression.

| Operation | p50 | p95 | Notes |
|:---|:---:|:---:|:---|
| IPC ping | 0.031 ms | 0.112 ms | pure round-trip, 100 calls |
| Path search — small repo | 0.365 ms | 1.106 ms | 50 calls |
| Path search — Swift app repo | 0.475 ms | 1.141 ms | 20 calls |
| Trigram grep — small repo | 0.153 ms | 0.297 ms | 20 calls |
| Trigram grep — trigram-heavy scope | 0.480 ms | 0.784 ms | 50 calls |
| Multi-pattern grep | 1.842 ms | 5.886 ms | 10 calls, small scope |
| `git:modified` filter | 0.837 ms | 6.033 ms | 10 calls, clean tree |

Baseline comparison on the same scope (medians): **`find -name` 21.4 ms (45× slower)**, **`rg -l` 11.9 ms (78× slower)**,
`find` in a small repo 34.7 ms (95× slower).

### Real agent-session telemetry (production audit log, 38 organic calls)

| Tool | Calls | p50 | p95 | Max | Notes |
|:---|:---:|:---:|:---:|:---:|:---|
| `ultrasearch_query` | 13 | **41 ms** | **1,952 ms** | 4,007 ms | cold/global queries are the tail |
| `ultrasearch_grep` | 16 | 13.4 ms | 26.9 ms | 26.9 ms | |
| `ultrasearch_multi_grep` | 5 | 47.0 ms | 63.3 ms | 63.3 ms | |
| native fallback | 11/38 (29%) | — | — | — | daemon not used; being reduced |

**Read both tables together.** The warm path is genuinely sub-millisecond; a cold or whole-disk query can take
seconds. Tail latency and fallback rate are tracked as open work items (see `OPTIMIZATIONS.md`).

Planned performance work (tail latency, content coverage, concurrency, token accounting) is listed in
[`OPTIMIZATIONS.md`](OPTIMIZATIONS.md). The audit that produced these numbers is in [`AUDIT-2026-10-14.md`](AUDIT-2026-10-14.md).

---

## Tool surface

**Three** MCP tools. These are the whole surface: a host that namespaces its servers prefixes
them (this machine's Magpie exposes `ultrasearch__find_files`), but the names inside the
server carry no `ultrasearch_` prefix.

An earlier version of this section documented six tools, including `ultrasearch_locate` and
`ultrasearch_metrics`, and called the first one `ultrasearch_query`. None of that was true of
the shipped server, so a reader who followed it would look for tools that do not exist. The
list below was taken from the running server's own `tools/list`.

### 1. `find_files`
Find files by name: fuzzy and typo-tolerant, over the whole path. All words must match.
Inline filters: `*.rs`, `src/`, `src/**/*.rs`, `!test/`, `git:modified`. A lone `name/` finds
folders; an empty query lists files changed in git, then those worked on lately.

| argument | meaning |
|---|---|
| `query` (required) | name words and filters, e.g. `config *.ts !test/` |
| `path` | folder to search: relative to the project, absolute, or `/` |
| `maxResults` | default 20 |
| `cursor` | from the previous result, for the next page |

### 2. `grep`
Indexed content search. Give a bare identifier or literal text from one line, not code
syntax; a regex is detected (`\b`, `.*`, `a|b`, `[a-z]`) or forced with `regex`. Smart case.
Prefix filters (`*.rs`, `src/`, `!test/`) or a file name to search one file. Definitions come
first, with their first lines.

| argument | meaning |
|---|---|
| `query` (required) | filters, then the text, e.g. `*.rs fn parse` |
| `regex` | treat the text as a regex (default: detected) |
| `path`, `maxResults`, `context`, `cursor` | as above; `context` is lines around each match |
| `output_mode` | `content` (default), `files_with_matches`, `count` |

The socket answer carries `content_max_file_bytes`, and it matters: the content index
skips files larger than that (1 MiB unless a coverage policy raises it). Measured: a
1,400,022-byte `.txt` containing a unique marker returned `files: []` with `complete: true`
— exactly what a genuine absence looks like — while the same marker in a 23-byte file was
found. So `complete: true` means "I finished searching what I index", not "this text is not
on disk". For a whole-disk answer, narrow the search or use the name index.

The socket answer also carries `complete`. It is honest: a search stopped by its time budget
returns `complete: false` with whatever it found, which is **not** the same as "no match".
A pattern that genuinely does not occur returns `complete: true`, zero files, and a tiny
`considered` count.

### 3. `multi_grep`
Multi-pattern OR retrieval in one call, with per-file match merging. Patterns are literal:
never escape them.

| argument | meaning |
|---|---|
| `patterns` (required) | literal patterns, any of which may match |
| `constraints` | file filters, e.g. `*.{ts,tsx} !test/` |
| `path`, `maxResults`, `context`, `output_mode`, `cursor` | as for `grep` |

### Not MCP tools
The daemon also answers `recent`, `status`, `ping`, `glob`, `git`, `open` and `save` on its
socket. `recent` is real (frecency, updated through the host's `tool_execution_end` hook) and
the telemetry counters are real, but neither is exposed as a tool.

The previously documented `semantic` grep mode is not in the shipped schemas either. Its
measured behaviour is kept in *Known limits* for the record; it is not reachable, so do not
plan around it.

---

## Observability

- **Audit log**: `~/.pi/agent/cache/pi-ultrasearch/audit.jsonl` — written by a **single layer** (the client),
  with test/benchmark runs isolated via `PI_ULTRASEARCH_TEST=1`. The regression gate no longer pollutes production data.
- **CLI-bypass detector**: flags `find`/`rg` subprocesses that could have used the index and feeds the recursive learner.
- **Recursive learner**: `recordMistake()` is now invoked by real failure paths (empty results, path mismatches,
  DLP interceptions, CLI bypasses), not just tests.
- **"Tokens saved" is an estimate**, computed as `150 + 75 × hits` for grep and `100 + 30 × hits` for path searches.
  It is not a prompt-token measurement; an A/B token-accounting harness is on the roadmap.
- **`status` answers "where did the index go"**, not just "how big is it": `entries_by_root` (entries per
  top-level folder, largest first), `excluded_names` (the directory names the walk actually prunes), and
  `scan_root` plus `scan_root_source` so a whole-disk fallback is visible instead of inferred from the entry
  count. Before these, an index of ~790k entries gave no way to see what was taking the space.
- **`status.content_policy.effective`** reports the content-index rules actually in force — the size cap, the
  indexed extensions, the skipped directory names and the generated-artefact exclusions — with a note on what a
  zero-hit grep does and does not mean. On a default install nothing is configured, so this block used to be
  `null` everywhere, which was useless at exactly the moment it mattered.
- **`event_lag` is not a backlog.** It is `fsevents::current_id() - index.event_id`: the
  live system-wide event counter minus the id stamped when the index was last *written*. Three
  things follow, and all three matter when reading `status`:
  - it grows on an idle daemon, because nothing writes the index when nothing changes.
    Measured on an isolated daemon with 21 entries and no churn: `event_id` never moved and
    `event_lag` climbed 4,817 → 63,064 in 60 seconds against an untouched index.
  - it is not comparable between machines; a busier system advances the counter faster.
  - a large value does **not** mean the daemon is behind. A daemon on a quiet tree can report
    six figures while having processed everything it was given.

  What it is genuinely good for: noticing that the index has not been written in a long time.
  For "is the follower losing to the event stream", measure what matters — whether a file
  created now is findable a few seconds later. The soak used to fail on this number and
  reported a wedge that was not there; it now reports the system-wide event rate alongside,
  which is what distinguishes the two.
- **Every command takes `--json`.** `status` and search always did; `bench`, `install` and `uninstall` used to
  print prose and now emit machine-readable output, so a script no longer has to scrape.

---

## MCP server

`bin/mcp-server.ts` speaks JSON-RPC 2.0 over stdio and exposes exactly one tool surface: the six
`ultrasearch_*` tools. The historical `fsearch_*` aliases are gone, so `tools/list` is the single
source of truth for every client. Protocol conformance (initialize/initialized, tools/list, tools/call,
notification semantics, unknown method, parse error, JSON-RPC error codes, stdio framing) is covered by
`test/mcp.test.ts` and runs hermetically without a daemon.

Registration is not hand-editing: `ultrasearch init` detects the harnesses on the machine and patches
their config with a timestamped backup, a printed diff and the exact revert command. It plans by
default and writes only with `--write`:

```bash
ultrasearch init --list                        # registry + what is detected/registered here
ultrasearch init --harness cursor              # show the diff, write nothing
ultrasearch init --harness cursor --write      # patch, with a backup and revert command
ultrasearch init --harness codex --remove --write
```

| Harness | Surface | Config |
|:---|:---|:---|
| Pi Agent | **native extension** (init skips it by default) | `~/.pi/agent/mcp.json` |
| T3 Code | inherits the Pi provider; CLI otherwise | — |
| Codex CLI | MCP | `~/.codex/config.toml` `[mcp_servers]` |
| Claude Code | MCP | `~/.claude.json` `mcpServers` |
| Claude Desktop | MCP | `claude_desktop_config.json` |
| Cursor | MCP | `~/.cursor/mcp.json` |
| Windsurf | MCP | `~/.codeium/windsurf/mcp_config.json` |
| Zed | MCP | `~/.config/zed/settings.json` `context_servers` (JSONC preserved) |
| VS Code | MCP | user `mcp.json` `servers` |
| Antigravity | MCP | `~/.gemini/antigravity/mcp_config.json` |

Each row carries a smoke artifact under `bench/harness-smoke/` (initialize + `tools/list` + one
`tools/call`, plus a native harness CLI arm where one exists) and the generated
[`docs/harness-matrix.md`](docs/harness-matrix.md) states exactly which arms ran and which are
explicitly `skipped:<reason>`. `npm run smoke:harness && npm run matrix:harness` regenerates both;
CI runs the smokes and fails on a missing or dishonest row.

Example MCP config entry:

```json
{
  "mcpServers": {
    "ultrasearch": {
      "command": "node",
      "args": ["/Users/your-name/.pi/agent/extensions/pi-ultrasearch/dist/bin/mcp-server.js"]
    }
  }
}
```

`npm run build` emits that entrypoint (see *Build & distribution*); `bin/mcp-server.ts` also works directly on
Node.js ≥ 22.18 through native TypeScript type-stripping. `ultrasearch init` resolves the command itself:
`--command`, `ULTRASEARCH_MCP_COMMAND`, `~/.local/bin/ultrasearch-mcp`, then `PATH`.

---

## Drop-in `us-rg` (ripgrep stays the fallback)

`scripts/us-rg` is a conservative ripgrep front-end. It accelerates exactly one case — a plain
literal content search over a directory or one named file — and sends **everything else** to the
real ripgrep unchanged: `--files`, `-l`, `-c`, `--json`, globs, types, context, regex, PCRE2. It
never shadows `rg`; install it under its own name:

```bash
ln -sf "$PWD/scripts/us-rg" ~/.local/bin/us-rg
us-rg "needle" src/                 # accelerated, ripgrep-compatible output
us-rg "needle" package-lock.json    # reads the named file even if the index skipped its text
us-rg --files src/                  # real ripgrep (correct semantics, still fast)
us-rg "a.*b" src/                   # regex → real ripgrep
```

Exit status follows ripgrep (`0` matches, `1` none, `2` fallback/error). Ripgrep must be installed;
`ULTRASEARCH_RG` overrides the binary path. A failed socket falls back to ripgrep, never to a silent
empty result.

## Interop & ergonomics (v0.5.0)

### Watch mode (#27)

```bash
ultrasearch watch "<query>" --in <dir> [--limit n] [--debounce ms] [--duration ms] [--once] [--json]
```

Streams the baseline matches, then one `add`/`remove` event per file as the directory changes. The watch loop does
not duplicate the daemon's journal: `fs.watch` supplies the change signal, `status` is consulted first so an event is
not answered while the index is behind, and the query itself reuses the normal socket path. A **silence watchdog**
polls the query when `fs.watch` has delivered nothing for `watchSilenceMs` (default 750 ms, period
`pollIntervalMs` 1000 ms), so a late or dropped FSEvents notification degrades to polling instead of silence; a
healthy watcher keeps the watchdog idle. `stop()` (or Ctrl-C) closes the watcher, removes signal handlers, stops
the watchdog and closes the client, so no socket or inode is held after exit. `--once` prints the baseline and exits
(used by the tests and by scripting). Events carry `via: "watch" | "poll" | "baseline"` so the detection path is
visible; `stats.pollRefreshes` counts fallback refreshes. The freshness probe is injectable
(`freshnessCheck`, or `null` to skip) for tests and callers that do not want the extra round trip.

### Multi-root workspaces and worktree dedupe (#28)

Extra roots are searched alongside the active worktree and merged by **realpath**: the same file is returned once,
and the copy under the active worktree wins. Hits from another root are attributed with `[root: <path>]` in CLI and
MCP output, and the number of collapsed duplicates is reported instead of silently dropped.

```bash
export ULTRASEARCH_ROOTS="/path/to/monorepo:/path/to/sibling-worktree"   # OS path delimiter
export ULTRASEARCH_ROOTS_FILE=~/.config/ultrasearch/roots.json            # default when the env var is unset
```

`~/.config/ultrasearch/roots.json`:

```json
{ "roots": ["/path/to/monorepo", "/path/to/sibling-worktree"], "preferActiveWorktree": true }
```

With no configuration the module is inert: one root, one daemon round trip. A root that resolves (by realpath) to
the active worktree is collapsed before any search. This is applied on the CLI and MCP surfaces; the Pi extension
keeps resolving the active worktree alone, as before.

### Code Mode declarations and recipes (#29)

`src/tool-schema.ts` is the single source of truth for the tool surface. `src/codemode.ts` generates the
`declare namespace tools` block from it, and `MCP_TOOLS` is derived from the same entries, so a parameter added in one
place cannot go missing in the other. `npm run codemode:declarations` regenerates the golden file at
`test/fixtures/codemode-declarations.txt`; `test/interop-surface.test.ts` fails the build when the generated text or
the Pi tool parameters drift. Shipped recipes (`search -> grep -> read`, symbol-then-context) run through
`runSearchGrepReadRecipe` and are executed end-to-end by the same test.

### MCP surface configuration (#30)

The default surface is exactly six `ultrasearch_*` tools. An operator can expose the same six definitions under an
extra prefix for a client configured before the rename, without hand-maintaining a second schema:

```bash
ultrasearch-mcp --alias ultra            # adds ultra_query ... ultra_metrics (12 tools on tools/list)
ultrasearch-mcp --prefix us              # renames the canonical prefix (6 tools)
ULTRASEARCH_MCP_ALIASES=a,b              # env equivalent (the canonical six always stay)
```

`MCP_CLIENT_PROFILES` records the per-client matrix (Claude Desktop, VS Code, Antigravity, Cursor, T3 Code) and the
smoke test initializes each profile's protocol version, asserts six tools, and calls its representative tool.

### Query history and suggestions (#40)

**Off by default.** Enable recording with `ULTRASEARCH_HISTORY=1`; disable a previously enabled setup with
`ULTRASEARCH_HISTORY=0`. Queries are scrubbed with the same credential redactor as tool output before they are
written to `~/.cache/ultrasearch/history.json` (mode `0600`, atomic temp+rename). Retention is capped at
`ULTRASEARCH_HISTORY_MAX` entries (default 200, clamped to 10..5000) and enforced on write and load.

```bash
ultrasearch history                       # newest first
ultrasearch history --suggest "grep ini"  # deterministic suggestions (prefix, token expansion, recency)
ultrasearch history --clear               # delete the store
```

The TUI renders the same suggestions for the most recent query. `historyCorpus()` exposes a `query -> uses` map as
a learner input.

### Prefetch on edit (#41)

`tool_execution_end` for `edit`/`write` calls warms the edited file after a 150 ms trailing debounce (rapid saves
coalesce into one request, batches are capped at 16; a stopped controller warms nothing). The primary request is the
daemon `prefetch` op; an engine without it falls back to a real content probe for the longest literal token in the
file, which forces the daemon to read it. Best-effort: a failure is counted, never surfaced as a tool error. The
edit→grep latency claim is **unmeasured** in this wave — the harness protocol (alternating order, cold-file control)
is not in place, so no speedup is asserted.

---

## Build & distribution

```bash
npm run build       # tsc -p tsconfig.build.json  ->  dist/ (TypeScript -> ESM JavaScript)
npm run typecheck   # tsc -p tsconfig.json (noEmit)
npm pack            # runs prepack (build) and packs dist/ + sources
```

The published `bin` entries (`ultrasearch`, `ultrasearch-tui`, `ultrasearch-mcp`) all point at built
JavaScript under `dist/`. `engines.node` is `>=22.18` (`.nvmrc` pins the same) because the Pi extension
and direct source entrypoints such as `bin/mcp-server.ts` use Node's native type-stripping. The build uses
TypeScript's `rewriteRelativeImportExtensions` to keep `.ts` import specifiers working in `dist/`.

The extension imports `typebox` for tool parameter schemas. Pi Agent hosts provide it; it is declared as an
**optional peer dependency** (`peerDependenciesMeta.typebox.optional = true`) so a standalone install does not
force it, and `type-stubs.d.ts` keeps `tsc` green without it. The Pi loader uses `index.ts`; the installer below
still runs `npm ci` and `npm run build` so the installed checkout and its distribution output are ready together.

## Install on macOS (Pi Agent)

The first install has four steps. The daemon installer installs the app bundle and LaunchAgent; installing the Pi
extension is a separate operation because `ultrasearch init` deliberately skips Pi's native extension surface.

1. Clone the project and load Rust's environment:

   ```bash
   mkdir -p "$HOME/src"
   git clone https://github.com/Ghost-9/pi-ultrasearch.git "$HOME/src/pi-ultrasearch"
   cd "$HOME/src/pi-ultrasearch"
   source "$HOME/.cargo/env"
   ```

2. Build the daemon and inspect the install plan. The dry run changes no system files:

   ```bash
   (cd engine && cargo build --release)
   ./scripts/install.sh --dry-run --bin "$PWD/engine/target/release/ultrasearch"
   ```

3. After reviewing the plan, install the daemon:

   ```bash
   ./scripts/install.sh --bin "$PWD/engine/target/release/ultrasearch"
   ```

   In **System Settings → Privacy & Security → Full Disk Access**, add or enable
   `/Applications/UltraSearch.app`. Then restart the LaunchAgent and verify the socket and guarded Mail path:

   ```bash
   launchctl kickstart -k "gui/$(id -u)/com.pi.ultrasearch"
   ./scripts/verify-fda.sh
   ```

   The installer defaults to an ad-hoc signature. Re-signing can change its CDHash, so Full Disk Access may stop
   applying even when the bundle identifier stays the same. The verifier prints the zero-hit Mail probe and a
   clear error if the daemon reports that Full Disk Access is unavailable; re-add or re-enable UltraSearch in
   the Full Disk Access list, restart the LaunchAgent, and run the verifier again. For an optional stable identity,
   create a self-signed Code Signing identity once in Keychain Access, confirm its name with
   `security find-identity -v -p codesigning`, then prefix the install command with
   `ULTRASEARCH_CODESIGN_IDENTITY="<identity name>"`.

4. Install the Pi extension:

   ```bash
   ./scripts/install-extension.sh
   ```

   The script clones the extension into `~/.pi/agent/extensions/pi-ultrasearch` only when that directory is
   absent, runs `npm ci` and `npm run build`, and prints the reload instruction. It uses no `sudo`. Run it again
   to rebuild an existing checkout; update that checkout with `git pull` first when installing newer source.

---

## Soak

`python3 scripts/soak.py --seconds 60` runs in CI on macOS; `--hours 48` is the real soak.

It runs the daemon against a synthetic tree that creates, modifies and deletes while the index is live, and
fails when compactions run away, event lag grows unbounded, RSS grows unbounded, or the daemon stops answering.
Those are the properties that failed in the incident this was written for: 2,671 MB RSS, 5,210,213 event lag
and 67 compactions in a row.

It also proves the follower is live: every sample creates a file and asserts that file is findable shortly
after. Without that check the soak would pass on a daemon that had stopped following events entirely — the
index would simply never change and every ceiling would hold. `entries` is the *base* index and does not move
(new files sit in the overlay until compaction), so measuring entries alone is what makes the test vacuous.

---

## Testing & CI

### Testing the content index

A daemon started directly for a test (`ULTRASEARCH_DIR=<temp> ... serve`) reports
`content_docs: 0` forever, whatever `ULTRASEARCH_WARM`, `ULTRASEARCH_CONTENT_ROOTS` or the scan
root are set to. Names index normally; only the content side stays empty, so a `grep` against
such a fixture returns `complete: true` with no files and cannot be told apart from "the text is
not there".

Two rounds went into that before it was clear. The content index belongs to the installed daemon:
a file created under `$HOME` is searchable through it within about five seconds. So content
behaviour is tested against the real daemon, not a fixture:

```bash
mkdir -p ~/ultrasearch-probe && printf 'x = 1  # marker\n' > ~/ultrasearch-probe/a.py
sleep 5
# then grep for "marker" over the real socket; the file is found
```

Verified that way, and correct: a binary file, an unreadable file (`chmod 000`) and a file over
`max_file_bytes` are all excluded from results, which is what `content_policy.note` says will
happen. The soak measures names and memory only, so it never covered this either.

Measured against the installed daemon, all converging without stale results:

| event | observed |
|---|---|
| file created | findable in 0-2 s |
| file deleted | gone immediately |
| file modified | new text found, old text gone, immediately |
| 60 files created, half rewritten, every fifth deleted | exactly the expected 48 after 2 s |
| 30 files created and deleted faster than a pass | 0 stale hits |
| directory removed with 10 indexed files | 10 before, 0 after |

Use a unique token for these. The first run used `ghost_token` and `dirtoken`, which matched real
files elsewhere in `$HOME` - `DataDirTokenTests.swift` contains "DirToken", and the match is
case-insensitive - so the index looked stale when it was reporting the truth.

### Is the installed app actually this source?

```sh
./scripts/verify-deployed.sh
```

Checksums cannot answer it: a codesigned bundle never hash-matches a cargo build. Neither can
mtimes - a commit that only adds `#[cfg(test)]` code touches `engine/src` without changing what
ships, and that alone made this app look fourteen minutes stale when it was current.

So the script compares behaviour. Each binary serves its own tiny tree in its own state
directory and both are asked the same name question; if the answers differ the install is not
the source. It exits non-zero if a probe produces nothing rather than reporting a pass it did
not earn. Measured on this machine: the installed app matches the repo build.

### On `unwrap` in the engine

There are 69 `unwrap`/`expect` calls in the engine's non-test code. They were audited rather
than removed, and the audit found each one guarded by a local invariant rather than by luck:

- `query.rs` removes a positive token only inside `if !negate && positives >= 8`, so the
  `position(|t| !t.negate).unwrap()` that follows always finds one.
- `mcp.rs` pops a glob only under `p.globs.len() == 1`.
- `content.rs` calls `run.next().unwrap()` only after refilling `run` to `at..min(at+k, n)` with
  `at < n`, so the range cannot be empty.

The rule that matters for this codebase is not "no unwraps" but "no unwrap reachable from
damaged input". The decoder and the segment loader are the parts that read bytes off disk, and
those were hardened and then fuzzed: the committed test runs 400 structured cases (real
interpolative encodings decoded with a deliberately wrong document count) and 3,000 random-byte
cases through the header parser, and both were run at 75x that depth locally - 30,000 and
60,000 - while nothing new appeared. That fuzz found a real panic (`ic_has`, fixed); its first
version did not, because random bytes almost never form a valid interpolative header, which is
why the structured cases exist.


```bash
npm test            # unit + integration + MCP conformance + interop suites (integration tests skip cleanly without the daemon)
npm run test:gate   # hermetic mock-socket latency gate + live daemon gate (skips live if unavailable)
npm run typecheck   # tsc --noEmit
npm run build       # required before packaging; CI smokes the packed CLI
```

`npm test` includes the interop suites: `test/interop-surface.test.ts` (declaration drift, MCP alias surface,
recipes, per-client matrix), `test/roots.test.ts`, `test/history.test.ts`, `test/watch.test.ts`,
`test/prefetch.test.ts` and `test/cli-interop.test.ts` (real CLI child processes against mock sockets).

A note for a **fresh worktree**: the live latency gate greps the repository root, and a newly created checkout
starts with a cold content index in the resident daemon; the first run can exceed the p95 threshold until the
daemon has indexed that path (the re-scoped live gate derives its ceiling from the raw daemon leg measured in the
same run, so a cold index raises both sides of the comparison; warm the path with a couple of grep calls before
treating a failure as a regression).

### Engine tests and what they cover

`cargo test --release --manifest-path engine/Cargo.toml` — 70 unit tests plus 15 that drive
a real daemon. The ones that matter most, because a failure there is silent in production:

- **the allocator** (6): every size class round-trips its contents, alignment holds at 1/8/16,
  a zero-sized allocation is safe, `drain` returns memory and stays usable, and blocks at or
  above `BIG` bypass the free lists. A custom global allocator tested by one case was the
  largest uncovered risk in the crate.
- **the index** (5): paths reconstruct from the parent chain, `entries_by_top` buckets by the
  first component, save/load round-trips every path, a corrupt or empty file is refused rather
  than half-loaded, and extension slots report a real slot or the 255 marker.
- **the ignore forms** (5 integration): `dir/**`, `dir/*`, `**/dir` and plain `dir/` each prune
  end to end against a real daemon, and a rule the walk cannot honour is refused rather than
  guessed. The unit test only proves the parser classifies a line; that is not the property
  that broke.
- **the prune list** (4): cache directories are pruned by name and nothing else, so a
  folder whose name merely resembles one (`my-target`, `node_modules_backup`) is still
  indexed; a suffix rule prunes files but never a directory of that name, because pruning
  it would drop its whole subtree; and the list `status` reports is sorted and unique.
- **the policies** (6 coverage, 8 deny): each knob refuses independently, an unconfigured
  policy refuses nothing, `within` respects the path boundary, and a denied folder blocks its
  subtree without blocking `/secrets` when `/secret` is denied.
- **the unsafe surface** (1): pinned at 127 occurrences. It fails when the count grows and not
  when it shrinks, and it counts code rather than prose, so the four safety contracts can
  discuss `unsafe` without inflating the budget.

`rustfmt` and `clippy` are both enforced at zero in CI, not ratcheted.

### A soak test, because the worst defect was a time behaviour

`python3 scripts/soak.py --seconds 60` runs in CI on macOS; `--hours 48` is the real soak. It
runs the daemon against a tree that keeps changing and fails when compactions run away, lag
grows unbounded, RSS grows unbounded, or the daemon stops answering. It also creates a file
every sample and asserts that file is findable - without that check the soak would pass on a
daemon that had stopped following events entirely, because `entries` is the base index and does
not move.

### The shipped app is current

#### A trap: a CLI-spawned daemon has no Full Disk Access

`connect()` is connect-or-spawn, so any CLI call made while no daemon is running will start
one. That process inherits the *terminal's* TCC context, not the app bundle's, so it logs
`no Full Disk Access: skipping consent-gated folders` — and because it takes the index lock
first, the LaunchAgent's instance exits with `another ultrasearch daemon is running`. The
result is a daemon that answered, indexes less, and holds the lock so the correctly-
entitled one cannot start.

Seen during this upgrade: `verify-fda.sh` reported "unavailable" while the app's grant was
intact, purely because a daemon spawned from a shell was running. The fix at the machine is
`launchctl bootout` + `bootstrap` with no stray processes; the durable fix is for the
spawned daemon to notice it lacks the gift and defer, which is not done yet.



`/Applications/UltraSearch.app` now runs this tree's engine build, and Full Disk Access
survived the upgrade.

That is worth recording because it nearly did not. The app's version string comes from
`engine/Cargo.toml`, which is pinned at **0.2.1 on purpose** - the engine is a renamed fork
of upstream `fsearch` v0.2.1 and that number is its provenance, not a product version. The
product version lives in `package.json` (0.3.4). So a freshly installed app still reports
0.2.1, and the honest check is not the version string but the behaviour: the same fixture
that indexed 35 entries with the old binary indexes 3 with this one, because `.git` is
pruned.

The upgrade path that preserves the grant: `scripts/install.sh` with
`ULTRASEARCH_CODESIGN_IDENTITY` set to the same Apple Development certificate the app was
originally signed with. TCC matches the designated requirement
`identifier "com.pi.ultrasearch" and anchor apple generic and certificate leaf[subject.CN] = ...`,
which contains **no cdhash** - so re-signing with the same identity keeps the requirement
byte-identical and the grant intact. The ad-hoc default (`-`) instead writes
`=designated => identifier "com.pi.ultrasearch"`, which drops the certificate clause and
loses the grant. Verified after this upgrade: requirement identical, `scripts/verify-fda.sh`
reports granted, and the daemon answers `scan_root_error` (a field 0.2.1 did not have).


## Known limits & gaps

- **Content-index coverage is partial** — the daemon indexes text for its tracked corpus (e.g. ~129 k docs of
  3.7 M entries on this machine). Path search is whole-disk; content grep is not. The policy is configurable and
  reported in `status.content_policy` ([`docs/content-index-policy.md`](docs/content-index-policy.md)).
- **Tail latency** — cold/global queries are bounded by `budget_ms` (partial answers carry `complete:false`);
  an opt-in `early_exit`/`low_run` adds a low-score-run stop. An unbounded query can still take seconds on a
  whole-disk scope, by design.
- **Fallback quality** — when the daemon is unavailable the client falls back to `rg`/`find` (sync spawn). This is
  a correctness net, not the fast path.
- **Staleness windows** — `status` reports `event_lag`, `staleness_ms` and `replay_in_progress` (#19); a result may
  still miss changes made during a replay window, which the fields make visible.
- **Platforms** — socket path resolution exists for Linux/Windows, and the client, tests and hermetic gate run on
  Linux CI; the daemon itself is macOS-only (exact blockers in [`docs/linux-daemon-blockers.md`](docs/linux-daemon-blockers.md)).
- **Frecency hook** — wired and covered by unit-level code paths, but no end-to-end regression test yet.
- **Working directory is not tracked live** — an unscoped `search`/`grep` defaults to the *client
  process's* `process.cwd()`, and the daemon plus the extension host are long-lived processes that started in
  one directory. Running `cd` inside a pane changes that pane's shell directory, not either process's, so an
  unscoped query keeps searching the directory the process started in. This bites hardest in PowerShell and
  multi-pane shells, where every pane can `cd` independently and nothing reports it back. **Pass the scope
  explicitly** (`in: "<dir>"`) until it is tracked; note that the client resolves a relative `in` against its
  own process cwd, not the pane's, so an absolute path is the reliable form. There is no cheap fix inside the
  daemon: per-pane cwd is a signal the shell must publish (an env var on `cd`, or a per-pane hook), and the
  daemon cannot observe it on its own. Deliberately documented rather than approximated.
- Full list with priorities: [`OPTIMIZATIONS.md`](OPTIMIZATIONS.md).

---

## Architecture

```mermaid
flowchart LR
    A["Pi Agent / T3 Code / MCP client"] -->|tool call| B["pi-ultrasearch (index.ts / MCP / CLI)"]
    B -->|line-buffered JSON over UDS| C["ultrasearch daemon (Rust, resident)"]
    C --> D["Path index (mmap trie)"]
    C --> E["Trigram content index"]
    B -->|daemon unavailable| F["rg / find fallback"]
    B --> G["audit.jsonl + learner"]
```

Upstream engine: [`noahdunnagan/fsearch`](https://github.com/noahdunnagan/fsearch) (MIT, © Noah Dunnagan), pinned at
`v0.2.1`. The renamed source is vendored in `engine/`; `engine/rebrand.sh <src-dir> <dst-dir>` reproduces it from
an upstream checkout. The upstream licence text and copyright are never rewritten — see [`NOTICE`](NOTICE). The
daemon runs from a macOS `.app` bundle (`UltraSearch.app`) so Full Disk Access can be granted to it. The default
ad-hoc signature can lose that grant after a re-sign; an optional persistent Keychain signing identity is described
above. Operational detail and rollback steps: [`docs/engine-rebrand.md`](docs/engine-rebrand.md).

---

## License

pi-ultrasearch is licensed under the [GNU Affero General Public License v3.0](LICENSE) © 2026 Ghost-9.
The upstream `fsearch` engine is MIT-licensed. Its copyright and licence text are preserved unmodified in
[`NOTICE`](NOTICE) and in the engine working copy; rebranding never claims upstream authorship.

## Engine behaviour (renamed MIT fork, vendored at `engine/`)

The daemon is a **renamed fork of the upstream `fsearch` engine (MIT, © Noah Dunnagan, v0.2.1)**,
vendored at `engine/` so its behaviour can be changed and tested in-tree and so the
source that ships is the source that is reviewed (`engine/NOTICE`,
`engine/BUILD.md`, and `docs/engine-changes.md` for every local change).
Nothing below needs configuration: an operator who sets nothing gets upstream's
searches.

### One owner for proximity ranking

`near:` re-ranks daemon-side, and the daemon reports what it added:

| Component | Scale | Where |
|---|---|---|
| `nearness` | `+12` in the `near` file's folder, `-3` per folder of distance, clamped at 0; the `near` file itself `-20` | `server::nearness` |
| `boost` | frecency: opens, your commits, and the file's mtime as one more open | `frecency::boost` |

Each hit carries `near` and `boost`; `score` is the match score plus them. **A
client must not re-rank a daemon result**: the extension's
`applyProximityRanking` (+100, a different scale on the same signal) now runs
only for the native `find`/`rg` fallback, where there is no daemon score to
trust.

### Bounded searches

`op: search` accepts `budget_ms` (a deadline) and `candidates` (a cap on how
many candidates are scored). The reply then carries `complete`, `scanned`,
`considered` and `budget_ms`; `complete: false` means the deadline or the cap
was reached and the hits are the best found so far. `grep` reports the same
`scanned`/`considered` beside its own `candidates`/`read`, with `complete`
already in place. See `docs/engine-changes.md` for the granularity.

### Freshness and index health

`op: status` reports `last_event_id`, `event_lag`, `staleness_ms` (0 when the
index is caught up), `replay_in_progress`, `compactions`,
`last_compact_ms`/`_bytes`/`_entries`/`_secs_ago`, `compactions_postponed` and
`queries_in_flight`. A compaction that comes due waits up to 2 s for in-flight
queries (best effort, never past a runaway overlay), and answers carry `stale`
/`stale_ms` while a replay window is open. The extension appends a one-line
freshness warning when it sees one.

### Content coverage

Grep covers a configurable subset of the disk. `coverage.json` (or
`ULTRASEARCH_CONTENT_*` / `ULTRASEARCH_WARM`) sets extensions, a size cap,
roots, and folders to warm at start; `status.content_policy` reports what is in
force. Full policy and the built-in rules: `docs/content-index-policy.md`.

### Security boundary

A fail-closed deny-list (`ULTRASEARCH_DENY`, `ULTRASEARCH_DENY_FILE`, or
`<index dir>/deny.txt`) is enforced in the engine before any result is written,
and a request may name its allowed boundary (`root`): an escaping scope is a
security error for every tool, and hits outside it are dropped and counted as
`withheld`. `docs/security-deny-list.md` has the contract.

### Running an isolated instance

`ULTRASEARCH_DIR`, `ULTRASEARCH_HOME` and `ULTRASEARCH_SCAN_ROOT` run a real
daemon over a fixture tree on its own socket without touching the live index or
crawling the whole disk. Add `ULTRASEARCH_NO_SPAWN=1` when the run must not leave
a daemon behind: a query then reports "no daemon is listening" rather than starting
one. `test/engine/harness.mjs` does exactly that, and
`node bench/engine-ab.mjs` compares two binaries over one fixture with
alternating rounds, medians, bootstrap CIs and an output-equivalence check
(raw samples in `bench/results/engine/`).
