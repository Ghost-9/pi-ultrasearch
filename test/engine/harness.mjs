// Shared harness for engine integration tests (node:test).
//
// Spawns a REAL vendored daemon over a fixture tree, on its own unix socket,
// in its own index directory. Nothing here touches `~/Library/Application
// Support/FSearch`, the live index, or the live daemon: every process gets
// `ULTRASEARCH_DIR`, `ULTRASEARCH_HOME` and `ULTRASEARCH_SCAN_ROOT`.
//
// Requires `engine/target/release/fsearch` to have been built:
//   cargo build --release --manifest-path engine/Cargo.toml   (see engine/BUILD.md)

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const ENGINE_DIR = path.join(REPO_ROOT, "engine");
/** The renamed daemon. `FSEARCH_BIN` accepted for a pre-rebrand checkout. */
export const ENGINE_BIN =
  process.env.ULTRASEARCH_ENGINE_BIN ??
  [path.join(ENGINE_DIR, "target", "release", "ultrasearch"), path.join(ENGINE_DIR, "target", "release", "fsearch")].find((p) => fs.existsSync(p)) ??
  path.join(ENGINE_DIR, "target", "release", "ultrasearch");
/** The socket the daemon binds; the fork renamed it with everything else. */
export const SOCKET_NAME = path.basename(ENGINE_BIN) === "fsearch" ? "fsearch.sock" : "ultrasearch.sock";
export const HAS_ENGINE = fs.existsSync(ENGINE_BIN);

/** Build the engine if the release binary is missing. */
export function ensureEngineBuilt() {
  if (fs.existsSync(ENGINE_BIN)) return;
  execFileSync("cargo", ["build", "--release"], { cwd: ENGINE_DIR, stdio: "inherit" });
}

let seq = 0;
export function tmpdir(prefix = "us-engine-") {
  // Keep Unix domain socket paths safely below macOS SUN_LEN (104 bytes) when sandbox $TMPDIR is deep.
  const sysTmp = os.tmpdir();
  const base = sysTmp.length > 40 && fs.existsSync("/tmp") ? "/tmp" : sysTmp;
  const d = fs.mkdtempSync(path.join(base, `${prefix}${process.pid}-${seq++}-`));
  return d;
}

/** Write a file, creating parent directories. */
export function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/**
 * A fixture tree of `n` files under `root`, with deterministic names and
 * contents so a search or a grep has a predictable answer.
 *   kind: "flat"  n files in one directory
 *         "deep"  n files spread over n/10 nested directories
 */
export function makeTree(root, n, kind = "flat") {
  fs.mkdirSync(root, { recursive: true });
  for (let i = 0; i < n; i++) {
    const dir = kind === "deep" ? path.join(root, `d${String(i % 10).padStart(2, "0")}/sub${i % 3}`) : root;
    const name = kind === "deep" ? `file-${String(i).padStart(5, "0")}.ts` : `fixture-${String(i).padStart(5, "0")}.txt`;
    writeFile(path.join(dir, name), `// fixture ${i}\nexport const value${i} = ${i};\nNEEDLE_${i % 7}\n`);
  }
  return root;
}

/** The daemon, as a client of a fixture index. */
export class EngineHarness {
  /**
   * @param {object} opts
   *   root   fixture tree the daemon indexes (default: a fresh tree with 40 files)
   *   files  how many fixture files (ignored when `root` is given)
   *   env    extra environment for the daemon process
   */
  constructor(opts = {}) {
    // HAS_ENGINE is computed at import time, but a fresh checkout may not have
    // the release binary yet — build on demand, then re-check.
    ensureEngineBuilt();
    if (!fs.existsSync(ENGINE_BIN)) throw new Error(`engine binary not built: ${ENGINE_BIN} (run: cargo build --release --manifest-path engine/Cargo.toml)`);
    this.root = opts.root ?? makeTree(path.join(tmpdir("us-root-"), "tree"), opts.files ?? 40, opts.kind ?? "flat");
    this.dir = opts.dir ?? path.join(tmpdir("us-idx-"), "data");
    fs.mkdirSync(this.dir, { recursive: true });
    this.env = { ...(opts.env ?? {}) };
    this.child = null;
    this.socket = path.join(this.dir, opts.socketName ?? SOCKET_NAME);
  }

  async start({ waitMs = 30_000 } = {}) {
    this.child = spawn(ENGINE_BIN, ["serve"], {
      env: {
        ...process.env,
        ULTRASEARCH_DIR: this.dir,
        ULTRASEARCH_HOME: this.root,
        ULTRASEARCH_SCAN_ROOT: this.root,
        ...this.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.stderr = "";
    this.child.stderr.on("data", (b) => (this.stderr += b.toString()));
    this.child.stdout.on("data", () => {});
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const s = await this.status().catch(() => null);
      if (s?.ok) return this;
      await sleep(50);
    }
    throw new Error(`daemon did not become ready in ${waitMs}ms; stderr:\n${this.stderr}`);
  }

  /** One request line -> parsed reply. */
  request(obj, { timeoutMs = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      const sock = net.connect(this.socket);
      let buf = "";
      const done = (err) => {
        sock.removeAllListeners();
        sock.destroy();
        err ? reject(err) : resolve(JSON.parse(buf.trim()));
      };
      const t = setTimeout(() => done(new Error(`timeout after ${timeoutMs}ms; got ${JSON.stringify(buf.slice(0, 200))}`)), timeoutMs);
      sock.on("connect", () => sock.write(`${JSON.stringify(obj)}\n`));
      sock.on("data", (d) => {
        buf += d.toString();
        if (buf.includes("\n")) {
          clearTimeout(t);
          done();
        }
      });
      sock.on("error", (e) => {
        clearTimeout(t);
        done(e);
      });
    });
  }

  status() {
    return this.request({ op: "status" }, { timeoutMs: 5000 });
  }

  search(q, extra = {}) {
    return this.request({ op: "search", q, ...extra });
  }

  grep(pattern, extra = {}) {
    return this.request({ op: "grep", pattern, ...extra });
  }

  ping() {
    return this.request({ op: "ping" }, { timeoutMs: 5000 });
  }

  stop({ signal = "SIGTERM" } = {}) {
    if (!this.child) return;
    this.child.kill(signal);
    this.child = null;
  }

  cleanup() {
    this.stop();
    for (const d of [this.root, this.dir]) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns truthy or the deadline passes. */
export async function until(fn, { timeoutMs = 15_000, everyMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(everyMs);
  }
  return last;
}

/** Median of a number[] (sorted copy; never mutates the input). */
export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? NaN : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** 95% bootstrap CI of the median (seeded LCG: reproducible). */
export function medianCI(xs, { iters = 2000, seed = 12345 } = {}) {
  const n = xs.length;
  if (n < 5) return [NaN, NaN];
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
  const meds = [];
  for (let i = 0; i < iters; i++) {
    const sample = new Array(n);
    for (let j = 0; j < n; j++) sample[j] = xs[Math.floor(rnd() * n)];
    meds.push(median(sample));
  }
  meds.sort((a, b) => a - b);
  return [meds[Math.floor(iters * 0.025)], meds[Math.floor(iters * 0.975)]];
}
