import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { UltraSearchClient } from "./src/client.ts";
import { isPathSafe, unsafeQueryScope, scrubSecrets } from "./src/sanitize.ts";
import { formatGrepFiles, explainReasonTags } from "./src/formatter.ts";
import { summarizeAudit, formatAuditSummary, resetAudit } from "./src/telemetry.ts";
import { analyzeCommandForBypass, diagnoseEmptyQuery } from "./src/observer.ts";
import { searchSemanticIntent, semanticEnabled, SEMANTIC_REFUSAL } from "./src/semantic.ts";
import { recordMistake } from "./src/recursive-learning.ts";
import { PrefetchController } from "./src/prefetch.ts";

const worktreeCache = new Map<string, { root: string; timestamp: number }>();
const CACHE_TTL_MS = 60_000;

/**
 * Resolves the top-level repository worktree root in <0.1ms using upward filesystem inspection,
 * caching results to avoid expensive child process spawns on every query.
 */
export function resolveWorktreeRoot(startDir = process.cwd()): string {
  const cached = worktreeCache.get(startDir);
  const now = performance.now();
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.root;
  }

  try {
    let curr = startDir;
    while (curr && curr !== path.dirname(curr)) {
      const gitPath = path.join(curr, ".git");
      if (fs.existsSync(gitPath)) {
        try {
          const stat = fs.statSync(gitPath);
          if (stat.isDirectory() || stat.isFile()) {
            worktreeCache.set(startDir, { root: curr, timestamp: now });
            return curr;
          }
        } catch {}
      }
      curr = path.dirname(curr);
    }

    // The upward .git walk above covers every real repository, including linked
    // worktrees (a .git *file*) and submodules. When no .git exists anywhere up
    // the tree, `git rev-parse` could only fail too, so it is not spawned: the
    // previous synchronous call cost 773 ms on a non-git cwd (issue #24).
  } catch {
    // Not a git repo or git unavailable
  }

  worktreeCache.set(startDir, { root: startDir, timestamp: now });
  return startDir;
}

/**
 * A one-line freshness warning when the daemon's index is behind a replay
 * (issue #19): an agent can then decide to re-run rather than trust a result
 * that may miss recent changes. Empty when the index is caught up.
 */
function freshnessHint(meta: any): string {
  const ms = meta?.staleMs ?? 0;
  return ms > 0 ? `\n[UltraSearch: index replay in progress, ${ms}ms behind; results may miss changes from that window]` : "";
}

/**
 * A one-line note when the daemon's policy withheld results (#23): the count
 * is reported rather than the rows being dropped silently, so "denied" is
 * never mistaken for "nothing matched".
 */
function withheldHint(meta: any): string {
  const n = meta?.withheld ?? 0;
  return n > 0 ? `\n[UltraSearch: ${n} path${n === 1 ? "" : "s"} withheld by policy]` : "";
}

export default function piUltraSearchExtension(pi: ExtensionAPI): void {
  const client = new UltraSearchClient({ harness: "pi" });
  // Issue #41: edited files are warmed after a debounce window, so the next
  // grep does not hit a cold content segment. Best-effort, never user-visible.
  const prefetcher = new PrefetchController({ client });

  // Helper to register tools cleanly across all Pi versions
  const register = (toolDef: any) => {
    if (typeof (pi as any).registerTool === "function") {
      (pi as any).registerTool(toolDef);
    }
  };

  // 1. ultrasearch_query: Fast path/file discovery with strict zero typo tolerance, globs, git filters, and proximity ranking
  register({
    name: "ultrasearch_query",
    label: "UltraSearch Query",
    description:
      "Exact indexed path search (<0.1ms, no typo tolerance). Accepts a name, glob (src/**/*.{ts,tsx}), extension filter (*.rs), or git status filter (git:modified, git:staged, git:untracked). `near` re-ranks by folder proximity. Scoped to the worktree unless global=true.",
    parameters: Type.Object({
      query: Type.String({
        description: "Name, glob, or filter (e.g. 'git:modified', 'src/**/*.{ts,tsx} !test/')",
      }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 30)" })),
      global: Type.Optional(Type.Boolean({ description: "Whole disk instead of the worktree" })),
      near: Type.Optional(Type.String({ description: "Re-rank by folder proximity to this path" })),
      explain: Type.Optional(Type.Boolean({ description: "Append match-reason tags (default true)" })),
      budget_ms: Type.Optional(Type.Number({ description: "Deadline (ms); partial results set complete:false" })),
    }),
    execute: async (_toolCallId: string, params: { query: string; limit?: number; global?: boolean; near?: string; budget_ms?: number; explain?: boolean }) => {
      try {
        const worktreeRoot = resolveWorktreeRoot();
        const searchScope = params.global ? undefined : worktreeRoot;

        // Parse optional inline near: filter if present in query string
        let cleanedQuery = params.query;
        let proximityTarget = params.near;
        const nearMatch = /\bnear:([^\s]+)/.exec(cleanedQuery);
        if (nearMatch) {
          proximityTarget = nearMatch[1];
          cleanedQuery = cleanedQuery.replace(nearMatch[0], "").trim();
        }

        // A query can name its own scope with `in:` (the daemon's own query
        // language), which a check on the tool parameters alone would miss.
        // Refused here for an actionable error, and again by the daemon via
        // `root` below: a caller bug must not widen a search.
        if (!params.global) {
          const escape = unsafeQueryScope(cleanedQuery, worktreeRoot);
          if (escape) {
            return {
              content: [
                {
                  type: "text",
                  text: `Security violation: query scope "${escape}" escapes the workspace root. Pass global: true for a disk-wide search.`,
                },
              ],
            };
          }
        }

        const res = await client.search(cleanedQuery, {
          in: searchScope,
          root: params.global ? undefined : worktreeRoot,
          limit: params.limit ?? 30,
          git: true,
          budget_ms: params.budget_ms,
          near: proximityTarget ? path.resolve(worktreeRoot, proximityTarget) : undefined,
        });

        if (!res.ok && res.error) {
          return { content: [{ type: "text", text: `UltraSearch error: ${res.error}` }] };
        }

        const hits = res.hits ?? [];

        // Telemetry & Diagnostic hint when 0 hits occur
        let hintText = "";
        if (hits.length === 0) {
          const hint = await diagnoseEmptyQuery(params.query, worktreeRoot, client);
          if (hint) hintText = `\n[UltraSearch Diagnostic: ${hint}]`;
        }

        if (hits.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No files matching "${params.query}" found (zero typo tolerance enforced).${hintText}${res.meta?.deadlineExceeded ? `\n[budget deadline ${res.meta.budgetMs}ms exceeded: no results before the deadline; narrow the scope or raise budget_ms]` : ""}`,
              },
            ],
            details: { tool: "ultrasearch_query", hitCount: 0, complete: res.meta?.complete ?? false, deadlineExceeded: res.meta?.deadlineExceeded ?? false, budgetMs: res.meta?.budgetMs },
          };
        }

        // A path can carry credential-shaped text (a token in a file name).
        // The same redactor that protects grep output applies to paths too, and
        // how many it changed is reported rather than silently masked.
        let dlpMasked = 0;
        const formatted = hits
          .map((h) => {
            const rel = h.path.startsWith(worktreeRoot) ? h.path.slice(worktreeRoot.length).replace(/^\//, "") : h.path;
            const safe = scrubSecrets(rel);
            if (safe !== rel) dlpMasked++;
            const gitTag = h.git ? ` [git:${h.git}]` : "";
            const distTag = h.distance !== undefined ? ` [dist:${h.distance}]` : "";
            // The daemon owns proximity ranking; its component is reported so
            // the ordering is explainable (see `server::nearness`).
            const nearTag = proximityTarget && h.near !== undefined ? ` [near:${h.near >= 0 ? "+" : ""}${h.near}]` : "";
            // #42: reason tags rendered from the engine's returned vector.
            const explain = params.explain === false ? "" : ` ${explainReasonTags(params.query, h).map((t) => `[${t}]`).join(" ")}`;
            return `${safe}${gitTag}${distTag}${nearTag}${explain} (${h.kind}, score: ${h.score})`;
          })
          .join("\n");

        const sourceNotice = res.source === "native_fallback" ? " (via native fallback)" : "";
        const dlpNote = dlpMasked > 0 ? ` [DLP: ${dlpMasked} path${dlpMasked === 1 ? "" : "s"} redacted]` : "";
        const budgetNotice = res.meta?.deadlineExceeded
          ? `\n[budget deadline ${res.meta.budgetMs}ms exceeded: partial results; narrow the scope or raise budget_ms]`
          : res.truncated
            ? `\n[truncated: ${res.meta?.truncatedCount ?? 0} more matches dropped by limit]`
            : "";
        return {
          content: [
            {
              type: "text",
              text: `Found ${hits.length} matches in ${((res.took_us ?? 0) / 1000).toFixed(2)}ms${sourceNotice}${dlpNote}:\n${formatted}${budgetNotice}${freshnessHint(res.meta)}${withheldHint(res.meta)}`,
            },
          ],
          details: {
            tool: "ultrasearch_query",
            hitCount: hits.length,
            complete: res.meta?.complete ?? false,
            truncated: res.meta?.truncated ?? false,
            truncatedCount: res.meta?.truncatedCount ?? 0,
            filteredCount: res.meta?.filteredCount ?? 0,
            tokenCount: res.meta?.tokenCount ?? 0,
            charCount: res.meta?.charCount ?? 0,
            source: res.source,
            budgetMs: res.meta?.budgetMs,
            deadlineExceeded: res.meta?.deadlineExceeded ?? false,
          },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `UltraSearch query unavailable: ${err?.message ?? err}` }],
        };
      }
    },
  });

  // 2. ultrasearch_grep: Instant indexed trigram text content search (<1ms)
  register({
    name: "ultrasearch_grep",
    label: "UltraSearch Grep",
    description:
      "Indexed content search (<1ms) with compact 'file:line: match' output; credentials are DLP-scrubbed.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Text or identifier to search" }),
      path_filter: Type.Optional(Type.String({ description: "Subfolder or file filter (e.g. 'src/')" })),
      mode: Type.Optional(Type.Union([Type.Literal("literal"), Type.Literal("regex"), Type.Literal("symbol"), Type.Literal("semantic")], {
        description: "literal (default) | regex | symbol (defs first) | semantic (intent)",
      })),
      limit: Type.Optional(Type.Number({ description: "Max files (default 30)" })),
      global: Type.Optional(Type.Boolean({ description: "Whole disk instead of the current scope" })),
      compact: Type.Optional(Type.Boolean({ description: "One-line 'file:line: match' (default true)" })),
      max_tokens: Type.Optional(Type.Number({ description: "Output token budget" })),
      context: Type.Optional(Type.Number({ description: "Context lines per match (0-5, default 0)" })),
      tag_symbols: Type.Optional(Type.Boolean({ description: "Tag AST definitions ([def:fn], [def:class])" })),
      budget_ms: Type.Optional(Type.Number({ description: "Deadline (ms); partial results set complete:false" })),
    }),
    execute: async (_toolCallId: string, params: { pattern: string; path_filter?: string; mode?: "literal" | "regex" | "symbol" | "semantic"; limit?: number; global?: boolean; compact?: boolean; max_tokens?: number; context?: number; tag_symbols?: boolean; budget_ms?: number }) => {
      try {
        const worktreeRoot = resolveWorktreeRoot();
        const baseScope = params.global ? undefined : worktreeRoot;
        const searchScope = params.path_filter
          ? (path.isAbsolute(params.path_filter) ? params.path_filter : path.join(worktreeRoot, params.path_filter))
          : baseScope;

        if (searchScope && !isPathSafe(searchScope, worktreeRoot) && !params.global) {
          return { content: [{ type: "text", text: "Security violation: path filter cannot escape workspace root." }] };
        }

        let files: any[] = [];
        let tookUs = 0;
        let sourceNotice = "";
        let resultMeta: any = undefined;

        if (params.mode === "semantic") {
          // The same gate as the MCP surface. The schema still lists semantic so the refusal can
          // explain itself; an agent that picks it must not silently get a confident-looking answer.
          if (!semanticEnabled()) {
            return { content: [{ type: "text", text: SEMANTIC_REFUSAL }], details: { tool: "ultrasearch_grep", mode: "semantic", refused: "experimental_opt_in" } };
          }
          const t0 = performance.now();
          const semantic = await searchSemanticIntent(client, params.pattern, {
            in: searchScope,
            limit: params.limit ?? 30,
            auditTool: "ultrasearch_grep",
          });
          files = semantic.files ?? [];
          tookUs = Math.round((performance.now() - t0) * 1000);
        } else {
          const res = await client.grep(params.pattern, {
            in: searchScope,
            root: params.global ? undefined : worktreeRoot,
            mode: (params.mode ?? "literal") as "literal" | "regex" | "symbol",
            limit: params.limit ?? 30,
            budget_ms: params.budget_ms ?? 2500,
            context: params.context ?? 0,
            tagSymbols: params.tag_symbols ?? (params.mode === "symbol"),
          });
          if (!res.ok && res.error) {
            return { content: [{ type: "text", text: `UltraSearch grep error: ${res.error}` }], details: { tool: "ultrasearch_grep", error: res.error, complete: false } };
          }
          files = res.files ?? [];
          tookUs = res.took_us ?? 0;
          sourceNotice = res.source === "native_fallback" ? " (native fallback)" : "";
          resultMeta = res.meta;
        }

        if (files.length === 0) {
          return { content: [{ type: "text", text: `No occurrences of "${params.pattern}" found.` }] };
        }

        const formatted = formatGrepFiles(files, {
          worktreeRoot,
          compact: params.compact,
          maxTokens: params.max_tokens,
          prioritizeSymbols: params.mode === "symbol",
          showContext: (params.context ?? 0) > 0,
          tagSymbols: params.tag_symbols ?? (params.mode === "symbol"),
        });

        // Feed the recursive learner with real DLP interceptions instead of test fixtures
        if (formatted.text.includes("[DLP_PROTECTED") || formatted.text.includes("[REDACTED_")) {
          recordMistake("dlp_violation", params.pattern, `DLP masked credential material while grepping ${searchScope ?? "workspace"}`);
        }

        const modeTag = params.mode === "semantic" ? " (semantic)" : "";
        const notices: string[] = [];
        if (resultMeta?.warning) notices.push(`[regex warning: ${resultMeta.warning}]`);
        if (resultMeta?.deadlineExceeded) notices.push(`[budget deadline ${resultMeta.budgetMs}ms exceeded: partial results; narrow the scope or raise budget_ms]`);
        else if (resultMeta?.truncated) notices.push(`[result truncated: ${resultMeta.truncatedCount ?? 0} files dropped by limit after ignoring ${resultMeta.filteredCount ?? 0} filtered]`);
        if (formatted.truncatedCount > 0) notices.push(`[${formatted.truncatedCount} matches dropped by max_tokens]`);
        // Freshness (#19) and policy withholding (#23) are one line each, at
        // the end, where an agent reads them.
        for (const note of [freshnessHint(resultMeta), withheldHint(resultMeta)]) {
          if (note) notices.push(note.trim());
        }
        const noticeText = notices.length > 0 ? `\n${notices.join("\n")}` : "";
        return {
          content: [
            {
              type: "text",
              text: `Found matches across ${files.length} files in ${(tookUs / 1000).toFixed(2)}ms${sourceNotice}${modeTag} (~${formatted.tokenCount} tokens):\n${formatted.text}${noticeText}`,
            },
          ],
          details: {
            tool: "ultrasearch_grep",
            fileCount: files.length,
            complete: resultMeta?.complete ?? false,
            truncated: resultMeta?.truncated ?? false,
            truncatedCount: resultMeta?.truncatedCount ?? 0,
            filteredCount: resultMeta?.filteredCount ?? 0,
            tokenCount: formatted.tokenCount,
            charCount: resultMeta?.charCount ?? 0,
            maxTokensDropped: formatted.truncatedCount,
            source: resultMeta?.source,
            budgetMs: resultMeta?.budgetMs,
            deadlineExceeded: resultMeta?.deadlineExceeded ?? false,
            regexWarning: resultMeta?.warning,
          },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `UltraSearch grep unavailable: ${err?.message ?? err}` }],
        };
      }
    },
  });

  // 3. ultrasearch_multi_grep: Simultaneous multi-pattern OR content retrieval
  register({
    name: "ultrasearch_multi_grep",
    label: "UltraSearch Multi Grep",
    description: "OR-search several patterns in one indexed call.",
    parameters: Type.Object({
      patterns: Type.Array(Type.String({ description: "Patterns to OR" })),
      path_filter: Type.Optional(Type.String({ description: "Subfolder filter" })),
      limit: Type.Optional(Type.Number({ description: "Max files (default 30)" })),
      compact: Type.Optional(Type.Boolean({ description: "One-line 'file:line: match' (default true)" })),
      max_tokens: Type.Optional(Type.Number({ description: "Output token budget" })),
      budget_ms: Type.Optional(Type.Number({ description: "Deadline (ms); partial results set complete:false" })),
    }),
    execute: async (_toolCallId: string, params: { patterns: string[]; path_filter?: string; limit?: number; compact?: boolean; max_tokens?: number; budget_ms?: number }) => {
      try {
        const worktreeRoot = resolveWorktreeRoot();
        const searchScope = params.path_filter ? path.join(worktreeRoot, params.path_filter) : worktreeRoot;

        const res = await client.multiGrep(params.patterns, {
          in: searchScope,
          root: worktreeRoot,
          limit: params.limit ?? 30,
          budget_ms: params.budget_ms,
        });

        const files = res.files ?? [];

        if (!res.ok && res.error) {
          return { content: [{ type: "text", text: `Multi-grep error: ${res.error}` }], details: { tool: "ultrasearch_multi_grep", error: res.error, complete: false } };
        }

        if (files.length === 0) {
          return { content: [{ type: "text", text: `No occurrences of [${params.patterns.join(", ")}] found.` }] };
        }

        const formatted = formatGrepFiles(files, {
          worktreeRoot,
          compact: params.compact,
          maxTokens: params.max_tokens,
        });
        const truncatedNotice = res.meta?.deadlineExceeded
          ? `\n[budget deadline ${res.meta.budgetMs}ms exceeded: partial results]`
          : res.meta?.truncated
            ? `\n[truncated: ${res.meta.truncatedCount ?? 0} files dropped by limit]`
            : "";
        return {
          content: [
            {
              type: "text",
              text: `Multi-grep matched ${files.length} files in ${((res.took_us ?? 0) / 1000).toFixed(2)}ms (~${formatted.tokenCount} tokens):\n${formatted.text}${truncatedNotice}`,
            },
          ],
          details: {
            tool: "ultrasearch_multi_grep",
            fileCount: files.length,
            complete: res.meta?.complete ?? false,
            truncated: res.meta?.truncated ?? false,
            truncatedCount: res.meta?.truncatedCount ?? 0,
            filteredCount: res.meta?.filteredCount ?? 0,
            tokenCount: formatted.tokenCount,
            charCount: res.meta?.charCount ?? 0,
            source: res.meta?.source,
            budgetMs: res.meta?.budgetMs,
            deadlineExceeded: res.meta?.deadlineExceeded ?? false,
          },
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Multi-grep error: ${err?.message ?? err}` }] };
      }
    },
  });

  // 4. ultrasearch_locate: O(1) exact file resolution
  register({
    name: "ultrasearch_locate",
    label: "UltraSearch Locate",
    description: "Exact filename lookup in the workspace (O(1) indexed).",
    parameters: Type.Object({
      filename: Type.String({ description: "Exact filename (e.g. 'package.json')" }),
      global: Type.Optional(Type.Boolean({ description: "Whole disk" })),
    }),
    execute: async (_toolCallId: string, params: { filename: string; global?: boolean }) => {
      try {
        const worktreeRoot = resolveWorktreeRoot();
        const searchScope = params.global ? undefined : worktreeRoot;
        const res = await client.search(`'${params.filename}`, {
          in: searchScope,
          root: params.global ? undefined : worktreeRoot,
          limit: 10,
          auditTool: "ultrasearch_locate",
        });

        const hits = res.hits ?? [];

        if (hits.length === 0) {
          return { content: [{ type: "text", text: `File "${params.filename}" not found.` }] };
        }

        // Paths go through the redactor like any other output (#23).
        const lines = hits.map((h) => scrubSecrets(h.path)).join("\n");
        return { content: [{ type: "text", text: `Located:\n${lines}` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Locate error: ${err?.message ?? err}` }] };
      }
    },
  });

  // 5. ultrasearch_recent: Recently worked files in the workspace / git branch
  register({
    name: "ultrasearch_recent",
    label: "UltraSearch Recent",
    description: "Recently edited workspace files, frecency-ranked.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Max files (default 15)" })),
    }),
    execute: async (_toolCallId: string, params: { limit?: number }) => {
      try {
        const worktreeRoot = resolveWorktreeRoot();
        const res = await client.recent(worktreeRoot, params.limit ?? 15);
        const hits = res.hits ?? [];

        if (hits.length === 0) {
          return { content: [{ type: "text", text: "No recent activity recorded for this workspace." }] };
        }
        const lines = hits.map((h) => scrubSecrets(h.path.replace(worktreeRoot, "").replace(/^\//, ""))).join("\n");
        return { content: [{ type: "text", text: `Recent workspace files:\n${lines}` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Recent activity query error: ${err?.message ?? err}` }] };
      }
    },
  });

  // 6. ultrasearch_metrics: Observability toolchain audit profiler & self-learning advice
  register({
    name: "ultrasearch_metrics",
    label: "UltraSearch Metrics",
    description: "Toolchain metrics: latency percentiles, error and zero-hit rates, tuning advice. Defaults to organic rows (gate/bench runs excluded).",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Rows to analyze (default 1000)" })),
      view: Type.Optional(Type.Union([Type.Literal("real"), Type.Literal("all"), Type.Literal("synthetic")], { description: "Provenance view (default real = organic only)" })),
    }),
    execute: async (_toolCallId: string, params: { limit?: number; view?: "real" | "all" | "synthetic" } = {}) => {
      const summary = summarizeAudit(params.limit ?? 1000, { view: params.view ?? "real" });
      const pool = client.poolStats();
      const text =
        `${formatAuditSummary(summary)}\n\n--- IPC Lanes ---\n` +
        `lanes: ${pool.lanes} (open: ${pool.open}) | in-flight: ${pool.inFlight} | created: ${pool.created} | closed: ${pool.closed} | active fallbacks: ${pool.activeFallbacks}`;
      return {
        content: [{ type: "text", text }],
        details: { view: summary.view, originCounts: summary.originCounts, totalCalls: summary.totalCalls, pool },
      };
    },
  });

  // Slash command: /ultrasearch [metrics|audit|reset|status]
  if (typeof (pi as any).registerCommand === "function") {
    const handleCommand = async (args: string, ctx: any) => {
      const [action, arg] = args.trim().toLowerCase().split(/\s+/);
      if (action === "metrics" || action === "audit") {
        const view = arg === "all" || arg === "synthetic" || arg === "real" ? (arg as "real" | "all" | "synthetic") : "real";
        const summary = summarizeAudit(1000, { view });
        ctx?.ui?.notify(formatAuditSummary(summary), "info");
      } else if (action === "reset") {
        resetAudit();
        ctx?.ui?.notify("UltraSearch audit log cleared.", "info");
      } else {
        const status = await client.status();
        ctx?.ui?.notify(
          `UltraSearch v0.3.1 daemon active: ${status.entries ?? 0} files indexed; index size: ${((status.index_bytes ?? 0) / 1024 / 1024).toFixed(1)}MB`,
          "info"
        );
      }
    };

    (pi as any).registerCommand("ultrasearch", {
      description: "UltraSearch telemetry, toolchain audit, and status.",
      handler: handleCommand,
    });
  }

  // 7. Toolchain Shadow Detector & File Touch lifecycle tracking via tool_execution_end
  if (typeof (pi as any).on === "function") {
    (pi as any).on("tool_execution_end", async (event: any) => {
      const toolName = event?.toolName;

      // Shadow Detector: check if agent bypassed ultrasearch with bash/powershell find or rg
      if (toolName === "bash" || toolName === "powershell") {
        const cmd = event?.params?.command || event?.params?.cmd;
        const duration = event?.durationMs ?? 20;
        if (typeof cmd === "string") {
          analyzeCommandForBypass(cmd, duration);
        }
      }

      // Frecency touch tracking
      const filePath =
        event?.params?.path ||
        event?.params?.target_file ||
        event?.params?.file ||
        event?.params?.absolute_path;

      if (
        (toolName === "read" ||
          toolName === "edit" ||
          toolName === "write" ||
          toolName === "client_view_file" ||
          toolName === "client_edit_file" ||
          toolName === "client_create_file") &&
        typeof filePath === "string"
      ) {
        client.open(filePath).catch(() => {});
      }

      // Prefetch on edit/write (#41): debounced warm-up of the file's
      // trigrams. Reads do not change content, so they do not warm anything.
      if (
        (toolName === "edit" || toolName === "write" || toolName === "client_edit_file" || toolName === "client_create_file") &&
        typeof filePath === "string"
      ) {
        prefetcher.touch(filePath);
      }
    });
  }
}
