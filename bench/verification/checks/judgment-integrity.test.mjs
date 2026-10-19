// bench/verification/checks/judgment-integrity.test.mjs — the judgment-set gate.
//
// THE FAILURE MODE THIS EXISTS FOR: this project has closed failing gates by
// editing the instrument instead of the engine. A judgment set that can be
// changed in the same commit that reads it cannot fail — the edit and the
// measurement move together, so nothing goes red and the number changes
// silently.
//
// These tests require the gate to FAIL on an unamended edit of a judgment set
// or of a `*-baseline.json`, and to pass only through an explicit amendment
// that carries a reason. The last test is the non-vacuity control: the checker
// must detect a mutation it makes itself.
//
//   node --test bench/verification/checks/judgment-integrity.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildManifest,
  checkIntegrity,
  collectGovernedFiles,
  computeManifestFiles,
  formatViolations,
  isGoverned,
  writeManifest,
  MANIFEST_RELPATH,
  REPO_ROOT,
} from "./judgment-integrity.mjs";

/** A throwaway repo with the shape the gate governs. */
function fakeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "us-judg-"));
  fs.mkdirSync(path.join(root, "bench", "judgments"), { recursive: true });
  fs.mkdirSync(path.join(root, "bench", "baseline", "results"), { recursive: true });
  fs.mkdirSync(path.join(root, "engine", "target", "release"), { recursive: true });
  fs.writeFileSync(path.join(root, "bench", "judgments", "wave1-judgments.json"), '{"queries":[]}\n');
  fs.writeFileSync(path.join(root, "bench", "baseline", "results", "judgments-baseline.json"), '{"v":1}\n');
  fs.writeFileSync(path.join(root, "engine", "target", "release", "junk-baseline.json"), "{}\n");
  return root;
}

const pin = (root) => writeManifest(buildManifest({ repoRoot: root, reason: "initial pin" }), root);

test("governs the judgment sets and the measurement artifacts, and not build output", () => {
  assert.equal(isGoverned("bench/judgments/wave1-judgments.json"), true);
  assert.equal(isGoverned("bench/judgments/wave2-bars.json"), true);
  assert.equal(isGoverned("bench/baseline/results/judgments-baseline.json"), true);
  assert.equal(isGoverned("bench/verification/after/tokens-baseline.json"), true);
  assert.equal(isGoverned("bench/baseline/results/equivalence-golden.json"), true, "the frozen equivalence instrument is governed (#61)");
  assert.equal(isGoverned("bench/verification/after/equivalence-golden.json"), true);
  assert.equal(isGoverned("bench/wave4/gates-v2.json"), true, "the scorecard is governed (#61)");
  assert.equal(isGoverned("bench/verification/wave4-summary.json"), true);
  assert.equal(isGoverned("bench/baseline/results/latency-2026-10-17.json"), false, "dated run artifacts stay outside the pin");
  // Never the manifest itself, and never generated output.
  assert.equal(isGoverned(MANIFEST_RELPATH), false);
  assert.equal(isGoverned("engine/target/release/junk-baseline.json"), false);
  assert.equal(isGoverned("node_modules/x/baseline.json"), false);
  assert.equal(isGoverned("dist/baseline.json"), false);
});

test("a fresh tree with a pin passes and covers every governed file", () => {
  const root = fakeRepo();
  try {
    pin(root);
    const result = checkIntegrity({ repoRoot: root });
    assert.equal(result.ok, true, formatViolations(result));
    // Two governed files; the engine/target one is excluded.
    assert.equal(result.checked, 2);
    assert.deepEqual(Object.keys(computeManifestFiles(root)).sort(), [
      "bench/baseline/results/judgments-baseline.json",
      "bench/judgments/wave1-judgments.json",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("FAIL: editing a judgment set without amending is caught", () => {
  const root = fakeRepo();
  try {
    pin(root);
    // The exact failure mode: quietly relax an expectation so a gate goes green.
    fs.writeFileSync(path.join(root, "bench", "judgments", "wave1-judgments.json"), '{"queries":[{"id":"gone"}]}\n');
    const result = checkIntegrity({ repoRoot: root });
    assert.equal(result.ok, false, "a silent judgment edit must fail the gate");
    const v = result.violations.find((x) => x.file === "bench/judgments/wave1-judgments.json");
    assert.ok(v, "the edited judgment set must be named");
    assert.equal(v.kind, "changed");
    assert.notEqual(v.expected, v.actual);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("FAIL: editing a *-baseline.json measurement artifact is caught", () => {
  const root = fakeRepo();
  try {
    pin(root);
    fs.writeFileSync(path.join(root, "bench", "baseline", "results", "judgments-baseline.json"), '{"v":2}\n');
    const result = checkIntegrity({ repoRoot: root });
    assert.equal(result.ok, false, "a silent artifact edit must fail the gate");
    assert.equal(result.violations[0].kind, "changed");
    assert.equal(result.violations[0].file, "bench/baseline/results/judgments-baseline.json");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("FAIL: adding a governed file the pin does not cover is caught", () => {
  const root = fakeRepo();
  try {
    pin(root);
    fs.writeFileSync(path.join(root, "bench", "judgments", "wave3-judgments.json"), '{"queries":[]}\n');
    const result = checkIntegrity({ repoRoot: root });
    assert.equal(result.ok, false, "an unpinned judgment set must fail the gate");
    assert.equal(result.violations[0].kind, "added");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("FAIL: deleting a governed file is caught", () => {
  const root = fakeRepo();
  try {
    pin(root);
    fs.rmSync(path.join(root, "bench", "judgments", "wave1-judgments.json"));
    const result = checkIntegrity({ repoRoot: root });
    assert.equal(result.ok, false, "deleting a pinned judgment set must fail the gate");
    assert.equal(result.violations[0].kind, "removed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("FAIL: a missing manifest is a failure, not a silent pass", () => {
  const root = fakeRepo();
  try {
    const result = checkIntegrity({ repoRoot: root });
    assert.equal(result.ok, false, "no manifest must not mean 'nothing to check'");
    assert.equal(result.violations[0].kind, "manifest-missing");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an amendment must carry a reason", () => {
  const root = fakeRepo();
  try {
    pin(root);
    for (const reason of [undefined, "", "   "]) {
      assert.throws(
        () => buildManifest({ repoRoot: root, reason }),
        /requires --reason/,
        "an unexplained re-baseline is the failure this gate prevents"
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a deliberate amendment records the reason and what moved, then passes", () => {
  const root = fakeRepo();
  try {
    const first = pin(root);
    fs.writeFileSync(path.join(root, "bench", "judgments", "wave1-judgments.json"), '{"queries":[{"id":"new"}]}\n');
    fs.writeFileSync(path.join(root, "bench", "judgments", "wave2-bars.json"), '{"bars":[]}\n');

    const previous = JSON.parse(fs.readFileSync(first, "utf8"));
    const next = buildManifest({ repoRoot: root, reason: "wave-2 lane added; documented in ADVISOR-WAVE2.md", previous });
    writeManifest(next, root);

    const result = checkIntegrity({ repoRoot: root });
    assert.equal(result.ok, true, "an amended tree must pass again");
    assert.equal(next.amendments.length, 2, "the amendment history is appended, never replaced");
    assert.equal(next.amendments[1].reason, "wave-2 lane added; documented in ADVISOR-WAVE2.md");
    assert.deepEqual(next.amendments[1].changed, ["bench/judgments/wave1-judgments.json"]);
    assert.deepEqual(next.amendments[1].added, ["bench/judgments/wave2-bars.json"]);
    // The reason is not decoration — it survives into the file on disk.
    assert.match(fs.readFileSync(first, "utf8"), /wave-2 lane added/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the failure report names the file and the remedy", () => {
  const root = fakeRepo();
  try {
    pin(root);
    fs.appendFileSync(path.join(root, "bench", "judgments", "wave1-judgments.json"), " ");
    const out = formatViolations(checkIntegrity({ repoRoot: root }));
    assert.match(out, /INTEGRITY GATE: FAILED/);
    assert.match(out, /bench\/judgments\/wave1-judgments\.json/);
    assert.match(out, /--amend-judgments --reason/);
    // It must say plainly that editing an instrument to go green is not allowed.
    assert.match(out, /not an amendment/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Non-vacuity: the gate must detect a mutation it introduces itself
// ---------------------------------------------------------------------------

test("NON-VACUITY: mutating a governed file is detected, restoring it is clean", () => {
  const root = fakeRepo();
  try {
    pin(root);
    const target = path.join(root, "bench", "judgments", "wave1-judgments.json");
    const original = fs.readFileSync(target);
    try {
      fs.writeFileSync(target, `${original} `);
      assert.equal(checkIntegrity({ repoRoot: root }).ok, false, "the checker missed its own mutation");
    } finally {
      fs.writeFileSync(target, original);
    }
    assert.equal(checkIntegrity({ repoRoot: root }).ok, true, "restore must return the tree to clean");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the real checkout is pinned and currently clean", () => {
  // The committed manifest must exist and must match this tree. If this fails,
  // either a judgment set changed without an amendment, or the manifest is stale.
  const result = checkIntegrity({ repoRoot: REPO_ROOT });
  assert.equal(result.ok, true, formatViolations(result));
  const files = collectGovernedFiles(REPO_ROOT);
  // Non-vacuity for the real repo: the gate must actually be covering something.
  assert.ok(files.length >= 5, `expected the real judgment sets to be governed, got ${files.length}`);
  assert.ok(
    files.includes("bench/judgments/wave1-judgments.json"),
    "the frozen wave-1 set must be governed"
  );
});