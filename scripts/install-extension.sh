#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="https://github.com/Ghost-9/pi-ultrasearch.git"
INSTALL_DIR="${PI_ULTRASEARCH_EXTENSION_DIR:-$HOME/.pi/agent/extensions/pi-ultrasearch}"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: scripts/install-extension.sh [--dry-run]

Install or rebuild the Pi Agent extension at:
  ~/.pi/agent/extensions/pi-ultrasearch

Options:
  --dry-run  Print the clone/dependency/build/reload steps without changing files
  -h, --help Show this help

Environment:
  PI_ULTRASEARCH_EXTENSION_DIR  Override the extension directory
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

if [ -e "$INSTALL_DIR" ] && [ ! -f "$INSTALL_DIR/package.json" ]; then
  die "$INSTALL_DIR exists but is not a pi-ultrasearch checkout (package.json missing)"
fi

if [ ! -e "$INSTALL_DIR" ]; then
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] mkdir -p %q\n' "$(dirname "$INSTALL_DIR")"
    printf '[dry-run] git clone %q %q\n' "$REPOSITORY" "$INSTALL_DIR"
  else
    command -v git >/dev/null 2>&1 || die "git is required to clone the extension"
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone "$REPOSITORY" "$INSTALL_DIR"
  fi
else
  printf 'using existing checkout: %s\n' "$INSTALL_DIR"
fi

if [ "$DRY_RUN" = 1 ]; then
  printf '[dry-run] (cd %q && npm ci)\n' "$INSTALL_DIR"
  printf '[dry-run] (cd %q && npm run build)\n' "$INSTALL_DIR"
else
  command -v npm >/dev/null 2>&1 || die "npm is required to install the extension"
  (cd "$INSTALL_DIR" && npm ci)
  (cd "$INSTALL_DIR" && npm run build)
fi

printf '\nPi extension files are ready at %s\n' "$INSTALL_DIR"
printf 'Reload step: quit and restart Pi Agent so it loads the extension.\n'
