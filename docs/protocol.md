# UltraSearch daemon protocol

The contract between any client and the resident UltraSearch daemon: one
newline-delimited JSON request per line over a UNIX socket, one JSON response
per request. This document is normative: the conformance tests in
`test/interop-surface.test.ts` and `test/engine/status.test.mjs` fail if the
code and this document disagree.

Current version: **1.1**

```
client ──► {"op":"search","q":"README","in":"/repo","limit":10}      + "\n"
daemon ──► {"ok":true,"id":null,"took_us":120,"hits":[…]}            + "\n"
```

---

## 1. Transport and framing

- **Socket**: UNIX stream socket. Default path by platform:
  - macOS: `~/Library/Application Support/UltraSearch/ultrasearch.sock`
  - Linux: `$XDG_RUNTIME_DIR/ultrasearch.sock`, else
    `~/.local/share/ultrasearch/ultrasearch.sock`
  - override with `PI_ULTRASEARCH_SOCKET` (the reference client and CLI honor it).
- **Framing**: UTF-8 JSON, one object per line (`\n` terminated). Blank lines
  are ignored. A response is exactly one line.
- **Ordering**: responses on one connection arrive in request order. A client
  may open several connections ("lanes") for concurrency; ordering is per
  connection.
- **Connection failure** is not a protocol error: the client reconnects (the
  reference client) or reports the request as unavailable.

## 2. Request envelope

```json
{ "id": 7, "op": "search", "q": "package.json", "in": "/repo", "limit": 5 }
```

| field  | required | meaning |
|:--|:--|:--|
| `op`   | no       | Operation. **Defaults to `search` when absent.** |
| `id`   | no       | Any JSON scalar. Echoed in the response so callers can correlate. |
| `root` | no       | The caller's allowed boundary (absolute path). The daemon refuses a scope outside it and drops any hit outside it (`security:` error). Omit for a deliberate disk-wide query. |
| other  | per op   | Operation fields, or query-language filters (section 5). |

**Unknown request fields are not an error.** A field that is not an `op`,
`id`, `root`, or operation extra becomes a query filter (section 5); a typo
therefore changes the query instead of failing it. Clients must send only
fields they know. This is the one place the protocol fails *open* rather than
closed, and it is preserved for backward compatibility.

## 3. Response envelope and errors

Success (name search):

```json
{"ok":true,"id":7,"took_us":120,"hits":[{"path":"/repo/package.json","kind":"file","mtime":0,"size":1,"score":10,"match":10}]}
```

Success (any other op):

```json
{"ok":true,"id":7,"scores":[0.5]}
```

Failure — always an HTTP-style string, never silently an empty success:

```json
{"ok":false,"id":7,"error":"unknown op multi_grep"}
```

There are **no numeric error codes on the socket**. The stable error classes a
client may match on:

| `error` shape | cause |
|:--|:--|
| `bad json: …` | the line did not parse; no `id` is known |
| `unknown op <op>` | operation not implemented by this daemon |
| `… needs a …` / `… must be a number` | invalid parameters (`open needs a path (or paths)`, `grep needs a pattern`, `glob needs a pattern`, `limit must be a number`, `unknown mode <m>`, `unknown case <c>`) |
| `security: … is denied by policy` | scope/root blocked by the deny-list (#23) |
| `security: scope … is outside the allowed root …` | scope escapes `root` (#23) |
| `security: that file is denied by policy` | `file:` target blocked |
| `search error`-prefixed daemon text | index not ready yet: the answer is the indexing progress message |

## 4. Operations

Ops the **daemon** implements (`engine/src/server.rs::run`):

| op | request fields | response |
|:--|:--|:--|
| `ping` | — | `{ok:true}` |
| `save` | — | `{ok:true,"scheduled":true}` (schedule an index compaction) |
| `search` | `q`, `in`, `limit`, `glob`, `offset`/`cursor`, `git`, `ignored`, `boost`, `near`, `budget_ms`, `candidates`, `early_exit`, `low_run` | name-search response, section 6.1 |
| `glob` | as `search`, plus `pattern` (the glob) | name-search response with `next` |
| `grep` | `pattern` **or** `patterns`, `q`, `in`, `file`, `mode`, `case`, `limit`, `offset`/`cursor`, `context`/`before`/`after`, `per_file`, `defs`, `git`, `ignored`, `budget_ms` | grep response, section 6.2 |
| `batch_resolve` | `symbols` (required list, capped at 64), `in`, `budget_ms` | parallel symbol/path resolution map, section 6.2b |
| `recent` | `in`, `limit`, `git` | name-search response; `took_us` is `0` |
| `status` | — | section 6.3 |
| `open` | `path` xor `paths` | `{ok:true,"scores":[…]}` (frecency boost per path) |
| `git` | `path` | `{ok:true,"root":…,"read":bool,"changed":n}` |

Disambiguation: `op:"search"` with a `q` containing any of `grep:`, `regex:`,
`sym:`, `content:`, `symbol:` is routed to `grep` (that is how the CLI's
`ultrasearch grep` is spelled down to the daemon).

Two client-level ops are **not** daemon ops. A daemon answers them
`unknown op …`, which is a normal compatibility answer:

| op | meaning |
|:--|:--|
| `multi_grep` | `{op:"multi_grep", patterns:[…], in, root, mode, limit, budget_ms}`. The reference client falls back to one `grep` per pattern and merges unique files (`source:"native_fallback"`). |
| `prefetch` | `{op:"prefetch", paths:[…]}` asks the daemon to warm those paths' trigrams. A daemon that does not implement it answers an error; the reference client treats that as "not warmed" and never fails the caller. |

## 5. Query language (`q`), shared by `search` and `grep`

`q` is the same language as the CLI query string. The first positive glob
narrows the search scope to the folder its leading literal part names.

| token | effect |
|:--|:--|
| bare words | **exact conjuncts** — every word must appear (zero typo tolerance) |
| `'name` or `"name` | exact path-name match |
| `*.ts`, `src/**/*.ts` | glob on the path (relative to `in:`, else `cwd`, else `/`) |
| `!test/` | exclude paths matching the glob |
| `git:modified`, `git:staged`, `git:untracked`, `git:ignored`, `git:clean`, `git:tracked`, `git:conflict`, `!git:ignored` | git-state filter in the repo holding the scope |
| `near:path` | re-rank by proximity to `path` (engine-owned `near` component) |
| `grep:needle`, `content:needle` | force a content search (literal) |
| `regex:pat` | content search by regex |
| `sym:name`, `symbol:name` | declaration-first symbol search |

## 6. Response shapes

### 6.1 Name search (`search`, `glob`, `recent`)

```json
{
  "ok": true, "id": 7, "took_us": 120,
  "hits": [
    {"path":"/repo/package.json","kind":"file","mtime":1750000000,"size":812,
     "score":10,"match":10,"near":0,"boost":0,"def":0,"git":"modified"}
  ],
  "next": 10,
  "complete": true, "scanned": 1000, "considered": 42, "budget_ms": 250,
  "withheld": 0, "stale": 0
}
```

Hit components are engine-owned and must not be re-computed by a client:
`score == match + near + boost + def` (`near`/`boost`/`def` are omitted when
zero). `git` is present only when `git:true` was requested. `next`, when
present, is the offset a paged client should request to continue.

### 6.2 Grep

```json
{
  "ok": true, "id": 8, "took_us": 400,
  "source": "index",
  "candidates": 42, "read": 3,
  "complete": true, "considered": 42, "scanned": 3, "indexing": 0,
  "files": [
    {"path":"/repo/src/client.ts",
     "matches":[{"line":12,"text":"export class UltraSearchClient {","col":0,"ranges":[[0,18]],"def":true}],
     "def":8,"git":"modified"}
  ],
  "next": 30
}
```

`source` is `index` (answered from the content index), `scan` (the content
index does not hold that scope, so files were read directly), or `file` (a
single `file:` target). `col`/`ranges`/`def`/`before`/`after` appear only when
requested (`defs`, `context`). `def` on a file is `8` when it declares the
queried name. `indexing` is `content_pending`: non-zero means the content
index is still building and a scope may answer from a scan.

### 6.2b Batch resolve (`batch_resolve`)

```json
{
  "ok": true, "id": 8, "took_us": 1240,
  "resolved": 2, "complete": true, "withheld": 0,
  "hits": {
    "write_note": {"path": "/repo/src/propose.rs", "line": 42},
    "src/lib.rs": {"path": "/repo/src/lib.rs"},
    "missing_sym": null
  }
}
```

Each symbol resolves via scoped literal content grep first and falls back to filename search when the symbol contains `/` or `.`. Policy checks (`deny` and `root`) are enforced identically per scope and per resolved hit; withheld hits count toward `withheld`.

### 6.3 Status

```json
{
  "ok": true, "id": 9,
  "protocol_version": "1.0",
  "entries": 3879170, "dirs": 630183, "overlay": 981, "removed": 934,
  "event_id": 5695106729, "index_bytes": 119984896,
  "content_docs": 145651, "content_segments": 43, "content_bytes": 169851328,
  "content_pending": 0, "full_disk_access": true, "owner": true,
  "pid": 13298, "uptime_ms": 3600000, "socket": "/…/ultrasearch.sock",
  "socket_dev": 16777220, "socket_ino": 1234567, "lock_pid": 13298,
  "last_event_id": 5695106756, "event_lag": 27, "staleness_ms": 0,
  "replay_in_progress": false,
  "compactions": 3, "last_compact_ms": 1665, "last_compact_bytes": 119984896,
  "last_compact_entries": 3879170, "last_compact_secs_ago": 0,
  "compactions_postponed": 0, "queries_in_flight": 0,
  "content_policy": {"configured": false, "extensions": null, "max_file_bytes": null, "roots": null},
  "deny_configured": false, "deny_rules": 0
}
```

`status` is the only op that answers while a configured deny-list cannot be
loaded (an operator must be able to ask why everything fails closed); it then
also carries `deny_error`.

### 6.4 Field semantics

| field | meaning |
|:--|:--|
| `budget_ms` | Server-side deadline. Absent: the scan runs to completion. Present: `complete` is `false` when the deadline expired, and the hits are the best found so far — not the top-k of the whole index. |
| `complete` | `true` only when the engine says the result set is complete. A response without `complete:true` is **not** guaranteed to cover the scope. |
| `stopped_by` | Why a partial answer stopped: `deadline`, `candidates`, or `low_run` (#35). Present only when `complete` is `false`. |
| `scanned` | Entries/files the scan examined. |
| `considered` | Candidates that passed the cheap per-name filter and were scored. |
| `withheld` | Results held back by the deny-list or by `root`. Reported, never silently dropped, so "denied" cannot be mistaken for "no match" (#23). |
| `stale` | Milliseconds the index was behind a replay when the answer was made (`0` = caught up). A non-zero value means the result may miss changes from that window (#19). |
| `near` | Proximity component. Also a request field: an absolute path to re-rank near. The engine owns the scale. |
| `git` | On a request: `true` to annotate hits with `git status`. On a hit: the status word (`modified`, `untracked`, …). |
| `root` | On a request: the caller's allowed boundary. The daemon refuses an escaping scope with a `security:` error and drops out-of-root hits (counted in `withheld`). |
| `limit` | Page size. The engine does not cap it; the reference client overscans to compensate for its own client-side ignore filtering. |

## 7. Versioning and compatibility rule

- The daemon reports the wire version it speaks as `protocol_version` in every
  `status` reply. Current version: **1.1**.
- **Same major = compatible.** A minor bump may only *add* optional request
  fields, new ops, or new response fields. A client written against 1.0 must
  keep working against 1.x by ignoring unknown response fields.
- **Different major = incompatible.** Removing or renaming a field, changing a
  field's type or meaning, changing a default, or narrowing what an existing
  field accepts is a major bump. The reference client detects this on
  `status()` and reports `protocol_mismatch: {client, daemon}` instead of
  reading fields whose meaning it does not know.
- A daemon older than 1.0 reports no `protocol_version`; a client must treat
  that as "1.0-compatible or older" and rely on feature detection (an
  `unknown op` or missing field), not on version comparison.

## 8. MCP surface (for MCP harnesses)

The MCP server (`bin/mcp-server.ts`) is a client of this protocol and exposes
the tool registry in `src/tool-schema.ts`: `ultrasearch_query`,
`ultrasearch_grep`, `ultrasearch_multi_grep`, `ultrasearch_locate`,
`ultrasearch_recent`, `ultrasearch_metrics`. Its JSON-RPC errors are separate
from the socket's string errors:

| code | meaning |
|:--|:--|
| `-32700` | parse error |
| `-32600` | invalid request |
| `-32601` | method not found |
| `-32602` | invalid params / unknown tool |
| `-32603` | internal error |
| `-32002` | request before `initialize` |

Supported MCP revisions: `2025-06-18`, `2025-03-26`, `2024-11-05`,
`2024-10-07`. The server echoes the client's revision when supported and
answers with the newest it supports otherwise.

The CLI (`bin/cli.ts`) is the third surface; the command-to-tool mapping is
declared in `src/surfaces.ts` and checked against the registry by the
conformance test.

## 9. Conformance

| test | asserts |
|:--|:--|
| `test/interop-surface.test.ts` | MCP `tools/list` and input schemas equal the registry; Pi tool parameters equal the registry; Code Mode declarations equal the registry; CLI surface covers the registry; `docs/protocol.md`'s version equals the client constant; `status()` surfaces and mismatch-checks `protocol_version` |
| `test/engine/status.test.mjs` | a real daemon answers `status.protocol_version` equal to the version frozen here |
| `test/engine/*.test.mjs` | engine behavior against a real daemon over this wire shape |
| `test/cli-interop.test.ts` | CLI commands drive the daemon through the reference client |
