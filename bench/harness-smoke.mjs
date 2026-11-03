#!/usr/bin/env node
/**
 * Harness smoke matrix runner (issue #52).
 *
 * For every row in `src/harness-registry.ts` this produces
 * `bench/harness-smoke/<id>.json` with two arms:
 *
 *   protocol — starts the MCP stdio server exactly the way that harness would
 *              (its registered command when present, otherwise the resolved
 *              launch), performs initialize with the harness's protocol
 *              revision, `tools/list` (exactly six canonical tools) and one
 *              `tools/call`. The daemon is a hermetic mock over a temp socket,
 *              recorded in the artifact as such.
 *   native   — where the harness provides a non-interactive CLI, runs that
 *              harness against the real server (through
 *              `bench/harness-smoke/probe-server.mjs`, which records the exact
 *              protocolVersion/clientInfo the harness sends). Where it does
 *              not, the artifact records `skipped:<reason>` — never a pass.
 *
 * CI runs the protocol arm everywhere; native arms run only where the harness
 * is installed on the machine. `bench/harness-matrix.mjs` renders the matrix
 * and fails on a missing or dishonest row.
 *
 * Usage:
 *   node bench/harness-smoke.mjs [--only id,id] [--out dir] [--json]
 *                                [--command path] [--arg v] [--home dir]
 *                                [--timeout-ms n] [--keep-going]
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HARNESSES,
  MCP_SERVER_NAME,
  detectHarness,
  findHarnessBinary,
  harnessConfigPath,
  resolveLaunch,
} from "../src/harness-registry.ts";
import { SERVER_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "../src/mcp.ts";
import { TOOL_SCHEMAS, canonicalToolNames } from "../src/tool-schema.ts";
import { readJsonEntry, readTomlSection } from "../src/config-edit.ts";
import { MockDaemon } from "../test/helpers/mock-daemon.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SMOKE_SCHEMA = "ultrasearch/harness-smoke@1";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    only: [],
    out: path.join(repoRoot, "bench", "harness-smoke"),
    json: false,
    command: undefined,
    args: [],
    home: os.homedir(),
    timeoutMs: 20000,
    keepGoing: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--only" && value) {
      opts.only.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
      i++;
    }
    else if (arg.startsWith("--only=")) opts.only.push(...arg.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean));
    else if (arg === "--out" && value) {
      opts.out = path.resolve(value);
      i++;
    }
    else if (arg.startsWith("--out=")) opts.out = path.resolve(arg.slice("--out=".length));
    else if (arg === "--json") opts.json = true;
    else if (arg === "--command" && value) {
      opts.command = value;
      i++;
    }
    else if (arg.startsWith("--command=")) opts.command = arg.slice("--command=".length);
    else if (arg === "--arg" && value) {
      opts.args.push(value);
      i++;
    }
    else if (arg === "--home" && value) {
      opts.home = path.resolve(value);
      i++;
    }
    else if (arg.startsWith("--home=")) opts.home = path.resolve(arg.slice("--home=".length));
    else if (arg === "--timeout-ms" && value) {
      opts.timeoutMs = Number(value);
      i++;
    }
    else if (arg === "--keep-going") opts.keepGoing = true;
    else {
      process.stderr.write(`harness-smoke: unknown option ${JSON.stringify(arg)}\n`);
      process.exit(2);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function gitState() {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  // Dirtiness means the SOURCE differed from the recorded commit, so untracked files
  // are excluded. `git status --porcelain` counts them, and the CI job builds `dist/`
  // before this step - so every artifact generated in CI was stamped "generated on a
  // dirty tree" and the matrix check rejected it immediately. The gate could not pass
  // on any commit, which is why this check had been red since before the change that
  // triggered it. Modified or staged tracked files still mark the tree dirty, which is
  // the case that actually matters.
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repoRoot, encoding: "utf8" });
  return {
    commit: commit.status === 0 ? commit.stdout.trim() : "unknown",
    worktreeDirty: status.status === 0 ? status.stdout.trim().length > 0 : null,
  };
}

/** Run a command with a hard timeout; never throws. */
function run(command, args, { env, cwd, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: cwd ?? repoRoot,
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${err?.message ?? err}`, timedOut, durationMs: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
  });
}

function tail(text, max = 2000) {
  const value = String(text ?? "");
  return value.length > max ? `…${value.slice(value.length - max)}` : value;
}

function short(value, max = 400) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Read the launch command a harness would use for our server, if registered. */
function launchFromConfig(spec, configPath) {
  try {
    if (!fs.existsSync(configPath)) return null;
    const text = fs.readFileSync(configPath, "utf8");
    const entry =
      spec.format === "toml"
        ? readTomlSection(text, [...spec.serverKey, MCP_SERVER_NAME])
        : readJsonEntry(text, spec.serverKey, MCP_SERVER_NAME);
    if (entry && typeof entry.command === "string" && entry.command.length > 0) {
      return { command: entry.command, args: Array.isArray(entry.args) ? entry.args.map(String) : [], source: "config" };
    }
  } catch {
    // An unreadable/foreign config is not a smoke failure; fall back to resolve.
  }
  return null;
}

// ---------------------------------------------------------------------------
// protocol arm
// ---------------------------------------------------------------------------

function framedReader(stream) {
  let buffer = "";
  const frames = [];
  const waiters = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        frame = { parseError: short(line, 200) };
      }
      if (waiters.length) waiters.shift()(frame);
      else frames.push(frame);
    }
  });
  return {
    frames,
    next(timeoutMs) {
      if (frames.length) return Promise.resolve(frames.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms waiting for a frame`)), timeoutMs);
        waiters.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      });
    },
  };
}

function request(client, id, method, params, timeoutMs) {
  const frame = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
  client.raw.stdin.write(JSON.stringify(frame) + "\n");
  return { input: frame };
}

function summarizeResponse(frame) {
  if (frame && typeof frame === "object" && "error" in frame) return frame;
  const result = frame?.result;
  if (result && Array.isArray(result.tools)) {
    return { jsonrpc: frame.jsonrpc, id: frame.id, result: { tools: result.tools.map((t) => t.name) } };
  }
  if (result && Array.isArray(result.content)) {
    return {
      jsonrpc: frame.jsonrpc,
      id: frame.id,
      result: {
        content: result.content.map((c) => ({ type: c.type, text: short(c.text, 300) })),
        ...(result.isError ? { isError: true } : {}),
        ...(result._meta ? { _meta: result._meta } : {}),
      },
    };
  }
  return frame;
}

/**
 * Start the server the way the harness would, then run the MCP handshake with
 * the harness's protocol revision. Returns the artifact arm.
 */
async function protocolArm(spec, ctx) {
  const arm = {
    status: "fail",
    launch: null,
    client: { name: "ultrasearch-smoke", version: "1.0.0" },
    requestedProtocolVersion: spec.protocolVersion,
    negotiatedProtocolVersion: null,
    serverInfo: null,
    toolCount: 0,
    toolNames: [],
    toolCall: null,
    checks: {},
    failures: [],
    daemon: "mock",
    transcript: [],
  };

  const configPath = harnessConfigPath(spec, ctx.home, ctx.platform);
  const fromConfig = launchFromConfig(spec, configPath);
  const launch = fromConfig ?? resolveLaunch({
    home: ctx.home,
    command: ctx.command,
    args: ctx.args,
    repoRoot,
  });
  arm.launch = { command: launch.command, args: launch.args, source: launch.source, configPath };

  const daemon = new MockDaemon({
    reply: (req) => {
      if (req.op === "search" || req.op === "recent") {
        return { ok: true, took_us: 12, source: "index", hits: [{ kind: "file", mtime: 0, path: path.join(repoRoot, "package.json"), score: 1, size: 10 }] };
      }
      if (req.op === "grep" || req.op === "multi_grep") {
        return { ok: true, took_us: 12, source: "index", files: [{ path: path.join(repoRoot, "package.json"), matches: [{ line: 1, text: "package.json here" }] }] };
      }
      return { ok: true };
    },
  });

  let child;
  try {
    await daemon.listen();
    child = spawn(launch.command, launch.args, {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_ULTRASEARCH_TEST: "1",
        PI_ULTRASEARCH_SOCKET: daemon.socketPath,
        PI_ULTRASEARCH_NO_SPAWN: "1",
        ULTRASEARCH_HISTORY: "0",
      },
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => (stderr += c));
    let exit = null;
    child.on("close", (code, signal) => (exit = { code, signal }));

    const reader = framedReader(child.stdout);
    const raw = { stdin: child.stdin };
    const client = { raw };

    const initialize = request(client, 1, "initialize", {
      protocolVersion: spec.protocolVersion,
      capabilities: {},
      clientInfo: arm.client,
    });
    let initResponse;
    try {
      initResponse = await reader.next(ctx.timeoutMs);
    } catch (err) {
      arm.failures.push(`initialize: ${err.message}${stderr ? ` (stderr: ${short(stderr, 200)})` : ""}`);
      return arm;
    }
    arm.transcript.push({ dir: "in", frame: initialize.input });
    arm.transcript.push({ dir: "out", frame: initResponse });
    if (!initResponse.result) {
      arm.failures.push(`initialize returned an error: ${short(initResponse.error ?? initResponse, 300)}`);
      return arm;
    }
    arm.negotiatedProtocolVersion = initResponse.result.protocolVersion ?? null;
    arm.negotiatedDown = arm.negotiatedProtocolVersion !== spec.protocolVersion;
    arm.serverInfo = initResponse.result.serverInfo ?? null;
    arm.checks.initialize = true;
    arm.checks.protocolSupported = SUPPORTED_PROTOCOL_VERSIONS.includes(arm.negotiatedProtocolVersion);
    if (!arm.checks.protocolSupported) arm.failures.push(`negotiated protocol ${arm.negotiatedProtocolVersion} is not supported`);
    if (!arm.checks.initialize) arm.failures.push("initialize produced no result");

    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    const listRequest = request(client, 2, "tools/list", {});
    const listResponse = await reader.next(ctx.timeoutMs);
    arm.transcript.push({ dir: "in", frame: listRequest.input });
    arm.transcript.push({ dir: "out", frame: summarizeResponse(listResponse) });
    const names = (listResponse.result?.tools ?? []).map((t) => t.name);
    arm.toolNames = names;
    arm.toolCount = names.length;
    const expected = canonicalToolNames();
    arm.checks.toolCount6 = names.length === 6;
    arm.checks.canonicalNames = names.length === expected.length && names.every((n, i) => n === expected[i]);
    if (!arm.checks.toolCount6) arm.failures.push(`tools/list returned ${names.length} tools, expected 6`);
    if (!arm.checks.canonicalNames) arm.failures.push(`tools/list names differ from the registry: ${names.join(", ")}`);

    const callArgs = { filename: "package.json" };
    const callRequest = request(client, 3, "tools/call", { name: "ultrasearch_locate", arguments: callArgs });
    const callResponse = await reader.next(ctx.timeoutMs);
    arm.transcript.push({ dir: "in", frame: callRequest.input });
    arm.transcript.push({ dir: "out", frame: summarizeResponse(callResponse) });
    const content = callResponse.result?.content ?? [];
    const textSample = typeof content[0]?.text === "string" ? short(content[0].text, 300) : "";
    arm.toolCall = {
      name: "ultrasearch_locate",
      arguments: callArgs,
      isError: Boolean(callResponse.result?.isError),
      textSample,
      meta: callResponse.result?._meta ?? null,
    };
    arm.checks.toolCallResult = Boolean(callResponse.result) && content.some((c) => c.type === "text");
    arm.checks.toolCallHit = textSample.includes("package.json");
    if (!arm.checks.toolCallResult) arm.failures.push(`tools/call returned ${short(callResponse.error ?? callResponse, 300)}`);
    else if (!arm.checks.toolCallHit) arm.failures.push(`tools/call did not return the mock hit: ${short(textSample, 200)}`);

    arm.status = Object.values(arm.checks).every(Boolean) ? "pass" : "fail";
    void exit;
    return arm;
  } catch (err) {
    arm.failures.push(`launch failed: ${err?.message ?? err}`);
    return arm;
  } finally {
    try {
      if (child && !child.killed) child.kill("SIGKILL");
    } catch {}
    await daemon.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// native arms
// ---------------------------------------------------------------------------

async function claudeNativeArm(spec, ctx) {
  const binary = findHarnessBinary(spec, ctx.home, process.env);
  if (!binary || !binary.includes("claude")) {
    return { status: "skipped", mode: "none", reason: "skipped:claude-cli-not-found" };
  }
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "ults-smoke-claude-"));
  const home = path.join(workdir, "home");
  const cwd = path.join(workdir, "cwd");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const probeLog = path.join(workdir, "client-frames.jsonl");
  const launch = resolveLaunch({ home: ctx.home, command: ctx.command, args: ctx.args, repoRoot });
  const probe = path.join(repoRoot, "bench", "harness-smoke", "probe-server.mjs");
  const wrapped = [process.execPath, probe, "--log", probeLog, "--", launch.command, ...launch.args];
  const env = { ...process.env, HOME: home, PI_ULTRASEARCH_TEST: "1", ULTRASEARCH_HISTORY: "0" };
  const arm = {
    status: "fail",
    mode: "harness-cli",
    binary,
    measuredProtocolVersion: null,
    measuredClientInfo: null,
    checks: {},
    failures: [],
    transcript: [],
  };
  try {
    const add = await run(binary, ["mcp", "add", "--scope", "user", MCP_SERVER_NAME, "--", ...wrapped], { env, cwd, timeoutMs: ctx.timeoutMs });
    arm.transcript.push({ dir: "cli", command: `claude mcp add --scope user ${MCP_SERVER_NAME} -- node probe-server.mjs -- <server>`, code: add.code, stdout: short(add.stdout, 500), stderr: tail(add.stderr, 800) });
    if (add.code !== 0) {
      arm.failures.push(`claude mcp add failed (exit ${add.code}${add.timedOut ? ", timed out" : ""})`);
      return arm;
    }
    const list = await run(binary, ["mcp", "list"], { env, cwd, timeoutMs: ctx.timeoutMs });
    arm.transcript.push({ dir: "cli", command: "claude mcp list", code: list.code, stdout: short(list.stdout, 1500), stderr: tail(list.stderr, 800) });
    const connected = new RegExp(`^${MCP_SERVER_NAME}\\b.*Connected`, "m").test(list.stdout);
    arm.checks.connected = list.code === 0 && connected;
    if (!arm.checks.connected) arm.failures.push(`claude mcp list did not report a connected ${MCP_SERVER_NAME} server`);

    // The proxy logged what the harness itself sent — the only honest source
    // for "which protocol revision does this client speak".
    if (fs.existsSync(probeLog)) {
      const frames = fs
        .readFileSync(probeLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const initialize = frames.find((f) => f.dir === "in" && f.frame?.method === "initialize")?.frame;
      if (initialize) {
        arm.measuredProtocolVersion = initialize.params?.protocolVersion ?? null;
        arm.measuredClientInfo = initialize.params?.clientInfo ?? null;
      }
      arm.checks.measuredProtocolVersion = typeof arm.measuredProtocolVersion === "string";
      if (!arm.checks.measuredProtocolVersion) arm.failures.push("the harness's initialize request was not captured by the probe");
    } else {
      arm.failures.push("probe log missing; the harness never started the server");
    }

    // The harness's own writer is the authority on the entry shape: record it.
    const configPath = path.join(home, ".claude.json");
    if (fs.existsSync(configPath)) {
      const entry = readJsonEntry(fs.readFileSync(configPath, "utf8"), ["mcpServers"], MCP_SERVER_NAME);
      arm.registeredEntryKeys = entry ? Object.keys(entry) : [];
      arm.registeredEntryType = entry?.type ?? null;
    }

    arm.status = Object.values(arm.checks).every(Boolean) ? "pass" : "fail";
    return arm;
  } catch (err) {
    arm.failures.push(`native arm error: ${err?.message ?? err}`);
    return arm;
  } finally {
    try {
      fs.rmSync(workdir, { recursive: true, force: true });
    } catch {}
  }
}

async function codexNativeArm(spec, ctx) {
  const binary = findHarnessBinary(spec, ctx.home, process.env);
  if (!binary || !binary.includes("codex")) {
    return { status: "skipped", mode: "none", reason: "skipped:codex-cli-not-found" };
  }
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "ults-smoke-codex-"));
  const codexHome = path.join(workdir, "codex-home");
  const cwd = path.join(workdir, "cwd");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const launch = resolveLaunch({ home: ctx.home, command: ctx.command, args: ctx.args, repoRoot });
  const env = { ...process.env, CODEX_HOME: codexHome, PI_ULTRASEARCH_TEST: "1", ULTRASEARCH_HISTORY: "0" };
  const arm = {
    status: "fail",
    mode: "config-only",
    binary,
    checks: {},
    failures: [],
    transcript: [],
  };
  try {
    const add = await run(binary, ["mcp", "add", MCP_SERVER_NAME, "--", launch.command, ...launch.args], { env, cwd, timeoutMs: ctx.timeoutMs });
    arm.transcript.push({ dir: "cli", command: `codex mcp add ${MCP_SERVER_NAME} -- <server>`, code: add.code, stdout: short(add.stdout, 400), stderr: tail(add.stderr, 800) });
    if (add.code !== 0) {
      arm.failures.push(`codex mcp add failed (exit ${add.code}${add.timedOut ? ", timed out" : ""})`);
      return arm;
    }
    const list = await run(binary, ["mcp", "list"], { env, cwd, timeoutMs: ctx.timeoutMs });
    arm.transcript.push({ dir: "cli", command: "codex mcp list", code: list.code, stdout: short(list.stdout, 1500), stderr: tail(list.stderr, 800) });
    arm.checks.listed = list.code === 0 && new RegExp(`^${MCP_SERVER_NAME}\\b`, "m").test(list.stdout);
    if (!arm.checks.listed) arm.failures.push(`codex mcp list did not list ${MCP_SERVER_NAME}`);
    const configPath = path.join(codexHome, "config.toml");
    if (fs.existsSync(configPath)) {
      const entry = readTomlSection(fs.readFileSync(configPath, "utf8"), ["mcp_servers", MCP_SERVER_NAME]);
      arm.registeredEntry = entry ?? null;
      arm.checks.registeredEntry = Boolean(entry?.command);
      if (!arm.checks.registeredEntry) arm.failures.push("the harness's own config.toml has no command for our entry");
    } else {
      arm.failures.push("codex wrote no config.toml");
    }
    arm.note = "`codex mcp list` validates the config but does not handshake; the protocol arm covers the handshake";
    arm.status = Object.values(arm.checks).every(Boolean) ? "pass" : "fail";
    return arm;
  } catch (err) {
    arm.failures.push(`native arm error: ${err?.message ?? err}`);
    return arm;
  } finally {
    try {
      fs.rmSync(workdir, { recursive: true, force: true });
    } catch {}
  }
}

async function piNativeArm(ctx) {
  const testFile = path.join(repoRoot, "test", "interop-surface.test.ts");
  const result = await run(process.execPath, ["--test", testFile], { cwd: repoRoot, env: { ...process.env, PI_ULTRASEARCH_TEST: "1" }, timeoutMs: Math.max(ctx.timeoutMs, 60000) });
  return {
    status: result.code === 0 ? "pass" : "fail",
    mode: "test-suite",
    command: `node --test ${path.relative(repoRoot, testFile)}`,
    checks: { testExitZero: result.code === 0 },
    failures: result.code === 0 ? [] : [`interop-surface.test.ts exited ${result.code}${result.timedOut ? " (timed out)" : ""}`],
    durationMs: result.durationMs,
    transcript: [{ dir: "cli", code: result.code, stdout: short(result.stdout, 400), stderr: tail(result.stderr, 800) }],
  };
}

async function nativeArm(spec, ctx) {
  switch (spec.nativeProbe) {
    case "claude-mcp-list":
      return claudeNativeArm(spec, ctx);
    case "codex-mcp-list":
      return codexNativeArm(spec, ctx);
    case "pi-interop-test":
      return piNativeArm(ctx);
    default:
      return {
        status: "skipped",
        mode: "none",
        reason: signalReason(spec),
      };
  }
}

/** Why no non-interactive harness client exists for this row. */
function signalReason(spec) {
  const binary = findHarnessBinary(spec, os.homedir(), process.env);
  if (binary) return "skipped:no-non-interactive-mcp-cli";
  const detected = detectHarness(spec, os.homedir());
  if (detected.installed) return "skipped:no-non-interactive-mcp-cli";
  return "skipped:harness-not-installed-on-this-machine";
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function buildArtifact(spec, ctx) {
  const configPath = harnessConfigPath(spec, ctx.home, ctx.platform);
  const detected = detectHarness(spec, ctx.home);
  const artifact = {
    schema: SMOKE_SCHEMA,
    id: spec.id,
    label: spec.label,
    generatedAt: nowIso(),
    commit: ctx.commit,
    worktreeDirty: ctx.worktreeDirty,
    serverVersion: SERVER_VERSION,
    supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    harness: {
      surface: spec.surface,
      configPath,
      configPresent: fs.existsSync(configPath),
      installed: detected.installed,
      installEvidence: detected.evidence,
      entryShapeSource: spec.entryShapeSource,
      declaredProtocolVersion: spec.protocolVersion,
      declaredProtocolVersionSource: spec.protocolVersionSource,
      declaredProtocolSupported: SUPPORTED_PROTOCOL_VERSIONS.includes(spec.protocolVersion),
      note: spec.note,
      directive: spec.directive,
    },
    arms: { protocol: null, native: null },
    status: "fail",
  };

  if (spec.surface === "pi-derived") {
    artifact.arms.protocol = {
      status: "skipped",
      reason: "skipped:inherits-pi-provider (see pi.json)",
      launch: null,
      toolNames: [],
      checks: {},
      failures: [],
    };
    artifact.arms.native = {
      status: "skipped",
      mode: "inherited",
      reason: "skipped:inherits-pi-provider (see pi.json)",
      checks: {},
      failures: [],
    };
    artifact.status = "skipped";
    return artifact;
  }

  artifact.arms.protocol = await protocolArm(spec, ctx);
  artifact.arms.native = await nativeArm(spec, ctx);

  if (artifact.arms.protocol.status === "fail" || artifact.arms.native.status === "fail") artifact.status = "fail";
  else if (artifact.arms.native.status === "skipped") artifact.status = "partial";
  else artifact.status = "pass";
  return artifact;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const specs = opts.only.length ? HARNESSES.filter((h) => opts.only.includes(h.id)) : HARNESSES;
  const unknown = opts.only.filter((id) => !HARNESSES.some((h) => h.id === id));
  if (unknown.length) {
    process.stderr.write(`harness-smoke: unknown harness id(s): ${unknown.join(", ")}\n`);
    process.exit(2);
  }
  fs.mkdirSync(opts.out, { recursive: true });
  const git = gitState();
  const ctx = {
    home: opts.home,
    command: opts.command,
    args: opts.args,
    timeoutMs: opts.timeoutMs,
    commit: git.commit,
    worktreeDirty: git.worktreeDirty,
    platform: process.platform,
  };
  const results = [];
  for (const spec of specs) {
    const artifact = await buildArtifact(spec, ctx);
    const file = path.join(opts.out, `${spec.id}.json`);
    fs.writeFileSync(file, JSON.stringify(artifact, null, 2) + "\n");
    results.push(artifact);
    if (!opts.json) {
      const proto = artifact.arms.protocol;
      const native = artifact.arms.native;
      const protocolText = proto.status === "pass" ? `pass (${proto.toolCount} tools, negotiated ${proto.negotiatedProtocolVersion})` : `${proto.status}${proto.reason ? ` (${proto.reason})` : ""}${proto.failures?.length ? `: ${proto.failures[0]}` : ""}`;
      const nativeText = native.status === "pass" ? `pass (${native.mode})` : `${native.status} (${native.reason ?? native.failures?.[0] ?? "no reason recorded"})`;
      process.stderr.write(`${spec.id.padEnd(15)} protocol: ${protocolText} | native: ${nativeText}\n`);
    }
    if (artifact.status === "fail" && !opts.keepGoing) break;
  }
  if (opts.json) process.stdout.write(JSON.stringify({ schema: SMOKE_SCHEMA, commit: ctx.commit, artifacts: results.map((r) => ({ id: r.id, status: r.status, protocol: r.arms.protocol.status, native: r.arms.native.status })) }, null, 2) + "\n");
  const failed = results.filter((r) => r.status === "fail");
  if (failed.length) {
    process.stderr.write(`harness-smoke: ${failed.length} arm failure(s): ${failed.map((f) => f.id).join(", ")}\n`);
    process.exit(1);
  }
  if (!opts.json) process.stderr.write(`harness-smoke: wrote ${results.length} artifact(s) to ${opts.out}\n`);
}

main().catch((err) => {
  process.stderr.write(`harness-smoke: ${err?.stack ?? err}\n`);
  process.exit(1);
});
