# Generic harness plan — UltraSearch beyond Pi

Status: proposed · 2026-10-15 · owner: platform/relevance waves · evidence: `bench/verification/`

## Goal

Make UltraSearch usable from any agent harness without harness-specific work in the core, with one
universal surface (MCP), one scriptable surface (CLI), and thin adapters only where a harness offers
something MCP cannot (native tools, lifecycle hooks, directives).

"Generic" means:

1. the same daemon and index serve every harness;
2. adding a harness is configuration plus a smoke test, not code;
3. no harness's prompt surface is bloated — a harness that already has native tools must not also load the MCP tools;
4. per-harness usage and savings are measurable.

## Architecture: one core, three surfaces, thin adapters

```
                    ┌──────────────────────────────┐
                    │  ultrasearch daemon (Rust)   │
                    │  path index · trigram · DLP  │
                    └──────────────┬───────────────┘
                                   │ JSON-RPC over UNIX socket (versioned)
              ┌────────────────────┼────────────────────┐
              │                    │                    │
        CLI (`ultrasearch`)   MCP stdio server     HTTP/local bridge (phase 4)
              │                    │                    │
      shell / scripts        any MCP harness      non-MCP harnesses
                                   │
        ┌──────────┬───────────────┼───────────────┬──────────────┐
     Pi ext    Codex CLI      Claude Code       Cursor / Zed /   T3 Code
     (native)  (MCP)          (MCP + skills)    Windsurf (MCP)   (via Pi provider or CLI)
```

Rules that keep it generic:

- **Core has no harness imports.** Harness names never appear in `engine/` or the client transport.
- **Tool schemas are one registry.** `src/tool-schema.ts` already generates both MCP and Code Mode surfaces; adapters must consume it, never re-declare.
- **Protocol is versioned and documented.** New `docs/protocol.md`; `status` reports `protocol_version`.
- **Config is written, not hand-edited.** `ultrasearch init --harness <id>` patches the harness's config with backups; `--dry-run` prints the diff.

## Harness matrix

| Harness | Surface | What is needed | Today |
|:--|:--|:--|:--|
| Pi Agent | native extension | extension loaded; 6 tools + hooks | ✅ shipped |
| T3 Code | inherits Pi provider | Pi extension when provider is Pi; CLI + directive otherwise | ✅ via Pi / 🟡 direct bridge TBD |
| Antigravity | MCP | `~/.gemini/.../mcp_config.json` | ✅ registered |
| VS Code (Copilot) | MCP | user `mcp.json` | ✅ registered |
| Claude Desktop | MCP | `claude_desktop_config.json` | ✅ registered |
| Claude Code | MCP + skills/hooks | MCP entry + optional skill teaching the CLI | 🟡 plan (phase 1) |
| Codex CLI | MCP | `~/.codex/config.toml` `[mcp_servers]` + `AGENTS.md` directive | 🟡 plan (phase 1) |
| Cursor / Windsurf / Zed | MCP | their MCP config + rules file | 🟡 plan (phase 1) |
| Aider / opencode / Amp / generic shell | CLI | `ultrasearch` on PATH + `--json` output | ✅ CLI exists; 🟡 wrapper docs |
| Remote / container harnesses | CLI or MCP over socket | Linux daemon (blocked: #32) | ❌ blocked |

## Phases

### Phase 0 — protocol freeze and docs (S)
- `docs/protocol.md`: every op, request/response shape, error codes, `protocol_version`, compatibility rule.
- `status.protocol_version` + a conformance test that fails if a tool exists on one surface only (the interop drift guard already does this for Pi/MCP).
- Acceptance: a third-party implementer can write a client from the doc alone; conformance suite green.

### Phase 1 — `ultrasearch init` (M)
- Detect installed harnesses; write or patch each config with timestamped backups; idempotent; `--dry-run`, `--harness`, `--remove`.
- Never touch a config it cannot parse; print exactly what changed; refuse to duplicate an already-registered server.
- Acceptance: fresh-machine simulation registers Codex CLI, Claude Code, Cursor, Zed, Windsurf, Antigravity, VS Code; every change reversible with the printed command.

### Phase 2 — harness smoke matrix (M)
- One documented test per harness: `initialize → tools/list → one query`, with expected tool count (6) and a recorded transcript under `bench/harness-smoke/<id>.json`.
- Machine-readable capability matrix (surface, tools, hooks, directive file, smoke status, last-verified commit).
- CI runs CLI + MCP arms; harness-native arms run locally and store evidence.
- Acceptance: every claimed-harness row has a current smoke artifact; unsupported rows are explicitly `unsupported`, not implied.

### Phase 3 — policy injection (S)
- Generate the right directive per harness so agents stop falling back to `grep -rn`: `AGENTS.md` (Pi, Codex), `CLAUDE.md` (Claude Code), `.cursor/rules`, workspace instructions (VS Code), Antigravity rules.
- Directive text carries the measured reason (path search **9.4×–29.5×** vs `rg --files`/`find`, cited to `bench/verification/wave1-summary.json`; the real bottleneck is subprocess spawn, not raw grep).
- Acceptance: a fresh session in each harness issues its first search through UltraSearch without a human reminder (recorded transcript).

### Phase 4 — per-harness telemetry (M)
- `origin` includes the harness id; savings attribution per harness; `ultrasearch report --by harness`.
- Acceptance: a session in two different harnesses produces two distinguishable blocks in the report.

### Phase 5 — packaging (L, depends on #32)
- Linux daemon port, then a Homebrew tap or signed install script; per-OS service install; universal binary.
- Acceptance: `brew install` (or script) + `ultrasearch init` on a clean machine yields a working MCP tool in under two minutes.

## Prioritization (RICE, qualitative inputs)

| Item | Reach | Impact | Confidence | Effort | Order |
|:--|--:|--:|--:|--:|:--|
| Phase 0 protocol freeze | all harnesses | 3 | 0.9 | S | 1 |
| Phase 3 policy injection | all harnesses | 3 | 0.8 | S | 2 |
| Phase 1 `init` | MCP harnesses | 3 | 0.8 | M | 3 |
| Phase 2 smoke matrix | trust + support | 2 | 0.9 | M | 4 |
| Phase 4 telemetry by harness | operators | 2 | 0.7 | M | 5 |
| Phase 5 packaging + Linux | new machines | 3 | 0.6 | L | 6 |

## Risks

- **MCP drift** — mitigated by the existing conformance suite + pinned protocol versions.
- **Prompt tax** — never load MCP tools into a harness that already has native tools (the Pi rule); the smoke matrix asserts tool counts.
- **TCC / Full Disk Access** — an ad-hoc re-sign can change the CDHash and invalidate the grant; the installer supports an optional persistent Keychain signing identity and includes a guarded-path verifier (`docs/engine-rebrand.md`).
- **Security on new surfaces** — DLP, deny-list and scope containment are engine-side today; MCP clients inherit them. The CLI must not add a bypass.
- **Remote/container harnesses** — the daemon is macOS-only until #32; remote agents keep the `rg` fallback.

## Acceptance for "generic"

1. `ultrasearch init` + one harness-specific smoke test is the entire cost of adding a harness.
2. No core file references a harness name.
3. Each supported harness has a current smoke artifact and a capability-matrix row.
4. A non-MCP harness can use the CLI with `--json` without shell-quoting hazards.
