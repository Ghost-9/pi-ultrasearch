#!/usr/bin/env python3
"""Soak the daemon against a churning tree and assert the properties that broke.

The original defect, as it presented: 2,671 MB RSS and 23.6% CPU, because the scan
root defaulted to `/` (2.3M entries), FSEvents lag reached 5,210,213, and the engine
forced 67 compactions in a row trying to catch up. Every one of those is a property
that a soak test can assert, and none of them were asserted.

This runs the daemon against a synthetic tree that churns the way a real one does -
files created, modified and deleted while the index is live - and fails when:

  * compactions run away (the churn detector stopped working)
  * event lag grows without bound (the follower is losing to the event stream)
  * RSS grows without bound (an unbounded structure)
  * the daemon stops answering (a wedge)

Two durations:
    python3 scripts/soak.py              # ~60 s, the CI gate
    python3 scripts/soak.py --hours 48   # the real soak, run on a weekend

Exit code 0 means every assertion held for the whole window.
"""

import argparse
import json
import os
import random
import shutil
import signal
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BIN = os.environ.get("ULTRASEARCH_BIN") or os.path.join(ROOT, "engine", "target", "release", "ultrasearch")

# Thresholds. Deliberately loose: this is a collapse detector, not a benchmark.
MAX_COMPACTIONS_PER_MIN = 30      # the bug produced 67 in a *row*
MAX_LAG = 50_000                  # the bug reached 5,210,213
MAX_RSS_GROWTH_MB = 120           # the bug reached 2,671 MB total
STATUS_TIMEOUT_S = 10


class Tree:
    """A synthetic directory tree that keeps changing under the daemon."""

    def __init__(self, root, seed=7):
        self.root = root
        self.rng = random.Random(seed)
        self.n = 0
        for d in ("src", "docs", "data", "nested/deep"):
            os.makedirs(os.path.join(root, d), exist_ok=True)
        for _ in range(60):
            self.write()

    def write(self):
        sub = self.rng.choice(["src", "docs", "data", "nested/deep"])
        self.n += 1
        path = os.path.join(self.root, sub, f"f{self.n}.txt")
        with open(path, "w") as f:
            f.write(f"note {self.n}\n" * self.rng.randint(1, 40))
        return path

    def churn(self, ops=6):
        """Create, modify and delete, the way a working tree does."""
        for _ in range(ops):
            act = self.rng.random()
            if act < 0.5:
                self.write()
            elif act < 0.8:
                existing = [os.path.join(dp, f) for dp, _, fs in os.walk(self.root) for f in fs]
                if existing:
                    with open(self.rng.choice(existing), "a") as f:
                        f.write(f"appended {self.n}\n")
            else:
                existing = [os.path.join(dp, f) for dp, _, fs in os.walk(self.root) for f in fs]
                if len(existing) > 40:
                    try:
                        os.remove(self.rng.choice(existing))
                    except OSError:
                        pass


def rss_mb(pid):
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)],
                             capture_output=True, text=True, timeout=10).stdout.strip()
        return int(out) / 1024.0 if out else None
    except (subprocess.SubprocessError, ValueError):
        return None


def search(env, term, timeout=STATUS_TIMEOUT_S):
    """Raw search output, or None if the daemon did not answer."""
    try:
        r = subprocess.run([BIN, term, "--json"], capture_output=True, text=True,
                           env=env, timeout=timeout)
        return r.stdout
    except (subprocess.SubprocessError, OSError):
        return None


def status(env, timeout=STATUS_TIMEOUT_S):
    """Ask the daemon. None means it did not answer - which is itself a failure."""
    try:
        r = subprocess.run([BIN, "status"], capture_output=True, text=True,
                           env=env, timeout=timeout)
        return json.loads(r.stdout)
    except (subprocess.SubprocessError, json.JSONDecodeError, OSError):
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=0, help="0 means the 60 s gate window")
    ap.add_argument("--seconds", type=float, default=0, help="explicit window, overrides --hours")
    ap.add_argument("--keep", action="store_true", help="leave the fixture tree on disk")
    args = ap.parse_args()

    window = args.seconds or (args.hours * 3600 if args.hours else 60.0)
    sample_every = 5.0 if window <= 300 else 60.0

    tmp = tempfile.mkdtemp(prefix="ultrasearch-soak-")
    data, tree_root = os.path.join(tmp, "data"), os.path.join(tmp, "tree")
    os.makedirs(data)
    os.makedirs(tree_root)
    tree = Tree(tree_root)

    env = dict(os.environ)
    env["ULTRASEARCH_DIR"] = data
    env["ULTRASEARCH_SCAN_ROOT"] = tree_root
    # The soak must not inherit whatever pacing the developer's shell set.
    for k in ("ULTRASEARCH_COMPACT_PENDING", "ULTRASEARCH_MAX_ENTRIES"):
        env.pop(k, None)

    print(f"soak: {window:.0f}s against {tree_root}")
    print(f"  binary {BIN}")

    daemon = subprocess.Popen([BIN, "serve"], env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    fails = []
    samples = []
    t0 = time.time()
    try:
        time.sleep(4)
        first = status(env)
        if first is None:
            print("  FAIL: the daemon never answered a status request")
            return 1
        start_compact = first.get("compactions", 0)
        rss0 = rss_mb(daemon.pid)

        while time.time() - t0 < window:
            tree.churn()
            # A file created right now must become findable. Without this the soak
            # would pass on a daemon that stopped following events entirely - the
            # index would simply never change, and every ceiling below would hold.
            probe = tree.write()
            probe_name = os.path.basename(probe).replace(".txt", "")
            time.sleep(sample_every)
            found = search(env, probe_name)
            if found is not None and probe_name not in found:
                fails.append(f"a file created {sample_every:.0f}s ago ({os.path.basename(probe)}) is not findable - the follower is not keeping up")
            st = status(env)
            if st is None:
                fails.append(f"the daemon stopped answering status at t+{time.time() - t0:.0f}s")
                break
            rss = rss_mb(daemon.pid)
            samples.append({
                "t": round(time.time() - t0),
                "entries": st.get("entries"),
                "overlay": st.get("overlay"),
                "compactions": st.get("compactions"),
                "lag": st.get("event_lag"),
                "rss_mb": rss,
            })
            elapsed_min = max((time.time() - t0) / 60.0, 1e-9)
            rate = (st.get("compactions", 0) - start_compact) / elapsed_min
            line = (f"  t+{time.time() - t0:5.0f}s  base {st.get('entries'):>5}  "
                    f"overlay {st.get('overlay'):>4}  "
                    f"compact {st.get('compactions'):>3} ({rate:5.1f}/min)  "
                    f"lag {st.get('event_lag'):>6}  rss {rss or 0:6.1f} MB")
            print(line)

            if rate > MAX_COMPACTIONS_PER_MIN:
                fails.append(f"compactions ran at {rate:.0f}/min, over the {MAX_COMPACTIONS_PER_MIN}/min ceiling - the churn detector is not holding")
            if (st.get("event_lag") or 0) > MAX_LAG:
                fails.append(f"event lag reached {st.get('event_lag')}, over the {MAX_LAG} ceiling - the follower is losing to the event stream")
            if rss and rss0 and rss - rss0 > MAX_RSS_GROWTH_MB:
                fails.append(f"RSS grew {rss - rss0:.0f} MB, over the {MAX_RSS_GROWTH_MB} MB ceiling - an unbounded structure")
    finally:
        daemon.send_signal(signal.SIGTERM)
        try:
            daemon.wait(timeout=15)
        except subprocess.TimeoutExpired:
            daemon.kill()
        if not args.keep:
            shutil.rmtree(tmp, ignore_errors=True)

    print()
    if not samples:
        print("  FAIL: no sample was taken")
        return 1

    last = samples[-1]
    print(f"  window        : {last['t']}s, {len(samples)} samples")
    print(f"  base entries  : {last['entries']}")
    print(f"  overlay       : {last['overlay']}")
    print(f"  compactions   : {last['compactions']} (from {start_compact})")
    print(f"  final lag     : {last['lag']}")
    print(f"  RSS           : {rss0:.1f} -> {last['rss_mb'] or 0:.1f} MB")

    if fails:
        for f in fails:
            print(f"  FAIL: {f}", file=sys.stderr)
        return 1
    print("  OK: compactions bounded, lag bounded, RSS bounded, daemon answered throughout")
    if tmp and args.keep:
        print(f"  fixture kept at {tmp}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
