// Security tests for the DLP layer (#23).
//
// Covers the three ways credential material used to reach the model:
//   1. a PEM body scrubbed line by line could never match, so every body line
//      was emitted verbatim (the regex was also written as the malformed
//      character class `[[\s\S]*?`);
//   2. query *path* output was never scrubbed at all;
//   3. no test asserted the negative: that ordinary code lines survive DLP.
process.env.PI_ULTRASEARCH_TEST = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { scrubSecrets, SecretGuard, looksLikePemBody, isSensitiveFile, queryScopes, unsafeQueryScope } from "../src/sanitize.ts";

/** A realistic multi-line RSA key: 64-column base64 body, five lines. */
const PEM_BODY = [
  "MIIEpAIBAAKCAQEA1234567890abcdefGHIJKLmnopqrstuvwxyz0123456789+/ABCDEF",
  "qrstuvwxyz0123456789+/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrst",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/AB",
  "mnoPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/ABCDEFGHIJKL",
  "DEADBEEFCAFEBABE0123456789+/AB",
];
const PEM = ["-----BEGIN RSA PRIVATE KEY-----", ...PEM_BODY, "-----END RSA PRIVATE KEY-----"].join("\n");
const OPENSSH_PEM = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz",
  "c2gtZWQyNTUxOQAAACDq0Y3DKkjNqkAzUFmCqGZ4uWcR3xDKkjNqkAzUFmCqGQAA",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

test("PEM: a whole multi-line block is redacted, body included", () => {
  const out = scrubSecrets(PEM);
  assert.ok(!out.includes("MIIEpAIBAAKCAQEA"), `body leaked: ${out}`);
  assert.ok(!out.includes("qrstuvwxyz0123456789+/"), `body leaked: ${out}`);
  assert.ok(!/-----END/.test(out), `footer survived: ${out}`);
  assert.match(out, /REDACTED/);
});

test("PEM: the EC and OpenSSH variants are redacted too", () => {
  const block = ["-----BEGIN EC PRIVATE KEY-----", ...PEM_BODY.slice(0, 3), "-----END EC PRIVATE KEY-----"].join("\n");
  for (const key of [block, OPENSSH_PEM]) {
    const out = scrubSecrets(key);
    for (const line of key.split("\n").filter((l) => l.length > 40)) {
      assert.ok(!out.includes(line), `line leaked from ${key.split("\n")[0]}: ${out}`);
    }
  }
});

test("PEM: scrubbing line by line redacts the whole body", () => {
  // This is the real grep path: the daemon returns matching lines, not files.
  const guard = new SecretGuard();
  const out = PEM.split("\n").map((l) => guard.line(l));
  assert.equal(out[0].includes("-----BEGIN"), false, out[0]);
  for (const body of PEM_BODY) {
    assert.ok(!out.join("\n").includes(body), `body line leaked through the guard: ${out.join("\n")}`);
  }
  assert.ok(out.slice(1, -1).every((l) => l === "[REDACTED_PRIVATE_KEY_BODY]"), JSON.stringify(out));
  assert.equal(guard.insidePrivateKey, false, "the guard must leave the block at the footer");
});

test("PEM: a body line whose header was not returned is still redacted", () => {
  // grep returns the matching line only; the BEGIN may be far above it.
  const guard = new SecretGuard();
  for (const out of [guard.line(PEM_BODY[0]), scrubSecrets(PEM_BODY[0])]) {
    assert.ok(!out.includes(PEM_BODY[0]), `body leaked: ${out}`);
    assert.match(out, /REDACTED/);
  }
  assert.equal(looksLikePemBody(PEM_BODY[0]), true);
  // The line's own shape must be recognisable as key material...
  assert.equal(looksLikePemBody("a3f5c9d8e7b6a5f4c3d2e1b0a9f8e7d6c5b4a3f2"), false, "a hex digest is not a key body");
});

test("PEM: a stray BEGIN cannot blank an unbounded amount of output", () => {
  const guard = new SecretGuard();
  guard.line("-----BEGIN RSA PRIVATE KEY-----");
  assert.equal(guard.insidePrivateKey, true);
  for (let i = 0; i < 200; i++) guard.line(`line ${i} of an unrelated file`);
  assert.equal(guard.insidePrivateKey, false, "the guard must time out");
  assert.equal(guard.line("visible again"), "visible again");
});

test("DLP false positives: ordinary code is never scrubbed", () => {
  // Ordinary lines, including the shapes a naive DLP rule gets wrong: a git
  // SHA-1, a SHA-256, a long hex constant, a data URI, a minified line, a
  // base64-looking identifier, a URL with a query string.
  const corpus = [
    "const x = 1;",
    "export function alpha() { return 42; }",
    '  const sha = "a3f5c9d8e7b6a5f4c3d2e1b0a9f8e7d6c5b4a3f2";',
    '{"name":"alpha","version":"1.2.3","license":"MIT"}',
    "https://example.com/path/to/resource?token=abc&page=2",
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    "a3f5c9d8e7b6a5f4c3d2e1b0a9f8e7d6c5b4a3f2",
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "// TODO: remove this before release",
    "for (let i = 0; i < 100; i++) { total += i * 2; }",
    "-rw-r--r--  1 user staff 1234 Oct 15 10:00 README.md",
    "  path: /Users/someone/projects/ultra-search/src/index.ts",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "// AWS access key ids start with AKIA; the redactor matches the full 20 chars",
    "1c8bfe8f801d79745c4631d09fff36c82aa37fc4cce4e2b8a4f5c8bfe8f801d7",
  ];
  const guard = new SecretGuard();
  for (const line of corpus) {
    assert.equal(guard.line(line), line, `over-redacted: ${line}`);
    assert.equal(scrubSecrets(line), line, `over-redacted by scrubSecrets: ${line}`);
  }
});

test("DLP never over-redacts a path or an identifier", () => {
  const paths = [
    "/home/dev/projects/ultra-search/src/sanitize.ts",
    "/home/dev/system-memory/projects/local-memory-agent.md",
    "/var/folders/_s/8tbk7qt16cl4tb8z7bphvzz80000gn/T/build/output.json",
    "src/components/PrivateKeyViewer.tsx",
  ];
  for (const p of paths) {
    assert.equal(scrubSecrets(p), p, `path was scrubbed: ${p}`);
  }
});

test("the credential families that were already covered still are", () => {
  // Each token is built from its prefix at runtime rather than written whole:
  // a fixture does not need to look like a live credential in the repository,
  // and a secret scanner cannot tell the two apart. The value the redactor
  // sees is exactly the documented shape.
  const cases: [string, string, string][] = [
    ["OpenAI", "sk-", "abcdefghijklmnopqrstuvwxyz012345"],
    ["GitHub PAT", "ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"],
    ["Google", "AIza", "SyA1234567890abcdefghijklmnopqrstuv"],
    ["AWS", "AKIA", "IOSFODNN7EXAMPLE"],
    ["Slack", "xoxb-", "1234567890-abcdefghijkl"],
  ];
  for (const [name, prefix, body] of cases) {
    assert.match(scrubSecrets(`value = ${prefix}${body}`), /REDACTED/, `${name} keys must still be redacted`);
  }
});

test("a sensitive filename is still recognised", () => {
  assert.equal(isSensitiveFile("/Users/x/.env"), true);
  assert.equal(isSensitiveFile("/Users/x/id_ed25519"), true);
  assert.equal(isSensitiveFile("/Users/x/server.pem"), true);
  assert.equal(isSensitiveFile("/Users/x/src/index.ts"), false);
});

test("query scopes: `in:` inside a query is checked like a tool parameter", () => {
  // The daemon's query language has its own `in:` filter, so a query is a
  // second way to name a scope. Both forms must be seen.
  assert.deepEqual(queryScopes("in:/etc/hosts passwd"), ["/etc/hosts"]);
  assert.deepEqual(queryScopes("alpha in:/home/dev/repo"), ["/home/dev/repo"]);
  assert.deepEqual(queryScopes('in:"/home/dev/My Docs" alpha'), ["/home/dev/My Docs"]);
  assert.deepEqual(queryScopes("in:~/secret alpha"), ["~/secret"]);
  assert.deepEqual(queryScopes("alpha beta"), []);
  // A word that merely contains `in:` is not a scope.
  assert.deepEqual(queryScopes("admin:/x" ), []);
});

test("query scopes: an escaping scope is refused, an in-root one is not", () => {
  const root = "/home/dev/repo";
  assert.equal(unsafeQueryScope("in:/etc/passwd x", root), "/etc/passwd");
  assert.equal(unsafeQueryScope("in:/home/dev/other x", root), "/home/dev/other");
  assert.equal(unsafeQueryScope("in:../../etc x", root), null, "a relative scope is the daemon's to resolve");
  assert.equal(unsafeQueryScope("in:/home/dev/repo/src x", root), null);
  assert.equal(unsafeQueryScope("in:/home/dev/repo x", root), null);
  // The offending token is returned as written, so the error can quote it.
  assert.equal(unsafeQueryScope("in:~/secret x", root, "/home/dev"), "~/secret");
  assert.equal(unsafeQueryScope("in:~/repo/src x", root, "/home/dev"), null);
  assert.equal(unsafeQueryScope("plain words", root), null);
});
