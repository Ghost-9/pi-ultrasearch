// The ignore-file forms, end to end through a real walk.
//
// The unit test in `walk.rs` only proves the parser classifies a line correctly.
// That is not the property that matters: `dist/**` was parsed as an "ambiguous
// glob" and skipped, so `.gitignore` silently did nothing and build output went
// into the index. Only a real daemon against a real tree can show whether pruning
// actually happened.
//
// Each case builds a tree with a keep file and a drop file, writes one ignore form,
// and asserts the drop file never reaches the index while the keep file does.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { EngineHarness, tmpdir, until, HAS_ENGINE } from "./harness.mjs";

// Each form is one that real projects actually use.
const FORMS = [
  { name: "dir/**", ignore: "dist/**\n", dropDir: "dist" },
  { name: "dir/*", ignore: "build/*\n", dropDir: "build" },
  { name: "**/dir", ignore: "**/vendor\n", dropDir: "vendor" },
  { name: "plain dir/", ignore: "out/\n", dropDir: "out" },
];

for (const form of FORMS) {
  test(`ignore form \`${form.name}\` prunes at enumeration`, { skip: !HAS_ENGINE && "engine not built" }, async () => {
    const base = tmpdir("us-ignoreform-");
    const root = path.join(base, "root");
    const keepName = `KEEPMARKER_${form.dropDir}`;
    const dropName = `DROPMARKER_${form.dropDir}`;

    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, form.dropDir), { recursive: true });
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, ".gitignore"), form.ignore);
    fs.writeFileSync(path.join(root, "src", `${keepName}.ts`), "kept\n");
    fs.writeFileSync(path.join(root, form.dropDir, `${dropName}.ts`), "dropped\n");

    const h = new EngineHarness({ root });
    h.env.ULTRASEARCH_SCAN_ROOT = root;
    await h.start();
    try {
      // The keep file proves the walk reached the tree; only then is the absence
      // of the drop file meaningful.
      const keep = await until(
        async () => {
          const r = await h.search(keepName, { limit: 10 });
          return (r.hits ?? []).length ? r : null;
        },
        { timeoutMs: 20_000 }
      );
      assert.ok(keep, `the keep file never appeared, so the absence of the drop file proves nothing`);

      const drop = await h.search(dropName, { limit: 10 });
      const paths = (drop.hits ?? []).map((hit) => hit.path);
      assert.equal(
        paths.length,
        0,
        `\`${form.name}\` should prune ${form.dropDir}/ but this file was indexed: ${JSON.stringify(paths)}`
      );

      // And the prune is reported, so the exclusion in force is readable rather
      // than remembered.
      const st = await h.status();
      const pruned = (st.excluded_names ?? []).map((n) => n.toLowerCase());
      assert.ok(
        pruned.includes(form.dropDir.toLowerCase()),
        `status should list ${form.dropDir} among the names it prunes; got ${JSON.stringify(pruned.slice(0, 12))}`
      );
    } finally {
      h.cleanup();
    }
  });
}

// A form the engine cannot honour must be REFUSED rather than guessed at, and the
// refusal must be visible: a silently ignored rule is how `dist/**` went unnoticed.
test("an interior-path rule is refused rather than guessed", { skip: !HAS_ENGINE && "engine not built" }, async () => {
  const base = tmpdir("us-ignoreform-unhonoured-");
  const root = path.join(base, "root");
  fs.mkdirSync(path.join(root, "a", "b", "c"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  // `a/b/c` needs path context the walk does not have at enumeration.
  fs.writeFileSync(path.join(root, ".gitignore"), "a/b/c/\n");
  fs.writeFileSync(path.join(root, "a", "b", "c", "HONOURCHECK_marker.ts"), "x\n");

  const h = new EngineHarness({ root });
  h.env.ULTRASEARCH_SCAN_ROOT = root;
  await h.start();
  try {
    const found = await until(
      async () => {
        const r = await h.search("HONOURCHECK_marker", { limit: 10 });
        return (r.hits ?? []).length ? r : null;
      },
      { timeoutMs: 20_000 }
    );
    assert.ok(
      found,
      "a rule the walk cannot honour must not silently prune: the file should still be indexed"
    );
  } finally {
    h.cleanup();
  }
});
