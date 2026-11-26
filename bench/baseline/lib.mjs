// bench/baseline/lib.mjs
// Independent verification library for pi-ultrasearch baselines.
// Owned by wave1/baseline (verifier). Does NOT import any repo bench harness.
//
// Every script that imports this library MUST call ensureTestEnv() before
// touching the UltraSearch client so the production audit log is never written.

import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "../..");
export const RESULTS_DIR = path.join(HERE, "results");
export const FIXTURE_ROOT = path.join(os.homedir(), ".cache", "pi-ultrasearch-bench", "fixture-5k");
export const SEARCH_SCOPE = process.env.ULTRASEARCH_BENCH_SEARCH_SCOPE ?? path.join(os.homedir(), "Search");

// ---------------------------------------------------------------- env / client

export function ensureTestEnv() {
  process.env.PI_ULTRASEARCH_TEST = "1";
  if (process.env.PI_ULTRASEARCH_TEST !== "1") {
    throw new Error("PI_ULTRASEARCH_TEST must be '1' — refusing to run");
  }
}

/** Import the client under test from THIS worktree (not the main checkout). */
export async function importClient() {
  ensureTestEnv();
  const mod = await import(pathToFileURL(path.join(REPO_ROOT, "src", "client.ts")).href);
  return mod;
}

let clientModulePromise = null;
export async function initClientModule() {
  ensureTestEnv();
  if (!clientModulePromise) clientModulePromise = importClient();
  const mod = await clientModulePromise;
  globalThis.__US_MOD__ = mod;
  return mod;
}

export function makeClient(overrides = {}) {
  const { UltraSearchClient } = globalThis.__US_MOD__;
  return new UltraSearchClient({ timeoutMs: 15000, ...overrides });
}

// ---------------------------------------------------------------- statistics

export function median(arr) {
  return percentile(arr, 50);
}

export function percentile(arr, p) {
  if (!arr || arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const idx = ((s.length - 1) * p) / 100;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export function mean(arr) {
  if (!arr || arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** Deterministic PRNG so bootstrap CIs are reproducible across runs/waves. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Percentile-bootstrap 95% CI for a sample statistic (default: median).
 * iters=10000, seeded per label. Report as [lo, hi].
 */
export function bootstrapCI(values, stat = median, { iters = 10000, seed = 12345 } = {}) {
  if (!values || values.length === 0) return [NaN, NaN];
  const rng = mulberry32(seed);
  const out = new Array(iters);
  const n = values.length;
  for (let i = 0; i < iters; i++) {
    const sample = new Array(n);
    for (let j = 0; j < n; j++) sample[j] = values[Math.floor(rng() * n)];
    out[i] = stat(sample);
  }
  out.sort((a, b) => a - b);
  const lo = out[Math.floor(iters * 0.025)];
  const hi = out[Math.min(iters - 1, Math.floor(iters * 0.975))];
  return [lo, hi];
}

export function stats(values, label = "") {
  const seed = hashString(label || "stats") || 1;
  const ci = bootstrapCI(values, median, { seed });
  return {
    n: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    mean: mean(values),
    median: median(values),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    median_ci95: ci,
    samples: values,
  };
}

// ---------------------------------------------------------------- time helpers

export function nowMs() {
  return performance.now();
}

/**
 * Spawn a native command and time the full subprocess lifecycle.
 * Non-zero exit codes are expected (rg: 1 = no matches) and are returned,
 * not thrown. maxBuffer is bounded at 64 MiB.
 */
export function timeExec(cmd, args, { cwd, timeoutMs = 120000, env } = {}) {
  const t0 = performance.now();
  let stdout = "";
  let stderr = "";
  let status = 0;
  try {
    stdout = execFileSync(cmd, args, {
      encoding: "utf8",
      cwd,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(env || {}) },
    });
  } catch (e) {
    status = typeof e.status === "number" ? e.status : 1;
    stdout = e.stdout ? e.stdout.toString() : "";
    stderr = e.stderr ? e.stderr.toString() : String(e.message ?? e);
  }
  const ms = performance.now() - t0;
  return { ms, stdout, stderr, status };
}

export function runCapture(cmd, args, opts = {}) {
  return timeExec(cmd, args, opts);
}

// ---------------------------------------------------------------- audit log

export function auditFilePath() {
  ensureTestEnv();
  // Per-process by default (wave-1 finding F7): two concurrent scripts cannot
  // truncate or interleave each other's evidence window. `PI_ULTRASEARCH_TEST_LOG`
  // names one file explicitly when several processes must share it.
  const explicit = process.env.PI_ULTRASEARCH_TEST_LOG?.trim();
  if (explicit) return explicit;
  return path.join(os.homedir(), ".pi", "agent", "cache", "pi-ultrasearch", `test_audit.${process.pid}.jsonl`);
}

/** Snapshot of the test audit log before an experiment (append-only file). */
export function auditSnapshot() {
  const file = auditFilePath();
  try {
    const raw = fs.readFileSync(file, "utf8");
    const rows = raw.split("\n").filter(Boolean);
    return { file, lineCount: rows.length, bytes: Buffer.byteLength(raw, "utf8"), ts: Date.now() };
  } catch {
    return { file, lineCount: 0, bytes: 0, ts: Date.now() };
  }
}

/** Parse only rows appended after the snapshot. */
export function readAuditSince(snapshot) {
  const file = auditFilePath();
  const rows = [];
  try {
    const raw = fs.readFileSync(file, "utf8");
    const all = raw.split("\n").filter(Boolean);
    const fresh = all.slice(snapshot.lineCount);
    for (const line of fresh) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* skip unparseable */
      }
    }
  } catch {
    /* file may not exist yet */
  }
  return rows;
}

// ---------------------------------------------------------------- scopes / fixture

export const FIXTURE_SPECIAL = {
  markerFile: "module_01232.ts",
  marker: "ULTRAMARKER_1232",
  markerFile2: "module_00007.ts",
  marker2: "ULTRAMARKER_7",
  specialFile: "mod_special_alpha.ts",
  deepFile: "deep_nested_file.ts",
  totalFiles: 5000,
};

export function fixtureExists() {
  try {
    return fs.statSync(path.join(FIXTURE_ROOT, "dir_12", FIXTURE_SPECIAL.markerFile)).isFile();
  } catch {
    return false;
  }
}

export function requireFixture() {
  if (!fixtureExists()) {
    throw new Error(
      `Fixture missing at ${FIXTURE_ROOT}. Run: node bench/baseline/make-fixture.mjs`,
    );
  }
}

export function isGitRepo(scope) {
  return fs.existsSync(path.join(scope, ".git"));
}

export function countFiles(scope, { cap = 200000 } = {}) {
  const t0 = performance.now();
  const { stdout } = timeExec("find", [scope, "-type", "f"], { timeoutMs: 60000 });
  const files = stdout.split("\n").filter(Boolean);
  return { count: Math.min(files.length, cap), tookMs: performance.now() - t0 };
}

// ---------------------------------------------------------------- misc

export function machineInfo() {
  const sh = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: "utf8", timeout: 15000 }).trim();
    } catch {
      return null;
    }
  };
  return {
    chip: sh("sysctl", ["-n", "machdep.cpu.brand_string"]),
    model: sh("sysctl", ["-n", "hw.model"]),
    macos: sh("sw_vers", ["-productVersion"]),
    kernel: sh("uname", ["-r"]),
    node: process.version,
    v8: process.versions.v8,
    rustc: sh("rustc", ["--version"]),
    arch: process.arch,
    platform: process.platform,
    cpuCount: os.cpus().length,
    totalMemBytes: os.totalmem(),
    loadavg_at_start: os.loadavg(),
  };
}

export function utcDate() {
  return new Date().toISOString();
}

export function utcDateShort() {
  return new Date().toISOString().slice(0, 10);
}

export function ensureResultsDir() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

export function saveJSON(filename, obj) {
  ensureResultsDir();
  const out = path.join(RESULTS_DIR, filename);
  fs.writeFileSync(out, JSON.stringify(obj, null, 2) + "\n", "utf8");
  return out;
}

/** Relative path when inside scope, else absolute. */
export function relTo(scope, abs) {
  const r = path.relative(scope, abs);
  return r && !r.startsWith("..") ? r : abs;
}

export function normalizePaths(scope, paths) {
  return [...new Set(paths.map((p) => (path.isAbsolute(p) ? path.resolve(p) : path.resolve(scope, p))))].sort();
}

export function setMetrics(usSet, nativeSet) {
  const us = new Set(usSet);
  const native = new Set(nativeSet);
  const inter = new Set([...us].filter((x) => native.has(x)));
  const usOnly = [...us].filter((x) => !native.has(x)).sort();
  const nativeOnly = [...native].filter((x) => !us.has(x)).sort();
  return {
    us_count: us.size,
    native_count: native.size,
    intersection: inter.size,
    us_only_count: usOnly.length,
    native_only_count: nativeOnly.length,
    recall_vs_native: native.size === 0 ? 1 : inter.size / native.size,
    precision_vs_native: us.size === 0 ? 1 : inter.size / us.size,
    jaccard: us.size + native.size - inter.size === 0 ? 1 : inter.size / (us.size + native.size - inter.size),
    us_only: usOnly.slice(0, 500),
    native_only: nativeOnly.slice(0, 500),
  };
}

export function log(msg) {
  process.stderr.write(`[bench] ${msg}\n`);
}

export function fmtMs(v) {
  if (!Number.isFinite(v)) return "n/a";
  if (v >= 100) return v.toFixed(1);
  if (v >= 10) return v.toFixed(2);
  return v.toFixed(3);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------- environment gate (advisor)
// A number is only FINAL when measured on AC power, at 1-min load < 1.5, with
// no competing rustc/cargo build. Otherwise results must be written with
// status="provisional" together with this environment block.

export const GATE_LOAD1_MAX = 1.5;

export function powerSnapshot() {
  const out = timeExec("pmset", ["-g", "batt"], { timeoutMs: 10000 });
  const text = out.stdout || out.stderr || "";
  const onAc = /AC Power/.test(text);
  const pct = (text.match(/(\d+)%/) || [])[1] ?? null;
  const discharging = /discharging/.test(text);
  return { on_ac: onAc, percent: pct === null ? null : Number(pct), discharging, raw: text.trim().replace(/\n/g, " | ") };
}

export function competingBuildProcesses() {
  // comm= gives the executable basename/path per process; robust to multi-line cmdlines.
  const out = timeExec("ps", ["-Ao", "pid=,comm="], { timeoutMs: 10000 });
  return (out.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => {
      const parts = l.split(/\s+/);
      const comm = parts.slice(1).join(" ");
      const base = comm.split("/").pop();
      return base === "cargo" || base === "rustc";
    });
}

export function daemonProcesses() {
  const out = timeExec("ps", ["-Ao", "pid=,args="], { timeoutMs: 10000 });
  return (out.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => l.includes("UltraSearch serve"));
}

/**
 * Evaluate the measurement gate. Pass only when: AC power connected AND
 * 1-min load average < 1.5 AND no competing cargo/rustc process is present.
 * `daemon` may be passed in (needs a client); its pid/index_bytes are recorded
 * but are not gate conditions.
 */
export function environmentGate(daemon = null) {
  const power = powerSnapshot();
  const load = os.loadavg();
  const competing = competingBuildProcesses();
  const daemonProcs = daemonProcesses();
  const checks = {
    ac_power: power.on_ac,
    load1_lt_gate: load[0] < GATE_LOAD1_MAX,
    no_cargo_rustc: competing.length === 0,
  };
  const pass = Object.values(checks).every(Boolean);
  return {
    status: pass ? "final" : "provisional",
    gate_pass: pass,
    gate_rule: "AC power AND 1-min load < 1.5 AND no cargo/rustc process",
    gate_load1_max: GATE_LOAD1_MAX,
    checks,
    power,
    loadavg: load,
    competing_processes: competing,
    daemon_processes: daemonProcs,
    daemon_pid: daemonProcs.length ? daemonProcs[0].split(" ")[0] : null,
    daemon_status: daemon
      ? {
          ok: daemon.ok ?? null,
          entries: daemon.entries ?? null,
          content_docs: daemon.content_docs ?? null,
          content_pending: daemon.content_pending ?? null,
          index_bytes: daemon.index_bytes ?? null,
          content_bytes: daemon.content_bytes ?? null,
          full_disk_access: daemon.full_disk_access ?? null,
        }
      : null,
    checked_at: new Date().toISOString(),
  };
}

/**
 * Mark a report provisional unless the pre-run gate passed and the environment
 * did not degrade during the run (power/competing processes). End loadavg is
 * recorded but not gated: the benchmark's own subprocesses contribute to it.
 */
export function finalizeEnvironmentStatus(preGate, endGate) {
  const degraded = !endGate.checks.ac_power || !endGate.checks.no_cargo_rustc;
  const status = preGate.gate_pass && !degraded ? "final" : "provisional";
  return { ...preGate, status, pre_run: preGate, end_of_run: endGate, degraded_during_run: degraded };
}
