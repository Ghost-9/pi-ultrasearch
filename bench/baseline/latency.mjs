// bench/baseline/latency.mjs
// Independent latency baseline, wave1/baseline (verifier).
//
// Alternating A/B: for each (scope, op) one UltraSearch call is immediately
// followed by one native rg/find call, repeated n times (default 30).
// Reports median, p50, p95, seeded percentile-bootstrap 95% CI of the median.
//
//   PI_ULTRASEARCH_TEST=1 node bench/baseline/latency.mjs
//   BENCH_N=30 PILOT_N=3 node bench/baseline/latency.mjs
//
// Raw samples are stored in results/latency-<date>.json.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  REPO_ROOT,
  FIXTURE_ROOT,
  SEARCH_SCOPE,
  FIXTURE_SPECIAL,
  ensureTestEnv,
  initClientModule,
  makeClient,
  stats,
  timeExec,
  machineInfo,
  utcDate,
  utcDateShort,
  saveJSON,
  countFiles,
  isGitRepo,
  requireFixture,
  log,
  fmtMs,
  sleep,
  environmentGate,
  finalizeEnvironmentStatus,
} from "./lib.mjs";

ensureTestEnv();

const N = Number(process.env.BENCH_N || 30);
const PILOT_N = process.env.PILOT_N ? Number(process.env.PILOT_N) : null;
const EFFECTIVE_N = PILOT_N ?? N;
const WARMUP = 2;

const SCOPES = [
  {
    id: "repo",
    dir: REPO_ROOT,
    pathQuery: "package.json",
    grep: "UltraSearchClient",
    multi: ["recordAudit", "formatGrepFiles"],
  },
  {
    id: "fixture",
    dir: FIXTURE_ROOT,
    pathQuery: FIXTURE_SPECIAL.markerFile, // module_1232.ts
    grep: FIXTURE_SPECIAL.marker, // ULTRAMARKER_1232
    multi: [FIXTURE_SPECIAL.marker, FIXTURE_SPECIAL.marker2],
  },
  {
    id: "search",
    dir: SEARCH_SCOPE,
    pathQuery: "VaultAndUpdaterTests.swift",
    grep: "VaultAndUpdater",
    multi: ["VaultAndUpdater", "PageFind"],
  },
];

function sizeLabel(id) {
  const s = SCOPES.find((x) => x.id === id);
  return s ? s.dir : id;
}

// ------------------------------------------------------------------ runners

async function runAB({ label, usFn, nativeFn }) {
  // Warmup both sides (discarded).
  for (let i = 0; i < WARMUP; i++) {
    try {
      await usFn();
    } catch {}
    try {
      nativeFn();
    } catch {}
  }

  const us = [];
  const native = [];
  const usErrors = [];
  const nativeErrors = [];
  let usHits = null;
  let nativeHits = null;

  for (let i = 0; i < EFFECTIVE_N; i++) {
    const t0 = performance.now();
    try {
      const res = await usFn();
      us.push(performance.now() - t0);
      usHits = extractHitCount(res);
    } catch (e) {
      us.push(performance.now() - t0);
      usErrors.push(String(e?.message ?? e));
    }

    const t1 = performance.now();
    try {
      const out = nativeFn();
      native.push(performance.now() - t1);
      nativeHits = countNativeHits(out);
    } catch (e) {
      native.push(performance.now() - t1);
      nativeErrors.push(String(e?.message ?? e));
    }
  }

  const usStats = stats(us, `${label}::us`);
  const nativeStats = stats(native, `${label}::native`);
  return {
    label,
    paired_alternation: true,
    n: EFFECTIVE_N,
    warmup: WARMUP,
    us: usStats,
    native: nativeStats,
    us_errors: usErrors.slice(0, 5),
    native_errors: nativeErrors.slice(0, 5),
    us_hits_last: usHits,
    native_hits_last: nativeHits,
  };
}

function extractHitCount(res) {
  if (!res || typeof res !== "object") return null;
  if (Array.isArray(res.hits)) return res.hits.length;
  if (Array.isArray(res.files)) return res.files.length;
  return null;
}

function countNativeHits(out) {
  if (!out || typeof out.stdout !== "string") return null;
  return out.stdout.split("\n").filter(Boolean).length;
}

function nativePathCmd(scope, pattern) {
  if (isGitRepo(scope)) {
    return { cmd: "rg", args: ["--files", "-g", pattern, scope] };
  }
  return { cmd: "find", args: [scope, "-type", "f", "-name", pattern] };
}

// ------------------------------------------------------------------ main

async function main() {
  requireFixture();
  log(`latency baseline starting — n=${EFFECTIVE_N}${PILOT_N ? " (PILOT)" : ""}`);
  const mod = await initClientModule();
  log(`client module loaded from ${path.join(REPO_ROOT, "src/client.ts")}`);

  const commit = timeExec("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.trim();
  const branch = timeExec("git", ["branch", "--show-current"], { cwd: REPO_ROOT }).stdout.trim();

  const meta = {
    suite: "latency",
    wave: "wave1/baseline",
    generated_at: utcDate(),
    date_short: utcDateShort(),
    repo_root: REPO_ROOT,
    commit,
    branch,
    git_dirty: timeExec("git", ["status", "--porcelain"], { cwd: REPO_ROOT }).stdout.trim().length > 0,
    pi_ultrasearch_test: process.env.PI_ULTRASEARCH_TEST,
    node: process.version,
    n: EFFECTIVE_N,
    pilot: Boolean(PILOT_N),
    machine: machineInfo(),
    loadavg_start: os.loadavg(),
    daemon: null,
    notes: [
      "Alternating A/B: each UltraSearch call is followed by one native call.",
      "Concurrent wave worktrees may write to the shared test audit log and consume CPU; loadavg captured.",
      "Native comparator for git scopes is `rg --files` (respects .gitignore); for non-git scopes `find`.",
      "US path search applies declared .gitignore/.ignore filtering client-side; counts may differ by design.",
      "US grep/trigram index covers the daemon corpus, not every file on disk.",
    ],
  };

  const probe = makeClient({ timeoutMs: 20000 });
  try {
    meta.daemon = await probe.status();
  } catch (e) {
    meta.daemon = { error: String(e?.message ?? e) };
  }
  const preGate = environmentGate(meta.daemon && meta.daemon.ok ? meta.daemon : null);
  log(`environment gate: ${preGate.status} (ac=${preGate.checks.ac_power}, load1<1.5=${preGate.checks.load1_lt_gate}, no-cargo=${preGate.checks.no_cargo_rustc})`);

  // Scope inventory.
  const activeScopes = SCOPES.filter((s) => fs.existsSync(s.dir));
  const scopes = {};
  for (const s of activeScopes) {
    const inv = countFiles(s.dir);
    scopes[s.id] = {
      dir: s.dir,
      git_repo: isGitRepo(s.dir),
      files: inv.count,
      inventory_ms: inv.tookMs,
      path_query: s.pathQuery,
      grep: s.grep,
      multi: s.multi,
    };
    log(`scope ${s.id}: ${inv.count} files at ${s.dir}`);
  }
  probe.close();
  await sleep(250);

  const runs = {};

  // 1-3. Per-scope ops: path search, trigram grep, multi-grep.
  for (const s of activeScopes) {
    const client = makeClient();
    try {
      const pg = nativePathCmd(s.dir, s.pathQuery);
      runs[`${s.id}__path_search`] = await runAB({
        label: `${s.id}__path_search`,
        usFn: () => client.search(s.pathQuery, { in: s.dir, limit: 30 }),
        nativeFn: () => timeExec(pg.cmd, pg.args),
      });
      runs[`${s.id}__path_search`].native_cmd = `${pg.cmd} ${pg.args.join(" ")}`;

      runs[`${s.id}__grep`] = await runAB({
        label: `${s.id}__grep`,
        usFn: () => client.grep(s.grep, { in: s.dir, limit: 10 }),
        nativeFn: () => timeExec("rg", ["-l", "--no-messages", "--color", "never", s.grep, s.dir]),
      });
      runs[`${s.id}__grep`].native_cmd = `rg -l --no-messages --color never ${s.grep} ${s.dir}`;

      runs[`${s.id}__multi_grep`] = await runAB({
        label: `${s.id}__multi_grep`,
        usFn: () => client.multiGrep(s.multi, { in: s.dir }),
        nativeFn: () =>
          timeExec("rg", ["-l", "--no-messages", "--color", "never", "-e", s.multi[0], "-e", s.multi[1], s.dir]),
      });
      runs[`${s.id}__multi_grep`].native_cmd = `rg -l --no-messages -e ${s.multi[0]} -e ${s.multi[1]} ${s.dir}`;
      log(`done ${s.id}: path/grep/multi`);
    } finally {
      client.close();
    }
    await sleep(250);
  }

  // 4. locate (global, mirrors ultrasearch_locate tool: search("'name", limit 50)).
  {
    const client = makeClient();
    try {
      const out = await runAB({
        label: "global__locate",
        usFn: () => client.search("'package.json", { limit: 50, auditTool: "ultrasearch_locate" }),
        nativeFn: () => timeExec("mdfind", ["-name", "package.json"]),
      });
      out.native_cmd = "mdfind -name package.json (Spotlight)";
      out.note = "US locate is global; native comparator is Spotlight mdfind.";
      runs["global__locate"] = out;
      log("done global locate");
    } finally {
      client.close();
    }
    await sleep(250);
  }

  // 5. recent (no native comparator).
  {
    const client = makeClient();
    const us = [];
    const usErrors = [];
    try {
      for (let i = 0; i < WARMUP; i++) {
        try {
          await client.recent(REPO_ROOT, 20);
        } catch {}
      }
      let hits = null;
      for (let i = 0; i < EFFECTIVE_N; i++) {
        const t0 = performance.now();
        try {
          const res = await client.recent(REPO_ROOT, 20);
          us.push(performance.now() - t0);
          hits = res?.hits?.length ?? hits;
        } catch (e) {
          us.push(performance.now() - t0);
          usErrors.push(String(e?.message ?? e));
        }
      }
      runs["repo__recent"] = {
        label: "repo__recent",
        paired_alternation: false,
        n: EFFECTIVE_N,
        warmup: WARMUP,
        us: stats(us, "repo__recent::us"),
        us_errors: usErrors.slice(0, 5),
        us_hits_last: hits,
        native_cmd: null,
        note: "No native comparator: frecency-rank is UltraSearch-specific.",
      };
      log("done recent");
    } finally {
      client.close();
    }
  }

  // 6. ping (no native comparator).
  {
    const client = makeClient();
    const us = [];
    const usErrors = [];
    try {
      for (let i = 0; i < WARMUP; i++) {
        try {
          await client.ping();
        } catch {}
      }
      for (let i = 0; i < EFFECTIVE_N; i++) {
        const t0 = performance.now();
        try {
          await client.ping();
          us.push(performance.now() - t0);
        } catch (e) {
          us.push(performance.now() - t0);
          usErrors.push(String(e?.message ?? e));
        }
      }
      runs["global__ping"] = {
        label: "global__ping",
        paired_alternation: false,
        n: EFFECTIVE_N,
        warmup: WARMUP,
        us: stats(us, "global__ping::us"),
        us_errors: usErrors.slice(0, 5),
        native_cmd: null,
        note: "Pure IPC round-trip; no native comparator.",
      };
      log("done ping");
    } finally {
      client.close();
    }
  }

  // Supplementary: CLI end-to-end (node process + IPC + exit), n=10, no native pairing.
  const cliSamples = { query: [], grep: [] };
  {
    const cli = path.join(REPO_ROOT, "bin", "cli.ts");
    for (let i = 0; i < 2; i++) {
      timeExec("node", ["--experimental-strip-types", cli, "query", "package.json", "--in", REPO_ROOT], {
        env: { PI_ULTRASEARCH_TEST: "1" },
        timeoutMs: 120000,
      });
      timeExec("node", ["--experimental-strip-types", cli, "grep", "FSearchClient", "--in", REPO_ROOT], {
        env: { PI_ULTRASEARCH_TEST: "1" },
        timeoutMs: 120000,
      });
    }
    for (let i = 0; i < 10; i++) {
      cliSamples.query.push(
        timeExec("node", ["--experimental-strip-types", cli, "query", "package.json", "--in", REPO_ROOT], {
          env: { PI_ULTRASEARCH_TEST: "1" },
          timeoutMs: 120000,
        }).ms,
      );
      cliSamples.grep.push(
        timeExec("node", ["--experimental-strip-types", cli, "grep", "FSearchClient", "--in", REPO_ROOT], {
          env: { PI_ULTRASEARCH_TEST: "1" },
          timeoutMs: 120000,
        }).ms,
      );
    }
    log("done CLI e2e supplement");
  }

  const environment = finalizeEnvironmentStatus(
    preGate,
    environmentGate(meta.daemon && meta.daemon.ok ? meta.daemon : null),
  );
  const report = {
    meta: { ...meta, status: environment.status, environment, loadavg_end: os.loadavg(), finished_at: utcDate() },
    scopes,
    runs,
    supplementary: {
      cli_e2e_query: { ...stats(cliSamples.query, "cli_e2e_query"), note: "node bin/cli.ts query package.json (repo), n=10" },
      cli_e2e_grep: { ...stats(cliSamples.grep, "cli_e2e_grep"), note: "node bin/cli.ts grep FSearchClient (repo), n=10" },
    },
  };

  const file = saveJSON(`latency-${utcDateShort()}.json`, report);

  // Console summary table.
  console.log("\n=== LATENCY BASELINE (median ms [95% CI], p95) ===");
  console.log(
    ["run", "n", "US median", "US CI95", "US p95", "native median", "native CI95", "native p95"]
      .map((h, i) => (i === 0 ? h.padEnd(28) : h.padStart(13)))
      .join(""),
  );
  for (const [key, r] of Object.entries(runs)) {
    const us = r.us;
    const nat = r.native;
    const ci = `[${fmtMs(us.median_ci95[0])},${fmtMs(us.median_ci95[1])}]`;
    const nci = nat ? `[${fmtMs(nat.median_ci95[0])},${fmtMs(nat.median_ci95[1])}]` : "—";
    console.log(
      key.padEnd(28) +
        String(r.n).padStart(13) +
        fmtMs(us.median).padStart(13) +
        ci.padStart(13) +
        fmtMs(us.p95).padStart(13) +
        (nat ? fmtMs(nat.median) : "—").padStart(13) +
        nci.padStart(13) +
        (nat ? fmtMs(nat.p95) : "—").padStart(13),
    );
  }
  console.log(`\nraw JSON: ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
