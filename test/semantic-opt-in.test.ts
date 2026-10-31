import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Semantic mode is gated OFF unless ULTRASEARCH_EXPERIMENTAL_SEMANTIC=1.
 *
 * Why a gate and not a removal: semantic is intent keyword expansion, not vector search, and it
 * measures badly on this project's own gold fixtures - nDCG@10 0.194, paraphrase recall@10 0.175,
 * false-positive rate 1.00. Closing that gap is research, not a patch, so the capability is worth
 * keeping. But an agent that trusts a confident-looking ten-file answer is worse off than one
 * that gets an honest refusal, so it must not be reachable by accident.
 *
 * The refusal text matters as much as the gate: it has to name the numbers and the way out, or an
 * agent reads "disabled" and falls back to whatever it had.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
// The npm test script intentionally runs before `npm run build`, so launch the
// source entrypoint supported by the declared Node >=22.18 runtime instead of
// depending on a dist/ artifact left over from a prior build.
const server = path.join(repoRoot, "bin", "mcp-server.ts");

/**
 * Call ultrasearch_grep over a real MCP session and return its stdout.
 *
 * Two things this has to get right, both learned by watching the first version of this test pass
 * for the wrong reasons:
 *
 *  1. The handshake. `tools/call` before `initialize` returns "Server not initialized", and an
 *     assertion like "does not contain /disabled by default/" then passes vacuously.
 *  2. The process does not exit when stdin closes. With spawnSync every call therefore blocked
 *     for the full timeout — measured 8s and 24s — even though the response was already written.
 *     That load tipped the F7 concurrency test into a reproducible failure in the full suite. So:
 *     read until the response for our id arrives, then kill the server. The refusal path responds
 *     without a daemon; live controls check for one before calling, so the wait is on output, not exit.
 */
async function callGrep(pattern: string, mode: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
	const init = {
		jsonrpc: "2.0",
		id: 0,
		method: "initialize",
		params: {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "semantic-opt-in-test", version: "0.0.0" },
		},
	};
	const ready = { jsonrpc: "2.0", method: "notifications/initialized" };
	const call = {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name: "ultrasearch_grep", arguments: { pattern, mode, limit: 5 } },
	};

	return new Promise<string>((resolve, reject) => {
		const child = spawn(process.execPath, [server], {
			env: {
				...process.env,
				// Route this server's telemetry to a synthetic per-process log.
				//
				// Without this the spawned server appends to the PRODUCTION audit log, which is a
				// standing hazard in this repo and is exactly what test/telemetry-logs.test.ts F7
				// asserts is untouched. Measured: adding this test without these two variables made
				// F7 fail reproducibly in the full suite while passing alone — my test was the
				// writer F7 was guarding against.
				PI_ULTRASEARCH_TEST: "1",
				PI_ULTRASEARCH_TEST_LOG: path.join(
					repoRoot,
					".tmp",
					`semantic-opt-in-${process.pid}-${pattern.replace(/\W+/g, "_")}.ndjson`,
				),
				...env,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		let out = "";
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill("SIGKILL");
			fn();
		};
		const timer = setTimeout(
			() => finish(() => reject(new Error(`no response within 20s:\n${out}`))),
			20_000,
		);

		child.stdout.on("data", (d: Buffer) => {
			out += d.toString();
			// The response to our tools/call carries "id":1.
			if (/"id"\s*:\s*1/.test(out)) finish(() => resolve(out));
		});
		child.on("error", (e) => finish(() => reject(e)));
		child.on("exit", () => finish(() => resolve(out)));

		for (const m of [init, ready, call]) child.stdin.write(JSON.stringify(m) + "\n");
		child.stdin.end();
	});
}

/** Guards against a killed/timed-out call being mistaken for a clean answer. */
function assertResponded(out: string, what: string) {
	assert.match(
		out,
		/"id"\s*:\s*1/,
		`${what}: no JSON-RPC response was produced, so any "does not contain" assertion below ` +
			`would be vacuous:\n${out}`,
	);
}

/**
 * The controls below need the resident daemon: without it the MCP server sits until the timeout,
 * which costs ~8s of load per call and — measured — tipped the F7 concurrency test into a
 * reproducible failure in the full suite. So they skip, WITH a printed reason, when no daemon is
 * listening. An explicit skip is fine here; a silent one is the failure mode this repo keeps
 * finding. The refusal test itself needs no daemon and always runs.
 */
function daemonSocket(): string {
	if (process.env.PI_ULTRASEARCH_SOCKET) return process.env.PI_ULTRASEARCH_SOCKET;
	const home = process.env.HOME ?? "";
	if (process.platform === "darwin") return path.join(home, "Library/Application Support/UltraSearch/ultrasearch.sock");
	return path.join(home, ".local/share/ultrasearch/ultrasearch.sock");
}

function daemonAvailable(): boolean {
	try {
		return existsSync(daemonSocket());
	} catch {
		return false;
	}
}

test("semantic is refused by default and the refusal explains itself", async () => {
	const out = await callGrep("how does ranking work", "semantic");
	assertResponded(out, "semantic default");
	assert.match(out, /disabled by default/i, "must refuse, not silently fall back:\n" + out);
	assert.match(out, /0\.194/, "must state the measured nDCG");
	assert.match(out, /1\.00/, "must state the false-positive rate");
	assert.match(out, /ULTRASEARCH_EXPERIMENTAL_SEMANTIC=1/, "must name the opt-in");
	assert.match(out, /literal|symbol/, "must name a usable alternative");
});

test("CONTROL: with the opt-in set, semantic is no longer refused", async (t) => {
	// Without this control the test above would also pass if semantic had simply been deleted, or
	// if the whole tool were broken. A refusal gate that cannot be opened is not a gate.
	if (!daemonAvailable()) {
		t.skip(`no resident ultrasearch daemon at ${daemonSocket()}; the opt-in path reaches the daemon`);
		return;
	}
	const out = await callGrep("how does ranking work", "semantic", {
		ULTRASEARCH_EXPERIMENTAL_SEMANTIC: "1",
	});
	assertResponded(out, "semantic opt-in");
	assert.doesNotMatch(
		out,
		/disabled by default/i,
		"with the opt-in set semantic must proceed:\n" + out,
	);
});

test("CONTROL: the other modes are unaffected by the gate", async (t) => {
	if (!daemonAvailable()) {
		t.skip(`no resident ultrasearch daemon at ${daemonSocket()}; literal/regex/symbol reach the daemon`);
		return;
	}
	for (const mode of ["literal", "regex", "symbol"]) {
		const out = await callGrep("search", mode);
		assertResponded(out, `mode=${mode}`);
		assert.doesNotMatch(out, /disabled by default/i, `mode=${mode} must not be gated:\n` + out);
	}
});
