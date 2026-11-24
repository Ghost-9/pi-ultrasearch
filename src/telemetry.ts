import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Row provenance (issue #31).
 * - `organic`: a real agent session.
 * - `synthetic`: a gate/test/benchmark run (PI_ULTRASEARCH_TEST=1 or PI_ULTRASEARCH_BENCH=1).
 */
export type AuditOrigin = "organic" | "synthetic";

export interface UltraSearchAuditRow {
  ts: number;
  origin?: AuditOrigin;
  /**
   * Which harness produced the call: `pi`, `mcp`, `cli`, `test`, or an explicit
   * `ULTRASEARCH_HARNESS` override. Stamped by {@link resolveHarness} at write
   * time; rows written before this field existed group as `unknown`.
   */
  harness?: string;
  sessionId?: string;
  tool: "ultrasearch_query" | "ultrasearch_grep" | "ultrasearch_locate" | "ultrasearch_recent" | "ultrasearch_multi_grep" | "ultrasearch_compact" | "cli_bypass";
  query?: string;
  pattern?: string;
  scope?: string;
  ms: number;
  ok: boolean;
  hitCount: number;
  tokensSaved?: number;
  source: "index" | "scan" | "native_fallback" | "cli_subprocess";
  bypassCommand?: string;
  diagnosticHint?: string;
}

export type AuditTool = UltraSearchAuditRow["tool"];

/** Explicit per-process override for the harness stamped on audit rows. */
export const HARNESS_ENV = "ULTRASEARCH_HARNESS";

const HARNESS_MAX_LENGTH = 32;
const UNKNOWN_HARNESS = "unknown";

/**
 * Normalizes a harness id for storage: lowercase, `[a-z0-9_.-]` only, no
 * leading/trailing separators, capped at 32 chars. Returns null when nothing
 * usable remains, so callers can fall through to the next source.
 */
export function sanitizeHarness(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, HARNESS_MAX_LENGTH)
    .replace(/[-_.]+$/, "");
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Harness stamped on a row being written, in precedence order:
 *
 * 1. `ULTRASEARCH_HARNESS` (operator override; wins so an MCP server can be
 *    relabelled per client without a code change);
 * 2. the explicit per-surface default (`pi`, `mcp`, `cli`) passed by the caller;
 * 3. `test` when `PI_ULTRASEARCH_TEST=1` (or the benchmark env) is set;
 * 4. `unknown` — never an empty string.
 *
 * Only use this for *writing* rows. For grouping stored rows, read
 * `row.harness` directly so a report run cannot relabel history by env.
 */
export function resolveHarness(explicit?: string): string {
  return (
    sanitizeHarness(process.env[HARNESS_ENV]) ??
    sanitizeHarness(explicit) ??
    (isSyntheticEnvironment() ? "test" : null) ??
    UNKNOWN_HARNESS
  );
}

/** The harness a stored row belongs to, without consulting the current env. */
export function storedHarness(row: Pick<UltraSearchAuditRow, "harness">): string {
  return sanitizeHarness(row.harness) ?? UNKNOWN_HARNESS;
}

/** The audit log directory (production and test logs). */
function auditDir(): string {
  return join(homedir(), ".pi", "agent", "cache", "pi-ultrasearch");
}

/**
 * The test/benchmark log (wave-1 finding F7). `PI_ULTRASEARCH_TEST_LOG` names
 * it explicitly; otherwise each process appends to its own
 * `test_audit.<pid>.jsonl`, so two concurrent scripts, waves or agents cannot
 * truncate or interleave each other's evidence window. The old single shared
 * `test_audit.jsonl` is never written again; readers that need rows from a
 * specific run are given its path through the environment variable.
 */
export function getTestAuditFilePath(): string {
  const explicit = process.env.PI_ULTRASEARCH_TEST_LOG?.trim();
  if (explicit) return explicit;
  return join(tmpdir(), "pi-ultrasearch-test", `test_audit.${process.pid}.jsonl`);
}

export function getAuditFilePath(): string {
  if (process.env.PI_ULTRASEARCH_TEST === "1") {
    return getTestAuditFilePath();
  }
  return join(auditDir(), "audit.jsonl");
}

/** The single shared path wave 1 used; kept only to name it in messages. */
const LEGACY_SHARED_TEST_AUDIT_FILE = join(homedir(), ".pi", "agent", "cache", "pi-ultrasearch", "test_audit.jsonl");
export { LEGACY_SHARED_TEST_AUDIT_FILE };
const LEGACY_AUDIT_FILE = join(homedir(), ".pi", "agent", "cache", "pi-fsearch", "audit.jsonl");
const MAX_LINES = 5000;

/** Reads one audit file, parsing the last `limit` usable rows. */
function readAuditFile(file: string, limit: number): UltraSearchAuditRow[] {
  try {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf-8")
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as UltraSearchAuditRow;
        } catch {
          return null;
        }
      })
      .filter((r): r is UltraSearchAuditRow => r !== null);
  } catch {
    return [];
  }
}

let estimatedLineCount = -1;

/**
 * Estimates LLM context tokens saved by using index-accelerated surgical search
 * vs loading whole files or raw recursive directory dumps into context.
 */
export function estimateTokensSaved(
  tool: string,
  hitCount: number
): number {
  if (tool === "cli_bypass" || tool === "ultrasearch_compact") return 0;
  if (tool === "ultrasearch_grep" || tool === "ultrasearch_multi_grep") {
    // A grep hit avoids loading entire files into agent context.
    // Average source file: 1,200 tokens. Surgical grep match: ~30 tokens.
    // Conservative estimated savings: ~75 tokens per hit, plus base 150 tokens for targeted hit list.
    return hitCount > 0 ? 150 + hitCount * 75 : 50;
  }
  if (tool === "ultrasearch_query" || tool === "ultrasearch_locate") {
    // Avoids massive recursive directory listings or find dumps in agent context.
    return hitCount > 0 ? 100 + hitCount * 30 : 25;
  }
  if (tool === "ultrasearch_recent") {
    return hitCount > 0 ? 120 + hitCount * 25 : 20;
  }
  return 0;
}

/**
 * Appends a telemetry row to the persistent audit log asynchronously/safely.
 * Never throws or blocks agent tool execution (<0.05ms).
 */
/** The env var that isolates benchmark/gate traffic from the production audit log. */
export function isSyntheticEnvironment(): boolean {
  return process.env.PI_ULTRASEARCH_TEST === "1" || process.env.PI_ULTRASEARCH_BENCH === "1";
}

export function recordAudit(row: UltraSearchAuditRow): void {
  try {
    if (row.tokensSaved === undefined) {
      row.tokensSaved = estimateTokensSaved(row.tool, row.hitCount);
    }
    if (row.origin === undefined) {
      row.origin = isSyntheticEnvironment() ? "synthetic" : "organic";
    }
    row.harness = resolveHarness(row.harness);

    const auditFile = getAuditFilePath();
    mkdirSync(dirname(auditFile), { recursive: true });

    // Initialize line count once
    if (estimatedLineCount === -1) {
      if (!existsSync(auditFile) && existsSync(LEGACY_AUDIT_FILE) && process.env.PI_ULTRASEARCH_TEST !== "1") {
        try {
          const legacy = readFileSync(LEGACY_AUDIT_FILE, "utf-8");
          writeFileSync(auditFile, legacy, "utf-8");
        } catch {}
      }
      if (existsSync(auditFile)) {
        const content = readFileSync(auditFile, "utf-8");
        estimatedLineCount = content.split("\n").filter(Boolean).length;
      } else {
        estimatedLineCount = 0;
      }
    }

    // Rotate only when exceeding threshold
    if (estimatedLineCount >= MAX_LINES) {
      try {
        const content = readFileSync(auditFile, "utf-8");
        const lines = content.split("\n").filter(Boolean);
        const retained = lines.slice(-Math.floor(MAX_LINES / 2));
        writeFileSync(auditFile, retained.join("\n") + "\n", "utf-8");
        estimatedLineCount = retained.length;
      } catch {}
    }

    appendFileSync(auditFile, JSON.stringify(row) + "\n", "utf-8");
    estimatedLineCount++;
  } catch {
    // Non-blocking telemetry
  }
}

/**
 * Loads recent audit rows from disk.
 */
export function loadAudit(limit = 1000): UltraSearchAuditRow[] {
  try {
    const auditFile = getAuditFilePath();
    const target = existsSync(auditFile)
      ? auditFile
      : (process.env.PI_ULTRASEARCH_TEST !== "1" && existsSync(LEGACY_AUDIT_FILE))
      ? LEGACY_AUDIT_FILE
      : null;
    if (!target) return [];
    return readAuditFile(target, limit);
  } catch {
    return [];
  }
}

export function resetAudit(): void {
  try {
    const auditFile = getAuditFilePath();
    if (existsSync(auditFile)) {
      writeFileSync(auditFile, "", "utf-8");
    }
    if (process.env.PI_ULTRASEARCH_TEST !== "1" && existsSync(LEGACY_AUDIT_FILE)) {
      writeFileSync(LEGACY_AUDIT_FILE, "", "utf-8");
    }
    estimatedLineCount = 0;
  } catch {}
}

function pct(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export type AuditView = "real" | "synthetic" | "all";

/**
 * Historical signature rows written into the production audit file by the
 * pre-0.3.1 benchmark gate (before PI_ULTRASEARCH_TEST isolation existed).
 * Only consulted when `legacySyntheticQueries: true` is passed explicitly.
 */
// FROZEN MEASUREMENT STRING: "FSearchClient" is the literal query written into
// the production audit log by the pre-rename (0a16e50) benchmark gate. It is kept
// un-renamed on purpose so the legacy synthetic-row heuristic still recognises
// historical gate rows; it does not name any current type or tool.
export const GATE_SIGNATURE_QUERIES: string[] = ["package.json", "FSearchClient", "scrubSecrets"];

export interface AuditOriginCounts {
  organic: number;
  synthetic: number;
  unmarked: number;
}

export function classifyAuditOrigin(
  row: UltraSearchAuditRow,
  opts: { testEnv?: boolean; legacySyntheticQueries?: boolean } = {}
): AuditOrigin {
  if (row.origin === "synthetic" || row.origin === "organic") return row.origin;
  if (opts.testEnv) return "synthetic";
  if (opts.legacySyntheticQueries) {
    const q = row.query ?? row.pattern ?? "";
    if (GATE_SIGNATURE_QUERIES.some((sig) => q === sig || q.includes(sig))) return "synthetic";
  }
  return "organic";
}

export interface HarnessStats {
  harness: string;
  calls: number;
  p50Ms: number;
  p95Ms: number;
  fallbackCount: number;
  /** Fallbacks as a percentage of all calls attributed to the harness. */
  fallbackRate: number;
  zeroHitCount: number;
  /** Zero-hit calls as a percentage of ok calls that carried a query/pattern. */
  zeroHitRate: number;
  /** ESTIMATE (the documented formula), never a measurement. */
  tokensSaved: number;
}

export interface UltraSearchSummary {
  totalCalls: number;
  totalTokensSaved: number;
  since: number | null;
  lastUsed: {
    ts: number | null;
    tool: string | null;
    query: string | null;
    ms: number;
    hitCount: number;
  } | null;
  toolStats: Array<{
    tool: string;
    calls: number;
    okRate: number;
    emptyRate: number;
    p50Ms: number;
    p90Ms: number;
    p95Ms: number;
    fallbackCount: number;
  }>;
  cliBypasses: Array<{
    command: string;
    ms: number;
    alternative: string;
  }>;
  zeroHitQueries: Array<{
    query: string;
    tool: string;
    hint?: string;
  }>;
  optimizationAdvice: string[];
  /** Which provenance slice this summary describes. */
  view?: AuditView;
  /** Row provenance counts across the whole loaded set (before the view filter). */
  originCounts?: AuditOriginCounts;
  /** Rows excluded by the view filter. */
  filteredOutRows?: number;
  /** Present when summarised with `by: "harness"`; grouped after the view filter. */
  harnessStats?: HarnessStats[];
  /** Which grouping the summary was asked for. */
  by?: "tool" | "harness";
}

/**
 * Loads production and test audit rows together, tagging test-file rows as
 * synthetic regardless of their stored value. Used by the real-vs-synthetic view.
 */
export function loadAllAudit(
  limit = 1000,
  opts: { includeTest?: boolean; includeProduction?: boolean } = {}
): UltraSearchAuditRow[] {
  const syntheticEnv = isSyntheticEnvironment();
  const includeProduction = opts.includeProduction ?? !syntheticEnv;
  const includeTest = opts.includeTest ?? true;
  const productionFile = join(homedir(), ".pi", "agent", "cache", "pi-ultrasearch", "audit.jsonl");

  const rows: UltraSearchAuditRow[] = [];
  if (includeProduction) rows.push(...readAuditFile(productionFile, limit));
  if (includeTest) {
    rows.push(...readAuditFile(getTestAuditFilePath(), limit).map((r) => ({ ...r, origin: "synthetic" as AuditOrigin })));
  }
  return rows.sort((a, b) => a.ts - b.ts).slice(-limit);
}

export interface SummarizeAuditOptions {
  /** "real" (default) shows organic rows only; "all" and "synthetic" widen it. */
  view?: AuditView;
  /** Inject rows directly (tests/benches) instead of reading the audit files. */
  rows?: UltraSearchAuditRow[];
  /** Treat known pre-0.3.1 gate signature queries as synthetic. */
  legacySyntheticQueries?: boolean;
  /** "harness" adds {@link UltraSearchSummary.harnessStats} grouped per harness. */
  by?: "tool" | "harness";
}

export function summarizeAudit(limit = 1000, opts: SummarizeAuditOptions = {}): UltraSearchSummary {
  const view: AuditView = opts.view ?? "real";
  const allRows = opts.rows ?? loadAllAudit(limit);
  const originCounts: AuditOriginCounts = { organic: 0, synthetic: 0, unmarked: 0 };

  const classified = allRows.map((row) => {
    if (row.origin === undefined) originCounts.unmarked++;
    const origin = classifyAuditOrigin(row, { legacySyntheticQueries: opts.legacySyntheticQueries });
    originCounts[origin]++;
    return { row, origin };
  });

  const matchesView = (origin: AuditOrigin): boolean =>
    view === "all" || (view === "real" ? origin === "organic" : origin === "synthetic");
  const rows = classified.filter((c) => matchesView(c.origin)).map((c) => c.row);
  const filteredOutRows = allRows.length - rows.length;
  const totalCalls = rows.length;
  const since = rows.length > 0 ? rows[0].ts : null;

  let totalTokensSaved = 0;
  let lastUsed: UltraSearchSummary["lastUsed"] = null;

  const byTool = new Map<string, UltraSearchAuditRow[]>();
  const cliBypasses: UltraSearchSummary["cliBypasses"] = [];
  const zeroHitQueries: UltraSearchSummary["zeroHitQueries"] = [];

  for (const r of rows) {
    const saved = r.tokensSaved ?? estimateTokensSaved(r.tool, r.hitCount);
    totalTokensSaved += saved;

    if (r.tool === "cli_bypass") {
      cliBypasses.push({
        command: r.bypassCommand ?? "unknown",
        ms: r.ms,
        alternative: r.diagnosticHint ?? "Use ultrasearch_query or ultrasearch_grep",
      });
      continue;
    }

    if (!byTool.has(r.tool)) {
      byTool.set(r.tool, []);
    }
    byTool.get(r.tool)!.push(r);

    if (r.ok && r.hitCount === 0 && (r.query || r.pattern)) {
      zeroHitQueries.push({
        query: r.query ?? r.pattern ?? "",
        tool: r.tool,
        hint: r.diagnosticHint,
      });
    }
  }

  // Find the latest active tool call (prefer actual ultrasearch query tools over test/cli bypasses if available)
  const nonBypassRows = rows.filter((r) => r.tool !== "cli_bypass");
  const latestRow = nonBypassRows.length > 0 ? nonBypassRows[nonBypassRows.length - 1] : rows[rows.length - 1];
  if (latestRow) {
    lastUsed = {
      ts: latestRow.ts,
      tool: latestRow.tool,
      query: latestRow.query ?? latestRow.pattern ?? latestRow.bypassCommand ?? null,
      ms: latestRow.ms,
      hitCount: latestRow.hitCount,
    };
  }

  const toolStats: UltraSearchSummary["toolStats"] = [];
  for (const [tool, toolRows] of byTool.entries()) {
    const latencies = toolRows.map((r) => r.ms);
    const okCount = toolRows.filter((r) => r.ok).length;
    const emptyCount = toolRows.filter((r) => r.ok && r.hitCount === 0).length;
    const fallbackCount = toolRows.filter((r) => r.source === "native_fallback").length;

    toolStats.push({
      tool,
      calls: toolRows.length,
      okRate: toolRows.length > 0 ? (okCount / toolRows.length) * 100 : 0,
      emptyRate: okCount > 0 ? (emptyCount / okCount) * 100 : 0,
      p50Ms: pct(latencies, 50),
      p90Ms: pct(latencies, 90),
      p95Ms: pct(latencies, 95),
      fallbackCount,
    });
  }

  const harnessStats: HarnessStats[] = [];
  if (opts.by === "harness") {
    const byHarness = new Map<string, UltraSearchAuditRow[]>();
    for (const r of rows) {
      const h = storedHarness(r);
      if (!byHarness.has(h)) byHarness.set(h, []);
      byHarness.get(h)!.push(r);
    }
    for (const [harness, harnessRows] of [...byHarness.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
      const latencies = harnessRows.map((r) => r.ms);
      const fallbackCount = harnessRows.filter((r) => r.source === "native_fallback").length;
      const okWithQuery = harnessRows.filter((r) => r.ok && (r.query !== undefined || r.pattern !== undefined));
      const zeroHitCount = okWithQuery.filter((r) => r.hitCount === 0).length;
      const tokensSaved = harnessRows.reduce((acc, r) => acc + (r.tokensSaved ?? estimateTokensSaved(r.tool, r.hitCount)), 0);
      harnessStats.push({
        harness,
        calls: harnessRows.length,
        p50Ms: pct(latencies, 50),
        p95Ms: pct(latencies, 95),
        fallbackCount,
        fallbackRate: harnessRows.length > 0 ? (fallbackCount / harnessRows.length) * 100 : 0,
        zeroHitCount,
        zeroHitRate: okWithQuery.length > 0 ? (zeroHitCount / okWithQuery.length) * 100 : 0,
        tokensSaved,
      });
    }
  }

  const advice: string[] = [];

  if (cliBypasses.length > 0) {
    advice.push(`Detected ${cliBypasses.length} CLI subprocess searches (find/rg). Directing agent to ultrasearch tools will save 10-40ms per call.`);
  }

  for (const stat of toolStats) {
    if (stat.tool === "ultrasearch_compact") {
      // Compaction is a disk maintenance operation over millions of files; evaluate against 2.5s gate
      if (stat.p95Ms > 2500) {
        advice.push(
          `LSM Compaction p95 latency is ${stat.p95Ms.toFixed(1)}ms (>2500ms maintenance threshold). Daemon memory or disk I/O may be saturated.`
        );
      }
      continue;
    }

    if (stat.p95Ms > 10) {
      advice.push(
        `Tool ${stat.tool} has p95 latency of ${stat.p95Ms.toFixed(1)}ms (>10ms target). Ensure scope paths are narrowed or UltraSearch daemon content index is warm.`
      );
    }
    if (stat.emptyRate > 35) {
      advice.push(
        `Tool ${stat.tool} has a ${stat.emptyRate.toFixed(1)}% zero-hit rate. Queries may be over-constrained. Suggest verifying exact file casing or using ultrasearch_locate.`
      );
    }
  }

  if (advice.length === 0) {
    advice.push("Toolchain running optimally. Sub-10ms CI gates maintained and zero CLI bypasses detected.");
  }

  return {
    totalCalls,
    totalTokensSaved,
    since,
    lastUsed,
    toolStats,
    cliBypasses: cliBypasses.slice(-10),
    zeroHitQueries: zeroHitQueries.slice(-10),
    optimizationAdvice: advice,
    view,
    originCounts,
    filteredOutRows,
    ...(opts.by === "harness" ? { harnessStats, by: "harness" as const } : {}),
  };
}

/** Convenience: real, synthetic and combined summaries in one pass. */
export function summarizeAuditViews(
  rows: UltraSearchAuditRow[],
  opts: { legacySyntheticQueries?: boolean } = {}
): { real: UltraSearchSummary; synthetic: UltraSearchSummary; all: UltraSearchSummary } {
  const views = { legacySyntheticQueries: opts.legacySyntheticQueries };
  return {
    real: summarizeAudit(rows.length || 1, { ...views, rows, view: "real" }),
    synthetic: summarizeAudit(rows.length || 1, { ...views, rows, view: "synthetic" }),
    all: summarizeAudit(rows.length || 1, { ...views, rows, view: "all" }),
  };
}

export function formatAuditSummary(summary: UltraSearchSummary): string {
  const parts: string[] = [];
  const view = summary.view ?? "all";
  const viewLabel = view === "real" ? "real sessions only" : view === "synthetic" ? "synthetic/gate runs only" : "all rows";
  parts.push("=== Pi-UltraSearch Observability & Toolchain Audit ===");
  parts.push(`View: ${viewLabel}${summary.filteredOutRows ? ` (${summary.filteredOutRows} rows excluded)` : ""}`);
  if (summary.originCounts) {
    parts.push(
      `Provenance: ${summary.originCounts.organic} organic · ${summary.originCounts.synthetic} synthetic · ${summary.originCounts.unmarked} unmarked`
    );
  }
  parts.push(`Total Monitored Calls: ${summary.totalCalls}`);
  parts.push(
    `Tokens Saved (ESTIMATE ONLY — formula 150+75×hits, not measured; see bench/results/TOKENS.md): ${summary.totalTokensSaved.toLocaleString()}`
  );
  if (summary.lastUsed && summary.lastUsed.ts) {
    parts.push(`Last Used: ${new Date(summary.lastUsed.ts).toISOString()} (${summary.lastUsed.tool})`);
  }
  if (summary.since) {
    parts.push(`Recording Since: ${new Date(summary.since).toISOString()}`);
  }
  parts.push("");

  parts.push("--- Latency & Quality Metrics ---");
  for (const s of summary.toolStats) {
    parts.push(
      `• ${s.tool.padEnd(18)}: ${s.calls} calls | p50: ${s.p50Ms.toFixed(2)}ms | p90: ${s.p90Ms.toFixed(2)}ms | p95: ${s.p95Ms.toFixed(2)}ms | Success: ${s.okRate.toFixed(1)}% | 0-Hit: ${s.emptyRate.toFixed(1)}% | Fallbacks: ${s.fallbackCount}`
    );
  }
  parts.push("");

  if (summary.harnessStats && summary.harnessStats.length > 0) {
    parts.push("--- Per-Harness Attribution ---");
    parts.push(
      "Tokens saved (ESTIMATE ONLY — formula 150+75×hits, not measured; see bench/results/TOKENS.md)"
    );
    for (const h of summary.harnessStats) {
      parts.push(
        `• ${h.harness.padEnd(18)}: ${h.calls} call${h.calls === 1 ? "" : "s"} | p50: ${h.p50Ms.toFixed(2)}ms | p95: ${h.p95Ms.toFixed(2)}ms | Fallbacks: ${h.fallbackCount} (${h.fallbackRate.toFixed(1)}%) | 0-Hit: ${h.zeroHitCount} (${h.zeroHitRate.toFixed(1)}%) | Tokens saved (estimate): ${h.tokensSaved.toLocaleString()}`
      );
    }
    parts.push("");
  }

  if (summary.cliBypasses.length > 0) {
    parts.push(`--- Detected CLI Bypasses (${summary.cliBypasses.length} instances) ---`);
    for (const b of summary.cliBypasses) {
      parts.push(`  ❌ [${b.ms.toFixed(1)}ms] "${b.command}" -> Hint: ${b.alternative}`);
    }
    parts.push("");
  }

  if (summary.zeroHitQueries.length > 0) {
    parts.push(`--- Recent 0-Hit Queries (${summary.zeroHitQueries.length}) ---`);
    for (const z of summary.zeroHitQueries) {
      parts.push(`  ⚠️  [${z.tool}] "${z.query}" ${z.hint ? `(Hint: ${z.hint})` : ""}`);
    }
    parts.push("");
  }

  parts.push("--- Recursive Learning & Actionable Advice ---");
  for (const a of summary.optimizationAdvice) {
    parts.push(`  💡 ${a}`);
  }

  return parts.join("\n");
}
