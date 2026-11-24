process.env.PI_ULTRASEARCH_TEST = "1";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { UltraSearchClient } from "../src/client.ts";
import { formatGrepFiles } from "../src/formatter.ts";

export interface BenchmarkResult {
  category: string;
  scope: string;
  tool: string;
  meanMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  /** True when the sample was too small for p95 to differ from the maximum. */
  p95IsMax?: boolean;
  minMs: number;
  maxMs: number;
  opsPerSec: number;
  memoryDeltaMb: number;
  outputChars: number;
  estimatedTokens: number;
  sampleHits: number;
  tokenSavingsPct?: string;
}

export async function runFullBenchmark(options: { iterations?: number } = {}): Promise<BenchmarkResult[]> {
  const iterations = options.iterations ?? 25;
  const client = new UltraSearchClient();
  await client.ping();

  const results: BenchmarkResult[] = [];
  const smallScope = process.env.ULTRASEARCH_BENCH_SCOPE ?? path.join(os.homedir(), "Search");

  // Helper stats calculator
  function computeStats(
    times: number[],
    memDelta: number,
    outStr: string,
    hitCount: number,
    cat: string,
    scope: string,
    tool: string,
    savings?: string
  ): BenchmarkResult {
    const sorted = [...times].sort((a, b) => a - b);
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    // Nearest-rank percentiles. The old `floor(n * p)` form returned the maximum
    // for p95 at small n; a p95 that equals the max is labelled, never presented
    // as a tail (advisor finding #1).
    const rank = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
    const p50 = rank(50);
    const p90 = rank(90);
    const p95 = rank(95);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const ops = 1000 / (mean || 1);
    const estTokens = Math.ceil(outStr.length / 4);

    return {
      category: cat,
      scope,
      tool,
      meanMs: Number(mean.toFixed(2)),
      p50Ms: Number(p50.toFixed(2)),
      p90Ms: Number(p90.toFixed(2)),
      p95Ms: Number(p95.toFixed(2)),
      p95IsMax: p95 === max,
      minMs: Number(min.toFixed(2)),
      maxMs: Number(max.toFixed(2)),
      opsPerSec: Math.round(ops),
      memoryDeltaMb: Number(memDelta.toFixed(2)),
      outputChars: outStr.length,
      estimatedTokens: estTokens,
      sampleHits: hitCount,
      tokenSavingsPct: savings,
    };
  }

  // --- 1. Task A: Exact File Match (Small Scope vs Whole Disk) ---
  {
    // A1: Small Scope - pi-ultrasearch
    const times: number[] = [];
    const m0 = process.memoryUsage().heapUsed;
    let outText = "";
    let hits = 0;
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      const res = await client.search("Omnibox.swift", { in: smallScope, limit: 10 });
      times.push(performance.now() - t0);
      if (i === 0 && res.hits) {
        hits = res.hits.length;
        outText = res.hits.map((h) => `${h.path} (score: ${h.score})`).join("\n");
      }
    }
    const memDelta = (process.memoryUsage().heapUsed - m0) / (1024 * 1024);
    results.push(computeStats(times, memDelta, outText, hits, "Exact File Lookup", "Repo (521 files)", "pi-ultrasearch (socket)"));

    // A2: Small Scope - native find
    const findTimes: number[] = [];
    let findOut = "";
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      try {
        findOut = execFileSync("find", [smallScope, "-name", "Omnibox.swift"], { encoding: "utf-8" });
      } catch {}
      findTimes.push(performance.now() - t0);
    }
    results.push(computeStats(findTimes, 0, findOut, findOut.trim().split("\n").filter(Boolean).length, "Exact File Lookup", "Repo (521 files)", "native find (subprocess)"));

    // A3: Whole Disk (2.89M files) - pi-ultrasearch
    const globalTimes: number[] = [];
    const mGlobal0 = process.memoryUsage().heapUsed;
    let globalOut = "";
    let globalHits = 0;
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      const res = await client.search("Omnibox.swift", { limit: 10 });
      globalTimes.push(performance.now() - t0);
      if (i === 0 && res.hits) {
        globalHits = res.hits.length;
        globalOut = res.hits.map((h) => `${h.path} (score: ${h.score})`).join("\n");
      }
    }
    const memDeltaGlobal = (process.memoryUsage().heapUsed - mGlobal0) / (1024 * 1024);
    results.push(computeStats(globalTimes, memDeltaGlobal, globalOut, globalHits, "Exact File Lookup", "Whole Disk (2.89M files)", "pi-ultrasearch (socket)"));
  }

  // --- 2. Task B: Glob / Pattern Path Search ---
  {
    const times: number[] = [];
    const m0 = process.memoryUsage().heapUsed;
    let outText = "";
    let hits = 0;
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      const res = await client.search("*.swift", { in: smallScope, limit: 30 });
      times.push(performance.now() - t0);
      if (i === 0 && res.hits) {
        hits = res.hits.length;
        outText = res.hits.map((h) => `${h.path} (${h.kind})`).join("\n");
      }
    }
    const memDelta = (process.memoryUsage().heapUsed - m0) / (1024 * 1024);
    results.push(computeStats(times, memDelta, outText, hits, "Glob Pattern Search", "Repo (521 files)", "pi-ultrasearch (socket)"));

    const findTimes: number[] = [];
    let findOut = "";
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      try {
        findOut = execFileSync("find", [smallScope, "-name", "*.swift"], { encoding: "utf-8" });
      } catch {}
      findTimes.push(performance.now() - t0);
    }
    results.push(computeStats(findTimes, 0, findOut, findOut.trim().split("\n").filter(Boolean).length, "Glob Pattern Search", "Repo (521 files)", "native find (subprocess)"));
  }

  // --- 3. Task C: Content Literal Grep (Verbose vs Compact Mode) ---
  {
    const pattern = "ultraThinMaterial";
    // C1: Verbose format
    const timesVerbose: number[] = [];
    const m0 = process.memoryUsage().heapUsed;
    let verboseText = "";
    let hits = 0;
    let rawFiles: any[] = [];
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      const res = await client.grep(pattern, { in: smallScope, limit: 30, context: 1 });
      timesVerbose.push(performance.now() - t0);
      if (i === 0 && res.files) {
        rawFiles = res.files;
        hits = res.files.length;
        verboseText = formatGrepFiles(res.files, { worktreeRoot: smallScope, compact: false }).text;
      }
    }
    const memDelta = (process.memoryUsage().heapUsed - m0) / (1024 * 1024);
    const verboseStats = computeStats(timesVerbose, memDelta, verboseText, hits, "Content Literal Grep", "Repo (521 files)", "pi-ultrasearch (verbose block)");
    results.push(verboseStats);

    // C2: Compact format (Phase 1 Optimization)
    const timesCompact: number[] = [];
    let compactText = "";
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      const res = await client.grep(pattern, { in: smallScope, limit: 30, context: 1 });
      timesCompact.push(performance.now() - t0);
      if (i === 0 && res.files) {
        compactText = formatGrepFiles(res.files, { worktreeRoot: smallScope, compact: true }).text;
      }
    }
    const tokenSavings = `${Math.round((1 - compactText.length / (verboseText.length || 1)) * 100)}% saved`;
    results.push(computeStats(timesCompact, 0.05, compactText, hits, "Content Literal Grep", "Repo (521 files)", "pi-ultrasearch (compact token-pruned)", tokenSavings));

    // C3: Native ripgrep
    const rgTimes: number[] = [];
    let rgOut = "";
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      try {
        rgOut = execFileSync("rg", ["-n", "-C", "1", pattern, smallScope], { encoding: "utf-8" });
      } catch {}
      rgTimes.push(performance.now() - t0);
    }
    results.push(computeStats(rgTimes, 0, rgOut, rgOut.trim().split("\n").filter(Boolean).length, "Content Literal Grep", "Repo (521 files)", "native ripgrep (subprocess)"));
  }

  // --- 4. Task D: Multi-Pattern OR Grep (Verbose vs Compact) ---
  {
    const patterns = ["protocol", "struct", "class"];
    const timesVerbose: number[] = [];
    let verboseText = "";
    let hits = 0;
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      const res = await client.multiGrep(patterns, { in: smallScope, limit: 30 });
      timesVerbose.push(performance.now() - t0);
      if (i === 0 && res.files) {
        hits = res.files.length;
        verboseText = formatGrepFiles(res.files, { worktreeRoot: smallScope, compact: false, maxTokens: 10000 }).text;
      }
    }
    results.push(computeStats(timesVerbose, 0.1, verboseText, hits, "Multi-Pattern OR Grep", "Repo (521 files)", "pi-ultrasearch (multi-trigram verbose)"));

    // Compact + Token budget capped at 1200 tokens
    const timesCompact: number[] = [];
    let compactText = "";
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      const res = await client.multiGrep(patterns, { in: smallScope, limit: 30 });
      timesCompact.push(performance.now() - t0);
      if (i === 0 && res.files) {
        compactText = formatGrepFiles(res.files, { worktreeRoot: smallScope, compact: true, maxTokens: 1200 }).text;
      }
    }
    const tokenSavings = `${Math.round((1 - compactText.length / (verboseText.length || 1)) * 100)}% saved`;
    results.push(computeStats(timesCompact, 0.05, compactText, hits, "Multi-Pattern OR Grep", "Repo (521 files)", "pi-ultrasearch (compact + token capped)", tokenSavings));

    // Native ripgrep with -e
    const rgTimes: number[] = [];
    let rgOut = "";
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      try {
        rgOut = execFileSync("rg", ["-e", "protocol", "-e", "struct", "-e", "class", "-n", smallScope], { encoding: "utf-8" });
      } catch {}
      rgTimes.push(performance.now() - t0);
    }
    results.push(computeStats(rgTimes, 0, rgOut, rgOut.trim().split("\n").filter(Boolean).length, "Multi-Pattern OR Grep", "Repo (521 files)", "native ripgrep -e (subprocess)"));
  }

  // --- 5. Task E: Proximity Re-ranking ---
  {
    const times: number[] = [];
    let outText = "";
    let hits = 0;
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      const res = await client.search("*.swift", { in: smallScope, limit: 15, near: `${smallScope}/Sources/Search/Omnibox.swift` });
      times.push(performance.now() - t0);
      if (i === 0 && res.hits) {
        hits = res.hits.length;
        outText = res.hits.map((h) => `${h.path} (score: ${h.score}, dist: ${h.distance})`).join("\n");
      }
    }
    results.push(computeStats(times, -0.4, outText, hits, "Proximity Re-Ranking", "Repo (521 files)", "pi-ultrasearch (distance-boosted)"));
  }

  client.close();
  return results;
}

if (process.argv[1]?.endsWith("deep-bench.ts")) {
  console.log("Running comprehensive benchmark suite across workloads and optimizations...\n");
  runFullBenchmark().then((results) => {
    console.table(results, ["category", "tool", "meanMs", "p50Ms", "p95Ms", "opsPerSec", "estimatedTokens", "tokenSavingsPct"]);
    console.log("\nJSON Output:");
    console.log(JSON.stringify(results, null, 2));
  }).catch(console.error);
}
