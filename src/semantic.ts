/**
 * Semantic / intent retrieval (issue #26 adjacent, wave 2 relevance).
 *
 * Wave 1 measured semantic nDCG@10 = 0.19: `expandIntentKeywords` kept every
 * word longer than two characters (questions, stopwords, articles) and OR-ed
 * them through `multiGrep`, so the result order was effectively random.
 *
 * Wave 2 keeps the same dispatch contract (one `multiGrep` call over expanded
 * tokens — `test/e2e-regressions.test.ts` asserts this) but adds:
 *   1. stopword removal and light stemming over split identifiers;
 *   2. a software-engineering concept lexicon (natural phrase -> code tokens);
 *   3. file-level scoring over the candidate set (token-boundary term coverage,
 *      within-candidate IDF, declaration and path bonuses, length normalisation);
 *   4. an honest-absence gate: a query whose distinctive terms are mostly absent
 *      from the scope returns nothing instead of the least-bad files.
 */

import * as fs from "node:fs";
import { UltraSearchClient } from "./client.ts";
import type { UltraSearchGrepFile } from "./types.ts";
import type { AuditTool } from "./telemetry.ts";
import { extractSymbolsRegex } from "./symbols.ts";

export interface SemanticSearchResult {
  term: string;
  matchedTokens: string[];
  files: UltraSearchGrepFile[];
  confidence: number;
  /** Evidence summary for explain output and diagnostics. */
  evidence?: SemanticEvidence;
}

export interface SemanticEvidence {
  groups: Array<{ id: string; variants: string[]; present: boolean; df: number; weight: number; generic: boolean }>;
  coverage_ratio: number;
  abstained: boolean;
  reason: string;
  ranking: Array<{ path: string; score: number; coverage: number; path_hit: boolean; declared: string | null }>;
}

// ---------------------------------------------------------------- vocabulary

const STOPWORDS = new Set(
  (
    "a an and are as at be been being before after between both but by can could did do does doing during each few " +
    "for from further had has have having he her here hers herself him himself his how i if in into is it its itself " +
    "just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she " +
    "should so some such than that the their theirs them themselves then there these they this those through to too " +
    "under until up very was we were what when where which while who whom why will with would you your yours yourself " +
    "yourselves mid every across about above again against all am any because below down during get got into it's " +
    "doesn't don't isn't wasn't weren't won't wouldn't can't cannot could've should've would've"
  ).split(/\s+/)
);

/** Short identifiers that are real code vocabulary despite their length. */
const SHORT_ALLOWED = new Set(["ci", "db", "io", "os", "ui", "ip", "api", "mcp", "dlp", "cli", "tui", "pid", "sql", "jwt", "ttl", "sdk", "gl", "pr"]);

/**
 * Ubiquitous tokens that appear across a codebase for structural rather than
 * topical reasons. They never count as the "distinctive evidence" that makes a
 * query answerable, and they are down-weighted in scoring.
 */
const GENERIC_TOKENS = new Set(
  (
    "value values result results data file files code name names type types list item items string number numbers " +
    "error errors message messages example examples line lines text path paths test " +
    "tests run runs running use uses used using make makes made new set sets setting get gets getting add adds " +
    "added read reads write writes written output input content doc docs document documents index main size count " +
    "length start starts end ends time times case cases function functions method methods class classes object " +
    "objects array arrays true false null undefined return returns returned call calls called view views page pages " +
    "first last next previous current state states mode modes level levels kind kinds part parts item items thing " +
    "things way ways work works working even point points middle away whole decide decide happen happens goes " +
    "reaching reach reaches give gives take takes come comes put puts around along back still already also may " +
    "might must shall let lets likely possible must without within where when which while who whose"
  ).split(/\s+/)
);

/**
 * Software-engineering concept lexicon: a trigger token (stemmed) maps to code
 * tokens that commonly realise the concept. Keep this general (vocabulary of the
 * domain, not of a specific repository).
 */
const CONCEPT_SYNONYMS: Record<string, string[]> = {
  credential: ["secret", "sanitize", "scrub", "redact", "mask", "dlp", "passwd", "password", "auth", "token"],
  secret: ["credential", "sanitize", "scrub", "redact", "mask", "dlp", "guard"],
  scrub: ["sanitize", "redact", "mask", "credential", "secret", "clean"],
  sanitize: ["scrub", "redact", "mask", "secret", "credential", "clean", "guard"],
  redact: ["sanitize", "scrub", "mask", "secret", "credential"],
  mask: ["redact", "sanitize", "secret", "credential", "scrub", "guard"],
  leak: ["secret", "sanitize", "redact", "dlp", "guard"],
  token: ["tokens", "auth", "session", "credential"],
  session: ["token", "auth", "login", "cookie", "resident"],
  save: ["saving", "saved", "savings", "estimate", "telemetry", "metric"],
  saving: ["save", "saved", "savings", "estimate", "telemetry", "metric"],
  estimate: ["save", "saved", "token", "metric", "telemetry", "compute", "count"],
  compute: ["calculate", "formula", "estimate", "metric", "telemetry", "count", "derive"],
  formula: ["compute", "calculate", "estimate", "metric"],
  telemetry: ["metric", "audit", "estimate", "observe", "report"],
  metric: ["telemetry", "audit", "score", "count"],
  daemon: ["resident", "serve", "socket", "sock", "spawn", "reconnect", "retry", "fallback", "server"],
  socket: ["daemon", "sock", "reconnect", "retry", "fallback", "ipc", "connect", "unix"],
  sock: ["socket", "daemon", "ipc"],
  die: ["dead", "death", "exit", "crash", "reconnect", "retry", "fallback", "respawn", "restart", "kill"],
  dead: ["die", "exit", "crash", "fallback", "respawn"],
  crash: ["die", "dead", "exit", "fallback", "reconnect", "respawn"],
  reconnect: ["retry", "fallback", "socket", "dead", "respawn", "backoff", "disconnect"],
  retry: ["fallback", "reconnect", "backoff", "retries"],
  fallback: ["retry", "reconnect", "spawn", "scan", "rg", "native"],
  disconnect: ["reconnect", "retry", "fallback", "dead", "exit", "socket", "gone"],
  gone: ["disconnect", "reconnect", "fallback", "dead", "exit", "away"],
  away: ["gone", "disconnect", "reconnect", "fallback", "dead", "exit", "disappear"],
  ci: ["workflow", "github", "action", "pipeline", "push", "job", "matrix"],
  workflow: ["ci", "github", "action", "pipeline", "job"],
  push: ["ci", "workflow", "github", "action", "commit", "merge"],
  github: ["ci", "workflow", "action", "push"],
  boundary: ["worktree", "root", "scope", "outside", "contain", "pathsafe", "escape", "traverse", "guard", "repository", "prefix", "within"],
  repository: ["repo", "worktree", "root", "scope", "pathsafe", "boundary", "outside", "tree"],
  worktree: ["root", "scope", "repository", "pathsafe", "boundary", "git"],
  workspace: ["worktree", "root", "scope", "repository", "boundary"],
  scope: ["worktree", "root", "boundary", "pathsafe", "repo", "limit"],
  contain: ["boundary", "outside", "pathsafe", "guard", "escape", "safe", "traverse", "within"],
  inside: ["within", "outside", "pathsafe", "scope", "boundary", "contain", "escape"],
  outside: ["outside", "outside", "escape", "traverse", "boundary", "pathsafe", "contain"],
  symlink: ["symlink", "realpath", "resolve", "escape", "traverse", "outside", "prefix"],
  path: ["scope", "worktree", "root", "boundary", "filter", "safe"],
  traversal: ["traverse", "escape", "outside", "boundary", "safe"],
  guard: ["sanitize", "secret", "boundary", "safe", "contain"],
  auth: ["authentication", "login", "token", "session", "password", "credential", "permission"],
  authentication: ["auth", "login", "token", "session", "password", "credential"],
  login: ["auth", "authentication", "token", "session", "signin"],
  index: ["trigram", "content", "resident", "cache"],
  trigram: ["index", "content", "grep"],
  resident: ["daemon", "index", "resident"],
  buffered: ["buffer", "flush", "line"],
  compress: ["compaction", "compact", "truncate", "token"],
  compaction: ["compact", "compress", "truncate", "autocompact"],
  truncate: ["limit", "compaction", "token", "truncated", "partial"],
  ignore: ["gitignore", "rule", "filter", "exclude", "matcher", "pattern"],
  filter: ["ignore", "rule", "exclude", "match"],
  observe: ["telemetry", "metric", "audit", "monitor"],
  audit: ["telemetry", "metric", "record", "log"],
  learn: ["recursive", "mistake", "correction", "feedback"],
  mistake: ["record", "learn", "correction", "error"],
  code: ["sandbox", "pipeline", "recipe", "codemode"],
  sandbox: ["codemode", "pipeline", "recipe", "isolation"],
  benchmark: ["latency", "token", "bench", "measure", "percentile"],
  latency: ["benchmark", "measure", "percentile", "median"],
  dlp: ["redact", "secret", "sanitize", "guard"],
  cache: ["cache", "ttl", "expire", "stale", "memoize", "expiration"],
  ttl: ["cache", "ttl", "expire", "expiration", "stale", "ignorecache"],
  expire: ["cache", "ttl", "stale", "expiration"],
  mock: ["mock", "stub", "fake", "harness", "fixture"],
  stub: ["mock", "fake", "harness"],
  ipc: ["ipc", "lane", "dispatch", "pending", "socket", "request"],
  correlation: ["correlation", "id", "dispatch", "pending", "request", "response"],
  request: ["request", "response", "dispatch", "lane", "pending"],
  response: ["response", "request", "reply"],
  option: ["option", "config", "setting", "default", "env", "constant"],
  config: ["config", "option", "setting", "default", "env", "constant"],
  default: ["default", "config", "option", "constant", "initial"],
  setting: ["setting", "option", "config", "default"],
  regular: ["regex", "pattern", "validate", "reject", "catastrophic", "backtrack", "quantifier", "compile"],
  regex: ["regex", "pattern", "validate", "reject", "backtrack", "compile"],
  regexp: ["regex", "pattern", "validate", "reject"],
  expression: ["regex", "pattern", "expression"],
  runaway: ["catastrophic", "backtrack", "reject", "escape"],
  catastrophic: ["catastrophic", "backtrack", "nested", "reject", "runaway"],
  backtrack: ["backtrack", "catastrophic", "nested", "reject"],
  validate: ["validate", "reject", "invalid", "guard", "sanitize"],
  partial: ["partial", "incomplete", "truncate", "budget", "limit", "complete", "ceiling", "cap"],
  incomplete: ["partial", "incomplete", "truncate", "budget", "complete"],
  whole: ["whole", "disk", "global", "entire", "scan"],
  disk: ["disk", "global", "whole", "filesystem", "volume"],
  global: ["global", "disk", "whole", "all"],
  database: ["database", "db", "sql"],
  migration: ["migration", "migrate"],
  schema: ["schema"],
  react: ["react", "jsx"],
  component: ["component", "widget"],
  hook: ["hook", "usestate", "useeffect"],
  management: ["management", "manage"],
};

// ------------------------------------------------------------------ stemming

const IRREGULAR_STEMS: Record<string, string> = {
  savings: "save",
  saving: "save",
  saved: "save",
  saves: "save",
  dies: "die",
  died: "die",
  dying: "die",
  computed: "compute",
  values: "value",
  rules: "rule",
  modules: "module",
  roles: "role",
  tables: "table",
  styles: "style",
  titles: "title",
  samples: "sample",
  examples: "example",
  variables: "variable",
  sources: "source",
  value: "value",
  credentials: "credential",
  secrets: "secret",
  policies: "policy",
  queries: "query",
  entries: "entry",
  properties: "property",
  dependencies: "dependency",
  binaries: "binary",
  utilities: "utility",
  strategies: "strategy",
  summaries: "summary",
  directories: "directory",
  processes: "process",
  indices: "index",
  matrices: "matrix",
  analyses: "analysis",
  leaves: "leaf",
  halves: "half",
  lives: "live",
  moves: "move",
  changes: "change",
  causes: "cause",
  uses: "use",
  cases: "case",
  classes: "class",
  passes: "pass",
  misses: "miss",
  matches: "match",
  caches: "cache",
  crashes: "crash",
  searches: "search",
  handles: "handle",
  files: "file",
  writes: "write",
  reads: "read",
  runs: "run",
  tokens: "token",
};

export function stemToken(token: string): string {
  if (token.length <= 3) return token;
  const irregular = IRREGULAR_STEMS[token];
  if (irregular) return irregular;
  let t = token;
  if (t.endsWith("ing") && t.length > 5) {
    t = t.slice(0, -3);
    if (/([bdfglmnprt])\1$/.test(t)) t = t.slice(0, -1);
    return t;
  }
  if (t.endsWith("ed") && t.length > 4) {
    t = t.slice(0, -2);
    if (/([bdfglmnprt])\1$/.test(t)) t = t.slice(0, -1);
    return t;
  }
  if (t.endsWith("ies") && t.length > 4) return t.slice(0, -3) + "y";
  if (t.endsWith("es") && t.length > 4) return t.slice(0, -2);
  if (t.endsWith("s") && !t.endsWith("ss") && t.length > 3) return t.slice(0, -1);
  return t;
}

/** Split an identifier or natural-language chunk into lowercase tokens. */
export function tokenizeIdentifier(text: string): string[] {
  const out: string[] = [];
  const parts = text.split(/[^A-Za-z0-9_$]+/);
  for (const part of parts) {
    if (!part) continue;
    const sub = part
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[\s_]+/);
    for (const s of sub) {
      const t = s.toLowerCase().replace(/[^a-z0-9$]/g, "");
      if (t.length >= 2) out.push(t);
    }
  }
  return out;
}

function queryContentTokens(query: string): string[] {
  const raw = tokenizeIdentifier(query);
  const out: string[] = [];
  for (const t of raw) {
    if (t.length >= 3 || SHORT_ALLOWED.has(t)) {
      if (STOPWORDS.has(t)) continue;
      out.push(t);
    }
  }
  return out;
}

interface ConceptGroup {
  id: string;
  variants: string[];
  generic: boolean;
}

function conceptFor(token: string): string[] {
  if (CONCEPT_SYNONYMS[token]) return CONCEPT_SYNONYMS[token];
  const stem = stemToken(token);
  if (CONCEPT_SYNONYMS[stem]) return CONCEPT_SYNONYMS[stem];
  // Longest trigger that the token starts with (authentication -> auth).
  let best: string | null = null;
  for (const key of Object.keys(CONCEPT_SYNONYMS)) {
    if (key.length < 4) continue;
    if ((token.startsWith(key) || key.startsWith(token)) && (!best || key.length > best.length)) best = key;
  }
  return best ? CONCEPT_SYNONYMS[best] : [];
}

function groupFor(token: string): ConceptGroup {
  const stem = stemToken(token);
  const variants = new Set<string>([stem]);
  for (const s of conceptFor(token)) variants.add(stemToken(s));
  return { id: stem, variants: Array.from(variants), generic: GENERIC_TOKENS.has(stem) || GENERIC_TOKENS.has(token) };
}

export function buildConceptGroups(query: string): ConceptGroup[] {
  const tokens = queryContentTokens(query);
  const groups: ConceptGroup[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    const g = groupFor(t);
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    groups.push(g);
  }
  return groups;
}

/**
 * Expanded patterns for the multiGrep dispatch. Preserves the wave 1 contract
 * (content tokens plus concept synonyms; no raw grep fallback).
 */
export function expandIntentKeywords(naturalQuery: string): string[] {
  const groups = buildConceptGroups(naturalQuery);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    for (const v of g.variants) {
      if (v.length < 2 || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
      if (out.length >= 10) return out;
    }
  }
  return out;
}

// --------------------------------------------------------------- file tokens

const MAX_SCORE_BYTES = 2 * 1024 * 1024;
interface FileInfo {
  mtimeMs: number;
  size: number;
  tokens: string[];
  decls: string[];
}
const infoCache = new Map<string, FileInfo>();

/** Declarations a cheap regex pass can trust: top-level vars, modified
 * members, and every function/class/type keyword form. Indented, unmodified
 * `const x = ...` is a local and is not evidence (the engine owns the precise
 * symbol index; this lane only needs the signal). */
function cheapDeclarations(text: string): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  for (const d of extractSymbolsRegex(text, "")) {
    if (d.kind === "var") {
      const line = lines[d.line - 1] ?? "";
      const modified = /^\s*(?:export\s+|pub\s+|public\s+|private\s+|protected\s+|internal\s+|static\s+|readonly\s+|declare\s+)/.test(line);
      const topLevel = /^\S/.test(line);
      if (!modified && !topLevel) continue;
    }
    out.push(d.name.toLowerCase());
  }
  return out;
}

function fileInfoOf(filePath: string): FileInfo | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > MAX_SCORE_BYTES) return null;
  const cached = infoCache.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const info: FileInfo = { mtimeMs: st.mtimeMs, size: st.size, tokens: tokenizeIdentifier(text), decls: cheapDeclarations(text) };
  infoCache.set(filePath, info);
  return info;
}

function tokenMatchesVariant(token: string, variant: string): boolean {
  if (token === variant) return true;
  // Morphological suffix only: "scrubbed" -> scrub + "bed" does NOT match, but
  // "scrubbed" stems to "scrub" before comparison, so this path is for plurals
  // and -ing/-ed forms that survived tokenisation.
  if (variant.length >= 4 && token.startsWith(variant)) {
    const rest = token.slice(variant.length);
    if (rest.length <= 4 && /^(s|es|ed|d|ing|ings|er|ers|ion|ions|or|ors|al|ally|ment|ments|ness|able|ible|ize|ized|izes|ing)$/.test(rest)) return true;
  }
  return false;
}

function variantInTokens(tokens: string[], variant: string): number {
  let n = 0;
  for (const t of tokens) if (tokenMatchesVariant(t, variant)) n++;
  return n;
}

// ------------------------------------------------------------------- scoring

function implementationPrior(filePath: string, groups: ConceptGroup[]): number {
  const testsMentioned = groups.some((g) => g.id === "test" || g.variants.includes("test") || g.variants.includes("mock"));
  if (testsMentioned) return 1.0;
  if (/(^|\/)(tests?|__tests__)\//.test(filePath)) return 0.8;
  if (/(^|\/)(src|lib|engine\/src)\//.test(filePath)) return 1.35;
  return 1.0;
}

export interface ScoredFile {
  file: UltraSearchGrepFile;
  score: number;
  coverage: number;
  pathHit: boolean;
  declared: string | null;
  contributions: Array<{ group: string; primary: number; synonym: number; path: number; declared: number }>;
}

export interface RankContentOptions {
  /** Scope root, used only for path display/diagnostics. */
  root?: string;
  /** Max files to read for scoring (perf guard). */
  maxFiles?: number;
  /** How many top lexical candidates get the AST declaration pass. */
  astTop?: number;}

export interface RankContentResult {
  scored: ScoredFile[];
  evidence: SemanticEvidence;
  abstain: boolean;
}

/**
 * Score grep candidates against the intent of `query`.
 *
 * Evidence model: every content token of the query becomes a concept group
 * (itself plus lexicon synonyms). Ranking signals, strongest first:
 *   - a filename token realises the group (mock-daemon.ts for "mock daemon");
 *   - a declaration in the file realises the group (AST/regex symbol index);
 *   - primary-token frequency, then synonym frequency (BM25-saturated);
 *   - coverage across groups, length-normalised (a 3 000-token engine file
 *     must not beat the 120-token file that answers the question).
 *
 * Abstention: the query is answerable only when one file realises at least
 * two distinct non-generic groups, or one non-generic group via its filename
 * or a declaration, and 40% of all groups are present somewhere. A question
 * whose only overlaps are ubiquitous words ("query" in a database question)
 * returns nothing rather than the least-bad files (SE11/SE12, wave-2 bars).
 */
export async function rankContentCandidates(
  files: UltraSearchGrepFile[],
  query: string,
  options: RankContentOptions = {}
): Promise<RankContentResult> {
  const groups = buildConceptGroups(query);
  const maxFiles = Math.min(options.maxFiles ?? 120, files.length);

  // Pass 1: lexical. Collect per-file group hits so document frequency (and
  // therefore the weights) is known before anything is scored.
  const base: Array<{
    file: UltraSearchGrepFile;
    tokens: string[];
    decls: string[];
    pathTokens: Set<string>;
    hits: Array<{ group: string; primary: number; synonym: number; variants: number; path: boolean }>;
  }> = [];
  const df = new Map<string, number>();
  const present = new Set<string>();
  const presentNonGeneric = new Set<string>();
  for (let i = 0; i < maxFiles; i++) {
    const file = files[i];
    const info = fileInfoOf(file.path);
    const tokens = info?.tokens ?? [];
    const decls = info?.decls ?? [];
    const pathTokens = new Set(tokenizeIdentifier(file.path.split("/").slice(-2).join(" ")));
    const hits: Array<{ group: string; primary: number; synonym: number; variants: number; path: boolean }> = [];
    for (const g of groups) {
      const primary = variantInTokens(tokens, g.id);
      let synonym = 0;
      let variants = 0;
      for (const v of g.variants) {
        const n = variantInTokens(tokens, v);
        if (n > 0) variants++;
        if (v !== g.id && n > synonym) synonym = n;
      }
      const path = g.variants.some((v) => v.length >= 4 && pathTokens.has(v));
      if (primary === 0 && synonym === 0 && !path) continue;
      hits.push({ group: g.id, primary, synonym, variants, path });
      df.set(g.id, (df.get(g.id) ?? 0) + 1);
      present.add(g.id);
      if (!g.generic) presentNonGeneric.add(g.id);
    }
    base.push({ file, tokens, decls, pathTokens, hits });
  }
  const n = base.length || 1;
  const weights = new Map<string, number>();
  for (const g of groups) {
    const d = df.get(g.id) ?? 0;
    weights.set(g.id, Math.log(1 + n / (d + 1)) * (g.generic ? 0.25 : 1));
  }

  // Pass 2: declaration evidence. The regex pass is scope-aware enough here
  // (indented unmodified `const x = ...` is a local); the precise AST index
  // belongs to the engine symbol lane, not to this one.
  const declByIndex = new Map<number, { names: string[]; count: number; groups: Set<string> }>();
  for (let i = 0; i < base.length; i++) {
    const names = base[i].decls;
    if (!names.length) continue;
    const declGroups = new Set<string>();
    for (const g of groups) {
      if (g.generic) continue;
      const variants = g.variants.filter((v) => v.length >= 4 && !GENERIC_TOKENS.has(v));
      if (variants.some((v) => names.some((name) => name.includes(v)))) declGroups.add(g.id);
    }
    if (declGroups.size) declByIndex.set(i, { names, count: 0, groups: declGroups });
  }

  const scored: ScoredFile[] = [];
  for (let i = 0; i < base.length; i++) {
    const f = base[i];
    let raw = 0;
    let coverage = 0;
    let pathHit = false;
    let declared: string | null = null;
    const contributions: ScoredFile["contributions"] = [];
    for (const h of f.hits) {
      const w = weights.get(h.group) ?? 0;
      coverage++;
      const cPrimary = h.primary > 0 ? w * (1 + Math.log2(1 + h.primary)) : 0;
      const cSynonym = h.synonym > 0 ? w * 0.45 * (1 + Math.log2(1 + h.synonym)) : 0;
      const cBreadth = w * 0.12 * Math.min(h.variants, 5);
      const cPath = h.path ? w * 3.0 : 0;
      if (h.path) pathHit = true;
      raw += cPrimary + cSynonym + cBreadth + cPath;
      contributions.push({ group: h.group, primary: cPrimary, synonym: cSynonym + cBreadth, path: cPath, declared: 0 });
    }
    const decl = declByIndex.get(i);
    if (decl) {
      for (const gid of decl.groups) {
        const w = weights.get(gid) ?? 0;
        const add = w * 4.0;
        raw += add;
        if (!declared) declared = gid;
        const c = contributions.find((x) => x.group === gid);
        if (c) c.declared += add;
        else contributions.push({ group: gid, primary: 0, synonym: 0, path: 0, declared: add });
      }
    }
    raw += 0.5 * coverage;
    // Length breaks ties rather than deciding them; the implementation prior
    // reflects that a mechanism question's answer is the code that implements
    // it, not the test that exercises it (the advisor's SE sets grade the
    // implementation 3 and its test 2; a test whose *name* answers the
    // question, e.g. mock-daemon.ts, still wins through the path signal).
    const norm = raw / (1 + f.tokens.length / 8000);
    const prior = implementationPrior(f.file.path, groups);
    if (norm > 0) scored.push({ file: f.file, score: norm * prior, coverage, pathHit, declared, contributions });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.coverage !== a.coverage) return b.coverage - a.coverage;
    return a.file.path.localeCompare(b.file.path);
  });

  const coverageRatio = groups.length ? present.size / groups.length : 0;
  const isGenericGroup = (id: string) => Boolean(groups.find((g) => g.id === id)?.generic);
  // Adequacy: a filename or declaration realises a distinctive group, or a
  // code file carries >= 2 distinctive groups at real density (> 4 primary
  // hits per 1k tokens). Prose in a 3k-token Rust file matching 'component'
  // and 'hook' once each is not an answer; the file that discusses budget and
  // completeness a hundred times is.
  const pathEvidence = base.some((f) => f.hits.some((h) => !isGenericGroup(h.group) && h.path));
  const declEvidence = [...declByIndex.values()].some((d) => d.groups.size > 0);
  let denseEvidence = false;
  for (const f of base) {
    if (/\.(md|markdown|txt)$/i.test(f.file.path)) continue;
    const prim = f.hits.filter((h) => !isGenericGroup(h.group) && h.primary >= 2);
    if (prim.length < 2) continue;
    const sum = prim.reduce((a, h) => a + h.primary, 0);
    if (sum / Math.max(1, f.tokens.length / 1000) >= 4) {
      denseEvidence = true;
      break;
    }
  }
  const strong = presentNonGeneric.size > 0 && (pathEvidence || declEvidence || denseEvidence);
  const abstain = groups.length === 0 || present.size === 0 || coverageRatio < 0.4 || !strong;
  const reason = abstain
    ? groups.length === 0
      ? "no content terms"
      : `distinctive evidence absent (coverage ${coverageRatio.toFixed(2)}, ${present.size}/${groups.length} groups, path=${pathEvidence} decl=${declEvidence} dense=${denseEvidence})`
    : `terms present (path=${pathEvidence} decl=${declEvidence} dense=${denseEvidence})`;
  return {
    scored,
    abstain,
    evidence: {
      groups: groups.map((g) => ({
        id: g.id,
        variants: g.variants,
        present: present.has(g.id),
        df: df.get(g.id) ?? 0,
        weight: weights.get(g.id) ?? 0,
        generic: g.generic,
      })),
      coverage_ratio: coverageRatio,
      abstained: abstain,
      reason,
      ranking: scored.slice(0, 10).map((s) => ({
        path: s.file.path,
        score: Math.round(s.score * 1000) / 1000,
        coverage: s.coverage,
        path_hit: s.pathHit,
        declared: s.declared,
        contributions: s.contributions.map((c) => ({
          ...c,
          primary: Math.round(c.primary * 100) / 100,
          synonym: Math.round(c.synonym * 100) / 100,
          path: Math.round(c.path * 100) / 100,
          declared: Math.round(c.declared * 100) / 100,
        })),
      })),
    },
  };
}


// ------------------------------------------------------------------ retrieval

export async function searchSemanticIntent(
  client: UltraSearchClient,
  naturalQuery: string,
  options: { in?: string; limit?: number; auditTool?: AuditTool } = {}
): Promise<SemanticSearchResult> {
  const expanded = expandIntentKeywords(naturalQuery);
  const limit = options.limit ?? 20;
  if (expanded.length === 0) {
    return { term: naturalQuery, matchedTokens: [], files: [], confidence: 0 };
  }
  // The merged union is cut at `limit`, and the per-pattern fan-out fills that
  // budget in pattern order: a budget close to the scope size is needed or
  // whole files (this repo's src/client.ts) never reach the ranker.
  const candidateLimit = Math.max(250, limit * 25);
  const groups = buildConceptGroups(naturalQuery);

  // Candidate generation: content grep union path search. A file can be the
  // answer by name even when its content never repeats the query words
  // (`.gitignore` answers "what decides what gets ignored"; `validate.ts`
  // answers "regular expression"). Path hits are merged into the candidate
  // set and scored by the same filename signal as everything else.
  const pathGroups = groups.filter((g) => !g.generic).slice(0, 8);
  const [grepRes, pathHits] = await Promise.all([
    client.multiGrep(expanded, {
      in: options.in,
      limit: candidateLimit,
      auditTool: options.auditTool,
    }),
    (async () => {
      const settled = await Promise.all(
        pathGroups.map((g) => client.search(g.id, { in: options.in, limit: 4, skipAudit: true }).catch(() => null))
      );
      const hits: UltraSearchGrepFile[] = [];
      for (const r of settled) for (const h of r?.hits ?? []) hits.push({ path: h.path, matches: [] });
      return hits;
    })(),
  ]);
  const seen = new Set<string>();
  const candidates: UltraSearchGrepFile[] = [];
  for (const f of [...(grepRes.files ?? []), ...pathHits]) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    candidates.push(f);
  }
  if (candidates.length === 0) {
    return { term: naturalQuery, matchedTokens: expanded, files: [], confidence: 0 };
  }

  const ranked = await rankContentCandidates(candidates, naturalQuery, { root: options.in });
  if (ranked.abstain) {
    return {
      term: naturalQuery,
      matchedTokens: expanded,
      files: [],
      confidence: 0,
      evidence: ranked.evidence,
    };
  }
  const kept = ranked.scored.slice(0, limit).map((s) => s.file);
  const top = ranked.scored[0]?.score ?? 0;
  const confidence = Math.min(1, Math.max(0.05, top / (top + 4)));
  return { term: naturalQuery, matchedTokens: expanded, files: kept, confidence, evidence: ranked.evidence };
}

/** Test seam. */
export function clearSemanticCaches(): void {
  infoCache.clear();
}

/**
 * Semantic mode is gated OFF by default. It is intent keyword expansion, not vector
 * search, and it does not perform: on this repo's own gold fixtures semantic nDCG@10 is
 * 0.194, paraphrase recall@10 is 0.175, and the false-positive rate is 1.00 — it returns
 * candidates for every paraphrase query, including ones with no matching subject.
 *
 * It is not removed: closing a 0.194 nDCG is research, not a patch, and the capability is
 * worth keeping while that happens. But it must not be reachable by accident, because an
 * agent that trusts a confident-looking ten-file result is worse off than one that gets an
 * honest error. Both the MCP and Pi surfaces share this gate so they cannot drift.
 */
export const SEMANTIC_OPT_IN_ENV = "ULTRASEARCH_EXPERIMENTAL_SEMANTIC";

export const SEMANTIC_REFUSAL =
  `semantic mode is disabled by default: it is intent keyword expansion, not vector ` +
  `search, and it measures badly on this project's own fixtures (nDCG@10 0.194, ` +
  `paraphrase recall@10 0.175, false-positive rate 1.00).\n` +
  `Use mode "literal" or "symbol". To use semantic anyway, set ` +
  `${SEMANTIC_OPT_IN_ENV}=1.`;

export function semanticEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SEMANTIC_OPT_IN_ENV] === "1";
}

// Re-export for callers that want declaration detection without the AST module.
export { extractSymbolsRegex };
