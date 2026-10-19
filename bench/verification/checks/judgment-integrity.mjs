// bench/verification/checks/judgment-integrity.mjs — judgment-set integrity gate.
//
// WHY THIS EXISTS
//
// This project has closed failing gates by editing the instruments instead of
// the engine: a "seventh gate" was closed by amending the versioned judgment
// set, one expectation was deleted because the engine ranked it 18/23, and a
// dozen `judgments.*` rows were marked `verified` while their before/after
// artifacts were byte-identical. A judgment set that can be edited in the same
// commit that reads it cannot fail: every edit is invisible, because the edit
// and the measurement move together.
//
// So the sets and the measurement artifacts are pinned by content hash in
// `bench/judgments/INTEGRITY.json`. Changing one is a loud, explicit act:
//
//     node bench/verification/checks/judgment-integrity.mjs
//     node bench/verification/checks/judgment-integrity.mjs --amend-judgments --reason "…"
//
// Without `--amend-judgments` any change to a governed file fails. `--reason`
// is mandatory on amend, so the amendment carries a justification a reviewer
// can check rather than a silent re-baseline.
//
// SCOPE — what is governed:
//   * `bench/judgments/*.json`  (the versioned judgment sets, bars and probes)
//   * every `*-baseline.json`    (the before/after measurement artifacts)
// The manifest itself is excluded (it is the pin, not the pinned).
//
// This is deliberately separate from `identity-guard.mjs`, which checks that a
// summary's before/after artifacts are *distinct measurements of two refs*.
// This gate checks that the instruments themselves have not moved underfoot.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

/** The manifest: the pin file. Excluded from its own governed set. */
export const MANIFEST_RELPATH = "bench/judgments/INTEGRITY.json";
export const MANIFEST_VERSION = 1;

/** Directory holding the versioned judgment sets. */
export const JUDGMENTS_DIR = "bench/judgments";

/** sha256 of a file's bytes, or null when it does not exist. */
export function sha256File(p) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}

/** Directories that are generated, never instruments. */
const BUILD_DIRS = ["node_modules", "target", ".git", "dist"];

/**
 * Is `relpath` governed? The versioned judgment sets and every
 * `-baseline.json` measurement artifact; never the manifest itself, and never
 * anything under generated build output (a `target/release/x-baseline.json` is
 * build cache, not an instrument, and is not byte-reproducible).
 */
export function isGoverned(relpath) {
  const posix = relpath.split(path.sep).join("/");
  if (posix === MANIFEST_RELPATH) return false;
  if (posix.split("/").some((s) => BUILD_DIRS.includes(s))) return false;
  if (posix.startsWith(`${JUDGMENTS_DIR}/`) && posix.endsWith(".json")) return true;
  // Fixed-name evidence and scorecards outside the judgment dir. The
  // equivalence golden is an instrument (it is the frozen 30-query answer
  // set, cited as final by docs/sla.md) and was overwritten in 4bc510e while
  // this gate stayed silent because it only matched `*-baseline.json` (#61).
  if (posix === "bench/baseline/results/equivalence-golden.json") return true;
  if (/^bench\/verification\/(before|after)\/equivalence-golden\.json$/.test(posix)) return true;
  if (/^bench\/wave\d+\/[^/]+\.json$/.test(posix)) return true;
  if (/^bench\/verification\/[^/]+\.json$/.test(posix)) return true;
  return posix.endsWith("-baseline.json");
}

function walk(dir, root, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    // Build output and dependency trees are never governed: they are not
    // instruments, and they are not reproducible byte-for-byte.
    if (BUILD_DIRS.includes(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(abs, root, out);
    else out.push(path.relative(root, abs).split(path.sep).join("/"));
  }
  return out;
}

/** Every governed file in the tree, sorted. Works without git. */
export function collectGovernedFiles(repoRoot = REPO_ROOT) {
  return walk(repoRoot, repoRoot).filter(isGoverned).sort();
}

/** The current hash of every governed file: `{ "<relpath>": "<sha256>" }`. */
export function computeManifestFiles(repoRoot = REPO_ROOT) {
  const out = {};
  for (const rel of collectGovernedFiles(repoRoot)) out[rel] = sha256File(path.join(repoRoot, rel));
  return out;
}

/** Read the stored manifest, or null when absent/unreadable. */
export function readManifest(repoRoot = REPO_ROOT) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, MANIFEST_RELPATH), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Compare the tree against the pin.
 *
 * Returns `{ ok, violations, checked, missing }` where each violation is
 * `{ file, kind, expected, actual }` and `kind` is one of
 *   changed  — the file's bytes differ from the pinned hash
 *   added    — a governed file exists that the pin does not cover
 *   removed  — a pinned file no longer exists
 */
export function checkIntegrity({ repoRoot = REPO_ROOT, manifest = null } = {}) {
  const stored = manifest ?? readManifest(repoRoot);
  if (!stored) {
    return {
      ok: false,
      violations: [{ file: MANIFEST_RELPATH, kind: "manifest-missing", expected: `a manifest at version ${MANIFEST_VERSION}`, actual: null }],
      checked: 0,
      missing: [],
    };
  }

  const actual = computeManifestFiles(repoRoot);
  const pinned = stored.files ?? {};
  const violations = [];

  for (const [file, expected] of Object.entries(pinned)) {
    if (!(file in actual)) {
      violations.push({ file, kind: "removed", expected, actual: null });
    } else if (actual[file] !== expected) {
      violations.push({ file, kind: "changed", expected, actual: actual[file] });
    }
  }
  for (const file of Object.keys(actual)) {
    if (!(file in pinned)) violations.push({ file, kind: "added", expected: null, actual: actual[file] });
  }

  return {
    ok: violations.length === 0,
    violations,
    checked: Object.keys(actual).length,
    missing: [],
  };
}

/**
 * Build a new manifest. `reason` is mandatory: an amendment is a deliberate,
 * reviewed act, and an unexplained re-baseline is the failure this gate exists
 * to prevent.
 */
export function buildManifest({ repoRoot = REPO_ROOT, reason, previous = null, now = new Date() } = {}) {
  if (!reason || !String(reason).trim()) {
    throw new Error("an amendment requires --reason (what changed, and why it is legitimate)");
  }
  const files = computeManifestFiles(repoRoot);
  const priorHashes = previous?.files ?? {};
  const changed = Object.keys(files).filter((f) => f in priorHashes && priorHashes[f] !== files[f]);
  const added = Object.keys(files).filter((f) => !(f in priorHashes));
  const removed = Object.keys(priorHashes).filter((f) => !(f in files));

  return {
    version: MANIFEST_VERSION,
    generated_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    amend_command: "node bench/verification/checks/judgment-integrity.mjs --amend-judgments --reason \"<why>\"",
    note:
      "Content hashes of the versioned judgment sets, the equivalence golden, the scorecards and every " +
      "*-baseline.json measurement artifact. " +
      "Any change fails the integrity gate unless it is amended deliberately with --amend-judgments --reason.",
    amendments: [
      ...(previous?.amendments ?? []),
      { date: now.toISOString().replace(/\.\d{3}Z$/, "Z"), reason: String(reason).trim(), changed, added, removed },
    ],
    files,
  };
}

export function writeManifest(manifest, repoRoot = REPO_ROOT) {
  const p = path.join(repoRoot, MANIFEST_RELPATH);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2) + "\n");
  return p;
}

/** Human-readable failure report. Loud on purpose. */
export function formatViolations(result) {
  const lines = ["", "JUDGMENT-SET INTEGRITY GATE: FAILED", ""];
  if (result.violations.some((v) => v.kind === "manifest-missing")) {
    lines.push(
      `  No integrity manifest at ${MANIFEST_RELPATH}.`,
      "  Create it deliberately:",
      `    node bench/verification/checks/judgment-integrity.mjs --amend-judgments --reason "initial pin"`,
      ""
    );
    return lines.join("\n");
  }
  lines.push(`  ${result.violations.length} governed file(s) differ from the pin (${result.checked} checked):`, "");
  for (const v of result.violations) {
    lines.push(`    [${v.kind.toUpperCase()}] ${v.file}`);
    if (v.kind === "changed") lines.push(`        pinned  ${v.expected}\n        on disk ${v.actual}`);
    if (v.kind === "added") lines.push(`        unpinned file on disk (sha256 ${String(v.actual).slice(0, 16)}…)`);
    if (v.kind === "removed") lines.push(`        pinned  ${String(v.expected).slice(0, 16)}…`);
  }
  lines.push(
    "",
    "  The judgment sets and measurement artifacts are pinned so a gate cannot be",
    "  closed by editing the instrument it is measured against. If this change is",
    "  legitimate, amend it deliberately and say why:",
    "",
    '    node bench/verification/checks/judgment-integrity.mjs --amend-judgments --reason "<what changed, why it is legitimate>"',
    "",
    "  Editing an instrument to turn a red gate green is not an amendment.",
    ""
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------- CLI

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const argv = process.argv.slice(2);
  const amend = argv.includes("--amend-judgments");
  const reasonIdx = argv.indexOf("--reason");
  const reason = reasonIdx >= 0 ? argv[reasonIdx + 1] : undefined;

  if (amend) {
    if (!reason || !String(reason).trim()) {
      console.error(
        "\nREFUSING to amend: --amend-judgments requires --reason \"<what changed, why it is legitimate>\".\n" +
          "An unexplained re-baseline is exactly the failure this gate prevents.\n"
      );
      process.exit(2);
    }
    const previous = readManifest(REPO_ROOT);
    const manifest = buildManifest({ repoRoot: REPO_ROOT, reason, previous });
    const p = writeManifest(manifest, REPO_ROOT);
    const last = manifest.amendments[manifest.amendments.length - 1];
    console.log(
      JSON.stringify(
        {
          amended: true,
          manifest: path.relative(REPO_ROOT, p),
          files: Object.keys(manifest.files).length,
          reason: last.reason,
          changed: last.changed,
          added: last.added,
          removed: last.removed,
        },
        null,
        2
      )
    );
  } else {
    const result = checkIntegrity({ repoRoot: REPO_ROOT });
    if (!result.ok) {
      console.error(formatViolations(result));
      process.exit(1);
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          manifest: MANIFEST_RELPATH,
          files_checked: result.checked,
          note: "judgment sets and measurement artifacts are unmodified",
        },
        null,
        2
      )
    );
  }
}