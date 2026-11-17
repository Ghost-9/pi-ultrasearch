#!/usr/bin/env bash
# Is the installed UltraSearch the same engine as the source in this repo?
#
# The obvious checks do not work here. A codesigned bundle never hash-matches a cargo build, so
# checksums prove nothing. Comparing mtimes also misleads: a commit that only adds `#[cfg(test)]`
# code touches the source file without changing what ships, and that alone made the app look 14
# minutes stale when it was current.
#
# So this compares behaviour: each binary serves its own tiny tree in its own state directory,
# and both are asked the same questions. Nothing here touches the real index or the running
# daemon.
#
# Two mistakes are recorded here because both made the first version vacuous, and vacuous is
# worse than absent:
#   * `index` returns before the walk finishes, so searching straight after answered from an
#     empty index - two empty result sets compared equal and proved nothing.
#   * the query was a word from a file's *contents*, but this is a name index; it correctly
#     returned nothing. A probe has to ask a question the system can answer.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${ULTRASEARCH_APP:-/Applications/UltraSearch.app/Contents/MacOS/UltraSearch}"
REPO="$ROOT/engine/target/release/ultrasearch"

for bin in "$APP" "$REPO"; do
  [ -x "$bin" ] || { echo "missing binary: $bin" >&2; exit 1; }
done

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

probe() {
  local bin="$1" tag="$2"
  mkdir -p "$tmp/$tag/tree" "$tmp/$tag/data"
  printf 'alpha canary one\n' > "$tmp/$tag/tree/needle-file.txt"
  printf 'beta canary two\n'  > "$tmp/$tag/tree/two.rs"
  export ULTRASEARCH_DIR="$tmp/$tag/data" ULTRASEARCH_SCAN_ROOT="$tmp/$tag/tree"

  "$bin" serve >/dev/null 2>&1 &
  local pid=$!
  for _ in $(seq 1 80); do
    "$bin" status 2>/dev/null | grep -q '"ok":true' && break
    sleep 0.5
  done

  # A name question, which this index can answer, plus the feature markers a stale install has
  # actually lacked before.
  "$bin" status 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("keys", sorted(k for k in d if not k.startswith("_")),
      "maxfile", d.get("content_max_file_bytes"))
'
  printf '{"op":"search","q":"needle","limit":5}\n' | "$bin" stdio 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
names = sorted(h.get("path","").rsplit("/", 1)[-1] for h in (d.get("hits") or []))
print("hits", names, "ok", d.get("ok"))
'
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

a=$(probe "$APP" app)
b=$(probe "$REPO" repo)

if [ -z "$a" ] || [ -z "$b" ]; then
  echo "INCONCLUSIVE: a probe produced no answer, so nothing was compared" >&2
  exit 1
fi
if [ "$a" = "$b" ]; then
  echo "installed app matches the repo build"
  echo "$a" | sed 's/^/  /'
else
  echo "MISMATCH: the installed app and the repo build answer differently" >&2
  printf '  app : %s\n  repo: %s\n' "$a" "$b" >&2
  exit 1
fi
