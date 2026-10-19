/**
 * Single source of truth for the UltraSearch tool surface (issues #29, #30).
 *
 * Everything that describes a tool — the MCP `tools/list` schema, the Code Mode
 * TypeScript declarations, and the drift guard against the Pi extension's
 * registered tools — is derived from `TOOL_SCHEMAS` here. Nothing downstream
 * hand-maintains a second copy: a parameter added in one place and forgotten
 * in another is exactly the drift this module exists to make impossible.
 *
 * Names are canonical and carry the single `ultrasearch_` prefix. Alias
 * surfaces (issue #30) are generated at runtime from these names; they are not
 * written down here, so no alias can ever become the source of truth.
 */

/** JSON-schema-ish parameter shapes the surface currently needs. */
export type ToolParamType = "string" | "number" | "boolean" | "array";

export interface ToolParam {
  type: ToolParamType;
  /** Element type when `type: "array"`. */
  items?: "string";
  /** Closed value set, when the parameter is an enum. */
  enum?: readonly string[];
  description: string;
}

/** How the tool's result is shaped in Code Mode declarations. */
export type ToolReturnKind = "search" | "grep" | "multi_grep" | "text";

export interface UltraSearchToolSchema {
  name: string;
  description: string;
  params: Record<string, ToolParam>;
  required: readonly string[];
  returns: ToolReturnKind;
}

const QUERY: UltraSearchToolSchema = {
  name: "ultrasearch_query",
  description:
    "Exact indexed path search (<0.1ms). Name, glob, extension or git-status filter; `near` re-ranks by proximity; worktree unless global.",
  params: {
    query: { type: "string", description: "Name, glob, or filter (e.g. 'git:modified', 'src/**/*.{ts,tsx} !test/')" },
    limit: { type: "number", description: "Max results (default 30)" },
    global: { type: "boolean", description: "Whole disk instead of the worktree" },
    near: { type: "string", description: "Re-rank by folder proximity to this path" },
    budget_ms: { type: "number", description: "Deadline (ms); partial results set complete:false" },
    explain: { type: "boolean", description: "Append match-reason tags (default true)" },
  },
  required: ["query"],
  returns: "search",
};

const GREP: UltraSearchToolSchema = {
  name: "ultrasearch_grep",
  description:
    "Indexed content search (<1ms) with compact 'file:line: match' output; credentials are DLP-scrubbed.",
  params: {
    pattern: { type: "string", description: "Text or identifier to search" },
    path_filter: { type: "string", description: "Subfolder or file filter" },
    file: { type: "string", description: "Read one file directly (JSON, lockfiles, logs)" },
    case: { type: "string", enum: ["smart", "sensitive", "insensitive"], description: "Case handling (default smart)" },
    global: { type: "boolean", description: "Whole disk instead of the current scope" },
    mode: { type: "string", enum: ["literal", "regex", "symbol", "semantic"], description: "literal (default) | regex | symbol (defs first) | semantic (EXPERIMENTAL: nDCG 0.194, paraphrase recall 0.175, FP 1.00 — do not gate on it)" },
    limit: { type: "number", description: "Max files (default 30)" },
    compact: { type: "boolean", description: "One-line 'file:line: match' (default true)" },
    max_tokens: { type: "number", description: "Output token budget" },
    context: { type: "number", description: "Context lines per match (0-5, default 0)" },
    tag_symbols: { type: "boolean", description: "Tag AST definitions ([def:fn], [def:class])" },
    budget_ms: { type: "number", description: "Deadline (ms); partial results set complete:false" },
  },
  required: ["pattern"],
  returns: "grep",
};

const MULTI_GREP: UltraSearchToolSchema = {
  name: "ultrasearch_multi_grep",
  description: "OR-search several patterns in one indexed call.",
  params: {
    patterns: { type: "array", items: "string", description: "Patterns to OR" },
    path_filter: { type: "string", description: "Subfolder filter" },
    limit: { type: "number", description: "Max files (default 30)" },
    compact: { type: "boolean", description: "One-line 'file:line: match' (default true)" },
    max_tokens: { type: "number", description: "Output token budget" },
    budget_ms: { type: "number", description: "Deadline (ms); partial results set complete:false" },
  },
  required: ["patterns"],
  returns: "multi_grep",
};

const LOCATE: UltraSearchToolSchema = {
  name: "ultrasearch_locate",
  description: "Exact filename lookup in the workspace (O(1) indexed).",
  params: {
    filename: { type: "string", description: "Exact filename (e.g. 'package.json')" },
    global: { type: "boolean", description: "Whole disk" },
  },
  required: ["filename"],
  returns: "text",
};

const RECENT: UltraSearchToolSchema = {
  name: "ultrasearch_recent",
  description: "Recently edited workspace files, frecency-ranked.",
  params: {
    limit: { type: "number", description: "Max files (default 15)" },
  },
  required: [],
  returns: "text",
};

const METRICS: UltraSearchToolSchema = {
  name: "ultrasearch_metrics",
  description:
    "Toolchain metrics: latency percentiles, error and zero-hit rates, tuning advice. Defaults to organic rows (gate/bench runs excluded).",
  params: {
    view: { type: "string", enum: ["real", "synthetic", "all"], description: "Provenance view (default real = organic only)" },
    limit: { type: "number", description: "Rows to analyze (default 1000)" },
  },
  required: [],
  returns: "text",
};

/** The default MCP surface: exactly six canonical `ultrasearch_*` tools. */
export const TOOL_SCHEMAS: readonly UltraSearchToolSchema[] = [QUERY, GREP, MULTI_GREP, LOCATE, RECENT, METRICS];

/** Canonical names in registration order. */
export function canonicalToolNames(): string[] {
  return TOOL_SCHEMAS.map((t) => t.name);
}

export function toolByName(name: string): UltraSearchToolSchema | undefined {
  return TOOL_SCHEMAS.find((t) => t.name === name);
}

/** The MCP `inputSchema` for one tool, derived from its registry entry. */
export function toolJsonSchema(tool: UltraSearchToolSchema): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, param] of Object.entries(tool.params)) {
    properties[key] = {
      type: param.type,
      ...(param.items ? { items: { type: param.items } } : {}),
      ...(param.enum ? { enum: [...param.enum] } : {}),
      description: param.description,
    };
  }
  return { type: "object", properties, ...(tool.required.length ? { required: [...tool.required] } : {}), additionalProperties: false };
}
