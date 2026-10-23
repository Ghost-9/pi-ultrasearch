# Building the vendored engine

`engine/` is the UltraSearch daemon: a **renamed fork of the upstream MIT engine**
(© Noah Dunnagan, v0.2.1 — the upstream project name, URL and licence text are in
`NOTICE` and `LICENSE`). It is vendored here so the source that ships is the source
that is reviewed, and so engine behaviour can be changed and tested in-tree.
`../docs/engine-changes.md` lists every behavioural change this fork carries.

## Requirements

- macOS (the daemon uses `getattrlistbulk(2)`, FSEvents and `libc` APIs that only
  exist on Darwin; there is no Linux build today)
- Rust 1.98.1 or newer (`edition = "2024"`; tested with `rustc 1.98.1`)
- No other toolchain: the only dependencies are `libc`, `rayon`, `memchr`,
  `memmap2`, `regex`, `regex-syntax`, `serde`, `serde_json`.

## Build

```bash
cd engine
cargo build --release          # ~30 s warm, ~1 min cold on an M-series Mac
cargo test --release           # unit tests, no daemon required
```

The binary lands at `engine/target/release/ultrasearch`. Build output is **not**
committed (`.gitignore`: `engine/target/`).

## Install (replaces the resident daemon)

Use the top-level installer, first in dry-run mode:

```bash
./scripts/install.sh --dry-run --bin "$PWD/engine/target/release/ultrasearch"
./scripts/install.sh         --bin "$PWD/engine/target/release/ultrasearch"
```

Run those commands from the repository root.

It replaces the resident daemon and starts its LaunchAgent. Ad-hoc signing is the
default; a re-sign can change the CDHash and silently invalidate Full Disk Access
even when the bundle identifier remains `com.pi.ultrasearch`. See
`../docs/engine-rebrand.md` for the optional stable signing identity and the FDA
verification command. Re-enable the grant and restart the daemon if verification
reports it missing.

## Running an isolated instance (tests and benchmarks)

The daemon writes its index to `~/Library/Application Support/UltraSearch` by default.
Every part of that is overridable so a test can run its own daemon without touching
the live index or walking the whole disk:

| Variable | Effect |
|---|---|
| `ULTRASEARCH_DIR` | index directory (`index.bin`, `content/`, `ultrasearch.sock`, `socket.lock`). Default: `$HOME/Library/Application Support/UltraSearch`. |
| `ULTRASEARCH_HOME` | the "home" paths are compared against for content scope. Default: `$HOME`. |
| `ULTRASEARCH_SCAN_ROOT` | the directory the first full crawl lists instead of `/`. Default: `/`. |
| `ULTRASEARCH_DENY` | path prefixes never returned (see `../docs/security-deny-list.md`). |
| `ULTRASEARCH_CONTENT_*`, `ULTRASEARCH_WARM` | content-index coverage (see `../docs/content-index-policy.md`). |
| `ULTRASEARCH_RESTRICT=1` | force the consent-gated folder skip list. |

Example — a fully isolated daemon over a fixture tree:

```bash
FIX=/tmp/us-fix
mkdir -p "$FIX/data" "$FIX/root"
ULTRASEARCH_DIR="$FIX/data" ULTRASEARCH_HOME="$FIX/root" ULTRASEARCH_SCAN_ROOT="$FIX/root" \
  ./engine/target/release/ultrasearch serve &
printf '{"op":"ping"}\n' | nc -U "$FIX/data/ultrasearch.sock"
```

`test/engine/harness.mjs` does exactly this and is what the engine integration tests
use.

## Regenerating this tree from upstream (and the two script fixups)

`rebrand.sh` is deterministic and idempotent *at its fixpoint*:

```bash
engine/rebrand.sh <upstream-checkout> /tmp/engine-renamed
engine/rebrand.sh /tmp/engine-renamed /tmp/engine-renamed   # second pass converges
```

Two ordering defects in the script leave the *first* pass slightly wrong; both are
in `README.md` only, and both are recorded here so a re-run can be repaired
deliberately rather than by hand:

1. The fork header it prepends says "rebranded <upstream> fork", and the token swap
   that follows rewrites the header it just wrote, so it ends up naming the fork
   after itself. Correct it to "renamed fork".
2. The `.local/bin/<binary>` → `.local/bin/ultrasearch-daemon` rewrite runs after the
   header is prepended, so the first pass leaves the upstream README's own install
   paths pointing at the wrong binary. The second pass fixes them.

Copy the converged tree over `engine/`, then restore `engine/rebrand.sh` (it is the
tool, not engine source, and it is excluded from the rebranded output on purpose: its
job is to hold the old-name → new-name mapping, so its own text must keep the old
name).

## Upstream sync policy

`engine/` tracks upstream v0.2.1 plus the local patches in
`../docs/engine-changes.md`. When syncing a newer upstream release, re-apply those
patches after a rebrand; do not merge upstream naming back in.
