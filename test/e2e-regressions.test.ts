process.env.PI_ULTRASEARCH_TEST = "1";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UltraSearchClient } from "../src/client.ts";
import { MockDaemon } from "./helpers/mock-daemon.ts";
import { loadPiHarness, waitFor } from "./helpers/pi-harness.ts";

/**
 * End-to-end regression suite (issue #22). Every test here fails if the feature
 * it covers is removed, not merely if its return value changes.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ults-e2e-"));
const daemons: MockDaemon[] = [];
const clients: UltraSearchClient[] = [];

after(async () => {
  for (const c of clients) c.close();
  for (const d of daemons) await d.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

async function newMock(options: ConstructorParameters<typeof MockDaemon>[0]): Promise<MockDaemon> {
  const daemon = new MockDaemon(options);
  daemons.push(daemon);
  await daemon.listen();
  return daemon;
}

function track(client: UltraSearchClient): UltraSearchClient {
  clients.push(client);
  return client;
}

const liveClient = track(new UltraSearchClient());
const daemonUp = await liveClient.ping();
const liveOnly = daemonUp ? false : "UltraSearch daemon not running (live regression skipped)";

// ---------------------------------------------------------------------------
// Frecency: the tool_execution_end hook must forward an open to the daemon
// ---------------------------------------------------------------------------

test("frecency hook: tool_execution_end on read/edit forwards {op:open} with the file path", async () => {
  const daemon = await newMock({ reply: () => ({ ok: true }) });
  const harness = await loadPiHarness({ socketPath: daemon.socketPath });

  const target = path.join(tmp, "frecency-hook-target.ts");
  fs.writeFileSync(target, "export const x = 1;\n");

  const handlers = harness.handlers.get("tool_execution_end") ?? [];
  assert.ok(handlers.length > 0, "the extension must register a tool_execution_end handler");

  await harness.emit("tool_execution_end", { toolName: "read", params: { path: target } });

  const open = await waitFor(() => daemon.lastOp("open"), 2000);
  assert.ok(open, "no open op reached the daemon: the frecency hook regressed");
  assert.equal(open.path, target);
});

test("frecency hook: unrelated tools do not touch frecency", async () => {
  const daemon = await newMock({ reply: () => ({ ok: true }) });
  const harness = await loadPiHarness({ socketPath: daemon.socketPath });

  await harness.emit("tool_execution_end", { toolName: "todo_write", params: { path: "/tmp/should-not-open.ts" } });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(daemon.countOps("open"), 0);
});

test("frecency ranking: an opened file outranks an untouched sibling", { skip: liveOnly }, async () => {
  const dir = path.join(tmp, "frecency-rank");
  fs.mkdirSync(dir, { recursive: true });
  const a = path.join(dir, "aaa.txt");
  const b = path.join(dir, "zzz.txt");
  fs.writeFileSync(a, "a\n");
  fs.writeFileSync(b, "b\n");

  // Wait for both to be visible in the scope before ranking them.
  await waitFor(async () => {
    const probe = await liveClient.search("*zzz*", { in: dir, limit: 5, skipAudit: true });
    return (probe.hits ?? []).length > 0;
  }, 45000);

  assert.equal(await liveClient.open(b), true);

  const ranked = await waitFor(async () => {
    const res = await liveClient.recent(dir, 5);
    const hits = res.hits ?? [];
    return hits[0]?.path?.endsWith("zzz.txt") ? hits : null;
  }, 15000);

  assert.ok(ranked, "the opened file never became the top frecency result");
  assert.ok(ranked[0].path.endsWith("zzz.txt"));
});

// ---------------------------------------------------------------------------
// Worktree scoping with two linked worktrees
// ---------------------------------------------------------------------------

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
}

test("worktree scoping: two linked worktrees resolve independently and never leak across", { skip: liveOnly }, async () => {
  const base = path.join(tmp, "worktrees");
  const wtA = path.join(base, "wt-a");
  const wtB = path.join(base, "wt-b");
  fs.mkdirSync(wtA, { recursive: true });
  git(["init", "-q"], wtA);
  git(["config", "user.email", "e2e@example.com"], wtA);
  git(["config", "user.name", "e2e"], wtA);
  fs.writeFileSync(path.join(wtA, "dupfile.txt"), "alpha root\n");
  git(["add", "-A"], wtA);
  git(["commit", "-qm", "init"], wtA);
  git(["worktree", "add", "-q", wtB, "-b", "e2e-feat"], wtA);
  fs.writeFileSync(path.join(wtB, "dupfile.txt"), "beta worktree\n");
  fs.mkdirSync(path.join(wtA, "src"), { recursive: true });

  const harness = await loadPiHarness();
  assert.equal(harness.mod.resolveWorktreeRoot(wtA), wtA, "worktree A must resolve to its own root");
  assert.equal(harness.mod.resolveWorktreeRoot(wtB), wtB, "linked worktree B must resolve to its own root");
  assert.equal(harness.mod.resolveWorktreeRoot(path.join(wtA, "src")), wtA, "a nested dir must resolve upward to A");

  const indexed = await waitFor(async () => {
    const res = await liveClient.search("dupfile.txt", { in: wtA, limit: 10, skipAudit: true });
    return (res.hits ?? []).length > 0 ? res : null;
  }, 45000);
  assert.ok(indexed, "worktree A's file was never indexed");

  const realA = fs.realpathSync(wtA);
  const realB = fs.realpathSync(wtB);
  for (const hit of indexed.hits ?? []) {
    assert.ok(hit.path.startsWith(realA), `hit escaped worktree A: ${hit.path}`);
    assert.ok(!hit.path.startsWith(realB), `cross-worktree leak from B: ${hit.path}`);
  }

  const scopedB = await liveClient.search("dupfile.txt", { in: wtB, limit: 10, skipAudit: true });
  assert.ok((scopedB.hits ?? []).every((h) => h.path.startsWith(realB)), "scope B returned paths outside B");
});

// ---------------------------------------------------------------------------
// Ignore-rule filtering
// ---------------------------------------------------------------------------

test("ignore rules: declared .gitignore patterns filter results (hermetic)", async () => {
  const dir = path.join(tmp, "ignore-hermetic");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitignore"), "secret-*\nbuild/\n");
  const daemon = await newMock({
    reply: () => ({
      ok: true,
      hits: [
        { kind: "file", mtime: 0, path: path.join(dir, "visible.txt"), score: 1, size: 0 },
        { kind: "file", mtime: 0, path: path.join(dir, "secret-abc.txt"), score: 1, size: 0 },
        { kind: "file", mtime: 0, path: path.join(dir, "build", "out.txt"), score: 1, size: 0 },
      ],
    }),
  });
  const client = track(new UltraSearchClient({ socketPath: daemon.socketPath, autoSpawnDaemon: false, maxReconnectRetries: 0 }));
  const res = await client.search("*.txt", { in: dir, limit: 20, skipAudit: true });
  assert.deepEqual((res.hits ?? []).map((h) => path.basename(h.path)), ["visible.txt"]);
  assert.equal(res.filteredCount, 2, "both the secret file and the ignored build dir must be filtered");
});

test("ignore rules: live daemon results honour the scope's .gitignore", { skip: liveOnly }, async () => {
  const dir = path.join(tmp, "ignore-live");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitignore"), "secret-*\n");
  fs.writeFileSync(path.join(dir, "visible.txt"), "v\n");
  fs.writeFileSync(path.join(dir, "secret-live.txt"), "s\n");

  const res = await waitFor(async () => {
    const probe = await liveClient.search("*.txt", { in: dir, limit: 20, skipAudit: true });
    return (probe.hits ?? []).some((h) => h.path.endsWith("visible.txt")) ? probe : null;
  }, 45000);
  assert.ok(res, "the visible fixture file was never indexed");
  const names = (res.hits ?? []).map((h) => path.basename(h.path));
  assert.ok(names.includes("visible.txt"));
  assert.ok(!names.includes("secret-live.txt"), "ignored file leaked into live results");
});

// ---------------------------------------------------------------------------
// Semantic mode
// ---------------------------------------------------------------------------

test("semantic mode: natural-language query expands to code tokens before dispatch", async () => {
  const daemon = await newMock({
    reply: (req) => {
      if (req.op === "multi_grep") return { ok: true, files: [{ path: "/tmp/auth.ts", matches: [{ line: 1, text: "auth" }] }] };
      return { ok: true, files: [] };
    },
  });
  const harness = await loadPiHarness({ socketPath: daemon.socketPath });

  // The expansion contract is only reachable behind the opt-in (see the refusal control below).
  const saved = process.env.ULTRASEARCH_EXPERIMENTAL_SEMANTIC;
  process.env.ULTRASEARCH_EXPERIMENTAL_SEMANTIC = "1";
  try {
    const result = await harness.callTool("_grep", {
      pattern: "where is the user authentication and login logic",
      mode: "semantic",
      limit: 10,
    });

    const op = daemon.lastOp("multi_grep");
    assert.ok(op, "semantic mode must dispatch multi_grep with expanded tokens");
    assert.ok(op.patterns.includes("auth"), `expected 'auth' in expanded tokens, got ${JSON.stringify(op.patterns)}`);
    assert.ok(op.patterns.includes("login"));
    assert.ok(op.patterns.includes("token"));
    assert.equal(daemon.countOps("grep"), 0, "semantic mode must not fall back to a raw literal grep");
    assert.ok((result.content?.[0]?.text ?? "").includes("semantic"));
  } finally {
    if (saved === undefined) delete process.env.ULTRASEARCH_EXPERIMENTAL_SEMANTIC;
    else process.env.ULTRASEARCH_EXPERIMENTAL_SEMANTIC = saved;
  }
});

test("semantic mode: the Pi surface refuses it without the explicit opt-in", async () => {
  const daemon = await newMock({ reply: () => ({ ok: true, files: [] }) });
  const harness = await loadPiHarness({ socketPath: daemon.socketPath });

  const saved = process.env.ULTRASEARCH_EXPERIMENTAL_SEMANTIC;
  delete process.env.ULTRASEARCH_EXPERIMENTAL_SEMANTIC;
  try {
    const result = await harness.callTool("_grep", {
      pattern: "where is the user authentication and login logic",
      mode: "semantic",
      limit: 5,
    });

    const text = result.content?.[0]?.text ?? "";
    assert.match(text, /disabled by default/, "a refused semantic call must say so");
    assert.match(text, /ULTRASEARCH_EXPERIMENTAL_SEMANTIC=1/, "the refusal must name the opt-in");
    assert.equal(daemon.countOps("multi_grep"), 0, "a refused semantic call must not reach the daemon");
  } finally {
    if (saved === undefined) delete process.env.ULTRASEARCH_EXPERIMENTAL_SEMANTIC;
    else process.env.ULTRASEARCH_EXPERIMENTAL_SEMANTIC = saved;
  }
});
