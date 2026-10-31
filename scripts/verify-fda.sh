#!/usr/bin/env bash
set -euo pipefail

SOCKET="${ULTRASEARCH_SOCKET:-$HOME/Library/Application Support/UltraSearch/ultrasearch.sock}"
PROBE_PATH="${ULTRASEARCH_FDA_PROBE_PATH:-$HOME/Library/Mail}"

node --input-type=module - "$SOCKET" "$PROBE_PATH" <<'NODE'
import net from "node:net";

const [socketPath, scope] = process.argv.slice(2);

function request(payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("daemon socket timed out")), 5000);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    }

    socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(null, JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        finish(new Error(`daemon returned invalid JSON: ${error.message}`));
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => {
      if (!settled) finish(new Error("daemon closed the socket without a response"));
    });
  });
}

try {
  const ping = await request({ op: "ping", id: 1 });
  if (ping.ok !== true) throw new Error(`socket ping failed: ${ping.error ?? "unknown error"}`);
  console.log(`socket: responding at ${socketPath}`);

  const status = await request({ op: "status", id: 2 });
  const grep = await request({
    op: "grep",
    id: 3,
    pattern: "ultrasearch-fda-check-7f4c2a91-never-match",
    mode: "literal",
    in: scope,
    limit: 1,
  });
  const hits = Array.isArray(grep.files) ? grep.files.length : 0;
  console.log(`grep: ${hits} hit(s) in ${scope}`);

  if (grep.ok !== true) {
    console.error(`ERROR: grep returned an error cleanly: ${grep.error ?? "unknown error"}`);
    process.exitCode = 1;
  }
  if (hits !== 0) {
    console.error("ERROR: the unique FDA probe unexpectedly matched indexed content");
    process.exitCode = 1;
  }
  if (status.full_disk_access === false) {
    console.error("ERROR: daemon reports Full Disk Access is unavailable; a zero-hit grep is expected for a guarded folder, and the socket response confirms the daemon did not crash");
    process.exitCode = 1;
  } else if (status.full_disk_access === true && grep.ok === true && hits === 0) {
    console.log("Full Disk Access: granted; the guarded-path grep completed with zero probe hits");
  } else if (status.full_disk_access !== true) {
    console.error("ERROR: status did not include a boolean full_disk_access field");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
}
NODE
