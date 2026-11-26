// Hermetic E2E tests for `op: "batch_resolve"` (protocol 1.1).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { EngineHarness, writeFile, tmpdir, until } from "./harness.mjs";

test("batch_resolve: resolves symbols and paths in one roundtrip with deny/root containment", async () => {
  const root = path.join(tmpdir("us-batch-"), "root");
  writeFile(path.join(root, "src", "alpha.rs"), "pub fn write_note_anchor() -> usize {\n    42\n}\n");
  writeFile(path.join(root, "src", "helpers", "symbiosis_util.ts"), "export const SYMBIOSIS_TOKEN = 7;\n");
  writeFile(path.join(root, "secret", "hidden.rs"), "pub fn HIDDEN_SECRET_SYMBOL() {}\n");
  writeFile(path.join(root, "other", "outside.rs"), "pub fn OUTSIDE_ROOT_SYMBOL() {}\n");

  const h = new EngineHarness({ root });
  fs.writeFileSync(path.join(h.dir, "deny.txt"), `${path.join(h.root, "secret")}\n`);
  await h.start();
  await until(async () => (await h.status()).content_docs >= 4, { timeoutMs: 20_000 });

  try {
    const res = await h.request({
      op: "batch_resolve",
      in: path.join(h.root, "src"),
      root: path.join(h.root, "src"),
      symbols: [
        "write_note_anchor",
        "helpers/symbiosis_util.ts",
        "SYMBIOSIS_TOKEN",
        "definitely_missing_symbol_xyz",
        "OUTSIDE_ROOT_SYMBOL",
      ],
      budget_ms: 400,
    });

    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.complete, true, JSON.stringify(res));
    assert.ok(res.hits.write_note_anchor, `missing code hit: ${JSON.stringify(res)}`);
    assert.match(res.hits.write_note_anchor.path, /src\/alpha\.rs$/);
    assert.equal(res.hits.write_note_anchor.line, 1);

    assert.ok(res.hits["helpers/symbiosis_util.ts"], `missing path hit: ${JSON.stringify(res)}`);
    assert.match(res.hits["helpers/symbiosis_util.ts"].path, /symbiosis_util\.ts$/);

    assert.ok(res.hits.SYMBIOSIS_TOKEN, JSON.stringify(res));
    assert.equal(res.hits.definitely_missing_symbol_xyz, null);
    assert.equal(res.hits.OUTSIDE_ROOT_SYMBOL, null);

    // Deny enforcement: denied scope must error closed; global scan must withhold secret hit.
    const deniedScope = await h.request({
      op: "batch_resolve",
      in: path.join(h.root, "secret"),
      symbols: ["HIDDEN_SECRET_SYMBOL"],
    });
    assert.equal(deniedScope.ok, false);
    assert.match(deniedScope.error, /denied by policy/);

    const withheldCheck = await h.request({
      op: "batch_resolve",
      symbols: ["HIDDEN_SECRET_SYMBOL", "write_note_anchor"],
    });
    assert.equal(withheldCheck.ok, true, JSON.stringify(withheldCheck));
    assert.equal(withheldCheck.hits.HIDDEN_SECRET_SYMBOL, null);
    assert.ok(withheldCheck.withheld >= 1, JSON.stringify(withheldCheck));
  } finally {
    h.cleanup();
  }
});
