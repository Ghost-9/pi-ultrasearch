process.env.PI_ULTRASEARCH_TEST = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Phase 5 packaging guards. These deliberately use --dry-run only: the test
 * suite must never install, sign or bootout the real daemon (the machine may
 * be running one; the release workflow and the operator do the real install).
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "install.sh");
const extensionScript = path.join(repoRoot, "scripts", "install-extension.sh");
const fdaVerifyScript = path.join(repoRoot, "scripts", "verify-fda.sh");
const formula = path.join(repoRoot, "packaging", "homebrew", "ultrasearch.rb");

function run(args: string[]) {
  return spawnSync("bash", [script, ...args], { cwd: repoRoot, encoding: "utf-8" });
}

test("packaging: install.sh is executable, valid bash, and documents --dry-run/--uninstall", () => {
  assert.ok(fs.existsSync(script), "scripts/install.sh missing");
  assert.ok((fs.statSync(script).mode & 0o111) !== 0, "install.sh must be executable");
  const syntax = spawnSync("bash", ["-n", script], { encoding: "utf-8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const help = run(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--dry-run/);
  assert.match(help.stdout, /--uninstall/);
  assert.match(help.stdout, /--bin <path>/);
});

test("packaging: extension installer dry-run plans clone, npm install/build, and Pi reload without writes", () => {
  assert.ok(fs.existsSync(extensionScript), "scripts/install-extension.sh missing");
  assert.ok((fs.statSync(extensionScript).mode & 0o111) !== 0, "install-extension.sh must be executable");
  assert.ok(fs.existsSync(fdaVerifyScript), "scripts/verify-fda.sh missing");
  assert.ok((fs.statSync(fdaVerifyScript).mode & 0o111) !== 0, "verify-fda.sh must be executable");
  for (const file of [extensionScript, fdaVerifyScript]) {
    const syntax = spawnSync("bash", ["-n", file], { encoding: "utf-8" });
    assert.equal(syntax.status, 0, syntax.stderr);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ults-extension-dry-"));
  const target = path.join(dir, "extensions", "pi-ultrasearch");
  try {
    const res = spawnSync("bash", [extensionScript, "--dry-run"], {
      encoding: "utf-8",
      env: { ...process.env, PI_ULTRASEARCH_EXTENSION_DIR: target },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[dry-run\] git clone .*pi-ultrasearch\.git/);
    assert.match(res.stdout, /npm ci/);
    assert.match(res.stdout, /npm run build/);
    assert.match(res.stdout, /Reload step: quit and restart Pi Agent/);
    assert.doesNotMatch(res.stdout, /sudo/);
    assert.equal(fs.existsSync(target), false, "extension dry-run must not create the destination");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("packaging: FDA verifier reports zero hits and a clean error when access is unavailable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ults-fda-check-"));
  const socketPath = path.join(dir, "probe.sock");
  const probePath = path.join(dir, "Mail");
  fs.mkdirSync(probePath);
  const server = net.createServer((client) => {
    let buffer = "";
    client.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      const response = request.op === "ping"
        ? { id: request.id, ok: true }
        : request.op === "status"
          ? { id: request.id, ok: true, full_disk_access: false }
          : { id: request.id, ok: true, files: [] };
      client.end(JSON.stringify(response) + "\n");
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const child = spawn("bash", [fdaVerifyScript], {
      env: {
        ...process.env,
        ULTRASEARCH_SOCKET: socketPath,
        ULTRASEARCH_FDA_PROBE_PATH: probePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(exitCode, 1, stderr);
    assert.match(stdout, /socket: responding/);
    assert.match(stdout, /grep: 0 hit\(s\)/);
    assert.match(stderr, /ERROR: daemon reports Full Disk Access is unavailable/);
    assert.doesNotMatch(stderr, /Unhandled|stack trace/i);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("packaging: dry-run plan is complete and performs no bootstrap", { skip: process.platform !== "darwin" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ults-install-dry-"));
  try {
    const fake = path.join(dir, "ultrasearch");
    fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const res = run(["--dry-run", "--bin", fake]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /existing install detected|no existing install detected/);
    assert.match(res.stdout, /\[dry-run\] install -m 0755 .*ultrasearch-daemon/);
    assert.match(res.stdout, /\[dry-run\] codesign/);
    assert.match(res.stdout, /\[dry-run\] launchctl bootstrap/);
    assert.match(res.stdout, /Full Disk Access/);
    assert.match(res.stdout, /ultrasearch init --list/);
    assert.doesNotMatch(res.stdout, /^ok: wrote /m, "dry-run must not write files");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("packaging: the formula template is syntactically valid Ruby and says it is unpublished", () => {
  assert.ok(fs.existsSync(formula), "packaging/homebrew/ultrasearch.rb missing");
  const text = fs.readFileSync(formula, "utf-8");
  assert.match(text, /class Ultrasearch < Formula/);
  assert.match(text, /sha256 "REPLACE_WITH_RELEASE_SHA256"/);
  assert.match(text, /NOT published/);
  const ruby = spawnSync("ruby", ["-c", formula], { encoding: "utf-8" });
  if (ruby.error && (ruby.error as NodeJS.ErrnoException).code === "ENOENT") return; // no ruby: syntax check skipped
  assert.equal(ruby.status, 0, ruby.stderr);
});

test("packaging: the release workflow stages and uploads scripts/install.sh", () => {
  const release = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf-8");
  assert.match(release, /scripts\/install\.sh/);
  assert.match(release, /ultrasearch-install-\$TAG\.sh/);
  assert.match(release, /gh release upload[\s\S]*ultrasearch-install-\$TAG\.sh/);
});
