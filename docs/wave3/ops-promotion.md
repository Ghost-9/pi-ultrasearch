# Wave 3 ops — live-daemon promotion (2026-10-15)

Branch `wave3/ops`, worktree `/Users/batra/ultrasearch-waves3/ops`, base `c64c62b`.
This is the ops record for promoting the engine built from this tree to the resident
LaunchAgent daemon. Raw evidence: `bench/results/wave3/promotion/`; artifact index:
`bench/results/wave3/manifest.json`; decision: `docs/decisions/0013-promote-main-engine.md`.

## 1. What was promoted

| | Before | After |
|:---|:---|:---|
| App bundle binary | `14bbcc13…` (wave-1 build) | `878e636c…` (built from this tree) |
| `~/.local/bin/ultrasearch-daemon` | `8240fdbb…` | same build, signed `com.pi.ultrasearch.daemon` |
| Status identity fields | absent (`pid: null`, no inode/lock) | present (`pid 36122`, `uptime_ms`, `socket_dev/ino`, `lock_pid`, `staleness_ms`, `compactions`, `content_policy`) |
| LaunchAgent pid | 8887 | 36122 |

Built with `cargo build --release --manifest-path engine/Cargo.toml` (1m03s).
Codesign rewrites the Mach-O signature, so file hashes differ from the unsigned build;
the shared LC_UUID `6E008204-1698-38D3-99FE-BD6FBF3A4D3E` proves the installed code is
the built code (`bash bench/results/wave3/capture-meta.sh` records this).

## 2. Preconditions

* **Backups** (stamp `20261015-wave3ops`):
  `/Applications/UltraSearch.app.bak-20261015-wave3ops`,
  `~/.local/bin/ultrasearch-daemon.bak-20261015-wave3ops`,
  `~/Library/LaunchAgents/com.pi.ultrasearch.plist.bak-20261015-wave3ops`.
  Hashes: `promotion/hashes.pre.txt`.
* **Restore drill** (before any destructive step): the backup app-bundle binary ran as an
  isolated daemon on a temp socket/index, answered `status ok` and returned 2 grep hits.
  Evidence: `promotion/restore-drill-status.json`, `restore-drill-grep.json`.
* **New-binary smoke**: the built engine served an isolated temp index and reported the
  new status fields. Evidence: `promotion/new-engine-smoke-*.json`.
* **Rollback ready**: `bench/results/wave3/rollback-wave3-ops.sh` (restores all three
  backups, reboots the job, waits for the socket, prints the status).

## 3. Commands (as run)

```bash
STAMP=20261015-wave3ops
cp -R /Applications/UltraSearch.app "/Applications/UltraSearch.app.bak-$STAMP"
cp -p ~/.local/bin/ultrasearch-daemon ~/.local/bin/ultrasearch-daemon.bak-$STAMP
cp -p ~/Library/LaunchAgents/com.pi.ultrasearch.plist ~/Library/LaunchAgents/com.pi.ultrasearch.plist.bak-$STAMP

install -m 0755 engine/target/release/ultrasearch ~/.local/bin/ultrasearch-daemon
install -m 0755 engine/target/release/ultrasearch /Applications/UltraSearch.app/Contents/MacOS/UltraSearch
codesign --force --deep --sign - --identifier com.pi.ultrasearch \
  --requirements '=designated => identifier "com.pi.ultrasearch"' /Applications/UltraSearch.app
codesign --force --sign - --identifier com.pi.ultrasearch.daemon ~/.local/bin/ultrasearch-daemon
launchctl bootout gui/$(id -u)/com.pi.ultrasearch
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pi.ultrasearch.plist
```

## 4. Verification (observed)

| Check | Result | Evidence |
|:---|:---|:---|
| `full_disk_access` | `true` at that promotion; the grant survived that specific re-sign, but later ad-hoc re-signs can change CDHash and invalidate it | `promotion/live-status-post.json` |
| New status fields | present; `lock_pid == pid == 36122` | same |
| Legacy compat socket | `{"id":2,"ok":true}` | `promotion/legacy-ping-post.txt` |
| Index reused | entries 6,999,615 → 7,030,442; content_docs 155,901 → 155,905; never zero | `live-status-pre.json` / `live-status-post.json` |
| Socket replaced | inode 39874674 → 41663190 | same |
| LaunchAgent | state running, pid 36122, program path correct | `promotion/promotion-steps.txt` |
| Codesign | `Identifier=com.pi.ultrasearch`, designated requirement exact | `promotion/codesign-app.txt` |
| `npm run test:gate` | **8/8 pass** (grep client p50 5.36 / raw 2.82 ms; search 0.86 / 1.25) | `promotion/test-gate-live.log` |
| `npm run test:engine` | **38/38 pass** | `promotion/test-engine.log` |
| One-line status | recorded | `promotion/status-one-line.txt` |

### The first `test:gate` run failed, and why it is not a promotion regression

Run 1 was 7/8: the live grep arm saw `client p50 78.88 ms` against `raw p50 2.49 ms`.
Direct client calls showed `source=scan`, `read=7734` — the scoped grep read every
on-disk file under the fresh worktree because the shared daemon's content index had never
covered that path (documented in the wave-2 notes as the cold-worktree condition). An
mtime-only touch of tracked files woke the daemon's dirty tracking (`read` dropped to 90),
the identical suite then passed **8/8** with no code or daemon change. The bare socket never
left the single-digit-ms floor, and the hermetic tests never changed.

## 5. Timing suite (all provisional)

The environment gate never passed during a bounded 30-minute wait
(`bench/results/wave3/gate-samples.jsonl`: 60 samples, 0 passing, min load1 9.45,
max 128.44; AC held, but a sibling wave's cargo/rustc ran in 19 of the 60 samples).
All seven artifacts carry `status: degraded` and
full gate + daemon blocks; `bench/results/wave3/final/` is empty by design. The per-artifact
headlines are in `bench/results/wave3/README.md` and `manifest.json`.

Two artifacts have an unmeasurable arm: the frozen wave-1 corpus
`/Users/batra/ultrasearch-waves/advisor` no longer exists on this machine, so the
`bench:scopes` relevance section and all of `bench:boost` scored 0.000 nDCG/recall.
That is corpus absence, not a daemon regression, and it is recorded as a known limit in
the manifest.

## 6. Rollback

```bash
bash bench/results/wave3/rollback-wave3-ops.sh
```

Restores the wave-1 app bundle, binary and plist from stamp `20261015-wave3ops`, reboots
the LaunchAgent and verifies the socket. The index is not moved by this promotion, so no
data migration is reversed. If FDA is ever lost, re-grant Full Disk Access to
**UltraSearch** in System Settings and restart the daemon.

## 7. Deferred

* A quiet-machine re-run of all seven artifacts to replace the provisional numbers
  (scripts unchanged; drop `--force-degraded`).
* Rebuilding the wave-1 judgment corpus (or adopting the wave-2 corpus) before any
  relevance/boost claim can be made.
* The engine-ab baseline `f84ce92` build lives in a temp dir; a future wave should pin it
  or rebuild it.

---

## Correction (2026-10-15, after the wave-3 relevance merge)

This document originally described the promotion of engine `7b413d87…` (built from `c64c62b`). That build predates the
grep page-ranking change. The live daemon was re-promoted after the merge to the engine built from `2a1ecc4`
(installed app binary `c6a27787a347aad8…`, pid 26819), with the same procedure and the same constraints; the index was
again reused (7,041,195 entries) and FDA survived. The independent verifier confirmed the **installed** app matches
`main` 30/30 rows on the frozen judgment set (F13). Keep this in mind when reading the engine identity/LC_UUID below:
those values describe the first promotion, not the current deployment.
