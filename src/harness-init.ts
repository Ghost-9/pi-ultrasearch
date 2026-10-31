/**
 * `ultrasearch init` planning and application (issue #51).
 *
 * Planning is pure: it reads configs, decides what an edit would be, and
 * renders the diff. Application writes a timestamped backup first, verifies
 * the result by reading the entry back, and restores the backup (or removes a
 * newly created file) if verification fails. Nothing here writes without an
 * explicit `--write` reaching `applyHarnessInit`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
/** Pi takes the tool surface as a native extension, not an MCP entry, so its
 * `registered` column read "no" even when the extension was installed and
 * working. Report that state honestly instead of as an absence. */
function nativeExtensionInstalled(id: string): boolean {
  if (id !== "pi") return false;
  try {
    return fs.existsSync(path.join(os.homedir(), ".pi", "agent", "extensions", "pi-ultrasearch"));
  } catch {
    return false;
  }
}

import {
  checkJson,
  checkToml,
  deepEqual,
  readJsonEntry,
  readTomlSection,
  removeJsonEntry,
  removeTomlSection,
  upsertJsonEntry,
  upsertTomlSection,
  type ConfigFormat,
} from "./config-edit.ts";
import {
  HARNESSES,
  MCP_SERVER_NAME,
  buildEntry,
  detectHarness,
  harnessConfigPath,
  managedEntry,
  resolveLaunch,
  type EntryShapeSource,
  type HarnessLaunch,
  type HarnessSpec,
  type HarnessSurface,
} from "./harness-registry.ts";

export type InitAction = "create" | "update" | "unchanged" | "remove" | "absent" | "refuse" | "skipped" | "not-detected";

export interface HarnessInitPlan {
  id: string;
  label: string;
  surface: HarnessSurface;
  configPath: string;
  format: ConfigFormat;
  serverKey: readonly string[];
  entryKind: HarnessSpec["entryKind"];
  entryShapeSource: EntryShapeSource;
  protocolVersion: string;
  protocolVersionSource: HarnessSpec["protocolVersionSource"];
  directive: string;
  note: string;
  initDefault: "write" | "skip";
  installed: boolean;
  evidence: string[];
  /** `write` targets the registry entry, `remove` deletes it. */
  mode: "write" | "remove";
  action: InitAction;
  reason?: string;
  launch?: HarnessLaunch;
  entry?: Record<string, unknown>;
  existingEntry?: Record<string, unknown>;
  before?: string;
  after?: string;
  diff?: string;
  backupPath?: string;
  revertCommand?: string;
  /** Set when application failed and the previous state was restored. */
  writeError?: string;
}

export interface PlanInitOptions {
  home: string;
  /** Explicit `--harness` selection; empty/undefined means every harness. */
  harnessIds?: readonly string[];
  /** Launch override. */
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  remove?: boolean;
  /** Include harnesses whose default is `skip` (Pi) and undetected ones. */
  force?: boolean;
  pathExists?: (p: string) => boolean;
  readFile?: (p: string) => string;
  platform?: string;
}

function readFileOrNull(p: string, opts: PlanInitOptions): string | null {
  const read = opts.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
  const exists = opts.pathExists ?? fs.existsSync;
  if (!exists(p)) return null;
  try {
    return read(p);
  } catch {
    return null;
  }
}

/** Fields this tool owns, as a comparable object. */
function managedOf(spec: HarnessSpec, entry: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!entry) return undefined;
  const managed = managedEntry(spec, entry);
  return Object.keys(managed).length ? managed : undefined;
}

function wantedEntry(spec: HarnessSpec, launch: HarnessLaunch): { desired: Record<string, unknown>; patch: Record<string, unknown> } {
  const desired = buildEntry(spec, launch);
  // Only the declared managed keys are patched; anything else the user or
  // another tool stored in the entry is preserved by the merge.
  const patch: Record<string, unknown> = {};
  for (const key of spec.managedKeys) if (key in desired) patch[key] = desired[key];
  return { desired, patch };
}

function changedManagedKeys(spec: HarnessSpec, existing: Record<string, unknown> | undefined, patch: Record<string, unknown>): string[] {
  if (!existing) return Object.keys(patch);
  const current = managedOf(spec, existing) ?? {};
  return Object.keys(patch).filter((k) => !deepEqual(current[k], patch[k]));
}

/** Plan one harness. Pure: no writes, no backups, no timestamps. */
export function planHarness(spec: HarnessSpec, opts: PlanInitOptions): HarnessInitPlan {
  const home = opts.home;
  const explicit = opts.harnessIds?.includes(spec.id) ?? false;
  const configPath = harnessConfigPath(spec, home, opts.platform as NodeJS.Platform | undefined);
  const detected = detectHarness(spec, home, { env: opts.env, pathExists: opts.pathExists });
  const base: HarnessInitPlan = {
    id: spec.id,
    label: spec.label,
    surface: spec.surface,
    configPath,
    format: spec.format,
    serverKey: spec.serverKey,
    entryKind: spec.entryKind,
    entryShapeSource: spec.entryShapeSource,
    protocolVersion: spec.protocolVersion,
    protocolVersionSource: spec.protocolVersionSource,
    directive: spec.directive,
    note: spec.note,
    initDefault: spec.initDefault,
    installed: detected.installed,
    evidence: detected.evidence,
    mode: opts.remove ? "remove" : "write",
    action: "unchanged",
  };

  if (spec.entryKind === "pi-native" && !opts.force) {
    return { ...base, action: "skipped", reason: "skipped by default: " + spec.note };
  }
  if (!explicit && !detected.installed) {
    return { ...base, action: "not-detected", reason: `not detected on this machine (${configPath} absent)` };
  }

  const before = readFileOrNull(configPath, opts);
  if (before !== null) {
    const parse = spec.format === "toml" ? checkToml(before) : checkJson(before, spec.format === "jsonc");
    if (!parse.ok) {
      return { ...base, action: "refuse", reason: `unparseable ${spec.format.toUpperCase()}: ${parse.reason}`, before };
    }
  }

  const existingEntry =
    before === null
      ? undefined
      : spec.format === "toml"
        ? readTomlSection(before, [...spec.serverKey, MCP_SERVER_NAME])
        : (readJsonEntry(before, spec.serverKey, MCP_SERVER_NAME) as Record<string, unknown> | undefined);
  const plan: HarnessInitPlan = { ...base, ...(before !== null ? { before } : {}), ...(existingEntry ? { existingEntry } : {}) };

  if (opts.remove) {
    if (before === null || existingEntry === undefined) return { ...plan, action: "absent", reason: "no ultrasearch entry to remove" };
    let after: string;
    try {
      after = spec.format === "toml" ? removeTomlSection(before, [...spec.serverKey, MCP_SERVER_NAME]).text : removeJsonEntry(before, spec.serverKey, MCP_SERVER_NAME).text;
    } catch (err: any) {
      return { ...plan, action: "refuse", reason: `removal refused: ${err?.message ?? String(err)}` };
    }
    return { ...plan, action: "remove", after, diff: formatDiff(before, after, configPath) };
  }

  const launch = resolveLaunch({
    home,
    command: opts.command,
    args: opts.args,
    env: opts.env,
    repoRoot: opts.repoRoot,
    pathExists: opts.pathExists,
  });
  const { desired, patch } = wantedEntry(spec, launch);
  const changedKeys = changedManagedKeys(spec, existingEntry, patch);
  if (before !== null && existingEntry !== undefined && changedKeys.length === 0) {
    return { ...plan, action: "unchanged", launch, entry: patch, reason: "entry already matches (idempotent)" };
  }

  let after: string;
  try {
    const baseText = before ?? (spec.format === "toml" ? "" : "{}\n");
    if (spec.format === "toml") {
      // Merge so a user's extra keys inside our table survive an update.
      const merged = existingEntry === undefined ? desired : { ...existingEntry, ...patch };
      after = upsertTomlSection(baseText, [...spec.serverKey, MCP_SERVER_NAME], merged).text;
    } else {
      const merged = existingEntry === undefined ? desired : patch;
      after = upsertJsonEntry(baseText, spec.serverKey, MCP_SERVER_NAME, merged, { jsonc: spec.format === "jsonc", merge: true }).text;
    }
  } catch (err: any) {
    return { ...plan, action: "refuse", reason: `edit refused: ${err?.message ?? String(err)}` };
  }

  const action: InitAction = existingEntry === undefined ? "create" : "update";
  return {
    ...plan,
    action,
    launch,
    entry: patch,
    ...(action === "update" ? { reason: `entry differs on: ${changedKeys.join(", ")}` } : {}),
    after,
    diff: formatDiff(before ?? "", after, configPath),
  };
}

export function planHarnessInit(opts: PlanInitOptions): HarnessInitPlan[] {
  const specs = opts.harnessIds?.length
    ? HARNESSES.filter((h) => opts.harnessIds?.includes(h.id))
    : HARNESSES;
  return specs.map((spec) => planHarness(spec, opts));
}

function timestamp(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function backupPathFor(configPath: string, now = new Date()): string {
  const stamp = timestamp(now);
  let candidate = `${configPath}.bak-${stamp}-ultrasearch-init`;
  let n = 2;
  while (fs.existsSync(candidate)) candidate = `${configPath}.bak-${stamp}-ultrasearch-init-${n++}`;
  return candidate;
}

export interface ApplyResult {
  plan: HarnessInitPlan;
  written: boolean;
}

/**
 * Apply one plan. Backs up existing files, writes atomically, verifies by
 * reading the entry back, and restores on failure.
 */
export function applyHarnessInit(plan: HarnessInitPlan): ApplyResult {
  if (plan.action === "unchanged" || plan.action === "absent" || plan.action === "skipped" || plan.action === "not-detected" || plan.action === "refuse") {
    return { plan, written: false };
  }
  if (plan.after === undefined) return { plan: { ...plan, writeError: "no target text computed" }, written: false };

  const dir = path.dirname(plan.configPath);
  fs.mkdirSync(dir, { recursive: true });
  const existed = fs.existsSync(plan.configPath);
  let backupPath: string | undefined;
  let previousMode: number | undefined;
  if (existed) {
    previousMode = fs.statSync(plan.configPath).mode & 0o777;
    backupPath = backupPathFor(plan.configPath);
    fs.copyFileSync(plan.configPath, backupPath);
  }
  const tmp = `${plan.configPath}.ultrasearch-init.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, plan.after, previousMode !== undefined ? { mode: previousMode } : undefined);
    fs.renameSync(tmp, plan.configPath);
    // Verify: the entry must read back exactly as intended.
    const written = fs.readFileSync(plan.configPath, "utf8");
    const check = plan.format === "toml" ? checkToml(written) : checkJson(written, plan.format === "jsonc");
    if (!check.ok) throw new Error(`post-write parse failed: ${check.reason}`);
    let ok = true;
    if (plan.mode === "remove") {
      const entry = plan.format === "toml" ? readTomlSection(written, [...plan.serverKey, MCP_SERVER_NAME]) : readJsonEntry(written, plan.serverKey, plan.id);
      ok = entry === undefined;
    } else if (plan.entry) {
      const entry =
        plan.format === "toml"
          ? readTomlSection(written, [...plan.serverKey, MCP_SERVER_NAME])
          : (readJsonEntry(written, plan.serverKey, MCP_SERVER_NAME) as Record<string, unknown> | undefined);
      const readBack: Record<string, unknown> = {};
      for (const key of Object.keys(plan.entry)) if (entry && key in entry) readBack[key] = entry[key];
      ok = entry !== undefined && deepEqual(readBack, plan.entry);
    }
    if (!ok) throw new Error("post-write read-back did not match the planned entry");
  } catch (err: any) {
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
      if (existed && backupPath) fs.copyFileSync(backupPath, plan.configPath);
      else if (!existed && fs.existsSync(plan.configPath)) fs.rmSync(plan.configPath, { force: true });
    } catch {}
    return { plan: { ...plan, writeError: err?.message ?? String(err) }, written: false };
  }

  const revertCommand = existed && backupPath ? `cp ${JSON.stringify(backupPath)} ${JSON.stringify(plan.configPath)}` : `rm ${JSON.stringify(plan.configPath)}`;
  return {
    plan: {
      ...plan,
      ...(backupPath ? { backupPath } : {}),
      revertCommand,
    },
    written: true,
  };
}

export function applyPlan(plans: HarnessInitPlan[]): HarnessInitPlan[] {
  return plans.map((plan) => applyHarnessInit(plan).plan);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Location-anchored diff: common prefix/suffix are dropped, the differing
 * window is shown with leading/trailing context and a line-range header.
 */
export function formatDiff(before: string, after: string, label: string): string {
  if (before === after) return "";
  const a = before.length ? before.split("\n") : [];
  const b = after.length ? after.split("\n") : [];
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const context = 3;
  const leadStart = Math.max(0, prefix - context);
  const lead = a.slice(leadStart, prefix);
  const removed = a.slice(prefix, a.length - suffix);
  const added = b.slice(prefix, b.length - suffix);
  const trail = a.slice(a.length - suffix, Math.min(a.length, a.length - suffix + context));
  const clip = (line: string) => (line.length > 200 ? `${line.slice(0, 200)}…` : line);
  const maxPerSide = 60;
  const out: string[] = [`--- ${label}`, `+++ ${label}`, `@@ lines ${leadStart + 1}..${Math.max(a.length, b.length)} @@`];
  for (const line of lead) out.push(` ${clip(line)}`);
  for (const line of removed.slice(0, maxPerSide)) out.push(`-${clip(line)}`);
  if (removed.length > maxPerSide) out.push(`-… (${removed.length - maxPerSide} more removed lines)`);
  for (const line of added.slice(0, maxPerSide)) out.push(`+${clip(line)}`);
  if (added.length > maxPerSide) out.push(`+… (${added.length - maxPerSide} more added lines)`);
  for (const line of trail) out.push(` ${clip(line)}`);
  return out.join("\n");
}

const ACTION_ORDER: InitAction[] = ["create", "update", "remove", "unchanged", "absent", "not-detected", "skipped", "refuse"];

export interface ReportOptions {
  json?: boolean;
  wrote?: boolean;
}

export function renderInitReport(plans: HarnessInitPlan[], opts: ReportOptions = {}): string {
  if (opts.json) {
    return JSON.stringify(
      {
        schema: "ultrasearch/init@1",
        wrote: opts.wrote ?? false,
        plans: plans.map((p) => ({
          id: p.id,
          label: p.label,
          action: p.action,
          configPath: p.configPath,
          format: p.format,
          serverKey: p.serverKey,
          installed: p.installed,
          evidence: p.evidence,
          reason: p.reason,
          launch: p.launch,
          backupPath: p.backupPath,
          revertCommand: p.revertCommand,
          writeError: p.writeError,
          entry: p.entry,
          diff: p.diff,
        })),
      },
      null,
      2
    );
  }
  const lines: string[] = [];
  const sorted = [...plans].sort((x, y) => ACTION_ORDER.indexOf(x.action) - ACTION_ORDER.indexOf(y.action));
  for (const p of sorted) {
    const installed = p.installed ? `detected: ${p.evidence[0] ?? "yes"}` : "not detected";
    lines.push(`▶ ${p.id} — ${p.label} [${p.surface}, ${installed}]`);
    lines.push(`  config : ${p.configPath} (${p.format}, key ${p.serverKey.join(".") || "-"})`);
    lines.push(`  action : ${p.action}${p.reason ? ` — ${p.reason}` : ""}`);
    if (p.entry) lines.push(`  entry  : ${JSON.stringify(p.entry)}`);
    if (p.diff) lines.push(p.diff.split("\n").map((l) => `  ${l}`).join("\n"));
    if (p.backupPath) lines.push(`  backup : ${p.backupPath}`);
    if (p.revertCommand) lines.push(`  revert : ${p.revertCommand}`);
    if (p.writeError) lines.push(`  ERROR  : ${p.writeError} (previous file restored)`);
    lines.push(`  note   : ${p.note}`);
    lines.push("");
  }
  const changed = plans.filter((p) => p.action === "create" || p.action === "update" || p.action === "remove").length;
  lines.push(
    opts.wrote
      ? `${changed} config(s) patched; each backup is listed above with its revert command.`
      : `${changed} config(s) would change; no files were written (pass --write to apply).`
  );
  return lines.join("\n");
}

/** Registry table for `ultrasearch init --list` (writes nothing). */
export function renderHarnessList(plans: HarnessInitPlan[], json = false): string {
  if (json) {
    return JSON.stringify(
      {
        schema: "ultrasearch/harness-list@1",
        harnesses: plans.map((p) => ({
          id: p.id,
          label: p.label,
          surface: p.surface,
          configPath: p.configPath,
          format: p.format,
          serverKey: p.serverKey,
          entryShapeSource: p.entryShapeSource,
          protocolVersion: p.protocolVersion,
          protocolVersionSource: p.protocolVersionSource,
          installed: p.installed,
          registered: p.existingEntry !== undefined,
          native_extension: nativeExtensionInstalled(p.id),
          initDefault: p.initDefault,
          directive: p.directive,
        })),
      },
      null,
      2
    );
  }
  const header = ["id", "harness", "surface", "format", "detected", "registered", "shape", "protocol", "init"];
  const rows = plans.map((p) => [
    p.id,
    p.label,
    p.surface,
    p.format,
    p.installed ? "yes" : "no",
    p.existingEntry !== undefined ? "yes" : nativeExtensionInstalled(p.id) ? "extension" : "no",
    p.entryShapeSource,
    `${p.protocolVersion}${p.protocolVersionSource === "assumed" ? " (assumed)" : ""}`,
    p.initDefault,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (row: string[]) => row.map((c, i) => c.padEnd(widths[i] as number)).join("  ");
  return [
    fmt(header),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.map(fmt),
  ].join("\n");
}
