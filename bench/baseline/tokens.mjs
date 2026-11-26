// bench/baseline/tokens.mjs
// Token-output baseline, wave1/baseline (verifier).
//
// Fixed 10-task set. For each task this script reproduces the exact text the
// index.ts tool handler returns (same client options, same formatter options)
// and records character counts plus a documented token estimate.
//
//   PI_ULTRASEARCH_TEST=1 node bench/baseline/tokens.mjs
//
// Outputs: results/tokens-baseline.json and TOKENS.md

import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  REPO_ROOT,
  FIXTURE_ROOT,
  FIXTURE_SPECIAL,
  HERE,
  ensureTestEnv,
  initClientModule,
  makeClient,
  timeExec,
  machineInfo,
  utcDate,
  utcDateShort,
  saveJSON,
  requireFixture,
  log,
  environmentGate,
  finalizeEnvironmentStatus,
} from "./lib.mjs";
import * as fs from "node:fs";

ensureTestEnv();

const ESTIMATOR = "ceil(characters / 4)";
// Constructed so the full literal never appears in committed sources (finding F2).
const ABSENT_GREP_TOKEN = "zzz_absent_" + "token_9c3f";

const TASKS = [
  {
    id: "t01",
    tool: "ultrasearch_query",
    scope: REPO_ROOT,
    params: { query: "package.json", limit: 30 },
    run: (c) => c.search("package.json", { in: REPO_ROOT, limit: 30, git: true, boost: true }),
  },
  {
    id: "t02",
    tool: "ultrasearch_query",
    scope: FIXTURE_ROOT,
    params: { query: FIXTURE_SPECIAL.markerFile, limit: 30 },
    run: (c) =>
      c.search(FIXTURE_SPECIAL.markerFile, { in: FIXTURE_ROOT, limit: 30, git: true, boost: true }),
  },
  {
    id: "t03",
    tool: "ultrasearch_query",
    scope: REPO_ROOT,
    params: { query: "zzz_absent_alpha_9c3f.ts", limit: 30 },
    run: (c) =>
      c.search("zzz_absent_alpha_9c3f.ts", { in: REPO_ROOT, limit: 30, git: true, boost: true }),
  },
  {
    id: "t04",
    tool: "ultrasearch_grep",
    scope: REPO_ROOT,
    params: { pattern: "UltraSearchClient", limit: 30, context: 0, mode: "literal" },
    run: (c) =>
      c.grep("UltraSearchClient", { in: REPO_ROOT, limit: 30, budget_ms: 2500, context: 0 }),
  },
  {
    id: "t05",
    tool: "ultrasearch_grep",
    scope: FIXTURE_ROOT,
    params: { pattern: FIXTURE_SPECIAL.marker, limit: 30, context: 0, mode: "literal" },
    run: (c) =>
      c.grep(FIXTURE_SPECIAL.marker, { in: FIXTURE_ROOT, limit: 30, budget_ms: 2500, context: 0 }),
  },
  {
    id: "t06",
    tool: "ultrasearch_grep",
    scope: FIXTURE_ROOT,
    params: { pattern: ABSENT_GREP_TOKEN, limit: 30, context: 0, mode: "literal" },
    run: (c) =>
      c.grep(ABSENT_GREP_TOKEN, { in: FIXTURE_ROOT, limit: 30, budget_ms: 2500, context: 0 }),
  },
  {
    id: "t07",
    tool: "ultrasearch_multi_grep",
    scope: REPO_ROOT,
    params: { patterns: ["recordAudit", "formatGrepFiles"], limit: 30 },
    run: (c) => c.multiGrep(["recordAudit", "formatGrepFiles"], { in: REPO_ROOT, limit: 30 }),
  },
  {
    id: "t08",
    tool: "ultrasearch_multi_grep",
    scope: FIXTURE_ROOT,
    params: { patterns: [FIXTURE_SPECIAL.marker, FIXTURE_SPECIAL.marker2], limit: 30 },
    run: (c) =>
      c.multiGrep([FIXTURE_SPECIAL.marker, FIXTURE_SPECIAL.marker2], { in: FIXTURE_ROOT, limit: 30 }),
  },
  {
    id: "t09",
    tool: "ultrasearch_locate",
    scope: null,
    params: { filename: "package.json", global: true, limit: 10 },
    run: (c) => c.search("'package.json", { limit: 10, auditTool: "ultrasearch_locate" }),
  },
  {
    id: "t10",
    tool: "ultrasearch_recent",
    scope: REPO_ROOT,
    params: { limit: 15 },
    run: (c) => c.recent(REPO_ROOT, 15),
  },
];

function pathSearchText(res, worktreeRoot) {
  const hits = res.hits ?? [];
  if (hits.length === 0) {
    // diagnoseEmptyQuery may append a dynamic hint at runtime; base text captured here.
    return {
      text: `No files matching "${res.__query}" found (zero typo tolerance enforced).`,
      dynamicHintPossible: true,
    };
  }
  const formatted = hits
    .map((h) => {
      const rel = h.path.startsWith(worktreeRoot)
        ? h.path.slice(worktreeRoot.length).replace(/^\//, "")
        : h.path;
      const gitTag = h.git ? ` [git:${h.git}]` : "";
      const distTag = h.distance !== undefined ? ` [dist:${h.distance}]` : "";
      return `${rel}${gitTag}${distTag} (${h.kind}, score: ${h.score})`;
    })
    .join("\n");
  const sourceNotice = res.source === "native_fallback" ? " (via native fallback)" : "";
  return {
    text: `Found ${hits.length} matches in ${((res.took_us ?? 0) / 1000).toFixed(2)}ms${sourceNotice}:\n${formatted}`,
    dynamicHintPossible: false,
  };
}

function grepText(res, formatter, worktreeRoot) {
  const files = res.files ?? [];
  if (files.length === 0) {
    return { text: `No occurrences of "${res.__pattern}" found.`, formatterTokens: null };
  }
  const formatted = formatter.formatGrepFiles(files, {
    worktreeRoot,
    compact: undefined,
    maxTokens: undefined,
    prioritizeSymbols: false,
    showContext: false,
    tagSymbols: false,
  });
  const sourceNotice = res.source === "native_fallback" ? " (native fallback)" : "";
  return {
    text: `Found matches across ${files.length} files in ${((res.took_us ?? 0) / 1000).toFixed(2)}ms${sourceNotice} (~${formatted.tokenCount} tokens):\n${formatted.text}`,
    formatterTokens: formatted.tokenCount,
  };
}

function multiText(res, formatter, worktreeRoot) {
  const files = res.files ?? [];
  if (files.length === 0) {
    return { text: `No occurrences of [${res.__patterns.join(", ")}] found.`, formatterTokens: null };
  }
  const formatted = formatter.formatGrepFiles(files, {
    worktreeRoot,
    compact: undefined,
    maxTokens: undefined,
  });
  return {
    text: `Multi-grep matched ${files.length} files in ${((res.took_us ?? 0) / 1000).toFixed(2)}ms (~${formatted.tokenCount} tokens):\n${formatted.text}`,
    formatterTokens: formatted.tokenCount,
  };
}

function locateText(res) {
  const hits = res.hits ?? [];
  if (hits.length === 0) return { text: `File "package.json" not found.` };
  return { text: `Located:\n${hits.map((h) => h.path).join("\n")}` };
}

function recentText(res, worktreeRoot) {
  const hits = res.hits ?? [];
  if (hits.length === 0) return { text: "No recent activity recorded for this workspace." };
  const lines = hits.map((h) => h.path.replace(worktreeRoot, "").replace(/^\//, "")).join("\n");
  return { text: `Recent workspace files:\n${lines}` };
}

async function main() {
  requireFixture();
  await initClientModule();
  const formatter = await import(pathToFileURL(path.join(REPO_ROOT, "src", "formatter.ts")).href);
  const client = makeClient({ timeoutMs: 20000 });
  const daemonStatus = await client.status().catch(() => null);
  const preGate = environmentGate(daemonStatus);
  log(`environment gate: ${preGate.status}`);

  const meta = {
    suite: "tokens",
    wave: "wave1/baseline",
    generated_at: utcDate(),
    date_short: utcDateShort(),
    commit: timeExec("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.trim(),
    branch: timeExec("git", ["branch", "--show-current"], { cwd: REPO_ROOT }).stdout.trim(),
    machine: machineInfo(),
    daemon: daemonStatus,
    estimator: {
      formula: ESTIMATOR,
      rationale:
        "Characters/4 is the standard rough BPE estimate for English prose and source code. " +
        "It is an ESTIMATE, not a tokenizer measurement: error is typically ±20%, worse for CJK, " +
        "base64, minified JSON or long identifiers. Only deltas measured with the SAME estimator " +
        "are meaningful; do not compare against counts from a different tokenizer.",
      limits: [
        "Timing strings inside tool text (e.g. 'in 2.63ms') are dynamic; run-to-run variation is <15 chars.",
        "The zero-hit path-search text may gain a dynamic diagnostic hint at runtime (not captured here).",
        "Formatter tokenCount itself uses ceil(chars/4); it is not an independent measurement.",
      ],
    },
    tasks: TASKS.map((t) => ({ id: t.id, tool: t.tool, params: t.params })),
  };

  const results = [];
  for (const t of TASKS) {
    const res = await t.run(client);
    if (t.tool === "ultrasearch_query") res.__query = t.params.query;
    if (t.tool === "ultrasearch_grep") res.__pattern = t.params.pattern;
    if (t.tool === "ultrasearch_multi_grep") res.__patterns = t.params.patterns;

    let built;
    if (t.tool === "ultrasearch_query") built = pathSearchText(res, t.scope ?? REPO_ROOT);
    else if (t.tool === "ultrasearch_grep") built = grepText(res, formatter, t.scope ?? REPO_ROOT);
    else if (t.tool === "ultrasearch_multi_grep") built = multiText(res, formatter, t.scope ?? REPO_ROOT);
    else if (t.tool === "ultrasearch_locate") built = locateText(res);
    else built = recentText(res, t.scope ?? REPO_ROOT);

    const text = built.text;
    const rec = {
      id: t.id,
      tool: t.tool,
      scope: t.scope,
      params: t.params,
      ok: res.ok !== false,
      us_source: res.source ?? null,
      took_us: res.took_us ?? null,
      hit_count: (res.hits ?? res.files ?? []).length,
      tool_text_chars: text.length,
      tool_text_lines: text.split("\n").length,
      estimated_tokens: Math.ceil(text.length / 4),
      formatter_token_count: built.formatterTokens ?? null,
      raw_json_chars: JSON.stringify(res).length,
      dynamic_hint_possible: Boolean(built.dynamicHintPossible),
      tool_text_sample: text.slice(0, 1500),
      tool_text_sample_truncated: text.length > 1500,
    };
    results.push(rec);
    log(
      `${t.id} ${t.tool} hits=${rec.hit_count} chars=${rec.tool_text_chars} est_tokens=${rec.estimated_tokens}`,
    );
  }
  client.close();

  const summary = {
    tasks: results.length,
    total_tool_text_chars: results.reduce((a, r) => a + r.tool_text_chars, 0),
    total_estimated_tokens: results.reduce((a, r) => a + r.estimated_tokens, 0),
    max_task_tokens: Math.max(...results.map((r) => r.estimated_tokens)),
    median_task_tokens: [...results.map((r) => r.estimated_tokens)].sort((a, b) => a - b)[
      Math.floor(results.length / 2)
    ],
  };

  const environment = finalizeEnvironmentStatus(preGate, environmentGate(daemonStatus));
  meta.status = environment.status;
  meta.environment = environment;
  const out = { meta, summary, tasks: results };
  const file = saveJSON("tokens-baseline.json", out);

  // ---- TOKENS.md -----------------------------------------------------------
  const md = [];
  md.push("# Token-output baseline — pi-ultrasearch (wave1/baseline)");
  md.push("");
  md.push(`Frozen: ${meta.generated_at} · commit \`${meta.commit}\` · ${meta.machine.chip}, Node ${meta.machine.node}`);
  md.push("");
  md.push("## Why this exists");
  md.push("");
  md.push(
    "Agent context is the scarce resource. This file freezes how many characters each UltraSearch tool",
    "returns for a fixed 10-task set, so later waves can quantify output-size claims against it.",
  );
  md.push("");
  md.push("## Estimator and its limits");
  md.push("");
  md.push(`**Estimate:** \`${ESTIMATOR}\` — ${meta.estimator.rationale}`);
  md.push("");
  md.push("Known limits:");
  for (const l of meta.estimator.limits) md.push(`- ${l}`);
  md.push("");
  md.push("## Frozen task set");
  md.push("");
  md.push("| # | Tool | Scope | Params | Hits | Chars | Est. tokens | Formatter tokens | Raw JSON chars |");
  md.push("|---|------|-------|--------|-----:|------:|------------:|-----------------:|---------------:|");
  for (const r of results) {
    const p = JSON.stringify(r.params).replace(/\|/g, "\\|");
    md.push(
      `| ${r.id} | ${r.tool} | ${r.scope ? r.scope.replace(os.homedir(), "~") : "(global)"} | \`${p}\` | ${r.hit_count} | ${r.tool_text_chars} | ${r.estimated_tokens} | ${r.formatter_token_count ?? "—"} | ${r.raw_json_chars} |`,
    );
  }
  md.push("");
  md.push(
    `**Totals:** ${summary.total_tool_text_chars.toLocaleString("en-US")} chars ≈ ${summary.total_estimated_tokens.toLocaleString("en-US")} estimated tokens across ${summary.tasks} tasks.`,
  );
  md.push("");
  md.push("## How later waves must use this");
  md.push("");
  md.push("1. Re-run `node bench/baseline/tokens.mjs` on the wave branch (never accept author-provided numbers).");
  md.push("2. Compare per-task `tool_text_chars` (and derived `estimated_tokens`) with the frozen JSON.");
  md.push("3. A token-reduction claim needs: same task set, same estimator, raw JSON committed, and the");
  md.push("   verifier's own re-measurement. Character deltas below noise (±15 chars from timing strings) are not evidence.");
  md.push("4. Cross-check with a real tokenizer if available; report the estimator's deviation, don't hide it.");
  md.push("");
  md.push("Reproduce:");
  md.push("");
  md.push("```bash");
  md.push("PI_ULTRASEARCH_TEST=1 node bench/baseline/tokens.mjs");
  md.push("```");
  md.push("");

  fs.writeFileSync(path.join(HERE, "TOKENS.md"), md.join("\n"), "utf8");

  console.log("\n=== TOKEN BASELINE ===");
  for (const r of results) {
    console.log(
      `${r.id} ${r.tool.padEnd(20)} hits=${String(r.hit_count).padStart(4)} chars=${String(r.tool_text_chars).padStart(6)} est_tokens=${String(r.estimated_tokens).padStart(5)}`,
    );
  }
  console.log(`total: ${summary.total_tool_text_chars} chars ~ ${summary.total_estimated_tokens} tokens`);
  console.log(`\nraw JSON: ${file}\nTOKENS.md: ${path.join(HERE, "TOKENS.md")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
