import * as readline from "node:readline";
import * as path from "node:path";
import { UltraSearchClient } from "./client.ts";
import { formatGrepFiles, explainReasonTags } from "./formatter.ts";
import { searchSemanticIntent, semanticEnabled, SEMANTIC_REFUSAL } from "./semantic.ts";
import { summarizeAudit, formatAuditSummary } from "./telemetry.ts";
import { diagnoseEmptyQuery } from "./observer.ts";
import { TOOL_SCHEMAS, toolJsonSchema } from "./tool-schema.ts";
import { multiRootSearch, multiRootGrep } from "./roots.ts";
import { appendHistory } from "./history.ts";

/**
 * Version reported in `initialize.serverInfo`. Keep in sync with package.json.
 */
export const SERVER_VERSION = "0.3.1";

/**
 * MCP protocol revisions this server understands, newest first. The server
 * echoes the client's requested revision when it is in this list, and answers
 * with the newest supported revision otherwise (MCP lifecycle negotiation).
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** JSON-RPC 2.0 error codes used by this server. */
export const JSON_RPC_ERRORS = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  /** MCP: request received before the initialize handshake. */
  NOT_INITIALIZED: -32002,
} as const;

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function err(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

/**
 * The canonical UltraSearch MCP tool surface, generated from the single
 * registry in `src/tool-schema.ts` (issue #29). Exactly one prefix
 * (`ultrasearch_`) and six tools by default; the historical `fsearch_*`
 * aliases are deliberately not part of this surface (issue #30).
 */
export const MCP_TOOLS: McpToolDefinition[] = TOOL_SCHEMAS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: toolJsonSchema(tool),
}));

/** Default MCP name prefix; the canonical surface carries exactly this one. */
export const DEFAULT_MCP_PREFIX = "ultrasearch";

/** Environment variable selecting the default prefix (operator opt-in). */
export const MCP_PREFIX_ENV = "ULTRASEARCH_MCP_PREFIX";
/** Colon/comma-separated extra prefixes exposed as aliases (opt-in, default none). */
export const MCP_ALIASES_ENV = "ULTRASEARCH_MCP_ALIASES";

/**
 * A configurable tool surface (issue #30). The default is one prefix and six
 * tools; an alias prefix adds the same six tools under a second prefix for a
 * client that was configured before the rename. Aliases are generated, never
 * hand-maintained, so they cannot drift from the canonical schemas.
 */
export interface McpSurfaceConfig {
  /** Canonical prefix (default `ultrasearch`). */
  prefix?: string;
  /** Extra prefixes to expose as aliases (default: none). */
  aliases?: readonly string[];
}

/** Server options: the tool surface plus optional multi-root scope (#28). */
export interface McpServerOptions extends McpSurfaceConfig {
  /** Extra roots searched and merged with the active root (issue #28). */
  roots?: readonly string[];
  /** Record query history for tool calls (opt-in; `history.ts` gates on env). */
  recordHistory?: boolean;
}

/** Parse `ULTRASEARCH_MCP_PREFIX` / `ULTRASEARCH_MCP_ALIASES` from an env map. */
export function resolveMcpSurfaceConfig(env: NodeJS.ProcessEnv = process.env): McpSurfaceConfig {
  const prefix = (env[MCP_PREFIX_ENV] ?? "").trim();
  const aliases = (env[MCP_ALIASES_ENV] ?? "")
    .split(/[,:]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    ...(prefix ? { prefix } : {}),
    ...(aliases.length ? { aliases } : {}),
  };
}

/** Map one exposed surface name onto its canonical `ultrasearch_*` name. */
export function canonicalNameForName(name: string, config: McpSurfaceConfig = {}): string {
  const prefix = (config.prefix ?? DEFAULT_MCP_PREFIX).trim() || DEFAULT_MCP_PREFIX;
  let suffix: string | null = null;
  if (name.startsWith(`${prefix}_`)) suffix = name.slice(prefix.length + 1);
  if (suffix === null) {
    for (const alias of config.aliases ?? []) {
      const clean = alias.trim().replace(/_+$/, "");
      if (clean && name.startsWith(`${clean}_`)) {
        suffix = name.slice(clean.length + 1);
        break;
      }
    }
  }
  if (suffix !== null && TOOL_SCHEMAS.some((t) => t.name === `${DEFAULT_MCP_PREFIX}_${suffix}`)) {
    return `${DEFAULT_MCP_PREFIX}_${suffix}`;
  }
  return name;
}

/**
 * Build the tool definitions exposed by one server instance. The canonical
 * definitions are first and unchanged; each alias prefix contributes a copy
 * with only the name replaced.
 */
export function buildToolSurface(config: McpSurfaceConfig = {}): McpToolDefinition[] {
  const prefix = (config.prefix ?? DEFAULT_MCP_PREFIX).trim() || DEFAULT_MCP_PREFIX;
  const rename = (p: string): McpToolDefinition[] =>
    TOOL_SCHEMAS.map((tool) => ({
      name: p === DEFAULT_MCP_PREFIX ? tool.name : tool.name.replace(`${DEFAULT_MCP_PREFIX}_`, `${p}_`),
      description: tool.description,
      inputSchema: toolJsonSchema(tool),
    }));
  const surface = rename(prefix);
  for (const alias of config.aliases ?? []) {
    const clean = alias.trim().replace(/_+$/, "");
    if (!clean || clean === prefix || clean === DEFAULT_MCP_PREFIX) continue;
    surface.push(...rename(clean));
  }
  return surface;
}

/** Per-client capability matrix (issue #30), asserted by the smoke tests. */
export const MCP_CLIENT_PROFILES: ReadonlyArray<{
  client: string;
  protocolVersion: string;
  aliases: readonly string[];
  representativeTool: string;
  note: string;
}> = [
  { client: "Claude Desktop", protocolVersion: "2024-11-05", aliases: [], representativeTool: "ultrasearch_query", note: "config file `claude_desktop_config.json`; stdio" },
  { client: "VS Code", protocolVersion: "2024-11-05", aliases: [], representativeTool: "ultrasearch_grep", note: "`.vscode/mcp.json`; stdio" },
  { client: "Antigravity", protocolVersion: "2025-03-26", aliases: [], representativeTool: "ultrasearch_query", note: "MCP settings; stdio" },
  { client: "Cursor", protocolVersion: "2025-03-26", aliases: [], representativeTool: "ultrasearch_multi_grep", note: "`~/.cursor/mcp.json`; stdio" },
  { client: "T3 Code", protocolVersion: "2025-06-18", aliases: [], representativeTool: "ultrasearch_metrics", note: "no generic user-level registry; Pi uses the native extension" },
];

/**
 * Model Context Protocol server speaking JSON-RPC 2.0 over stdio.
 * Supports Claude Desktop, Cursor, Windsurf, Zed, VS Code, Antigravity, and T3 Code.
 *
 * Conformance: newline-delimited JSON (one message per line), notifications are
 * never answered, requests before `initialize` are rejected with -32002, and
 * transport/protocol failures use the JSON-RPC error codes.
 */
export class UltraSearchMcpServer {
  private client: UltraSearchClient;
  private cwd: string;
  private initialized = false;
  private queue: Promise<void> = Promise.resolve();
  /** Tool definitions this instance exposes (canonical plus configured aliases). */
  private surface: McpToolDefinition[];
  /** Exposed name -> canonical name, so `tools/call` accepts an alias. */
  private surfaceNames = new Map<string, string>();
  private roots: string[];
  private recordHistory: boolean;

  constructor(client?: UltraSearchClient, cwd = process.cwd(), surface: McpServerOptions = {}) {
    this.client = client ?? new UltraSearchClient({ harness: "mcp" });
    this.cwd = cwd;
    this.roots = [...(surface.roots ?? [])];
    this.recordHistory = surface.recordHistory ?? true;
    this.surface = buildToolSurface(surface);
    for (const tool of this.surface) this.surfaceNames.set(tool.name, canonicalNameForName(tool.name, surface));
  }

  /** Names this instance exposes in `tools/list` (test and diagnostics surface). */
  public toolNames(): string[] {
    return this.surface.map((t) => t.name);
  }

  public get isInitialized(): boolean {
    return this.initialized;
  }

  /** Attach to process stdio. One JSON message per line; blank lines ignored. */
  public start(): void {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    rl.on("line", (line) => {
      // Serialize handling: a later frame must never overtake an earlier one,
      // so responses leave in request order (a sync parse-error reply would
      // otherwise jump ahead of an awaited request).
      this.queue = this.queue.then(() => this.dispatch(line));
    });

    process.on("SIGINT", () => {
      this.client.close();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      this.client.close();
      process.exit(0);
    });
  }

  /**
   * Parse and answer one framed stdio message. Never throws, never writes for a
   * notification, and answers malformed JSON with a -32700 parse error.
   */
  public async dispatch(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch (parseErr: any) {
      this.write(err(null, JSON_RPC_ERRORS.PARSE, "Parse error", parseErr?.message ?? String(parseErr)));
      return;
    }

    const response = await this.handleMessage(msg);
    if (response) this.write(response);
  }

  protected write(response: unknown): void {
    process.stdout.write(JSON.stringify(response) + "\n");
  }

  /** Pure message handler: returns the response, or null for notifications. */
  public async handleMessage(msg: any): Promise<any> {
    // JSON-RPC: a message without an `id` member is a notification. It must
    // never be answered, whatever its method or shape.
    const isNotification = msg !== null && typeof msg === "object" && !Array.isArray(msg) && !("id" in msg);

    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      return isNotification ? null : err(null, JSON_RPC_ERRORS.INVALID_REQUEST, "Invalid Request");
    }

    const { id, method, params } = msg;

    if (typeof method !== "string" || method.length === 0) {
      return isNotification ? null : err(id ?? null, JSON_RPC_ERRORS.INVALID_REQUEST, "Invalid Request: method must be a string");
    }

    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
    const fail = (code: number, message: string, data?: unknown) => err(id ?? null, code, message, data);

    // --- lifecycle -----------------------------------------------------------
    if (method === "initialize") {
      this.initialized = true;
      const requested = params?.protocolVersion;
      const protocolVersion =
        typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;
      return reply({
        protocolVersion,
        serverInfo: { name: "pi-ultrasearch", version: SERVER_VERSION },
        capabilities: { tools: { listChanged: false } },
      });
    }

    if (method === "notifications/initialized" || method === "notifications/cancelled") {
      return null;
    }

    if (method === "ping") {
      return reply({});
    }

    // Everything below the handshake is rejected until `initialize` arrives.
    if (!this.initialized) {
      return isNotification ? null : fail(JSON_RPC_ERRORS.NOT_INITIALIZED, "Server not initialized");
    }

    if (method === "tools/list") {
      return reply({ tools: this.surface });
    }

    if (method === "tools/call") {
      const rawName = params?.name;
      if (typeof rawName !== "string" || rawName.length === 0) {
        return fail(JSON_RPC_ERRORS.INVALID_PARAMS, "Invalid params: 'name' must be a string");
      }
      if (params?.arguments !== undefined && (params.arguments === null || typeof params.arguments !== "object" || Array.isArray(params.arguments))) {
        return fail(JSON_RPC_ERRORS.INVALID_PARAMS, "Invalid params: 'arguments' must be an object");
      }
      const canonical = this.surfaceNames.get(rawName);
      if (!canonical) {
        return fail(JSON_RPC_ERRORS.INVALID_PARAMS, `Unknown tool: ${rawName}`);
      }
      try {
        return reply(await this.callTool(canonical, params?.arguments ?? {}));
      } catch (toolErr: any) {
        // A tool that ran and failed is a result, not a protocol error.
        return reply({
          content: [{ type: "text", text: `UltraSearch error: ${toolErr?.message ?? toolErr}` }],
          isError: true,
        });
      }
    }

    return isNotification ? null : fail(JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }

  private async callTool(
    name: string,
    args: any
  ): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean; _meta?: Record<string, unknown> }> {    const activeRoot = typeof args.path === "string" ? path.resolve(this.cwd, args.path) : this.cwd;
    const text = (t: string, isError = false, meta?: Record<string, unknown>) => ({
      content: [{ type: "text" as const, text: t }],
      ...(isError ? { isError: true } : {}),
      ...(meta ? { _meta: meta } : {}),
    });

    if (name === "ultrasearch_query") {
      if (typeof args.query !== "string" || args.query.length === 0) {
        return text("Invalid params: 'query' must be a non-empty string", true);
      }
      const limit = args.limit ?? 30;
      let hits: any[];
      let meta: Record<string, unknown>;
      let rootNote = "";
      if (!args.global && this.roots.length > 0) {
        // Multi-root workspace (#28): fan out, dedupe by realpath, keep the
        // active worktree's copy, and attribute extra-root hits.
        const merged = await multiRootSearch(args.query, {
          activeRoot,
          roots: this.roots,
          limit,
          search: (q, root) => this.client.search(q, { in: root, root, limit, near: args.near, budget_ms: args.budget_ms }),
        });
        hits = merged.hits;
        // Merged per-root answers cannot claim completeness the engine never
        // reported (each root may have been clipped by `limit`).
        meta = { complete: false, tool: "ultrasearch_query", hitCount: hits.length, roots: merged.roots.length, duplicates: merged.duplicates, ...(merged.errors.length ? { errors: merged.errors } : {}) };
        rootNote = merged.duplicates > 0 ? `\n# ${merged.duplicates} duplicate(s) collapsed across ${merged.roots.length} roots` : "";
      } else {
        const res = await this.client.search(args.query, {
          in: args.global ? undefined : activeRoot,
          limit,
          near: args.near,
          budget_ms: args.budget_ms,
        });
        hits = res.hits ?? [];
        meta = { ...(res.meta ?? { complete: false }), tool: "ultrasearch_query", hitCount: hits.length };
      }
      this.recordToolQuery("ultrasearch_query", args.query, hits.length, activeRoot);
      if (hits.length === 0) {
        const hint = await diagnoseEmptyQuery(args.query, activeRoot, this.client);
        return text(`No files matching "${args.query}" found.\n💡 Hint: ${hint ?? "Verify exact symbol casing."}${rootNote}`, false, meta);
      }
      const attributed = hits.map((h: any) => {
        const tags = args.explain === false ? "" : explainReasonTags(args.query, h).map((t: string) => `[${t}]`).join(" ");
        const suffix = tags ? ` ${tags}` : "";
        return rootNote && !h.active && h.root
          ? `${h.path} [root: ${h.root}] (${h.kind}, score: ${h.score})${suffix}`
          : `${h.path} (${h.kind}, score: ${h.score})${suffix}`;
      });
      return text(`${attributed.join("\n")}${rootNote}`, false, meta);
    }

    if (name === "ultrasearch_grep") {
      if (typeof args.pattern !== "string" || args.pattern.length === 0) {
        return text("Invalid params: 'pattern' must be a non-empty string", true);
      }
      const searchScope = args.global ? undefined : args.path_filter ? path.resolve(activeRoot, args.path_filter) : activeRoot;
      const ctxCount = typeof args.context === "number" ? args.context : 0;
      let files: any[] = [];
      let resultMeta: any = undefined;
      let grepRootNote = "";
      if (!args.global && !args.path_filter && this.roots.length > 0) {
        // Multi-root grep (#28): merge by realpath, prefer the active worktree.
        const merged = await multiRootGrep(args.pattern, {
          activeRoot,
          roots: this.roots,
          grep: (p, root) => this.client.grep(p, { in: root, root, mode: args.mode ?? "literal", limit: args.limit ?? 30, context: ctxCount, budget_ms: args.budget_ms }),
        });
        files = merged.files;
        resultMeta = { complete: false, roots: merged.roots.length, duplicates: merged.duplicates, ...(merged.errors.length ? { errors: merged.errors } : {}) };
        grepRootNote = merged.duplicates > 0 ? `\n# ${merged.duplicates} duplicate file(s) collapsed across ${merged.roots.length} roots` : "";
      } else if (args.mode === "semantic") {
        // Shared gate with the Pi surface (src/semantic.ts): see SEMANTIC_REFUSAL for the
        // measured numbers and why the capability is kept rather than removed.
        if (!semanticEnabled()) {
          return { content: [{ type: "text", text: SEMANTIC_REFUSAL }], isError: true } as any;
        }
        const semantic = await searchSemanticIntent(this.client, args.pattern, { in: searchScope, limit: args.limit ?? 30, auditTool: "ultrasearch_grep" });
        files = semantic.files ?? [];
      } else {
        const res = await this.client.grep(args.pattern, {
          in: searchScope,
          mode: args.mode ?? "literal",
          limit: args.limit ?? 30,
          context: ctxCount,
          budget_ms: args.budget_ms,
        });
        if (!res.ok && res.error) {
          return text(`grep error: ${res.error}`, true, {
            ...(res.meta ?? { complete: false }),
            tool: "ultrasearch_grep",
            error: res.error,
            regexWarning: res.meta?.warning,
          });
        }
        files = res.files ?? [];
        resultMeta = res.meta;
      }
      this.recordToolQuery("ultrasearch_grep", args.pattern, files.length, activeRoot);
      if (files.length === 0) {
        const hint = await diagnoseEmptyQuery(args.pattern, activeRoot, this.client);
        return text(`No occurrences of "${args.pattern}" found.\n💡 Hint: ${hint ?? "Strict exact zero-typo matching enforced."}`, false, {
          ...(resultMeta ?? { complete: false }),
          tool: "ultrasearch_grep",
          fileCount: 0,
        });
      }
      const formatted = formatGrepFiles(files, {
        worktreeRoot: activeRoot,
        compact: args.compact ?? true,
        maxTokens: args.max_tokens,
        prioritizeSymbols: args.mode === "symbol",
        showContext: ctxCount > 0,
        tagSymbols: args.tag_symbols ?? (args.mode === "symbol"),
      });
      const warningText = resultMeta?.warning ? `\n[regex warning: ${resultMeta.warning}]` : "";
      return text(`${formatted.text}${warningText}${grepRootNote}`, false, {
        ...(resultMeta ?? { complete: false }),
        tool: "ultrasearch_grep",
        fileCount: files.length,
        tokenCount: formatted.tokenCount,
        truncatedCount: Math.max(formatted.truncatedCount, resultMeta?.truncatedCount ?? 0),
      });
    }

    if (name === "ultrasearch_multi_grep") {
      if (!Array.isArray(args.patterns) || args.patterns.length === 0 || !args.patterns.every((p: unknown) => typeof p === "string")) {
        return text("Invalid params: 'patterns' must be an array of strings", true);
      }
      const searchScope = args.path_filter ? path.resolve(activeRoot, args.path_filter) : activeRoot;
      const res = await this.client.multiGrep(args.patterns, { in: searchScope, limit: args.limit ?? 30, budget_ms: args.budget_ms });
      const files = res.files ?? [];
      const meta = { ...(res.meta ?? { complete: false }), tool: "ultrasearch_multi_grep", fileCount: files.length };
      if (files.length === 0) {
        return text(`No occurrences of [${args.patterns.join(", ")}] found.\n💡 Hint: Exact zero-typo matching enforced across all patterns.`, false, meta);
      }
      const formatted = formatGrepFiles(files, { worktreeRoot: activeRoot, compact: args.compact ?? true, maxTokens: args.max_tokens });
      return text(formatted.text, false, {
        ...meta,
        tokenCount: formatted.tokenCount,
        truncatedCount: Math.max(formatted.truncatedCount, res.meta?.truncatedCount ?? 0),
      });
    }

    if (name === "ultrasearch_locate") {
      if (typeof args.filename !== "string" || args.filename.length === 0) {
        return text("Invalid params: 'filename' must be a non-empty string", true);
      }
      const searchScope = args.global ? undefined : activeRoot;
      const res = await this.client.search(`'${args.filename}`, { in: searchScope, limit: 10, auditTool: "ultrasearch_locate" });
      const hits = res.hits ?? [];
      if (hits.length === 0) {
        const hint = await diagnoseEmptyQuery(args.filename, activeRoot, this.client);
        return text(`File "${args.filename}" not found in current scope.\n💡 Hint: ${hint ?? "Use ultrasearch_query for glob search across subdirectories."}`);
      }
      return text(hits.map((h) => h.path).join("\n"), false, {
        ...(res.meta ?? { complete: false }),
        tool: "ultrasearch_locate",
        hitCount: hits.length,
      });
    }

    if (name === "ultrasearch_recent") {
      const res = await this.client.recent(activeRoot, args.limit ?? 15);
      const hits = res.hits ?? [];
      return text(
        hits.map((h) => `${h.path} (score: ${h.score})`).join("\n") || "No recent files recorded in scope.",
        false,
        { ...(res.meta ?? { complete: false }), tool: "ultrasearch_recent", hitCount: hits.length }
      );
    }

    if (name === "ultrasearch_metrics") {
      const view = args.view === "all" || args.view === "synthetic" || args.view === "real" ? args.view : "real";
      const summary = summarizeAudit(typeof args.limit === "number" ? args.limit : 1000, { view });
      return text(formatAuditSummary(summary), false, {
        tool: "ultrasearch_metrics",
        view: summary.view,
        originCounts: summary.originCounts,
        totalCalls: summary.totalCalls,
      });
    }

    return text(`Unknown tool: ${name}`, true);
  }

  /**
   * Opt-in query history (#40). `appendHistory` itself gates on
   * `ULTRASEARCH_HISTORY`, so the default server records nothing.
   */
  private recordToolQuery(tool: string, query: string, hits: number, root: string): void {
    if (!this.recordHistory) return;
    try {
      appendHistory({ q: query, tool, hits, root });
    } catch {
      // History is a convenience; it must never fail a tool call.
    }
  }
}
