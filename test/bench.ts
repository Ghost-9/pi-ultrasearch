process.env.PI_ULTRASEARCH_TEST = "1";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { UltraSearchClient } from "../src/client.ts";

async function runBenchmark() {
  const client = new UltraSearchClient();
  const iterations = 10;
  const targetQuery = "Omnibox.swift";
  const grepPattern = "ultraThinMaterial";
  const cwd = process.env.ULTRASEARCH_BENCH_SCOPE ?? path.join(os.homedir(), "Search");

  console.log("=== EMPIRICAL SEARCH BENCHMARK (10 runs, Apple Silicon M1/M4) ===\n");

  // 1. Native find
  const nativeFindTimes: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    try {
      execFileSync("find", [cwd, "-name", targetQuery], { encoding: "utf-8" });
    } catch {}
    nativeFindTimes.push(performance.now() - t0);
  }

  // 2. Native ripgrep
  const nativeRgTimes: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    try {
      execFileSync("rg", ["-l", grepPattern, cwd], { encoding: "utf-8" });
    } catch {}
    nativeRgTimes.push(performance.now() - t0);
  }

  // 3. UltraSearch Client Search
  const ultrasearchFindTimes: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await client.search(targetQuery, { in: cwd, limit: 10 });
    ultrasearchFindTimes.push(performance.now() - t0);
  }

  // 4. UltraSearch Client Grep
  const ultrasearchGrepTimes: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await client.grep(grepPattern, { in: cwd, limit: 10 });
    ultrasearchGrepTimes.push(performance.now() - t0);
  }

  client.close();

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  // Nearest-rank percentiles (advisor finding #1: the old floor(n*0.95) form
  // reported the maximum as p95 at small n). A p95 equal to the max is labelled.
  const rank = (arr: number[], p: number) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
  };
  const p50 = (arr: number[]) => rank(arr, 50);
  const p95Label = (arr: number[]) => {
    const v = rank(arr, 95);
    return v === Math.max(...arr) ? `${v.toFixed(2)}ms (n=${arr.length}: p95==max)` : `${v.toFixed(2)}ms`;
  };

  console.log(`Native find (subprocess):        mean: ${avg(nativeFindTimes).toFixed(2)}ms | p50: ${p50(nativeFindTimes).toFixed(2)}ms | p95: ${p95Label(nativeFindTimes)}`);
  console.log(`pi-ultrasearch search (socket):  mean: ${avg(ultrasearchFindTimes).toFixed(2)}ms | p50: ${p50(ultrasearchFindTimes).toFixed(2)}ms | p95: ${p95Label(ultrasearchFindTimes)}`);
  console.log(`Speedup (Find):                 ${(avg(nativeFindTimes) / avg(ultrasearchFindTimes)).toFixed(1)}x faster\n`);

  console.log(`Native ripgrep (subprocess):     mean: ${avg(nativeRgTimes).toFixed(2)}ms | p50: ${p50(nativeRgTimes).toFixed(2)}ms | p95: ${p95Label(nativeRgTimes)}`);
  console.log(`pi-ultrasearch grep (trigram):   mean: ${avg(ultrasearchGrepTimes).toFixed(2)}ms | p50: ${p50(ultrasearchGrepTimes).toFixed(2)}ms | p95: ${p95Label(ultrasearchGrepTimes)}`);
  console.log(`Speedup (Grep):                 ${(avg(nativeRgTimes) / avg(ultrasearchGrepTimes)).toFixed(1)}x faster\n`);
}

runBenchmark().catch(console.error);
