// #59: a scan-mode grep must not read gitignored trees before filtering them.
//
// The live name index holds ignored files (a worktree's build output). Before
// this fix, `ignored: false` was applied after the files were read — and for a
// scope with no git status (a fresh/linked worktree, a non-git fixture) the
// old server-side filter could not even drop them. The client filtered the
// rows it received, so the tool looked right while the daemon paid for every
// ignored file.
//
// This test forces scan mode (HOME is an empty dir, so the content index does
// not hold the scope), puts the matching text in both a kept and an ignored
// file, and asserts the ignored one never crosses the socket when the request
// asks for it to be hidden. The control proves it is in the index.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { EngineHarness, writeFile, tmpdir, until } from "./harness.mjs";

test("#59: ignored files are pruned before the scan reads them", async () => {
  const h = new EngineHarness({ root: path.join(tmpdir("us-ignore-"), "root") });
  fs.mkdirSync(path.join(h.root, ".git"), { recursive: true });
  writeFile(path.join(h.root, ".gitignore"), "ignored/\n");
  writeFile(path.join(h.root, "src", "keep.ts"), "export const kept = 'NEEDLE_IGNORE_7c2';\n");
  writeFile(path.join(h.root, "ignored", "drop.ts"), "export const dropped = 'NEEDLE_IGNORE_7c2';\n");

  // Force scan mode: the content index is built under a different HOME.
  h.env.ULTRASEARCH_HOME = tmpdir("us-ignore-home-");
  h.env.ULTRASEARCH_SCAN_ROOT = h.root;
  await h.start();
  try {
    // The name index is live: wait until both files are visible (the control
    // request, which does not prune), then measure the pruned one.
    const all = await until(
      async () => {
        const r = await h.grep("NEEDLE_IGNORE_7c2", { in: h.root, limit: 10, ignored: true });
        const ps = (r.files ?? []).map((f) => f.path);
        return ps.some((p) => p.includes("/ignored/drop.ts")) && ps.some((p) => p.endsWith("/src/keep.ts")) ? r : null;
      },
      { timeoutMs: 15_000 }
    );
    assert.ok(all, "fixture files never appeared in the index");

    const hidden = await h.grep("NEEDLE_IGNORE_7c2", { in: h.root, limit: 10, ignored: false });
    assert.equal(hidden.ok, true);
    assert.equal(hidden.source, "scan", "the fixture must exercise the scan path");
    const hiddenPaths = (hidden.files ?? []).map((f) => f.path);
    assert.ok(hiddenPaths.some((p) => p.endsWith("/src/keep.ts")), "the kept file must be found");
    assert.ok(!hiddenPaths.some((p) => p.includes("/ignored/")), `ignored file crossed the socket: ${JSON.stringify(hiddenPaths)}`);

    // Control: the ignored file is in the name index, so only the prune can
    // explain its absence above.
    const allPaths = (all.files ?? []).map((f) => f.path);
    assert.ok(allPaths.some((p) => p.includes("/ignored/drop.ts")), `control: ignored file missing when asked for: ${JSON.stringify(allPaths)}`);
  } finally {
    h.cleanup();
  }
});
