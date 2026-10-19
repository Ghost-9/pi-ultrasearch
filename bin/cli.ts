#!/usr/bin/env node
import { UltraSearchClient } from "../src/client.ts";
import { formatGrepFiles } from "../src/formatter.ts";
import { formatAuditSummary, summarizeAudit, loadAudit, type AuditView } from "../src/telemetry.ts";
import { LsmCompactor } from "../src/compactor.ts";
import { formatRecursiveLearningReport } from "../src/recursive-learning.ts";
import { UltraSearchTui } from "../src/tui.ts";
import { WatchSession, parseWatchArgs, formatWatchEvent } from "../src/watch.ts";
import { appendHistory, clearHistory, formatSuggestions, loadHistory, resolveHistoryOptions, suggestQueries } from "../src/history.ts";
import { loadRootConfig, multiRootSearch, multiRootGrep } from "../src/roots.ts";
import { planHarnessInit, applyPlan, renderInitReport, renderHarnessList } from "../src/harness-init.ts";
import { HARNESSES } from "../src/harness-registry.ts";
import { POLICY_HARNESSES, applyPolicy, isPolicyHarnessId, planPolicy, policyBlock, policyHarnessIds } from "../src/policy.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/** Best-effort, opt-in query history (issue #40); a no-op unless enabled. */
function recordQuery(tool: string, query: string, hits: number | undefined, root: string): void {
  try {
    appendHistory({ q: query, tool, ...(typeof hits === "number" ? { hits } : {}), root });
  } catch {}
}

/** One or two past near-matches on stderr, so stdout stays machine-parseable. */
function printSuggestions(query: string, options = resolveHistoryOptions()): void {
  if (!options.enabled) return;
  try {
    const suggestions = suggestQueries(loadHistory(options), query, 2);
    if (suggestions.length > 0) process.stderr.write(`💡 Related past queries:\n${formatSuggestions(suggestions)}\n`);
  } catch {}
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "help";

  const client = new UltraSearchClient({ harness: "cli" });

  try {
    switch (command) {
      case "query":
      case "search": {
        const query = args[1];
        if (!query) {
          console.error("Usage: ultrasearch query <pattern> [--in <dir>] [--limit <n>]");
          process.exit(1);
        }
        let scope = process.cwd();
        let limit = 30;
        for (let i = 2; i < args.length; i++) {
          if (args[i] === "--in" && args[i + 1]) scope = path.resolve(args[i + 1]);
          if (args[i] === "--limit" && args[i + 1]) limit = parseInt(args[i + 1], 10);
        }
        const rootConfig = loadRootConfig();
        const result = await multiRootSearch(query, {
          activeRoot: scope,
          roots: rootConfig.roots,
          preferActiveWorktree: rootConfig.preferActiveWorktree,
          search: (q, root) => client.search(q, { in: root, limit }),
        });
        if (result.hits.length === 0 && result.errors.length > 0) {
          for (const err of result.errors) console.error(`Search error (${err.root}): ${err.error}`);
          process.exit(1);
        }
        for (const hit of result.hits) {
          console.log(result.multi && !hit.active ? `${hit.path} [root: ${hit.root}]` : hit.path);
        }
        if (result.duplicates > 0) console.error(`# ${result.duplicates} duplicate path(s) collapsed across ${result.roots.length} roots`);
        for (const err of result.errors) console.error(`! partial failure (${err.root}): ${err.error}`);
        recordQuery("ultrasearch_query", query, result.hits.length, scope);
        printSuggestions(query);
        break;
      }

      case "grep": {
        const pattern = args[1];
        if (!pattern) {
          console.error("Usage: ultrasearch grep <pattern> [--in <dir>] [--file <path>] [--case smart|sensitive|insensitive] [--mode literal|regex|symbol]");
          process.exit(1);
        }
        let scope = process.cwd();
        let file: string | undefined;
        let caseMode: "smart" | "sensitive" | "insensitive" | undefined;
        let grepMode: "literal" | "regex" | "symbol" | undefined;
        for (let i = 2; i < args.length; i++) {
          if (args[i] === "--in" && args[i + 1]) scope = path.resolve(args[i + 1]);
          if (args[i] === "--file" && args[i + 1]) { file = path.resolve(args[i + 1]); scope = path.dirname(file); }
          if (args[i] === "--case" && args[i + 1] && ["smart", "sensitive", "insensitive"].includes(args[i + 1])) caseMode = args[i + 1] as any;
          if (args[i] === "--mode" && args[i + 1] && ["literal", "regex", "symbol"].includes(args[i + 1])) grepMode = args[i + 1] as any;
        }
        if (file) {
          const r = await client.grep(pattern, { in: scope, file, case: caseMode, mode: grepMode });
          if (!r.ok) { console.error(`Grep error: ${r.error ?? "unknown"}`); process.exit(1); }
          const formatted = formatGrepFiles(r.files ?? [], { worktreeRoot: scope, compact: true });
          if (formatted.text) console.log(formatted.text);
          recordQuery("ultrasearch_grep", pattern, r.files?.length ?? 0, scope);
          break;
        }
        const rootConfig = loadRootConfig();
        const result = await multiRootGrep(pattern, {
          activeRoot: scope,
          roots: rootConfig.roots,
          preferActiveWorktree: rootConfig.preferActiveWorktree,
          grep: (p, root) => client.grep(p, { in: root, case: caseMode, mode: grepMode }),
        });
        if (result.files.length === 0 && result.errors.length > 0) {
          for (const err of result.errors) console.error(`Grep error (${err.root}): ${err.error}`);
          process.exit(1);
        }
        const formatted = formatGrepFiles(result.files, { worktreeRoot: scope, compact: true });
        console.log(formatted.text);
        if (result.duplicates > 0) console.error(`# ${result.duplicates} duplicate file(s) collapsed across ${result.roots.length} roots`);
        for (const err of result.errors) console.error(`! partial failure (${err.root}): ${err.error}`);
        recordQuery("ultrasearch_grep", pattern, result.files.length, scope);
        printSuggestions(pattern);
        break;
      }

      case "multi-grep": {
        const patterns = args.slice(1).filter((a) => !a.startsWith("--"));
        if (patterns.length === 0) {
          console.error("Usage: ultrasearch multi-grep <pattern1> <pattern2> ... [--in <dir>]");
          process.exit(1);
        }
        let scope = process.cwd();
        const inIdx = args.indexOf("--in");
        if (inIdx !== -1 && args[inIdx + 1]) scope = path.resolve(args[inIdx + 1]);

        const res = await client.multiGrep(patterns, { in: scope });
        if (!res.ok || !res.files) {
          console.error(`Multi-grep error: ${res.error || "No matches"}`);
          process.exit(1);
        }
        const formatted = formatGrepFiles(res.files, { worktreeRoot: scope, compact: true });
        console.log(formatted.text);
        break;
      }

      case "locate": {
        const filename = args[1];
        if (!filename) {
          console.error("Usage: ultrasearch locate <filename>");
          process.exit(1);
        }
        const res = await client.search(filename, { limit: 50 });
        for (const hit of res.hits || []) {
          console.log(hit.path);
        }
        break;
      }

      case "recent": {
        let scope = process.cwd();
        const inIdx = args.indexOf("--in");
        if (inIdx !== -1 && args[inIdx + 1]) scope = path.resolve(args[inIdx + 1]);

        const hits = (await client.recent(scope, 20)).hits ?? [];
        for (const hit of hits) {
          console.log(hit.path);
        }
        recordQuery("ultrasearch_recent", "(recent)", hits.length, scope);
        break;
      }

      case "compact": {
        console.log("⏳ Triggering LSM segment compaction & index consolidation...");
        const compactor = new LsmCompactor(client);
        const res = await compactor.compact();
        if (res.ok) {
          console.log(`✅ ${res.message}`);
        } else {
          console.error(`❌ ${res.message}`);
          process.exit(1);
        }
        break;
      }

      case "report":
      case "metrics": {
        // `report` is the Phase-4 surface; `metrics` stays as the historical
        // alias. `--by harness` adds the per-harness attribution block while
        // keeping the real/synthetic view split (real is the default).
        const rest = command === "report" ? args.slice(1) : args;
        let view: AuditView = "real";
        let by: "tool" | "harness" = "tool";
        let limit = 1000;
        let asJson = false;
        for (let i = 0; i < rest.length; i++) {
          const arg = rest[i];
          const value = rest[i + 1];
          if (arg === "--by" && value) {
            if (value !== "harness" && value !== "tool") {
              console.error("Usage: ultrasearch report [--by harness|tool] [--view real|synthetic|all] [--limit n] [--json]");
              process.exit(2);
            }
            by = value;
            i++;
          } else if (arg === "--view" && value) {
            if (value !== "real" && value !== "synthetic" && value !== "all") {
              console.error("Usage: ultrasearch report [--by harness|tool] [--view real|synthetic|all] [--limit n] [--json]");
              process.exit(2);
            }
            view = value;
            i++;
          } else if (arg === "--limit" && value) {
            limit = Math.max(1, parseInt(value, 10) || 1000);
            i++;
          } else if (arg === "--json") {
            asJson = true;
          } else if (arg.startsWith("--")) {
            console.error(`Unknown report flag: ${arg}`);
            process.exit(2);
          }
        }
        const audit = loadAudit(limit);
        const summary = summarizeAudit(Math.max(limit, audit.length), { view, by });
        console.log(asJson ? JSON.stringify(summary, null, 2) : formatAuditSummary(summary));
        break;
      }

      case "learning": {
        console.log(formatRecursiveLearningReport());
        break;
      }

      case "watch": {
        let parsed;
        try {
          parsed = parseWatchArgs(args.slice(1));
        } catch (err: any) {
          console.error(err?.message ?? String(err));
          process.exit(2);
        }
        const session = new WatchSession({
          query: parsed.query,
          dir: parsed.dir,
          client,
          limit: parsed.limit,
          debounceMs: parsed.debounceMs,
          ...(parsed.durationMs !== undefined ? { durationMs: parsed.durationMs } : {}),
          once: parsed.once,
          onEvent: (event) => console.log(formatWatchEvent(event, parsed.dir, parsed.json)),
        });
        // The shared client is closed by main's finally; the session must not
        // close it early or hold the socket after stop().
        const stats = await session.run();
        process.stderr.write(
          `# watch stopped: ${stats.added} added, ${stats.removed} removed, ${stats.refreshes} refresh(es), ${stats.pollRefreshes} poll refresh(es), ${stats.errors} error(s)\n`
        );
        recordQuery("ultrasearch_watch", parsed.query, stats.baseline + stats.added, parsed.dir);
        break;
      }

      case "history": {
        const options = resolveHistoryOptions();
        let suggestInput: string | null = null;
        let limit = 10;
        let doClear = false;
        for (let i = 1; i < args.length; i++) {
          if (args[i] === "--suggest" && args[i + 1]) suggestInput = args[++i] ?? "";
          else if (args[i] === "--clear") doClear = true;
          else if (args[i] === "--limit" && args[i + 1]) limit = Math.max(1, parseInt(args[++i] ?? "10", 10) || 10);
        }
        if (doClear) {
          const cleared = clearHistory(options);
          console.log(cleared ? `✅ Cleared query history at ${options.path}` : `No history file at ${options.path}`);
          break;
        }
        const entries = loadHistory(options);
        if (suggestInput !== null) {
          const suggestions = suggestQueries(entries, suggestInput, limit);
          if (suggestions.length === 0) console.log("No suggestions from stored history.");
          else console.log(formatSuggestions(suggestions));
          break;
        }
        if (!options.enabled) {
          console.log("Query history is OFF (opt-in). Enable with ULTRASEARCH_HISTORY=1; retention cap default 200 (ULTRASEARCH_HISTORY_MAX).");
        }
        if (entries.length === 0) {
          console.log(`No history entries at ${options.path}.`);
          break;
        }
        for (const entry of [...entries].reverse().slice(0, limit)) {
          const when = new Date(entry.ts).toISOString();
          const hits = typeof entry.hits === "number" ? ` (${entry.hits} hits)` : "";
          console.log(`${when}  ${entry.tool}  ${entry.q}${hits}`);
        }
        break;
      }

      case "policy": {
        // Issue #53: generate the harness's directive block. Nothing is
        // written unless the operator passes --write; --dry-run prints the
        // diff it would apply. Tests pin HOME and --root at temp dirs, so a
        // test can never touch a real harness config.
        let harnessArg: string | null = null;
        let root = process.cwd();
        let write = false;
        let dryRun = false;
        let remove = false;
        for (let i = 1; i < args.length; i++) {
          if (args[i] === "--harness" && args[i + 1]) harnessArg = args[++i] ?? null;
          else if (args[i] === "--root" && args[i + 1]) root = path.resolve(args[++i] ?? ".");
          else if (args[i] === "--write") write = true;
          else if (args[i] === "--dry-run") dryRun = true;
          else if (args[i] === "--remove") remove = true;
        }
        if (!harnessArg) {
          console.error(`Usage: ultrasearch policy --harness <${policyHarnessIds().join("|")}> [--write] [--dry-run] [--remove] [--root <dir>]`);
          process.exit(1);
        }
        if (!isPolicyHarnessId(harnessArg)) {
          console.error(`Unknown harness '${harnessArg}'. Known harnesses: ${policyHarnessIds().join(", ")}`);
          process.exit(1);
        }
        if (write && dryRun) {
          console.error("--write and --dry-run are mutually exclusive; --dry-run never writes.");
          process.exit(1);
        }
        const harness = POLICY_HARNESSES[harnessArg];
        try {
          const plan = planPolicy({ harness: harnessArg, root, remove });
          if (write) {
            const result = applyPolicy(plan);
            const verb = plan.action === "remove" ? "removed" : plan.action === "create" ? "created" : plan.action === "unchanged" ? "unchanged" : "updated";
            console.log(`✅ ${harness.label}: ${verb} ${result.path}`);
            if (result.backup) console.log(`   backup: ${result.backup}`);
          } else if (dryRun || remove) {
            if (!plan.diff) console.log(`No changes: ${plan.path} (${plan.action}).`);
            else console.log(plan.diff.trimEnd());
          } else {
            console.log(`# Target: ${plan.path}`);
            console.log(`# Apply with: ultrasearch policy --harness ${harnessArg} --write${remove ? " --remove" : ""}`);
            console.log(policyBlock(harnessArg).trimEnd());
          }
          if (harness.globalPath) console.log(`# User-scope alternative: ${harness.globalPath}`);
        } catch (err: any) {
          console.error(`policy error: ${err?.message ?? err}`);
          process.exit(1);
        }
        break;
      }

      case "tui": {
        client.close();
        const tui = new UltraSearchTui();
        await tui.run(args.includes("--once"));
        return;
      }

      case "authorize":
      case "permissions": {
        console.log("🔐 Checking macOS Full Disk Access status for UltraSearch daemon...");
        try {
          const status = await client.status();
          if (status.full_disk_access) {
            console.log("✅ Full Disk Access is ALREADY active! Downloads, Documents, and Desktop are indexed.");
            break;
          }
        } catch {}

        console.log("⚠️ Full Disk Access is currently missing on macOS.");
        console.log("👉 Opening System Settings -> Privacy & Security -> Full Disk Access...");
        try {
          const { execSync } = await import("node:child_process");
          execSync("open 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'");
          const sysApp = "/Applications/UltraSearch.app";
          const userApp = path.join(os.homedir(), "Applications/UltraSearch.app");
          const target = fs.existsSync(sysApp) ? sysApp : (fs.existsSync(userApp) ? userApp : path.join(os.homedir(), ".local/bin/ultrasearch-daemon"));
          execSync(`open -R "${target}"`);
          console.log(`📂 Revealed '${target}' in Finder.`);
          console.log("💡 In System Settings, make sure 'UltraSearch' is toggled ON (blue switch).");
          console.log("💡 If an old entry exists, remove it (-) and drag the highlighted UltraSearch into the list.");
        } catch (e: any) {
          console.error("Could not open settings:", e.message);
        }
        break;
      }

      case "daemon": {
        const sub = args[1] || "status";
        const { execSync } = await import("node:child_process");
        if (sub === "status") {
          try {
            const status = await client.status();
            console.log(JSON.stringify(status, null, 2));
          } catch (e: any) {
            console.error("Daemon is not reachable:", e.message);
          }
        } else if (sub === "restart") {
          console.log("🔄 Restarting ultrasearch daemon...");
          client.close();
          try {
            const plistPath = path.join(os.homedir(), "Library/LaunchAgents/com.pi.ultrasearch.plist");
            if (fs.existsSync(plistPath)) {
              try {
                execSync("launchctl kickstart -k gui/$(id -u)/com.pi.ultrasearch");
                console.log("✅ Ultrasearch daemon restarted cleanly via launchd service (PID 1 managed).");
                break;
              } catch {}
            }
            execSync("pkill -9 -f 'UltraSearch serve' ; pkill -9 -f 'ultrasearch-daemon serve' ; pkill -9 -f 'ultrasearch serve' || true");
            const sysAppBin = "/Applications/UltraSearch.app/Contents/MacOS/UltraSearch";
            const userAppBin = path.join(os.homedir(), "Applications/UltraSearch.app/Contents/MacOS/UltraSearch");
            const localDaemonBin = path.join(os.homedir(), ".local/bin/ultrasearch-daemon");
            const daemonBin = fs.existsSync(sysAppBin) ? sysAppBin : (fs.existsSync(userAppBin) ? userAppBin : localDaemonBin);
            const logFile = path.join(os.homedir(), "Library/Application Support/UltraSearch/daemon.log");
            execSync(`nohup "${daemonBin}" serve > "${logFile}" 2>&1 &`);
            console.log(`✅ Ultrasearch daemon restarted cleanly from ${daemonBin}`);
          } catch (e: any) {
            console.error("Restart error:", e.message);
          }
        } else {
          console.log("Usage: ultrasearch daemon [status|restart]");
        }
        break;
      }

      case "install": {
        const localBin = path.join(os.homedir(), ".local/bin");
        if (!fs.existsSync(localBin)) fs.mkdirSync(localBin, { recursive: true });

        const thisFile = path.resolve(process.argv[1]);
        const here = path.dirname(thisFile);
        // Prefer the built distribution (dist/bin/*.js) when it exists; otherwise run
        // the TypeScript sources, which Node >= 22.18 type-strips natively.
        const builtCli = [path.join(here, "cli.js"), path.resolve(here, "..", "dist", "bin", "cli.js")].find((p) => fs.existsSync(p));
        const builtTui = [path.join(here, "tui.js"), path.resolve(here, "..", "dist", "bin", "tui.js")].find((p) => fs.existsSync(p));
        const cliEntry = builtCli ?? thisFile;
        const tuiEntry = builtTui ?? path.resolve(path.join(here, "tui.ts"));

        const cliTarget = path.join(localBin, "ultrasearch");
        const tuiTarget = path.join(localBin, "ultrasearch-tui");

        // Write executable shims pointing at the selected entrypoint
        fs.writeFileSync(cliTarget, `#!/usr/bin/env bash\nexec node "${cliEntry}" "$@"\n`, { mode: 0o755 });
        fs.writeFileSync(tuiTarget, `#!/usr/bin/env bash\nexec node "${tuiEntry}" "$@"\n`, { mode: 0o755 });

        console.log(`✅ Installed 'ultrasearch' -> ${cliTarget}`);
        console.log(`✅ Installed 'ultrasearch-tui' -> ${tuiTarget}`);

        const daemonTarget = path.join(localBin, "ultrasearch-daemon");
        const ultrasearchBin = path.join(localBin, "ultrasearch");
        if (fs.existsSync(ultrasearchBin)) {
          try {
            if (!fs.existsSync(daemonTarget)) fs.symlinkSync(ultrasearchBin, daemonTarget);
            console.log(`✅ Linked 'ultrasearch-daemon' -> ${daemonTarget}`);
          } catch {}
        }

        const launchAgentsDir = path.join(os.homedir(), "Library/LaunchAgents");
        const plistPath = path.join(launchAgentsDir, "com.pi.ultrasearch.plist");
        const sysAppBin = "/Applications/UltraSearch.app/Contents/MacOS/UltraSearch";
        const userAppBin = path.join(os.homedir(), "Applications/UltraSearch.app/Contents/MacOS/UltraSearch");
        const targetBin = fs.existsSync(sysAppBin) ? sysAppBin : (fs.existsSync(userAppBin) ? userAppBin : path.join(localBin, "ultrasearch-daemon"));
        const logFile = path.join(os.homedir(), "Library/Application Support/UltraSearch/daemon.log");

        if (!fs.existsSync(launchAgentsDir)) fs.mkdirSync(launchAgentsDir, { recursive: true });
        const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.pi.ultrasearch</string>
  <key>ProgramArguments</key>
  <array>
    <string>${targetBin}</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${os.homedir()}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logFile}</string>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`;
        fs.writeFileSync(plistPath, plistContent);
        try {
          const { execSync } = await import("node:child_process");
          execSync(`launchctl bootstrap gui/$(id -u) "${plistPath}" 2>/dev/null || launchctl kickstart -k gui/$(id -u)/com.pi.ultrasearch 2>/dev/null || true`);
          console.log(`✅ Registered LaunchAgent -> ${plistPath}`);
        } catch {}
        break;
      }

      case "init": {
        const harnessIds: string[] = [];
        const extraArgs: string[] = [];
        let list = false;
        let write = false;
        let dryRun = false;
        let remove = false;
        let json = false;
        let force = false;
        let home = os.homedir();
        let command: string | undefined;
        for (let i = 1; i < args.length; i++) {
          const arg = args[i] ?? "";
          const value = args[i + 1];
          if (arg === "--harness" && value) {
            harnessIds.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
            i++;
          } else if (arg.startsWith("--harness=")) {
            harnessIds.push(...arg.slice("--harness=".length).split(",").map((s) => s.trim()).filter(Boolean));
          } else if (arg === "--list") {
            list = true;
          } else if (arg === "--write") {
            write = true;
          } else if (arg === "--dry-run") {
            dryRun = true;
          } else if (arg === "--remove") {
            remove = true;
          } else if (arg === "--json") {
            json = true;
          } else if (arg === "--force") {
            force = true;
          } else if (arg === "--command" && value) {
            command = value;
            i++;
          } else if (arg.startsWith("--command=")) {
            command = arg.slice("--command=".length);
          } else if (arg === "--arg" && value) {
            extraArgs.push(value);
            i++;
          } else if (arg === "--home" && value) {
            home = path.resolve(value);
            i++;
          } else {
            console.error(`init: unknown option ${JSON.stringify(arg)}`);
            console.error("Usage: ultrasearch init [--harness <id>[,<id>]] [--list] [--write] [--dry-run] [--remove] [--json] [--force] [--command <path>] [--arg <v>] [--home <dir>]");
            process.exit(2);
          }
        }
        if (write && dryRun) {
          console.error("init: --write and --dry-run are mutually exclusive");
          process.exit(2);
        }
        const unknown = harnessIds.filter((id) => !HARNESSES.some((h) => h.id === id));
        if (unknown.length > 0) {
          console.error(`init: unknown harness id(s): ${unknown.join(", ")}`);
          console.error(`Known: ${HARNESSES.map((h) => h.id).join(", ")}`);
          process.exit(2);
        }
        // `--list` reports registration state for every harness, so planning
        // is asked not to short-circuit on detection; nothing is written.
        const plans = planHarnessInit({
          home,
          harnessIds,
          command,
          args: extraArgs,
          remove,
          force: force || list,
          repoRoot: path.resolve(path.dirname(process.argv[1] ?? ""), ".."),
        });
        if (list) {
          console.log(renderHarnessList(plans, json));
          break;
        }
        const applied = write ? applyPlan(plans) : plans;
        console.log(renderInitReport(applied, { json, wrote: write }));
        const failed = applied.some((p) => p.action === "refuse" || p.writeError);
        if (failed) process.exit(1);
        break;
      }

      case "help":
      default: {
        console.log(`
⚡ PI-ULTRASEARCH: Sub-millisecond filesystem search & trigram code indexing

Commands:
  ultrasearch init [--harness <id>] [--write] Register the MCP server in harness configs
  ultrasearch query <text> [--in <dir>]     Search paths with zero-typo exactness
  ultrasearch grep <pattern> [--in <dir>]    Grep trigram index with DLP masking
  ultrasearch multi-grep <p1> <p2>          Search multiple patterns in single IPC pass
  ultrasearch locate <filename>             Instant whole-disk filename locator
  ultrasearch recent [--in <dir>]           Recently modified & git-active files
  ultrasearch watch <query> [--in <dir>]    Stream new matches as files change (Ctrl-C to stop)
  ultrasearch history [--suggest <text>]    Opt-in local query history + suggestions
  ultrasearch policy --harness <id>         Print/apply the harness directive block (--write, --dry-run, --remove)
  ultrasearch compact                       Trigger automated LSM index compaction
  ultrasearch metrics                       Display latency, throughput, token savings
  ultrasearch report [--by harness]         Audit report; --by harness adds per-harness attribution
  ultrasearch learning                      Inspect recursive learning rules & mistakes
  ultrasearch tui [--once]                  Launch interactive mission control TUI
  ultrasearch install                       Install symlinks into ~/.local/bin
  ultrasearch init                          Detect harnesses and plan MCP registration
`);
        break;
      }
    }
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error("UltraSearch CLI error:", err);
  process.exit(1);
});
