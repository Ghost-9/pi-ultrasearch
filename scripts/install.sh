#!/usr/bin/env bash
# UltraSearch daemon installer (macOS) — Phase 5 packaging.
#
# Installs the resident daemon binary and its LaunchAgent, or removes them
# again. The conventions (paths, bundle identifier, codesign requirement,
# backup names) are the ones in docs/engine-rebrand.md; this script is the
# scripted form of the manual install, not a second convention.
#
#   ./scripts/install.sh                 install (re-signs and restarts on each run)
#   ./scripts/install.sh --dry-run       print every action, change nothing
#   ./scripts/install.sh --bin <path>    install a specific engine binary
#   ./scripts/install.sh --uninstall     remove the job and installed binaries
#
# What it does NOT do:
#   * it never touches ~/Library/Application Support/UltraSearch (the index
#     and state are user data; uninstall only reports the path);
#   * it does not register harnesses — that is `ultrasearch init --list`
#     (phase 1), printed as the next step;
#   * it does not download anything: build the engine first
#     (engine/BUILD.md), or pass --bin.
#
# The daemon is macOS-only today. Running this on Linux exits 2 and points at
# docs/linux-daemon-blockers.md; the client surfaces themselves work on Linux.
set -euo pipefail

LABEL="com.pi.ultrasearch"
APP="/Applications/UltraSearch.app"
APP_BIN="$APP/Contents/MacOS/UltraSearch"
DAEMON_BIN="$HOME/.local/bin/ultrasearch-daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SUPPORT_DIR="$HOME/Library/Application Support/UltraSearch"
LOG_FILE="$SUPPORT_DIR/daemon.log"
STAMP="$(date +%Y%m%d-%H%M%S)"

# One version for the bundle, the crate and the MCP `serverInfo`, read from
# Cargo.toml. These used to disagree (the bundle said 1.0 while the crate and
# the MCP server said 0.2.1), so an operator could not answer "what is
# deployed?" — which breaks vulnerability tracking and support.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$SCRIPT_DIR/../engine/Cargo.toml" 2>/dev/null | head -1)"
if [ -z "$VERSION" ]; then
  echo "install.sh: could not read the version from engine/Cargo.toml" >&2
  exit 1
fi

DRY_RUN=0
UNINSTALL=0
SOURCE_BIN=""
CODE_SIGN_IDENTITY="${ULTRASEARCH_CODESIGN_IDENTITY:--}"

usage() {
  cat <<'EOF'
Usage: scripts/install.sh [options]

Options:
  --bin <path>   Engine binary to install (default: engine/target/release/ultrasearch,
                 then ./target/release/ultrasearch when run from engine/)
  --dry-run      Print every action without executing it
  --uninstall    Stop the LaunchAgent and remove the installed binaries
  -h, --help     This help

Environment:
  ULTRASEARCH_DAEMON_BIN  Alternative default for --bin
  ULTRASEARCH_CODESIGN_IDENTITY  Keychain code-signing identity; default: - (ad-hoc)
EOF
}

# ---------------------------------------------------------------------------
# dry-run-aware primitives
# ---------------------------------------------------------------------------

say() { printf '%s\n' "$*"; }
ok() { printf 'ok: %s\n' "$*"; }
warn() { printf 'warn: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit "${2:-1}"
}

run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# Writes stdin to a file, skipping the write when the content is unchanged.
write_file() {
  local path="$1"
  local tmp
  tmp="$(mktemp)"
  cat >"$tmp"
  if [ -f "$path" ] && cmp -s "$tmp" "$path"; then
    ok "unchanged $path"
    rm -f "$tmp"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] write %s (%s bytes)\n' "$path" "$(wc -c <"$tmp" | tr -d ' ')"
    rm -f "$tmp"
  else
    mkdir -p "$(dirname "$path")"
    install -m 0644 "$tmp" "$path"
    ok "wrote $path"
    rm -f "$tmp"
  fi
}

job_loaded() {
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1
}

# Same header shape, copied from the live job so launchd semantics stay
# identical when the job is bootstrapped.
plist_content() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$APP_BIN</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$HOME</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_FILE</string>
  <key>StandardErrorPath</key>
  <string>$LOG_FILE</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
EOF
}

fda_steps() {
  cat <<EOF

Full Disk Access (required for whole-disk search):
  1. Open System Settings -> Privacy & Security -> Full Disk Access.
  2. Add $APP if it is not listed (the + button, then choose the app).
  3. Toggle it on. The daemon must be restarted after the toggle:
       launchctl kickstart -k gui/$(id -u)/$LABEL
  The bundle identifier must remain "$LABEL". The default ad-hoc signature can
  change its CDHash when re-signed, which may silently invalidate the grant even
  when the bundle identifier is unchanged. See docs/engine-rebrand.md for the
  optional stable signing identity and scripts/verify-fda.sh.

Next step (harness registration; requires the phase-1 \`init\` command):
  ultrasearch init --list

State directory (index, content index, logs) — left untouched:
  $SUPPORT_DIR
EOF
}

# ---------------------------------------------------------------------------
# argument parsing
# ---------------------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --bin)
      [ $# -ge 2 ] || die "--bin needs a path" 3
      SOURCE_BIN="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown option: $1" 3
      ;;
  esac
done

# ---------------------------------------------------------------------------
# platform gate
# ---------------------------------------------------------------------------

if [ "$(uname -s)" != "Darwin" ]; then
  warn "the UltraSearch daemon is macOS-only today (getattrlistbulk/FSEvents)."
  warn "exact blockers and the port checklist: docs/linux-daemon-blockers.md"
  warn "the CLI/MCP client surfaces run on Linux without the daemon (client-only build)."
  exit 2
fi

# ---------------------------------------------------------------------------
# uninstall
# ---------------------------------------------------------------------------

if [ "$UNINSTALL" = 1 ]; then
  say "== UltraSearch uninstall =="
  if job_loaded; then
    run launchctl bootout "gui/$(id -u)/$LABEL"
    ok "stopped $LABEL"
  else
    ok "LaunchAgent was not loaded"
  fi

  if [ -f "$PLIST" ]; then
    run mv "$PLIST" "$PLIST.uninstalled-$STAMP"
    ok "moved LaunchAgent to $PLIST.uninstalled-$STAMP"
  else
    ok "no LaunchAgent at $PLIST"
  fi

  if [ -f "$DAEMON_BIN" ]; then
    run mv "$DAEMON_BIN" "$DAEMON_BIN.uninstalled-$STAMP"
    ok "moved daemon binary to $DAEMON_BIN.uninstalled-$STAMP"
  else
    ok "no daemon binary at $DAEMON_BIN"
  fi

  if [ -d "$APP" ]; then
    run mv "$APP" "$APP.uninstalled-$STAMP"
    ok "moved app bundle to $APP.uninstalled-$STAMP (reversible)"
  else
    ok "no app bundle at $APP"
  fi

  cat <<EOF

Removed. Nothing in "$SUPPORT_DIR" was touched; delete it manually
if you also want to drop the index and logs.
EOF
  exit 0
fi

# ---------------------------------------------------------------------------
# install
# ---------------------------------------------------------------------------

say "== UltraSearch install =="

# 1. Locate the engine binary.
if [ -z "$SOURCE_BIN" ] && [ -n "${ULTRASEARCH_DAEMON_BIN:-}" ]; then
  SOURCE_BIN="$ULTRASEARCH_DAEMON_BIN"
fi
if [ -z "$SOURCE_BIN" ]; then
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  for candidate in \
    "$REPO_ROOT/engine/target/release/ultrasearch" \
    "./target/release/ultrasearch"; do
    if [ -f "$candidate" ]; then
      SOURCE_BIN="$candidate"
      break
    fi
  done
fi
if [ -z "$SOURCE_BIN" ] || [ ! -f "$SOURCE_BIN" ]; then
  die "no engine binary found. Build it first (engine/BUILD.md) or pass --bin <path>." 1
fi
if [ ! -x "$SOURCE_BIN" ]; then
  die "$SOURCE_BIN is not executable" 1
fi
ok "source binary: $SOURCE_BIN ($(shasum -a 256 "$SOURCE_BIN" | cut -c1-12))"

# 2. Detect an existing install before changing anything.
DETECTED=0
[ -f "$PLIST" ] && DETECTED=1
[ -f "$APP_BIN" ] && DETECTED=1
[ -f "$DAEMON_BIN" ] && DETECTED=1
if [ "$DETECTED" = 1 ]; then
  ok "existing install detected (plist=$([ -f "$PLIST" ] && echo yes || echo no), app=$([ -f "$APP_BIN" ] && echo yes || echo no), daemon=$([ -f "$DAEMON_BIN" ] && echo yes || echo no))"
  if job_loaded; then
    ok "$LABEL job is loaded"
  else
    warn "$LABEL job is NOT loaded"
  fi
else
  ok "no existing install detected (fresh install)"
fi

# 3. Install the CLI-side daemon binary.
run mkdir -p "$(dirname "$DAEMON_BIN")"
if [ -f "$DAEMON_BIN" ] && [ ! "$SOURCE_BIN" -ef "$DAEMON_BIN" ] && cmp -s "$SOURCE_BIN" "$DAEMON_BIN" 2>/dev/null; then
  ok "unchanged $DAEMON_BIN"
else
  run install -m 0755 "$SOURCE_BIN" "$DAEMON_BIN"
  ok "installed $DAEMON_BIN"
fi

# 4. Install the app-bundle binary (what launchd runs and what holds the FDA
#    grant). The bundle is created when missing so a fresh machine needs one
#    command, not a manual mkdir.
run mkdir -p "$APP/Contents/MacOS"
run mkdir -p "$SUPPORT_DIR"
if [ -f "$APP_BIN" ] && cmp -s "$SOURCE_BIN" "$APP_BIN" 2>/dev/null; then
  ok "unchanged $APP_BIN"
else
  if [ -f "$APP_BIN" ]; then
    run cp -R "$APP" "$APP.bak-$STAMP"
    ok "backed up existing bundle to $APP.bak-$STAMP"
  fi
  run install -m 0755 "$SOURCE_BIN" "$APP_BIN"
  ok "installed $APP_BIN"
fi

# The bundle identity must exist even when the binary was unchanged, so the
# FDA grant and codesign identifiers resolve. An existing Info.plist is never
# rewritten — the bundle id it carries is what the TCC grant is stored against.
if [ ! -f "$APP/Contents/Info.plist" ]; then
  write_file "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>$LABEL</string>
  <key>CFBundleName</key>
  <string>UltraSearch</string>
  <key>CFBundleExecutable</key>
  <string>UltraSearch</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$VERSION</string>
  <key>CFBundleVersion</key>
  <string>$VERSION</string>
</dict>
</plist>
EOF
else
  # Keep the existing file: rewriting it wholesale could change the identity the
  # TCC grant is keyed to. But the *version* keys must still be corrected, or an
  # upgrade leaves the bundle claiming whatever version it was first installed
  # at (observed: bundle 1.0 while the crate and the MCP server said 0.2.1).
  if command -v /usr/libexec/PlistBuddy >/dev/null 2>&1; then
    for key in CFBundleShortVersionString CFBundleVersion; do
      cur="$(/usr/libexec/PlistBuddy -c "Print :$key" "$APP/Contents/Info.plist" 2>/dev/null || true)"
      if [ "$cur" != "$VERSION" ]; then
        /usr/libexec/PlistBuddy -c "Set :$key $VERSION" "$APP/Contents/Info.plist" 2>/dev/null \
          || /usr/libexec/PlistBuddy -c "Add :$key string $VERSION" "$APP/Contents/Info.plist" 2>/dev/null \
          || true
        ok "Info.plist $key: ${cur:-absent} -> $VERSION"
      fi
    done
  fi
  ok "keeping existing $APP/Contents/Info.plist (identity preserved)"
fi

# 5. Sign the app and helper. Ad-hoc remains the default for a frictionless
#    install; a stable Keychain identity can be selected with the environment
#    variable documented above.
if [ "$CODE_SIGN_IDENTITY" = "-" ]; then
  run codesign --force --deep --sign - \
    --identifier "$LABEL" \
    --requirements "=designated => identifier \"$LABEL\"" \
    "$APP"
  run codesign --force --sign - --identifier "$LABEL.daemon" "$DAEMON_BIN"
  ok "signed $APP and $DAEMON_BIN ad hoc; Full Disk Access may need to be re-granted after a re-sign"
else
  run codesign --force --deep --sign "$CODE_SIGN_IDENTITY" --identifier "$LABEL" "$APP"
  run codesign --force --sign "$CODE_SIGN_IDENTITY" --identifier "$LABEL.daemon" "$DAEMON_BIN"
  ok "signed $APP and $DAEMON_BIN with identity: $CODE_SIGN_IDENTITY"
fi

# 6. Install and (re)start the LaunchAgent.
write_file "$PLIST" < <(plist_content)
if job_loaded; then
  run launchctl bootout "gui/$(id -u)/$LABEL" || true
fi
run launchctl bootstrap "gui/$(id -u)" "$PLIST"
run launchctl kickstart -k "gui/$(id -u)/$LABEL"
ok "started $LABEL"

fda_steps
say ""
say "done. Verify: printf '{\"op\":\"status\",\"id\":1}\\n' | nc -U \"$SUPPORT_DIR/ultrasearch.sock\""
