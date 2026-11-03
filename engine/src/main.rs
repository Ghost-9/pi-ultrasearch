mod frecency;
mod git;
mod mcp;
mod server;

use ultrasearch::{index, live, query};

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::time::Instant;

/// See `ultrasearch::alloc`.
#[global_allocator]
static GLOBAL: ultrasearch::alloc::Alloc = ultrasearch::alloc::Alloc;

const USAGE: &str = "usage:
  ultrasearch <query...> [--json]   search (starts the daemon if needed)
  ultrasearch stdio                 JSON lines on stdin/stdout
  ultrasearch mcp                   MCP server on stdin/stdout, for coding agents
  ultrasearch serve                 run the daemon in the foreground
  ultrasearch status
  ultrasearch install [--login]      copy to ~/.local/bin; --login also starts the daemon at login
                                (needs Full Disk Access granted to ~/.local/bin/ultrasearch-daemon)
  ultrasearch uninstall             remove the login agent (keeps the index)
  ultrasearch bench <query...>      time a query in-process against the saved index";

const LABEL: &str = "mt.nd.ultrasearch";

fn home() -> String {
    ultrasearch::env::home()
}

/// The index directory (`ULTRASEARCH_DIR` / `ULTRASEARCH_DIR`, else the default).
/// The daemon, the CLI, the MCP server and the tests all resolve it here, so
/// an isolated instance is one environment variable away.
fn data_dir() -> PathBuf {
    let d = ultrasearch::env::data_dir();
    std::fs::create_dir_all(&d).ok();
    d
}

unsafe extern "C" {
    fn setiopolicy_np(iotype: i32, scope: i32, policy: i32) -> i32;
}

fn main() {
    // Never let a search download iCloud placeholders: opening or listing a
    // dataless file/dir fails fast instead of materializing it.
    // (IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES, IOPOL_SCOPE_PROCESS, OFF)
    unsafe { setiopolicy_np(3, 0, 1) };
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None | Some("-h" | "--help") => eprintln!("{USAGE}"),
        Some("serve") => {
            space_efficient();
            server::serve(data_dir(), home())
        }
        Some("stdio") => stdio(),
        Some("mcp") => mcp::run(data_dir()),
        Some("status") => print_one(&serde_json::json!({"op": "status"}), true),
        // Every command can be scripted. `status` and search always supported
        // --json; bench, install and uninstall only printed prose, so a caller
        // had to scrape or give up.
        Some("bench") => bench(
            // --json belongs to the command, not to the query it is benchmarking.
            &args[1..].iter().filter(|a| *a != "--json").cloned().collect::<Vec<_>>().join(" "),
            json_flag(&args),
        ),
        Some("install") => install(args.iter().any(|a| a == "--login"), json_flag(&args)),
        Some("uninstall") => uninstall(json_flag(&args)),
        Some(_) => {
            let json = args.iter().any(|a| a == "--json");
            let q: Vec<&str> = args.iter().map(String::as_str).filter(|a| *a != "--json").collect();
            // The folder `git:` filters and globs are about, unless `in:` says.
            let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
            print_one(&serde_json::json!({"q": q.join(" "), "cwd": cwd}), json);
        }
    }
}

/// macOS's malloc (27, xzone) keeps freed small blocks dirty and its
/// pressure relief does nothing, so after the first run or a compaction the
/// daemon held 150-290 MB it no longer used, until restarted. In
/// space-efficient mode, read only at launch, it hands them back: the daemon
/// idles at 5-15 MB on the M6, for searches ~8% slower. So `serve` restarts
/// itself in it.
fn space_efficient() {
    if std::env::var_os("MallocSpaceEfficient").is_none()
        && let Ok(exe) = std::env::current_exe()
    {
        use std::os::unix::process::CommandExt;
        let e = std::process::Command::new(exe).args(std::env::args_os().skip(1)).env("MallocSpaceEfficient", "1").exec();
        eprintln!("{} re-exec failed: {e}", query::now_secs());
    }
}

fn print_one(req: &serde_json::Value, raw: bool) {
    let mut s = server::connect(&data_dir()).unwrap_or_else(|e| die(&format!("cannot reach daemon: {e}")));
    s.write_all(format!("{req}\n").as_bytes()).unwrap();
    // One request only: the daemon needn't keep the cores warm for a next one.
    let _ = s.shutdown(std::net::Shutdown::Write);
    let mut line = String::new();
    BufReader::new(&s).read_line(&mut line).unwrap();
    if raw {
        print!("{line}");
        return;
    }
    let v: serde_json::Value = serde_json::from_str(&line).unwrap_or_default();
    if v["ok"] != true {
        die(v["error"].as_str().unwrap_or("error"));
    }
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    for h in v["hits"].as_array().into_iter().flatten() {
        let _ = writeln!(out, "{}", h["path"].as_str().unwrap_or(""));
    }
    for f in v["files"].as_array().into_iter().flatten() {
        for m in f["matches"].as_array().into_iter().flatten() {
            let _ = writeln!(out, "{}:{}: {}", f["path"].as_str().unwrap_or(""), m["line"], m["text"].as_str().unwrap_or("").trim());
        }
    }
    let _ = out.flush();
}

fn stdio() {
    let s = server::connect(&data_dir()).unwrap_or_else(|e| die(&format!("cannot reach daemon: {e}")));
    let mut up = s.try_clone().unwrap();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if writeln!(up, "{line}").is_err() {
                break;
            }
        }
        let _ = up.shutdown(std::net::Shutdown::Write);
    });
    let mut out = std::io::stdout().lock();
    for line in BufReader::new(s).lines() {
        let Ok(line) = line else { break };
        if writeln!(out, "{line}").and_then(|_| out.flush()).is_err() {
            break;
        }
    }
}

/// True when `--json` was passed, for the commands that print prose (#U8).
fn json_flag(args: &[String]) -> bool {
    args.iter().any(|a| a == "--json")
}

fn bench(qs: &str, as_json: bool) {
    let dir = data_dir();
    let idx = index::Index::load(&dir.join("index.bin")).unwrap_or_else(|| die("no index yet; run ultrasearch serve"));
    let live = live::Live::new(idx);
    let home = home();
    let mut q = query::Query::parse(qs, &home).unwrap_or_else(|e| die(&e));
    // Like the daemon: a content search when the query has a pattern, on
    // user-interactive threads, paths included.
    let grep = q.grep.take().map(|p| ultrasearch::Grep::new(&p, q.grep_mode).unwrap_or_else(|e| die(&e)));
    let content = grep.as_ref().map(|_| ultrasearch::content::Content::open_shared(dir.join("content")));
    let pool = rayon::ThreadPoolBuilder::new()
        .start_handler(|_| {
            ultrasearch::qos::set_self(ultrasearch::qos::Qos::UserInteractive);
            ultrasearch::alloc::keep_on_this_thread();
        })
        .build()
        .unwrap();
    let run = || -> Vec<String> {
        let (Some(g), Some(c)) = (&grep, &content) else {
            let mut p = Vec::new();
            let hits = pool.install(|| query::Searcher { live: &live }.search(&q));
            return hits
                .iter()
                .map(|h| {
                    live.base.path(h.idx as usize, &mut p);
                    format!("{:5} {}", h.score, String::from_utf8_lossy(&p))
                })
                .collect();
        };
        let r = if q.scope.as_ref().is_none_or(|s| ultrasearch::content::in_scope(s, home.as_bytes())) {
            pool.install(|| c.search(g, &q))
        } else {
            let paths = pool.install(|| ultrasearch::content::scan_paths(&live, q.clone_for_scan(), home.as_bytes(), false));
            ultrasearch::content::verify(g, &paths, q.limit)
        };
        let first = |f: &ultrasearch::FileMatches| f.lines.first().map_or(String::new(), |(n, t)| format!("{n}: {}", t.trim()));
        r.files.iter().map(|f| format!("{}:{}", String::from_utf8_lossy(&f.path), first(f))).collect()
    };
    // Between runs, another name search: a repeat would be answered from
    // the names cache, which only a repeat of the last query hits.
    let other = query::Query::parse("zzzzzz", &home).unwrap();
    let mut times = Vec::new();
    let mut out = Vec::new();
    for _ in 0..20 {
        pool.install(|| query::Searcher { live: &live }.search(&other));
        let t = Instant::now();
        out = run();
        times.push(t.elapsed());
    }
    let first = times[0];
    times.sort();
    if as_json {
        let ms = |d: std::time::Duration| (d.as_secs_f64() * 1000.0 * 1000.0).round() / 1000.0;
        println!(
            "{}",
            serde_json::json!({
                "ok": true,
                "query": qs,
                "runs": times.len(),
                "first_ms": ms(first),
                "median_ms": ms(times[times.len() / 2]),
                "min_ms": ms(times[0]),
                "results": out.iter().take(10).collect::<Vec<_>>(),
            })
        );
    } else {
        for l in out.iter().take(10) {
            println!("{l}");
        }
        eprintln!("first {first:.2?}  median {:.2?}  min {:.2?}", times[times.len() / 2], times[0]);
    }
}

fn plist_path() -> PathBuf {
    PathBuf::from(home()).join(format!("Library/LaunchAgents/{LABEL}.plist"))
}

fn launchctl(args: &[&str]) -> bool {
    std::process::Command::new("launchctl").args(args).stderr(std::process::Stdio::null()).status().is_ok_and(|s| s.success())
}

fn domain() -> String {
    format!("gui/{}", unsafe { libc::getuid() })
}

/// Refuse to install alongside a daemon this binary did not create.
///
/// The shipped app registers `com.pi.ultrasearch`. This source tree uses
/// `mt.nd.ultrasearch`, so running `install` here would add a SECOND LaunchAgent,
/// and two daemons contend for the same socket directory and index. Observed for
/// real: the running app's agent label does not match the current source.
fn foreign_agent() -> Option<String> {
    let dir = PathBuf::from(home()).join("Library/LaunchAgents");
    let entries = std::fs::read_dir(dir).ok()?;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.contains("ultrasearch") && name.ends_with(".plist") && !name.starts_with(LABEL) {
            return Some(name);
        }
    }
    None
}

fn install(login: bool, as_json: bool) {
    if let Some(other) = foreign_agent() {
        let msg = format!(
            "refusing to install: {other} already manages a UltraSearch daemon. Running this \
             binary would add a second agent ({LABEL}) and the two would contend for the same \
             socket and index. Remove the other agent first, or use the app that owns it."
        );
        if as_json {
            println!("{}", serde_json::json!({"ok": false, "error": msg, "existing_agent": other}));
        } else {
            eprintln!("{msg}");
        }
        std::process::exit(1);
    }
    // A plain reinstall keeps an existing login agent.
    let login = login || plist_path().exists();
    let bin = PathBuf::from(home()).join(".local/bin/ultrasearch-daemon");
    // Stop the old daemon so the next one runs the new binary. Unload the
    // login agent first, or KeepAlive would restart it straight away.
    let target = format!("{}/{LABEL}", domain());
    launchctl(&["bootout", &target]);
    server::stop(&data_dir()).unwrap_or_else(|e| die(&e));
    std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
    // Replace, never overwrite in place: a rewritten signed binary at the same
    // path can be SIGKILLed by the code-signing cache. Copy then rename, so
    // reinstalling from the installed copy works too.
    let tmp = bin.with_extension("new");
    std::fs::copy(std::env::current_exe().unwrap(), &tmp).and_then(|_| std::fs::rename(&tmp, &bin)).unwrap_or_else(|e| die(&format!("copy: {e}")));
    let agents = format!(
        "for coding agents: claude mcp add -s user ultrasearch -- {0} mcp\n                   codex mcp add ultrasearch -- {0} mcp",
        bin.display()
    );
    if !login {
        if as_json {
            println!(
                "{}",
                serde_json::json!({
                    "ok": true, "installed": bin.display().to_string(), "login_agent": false, "agents": agents,
                })
            );
        } else {
            println!("installed {}; the daemon starts on first use\n{agents}", bin.display());
        }
        return;
    }
    let log = data_dir().join("daemon.log");
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key><array><string>{}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>{}</string>
  <key>StandardErrorPath</key><string>{}</string>
</dict>
</plist>
"#,
        bin.display(),
        log.display(),
        log.display()
    );
    std::fs::write(plist_path(), plist).unwrap();
    // bootout returns before the old job is fully gone; bootstrap fails
    // until it is.
    // to_string_lossy: a non-UTF-8 home path must not panic the installer. launchd
    // needs a string and a lossy path is still a better failure than a crash.
    let plist = plist_path().to_string_lossy().into_owned();
    let bootstrap = || launchctl(&["bootstrap", &domain(), &plist]);
    let retry = || {
        std::thread::sleep(std::time::Duration::from_millis(100));
        false
    };
    if !(0..50).any(|_| bootstrap() || retry()) {
        die("launchctl bootstrap failed");
    }
    if as_json {
        println!(
            "{}",
            serde_json::json!({
                "ok": true, "installed": bin.display().to_string(), "login_agent": true, "agents": agents,
            })
        );
    } else {
        println!("installed {} (LaunchAgent {LABEL})\n{agents}", bin.display());
    }
}

fn uninstall(as_json: bool) {
    launchctl(&["bootout", &format!("{}/{LABEL}", domain())]);
    let _ = std::fs::remove_file(plist_path());
    if as_json {
        println!(
            "{}",
            serde_json::json!({
                "ok": true, "removed_login_agent": LABEL, "index_kept_at": data_dir().display().to_string(),
            })
        );
    } else {
        println!("removed LaunchAgent {LABEL}; index kept in {}", data_dir().display());
    }
}

fn die(msg: &str) -> ! {
    eprintln!("ultrasearch: {msg}");
    std::process::exit(1)
}
