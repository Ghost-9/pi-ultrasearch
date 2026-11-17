#!/usr/bin/env python3
"""Soak the daemon against a churning tree and assert the properties that broke.

The original defect, as it presented: 2,671 MB RSS and 23.6% CPU, because the scan
root defaulted to `/` (2.3M entries), FSEvents lag reached 5,210,213, and the engine
forced 67 compactions in a row trying to catch up. Every one of those is a property
that a soak test can assert, and none of them were asserted.

This runs the daemon against a synthetic tree that churns the way a real one does -
files created, modified and deleted while the index is live - and fails when:

  * compactions run away (the churn detector stopped working)
  * a file created now is not findable a moment later (the follower is losing to the
    event stream) - measured directly; `event_lag` itself is reported but not asserted,
    because it counts system-wide events since the index was last written
  * memory grows without bound (an unbounded structure)
  * the daemon stops answering (a wedge)

Memory is measured as the process's physical footprint, not RSS. On macOS RSS counts mapped
file pages the kernel drops on demand, and the index is memory-mapped, so the daemon reads
158 MB RSS while holding 18.9 MB - and this soak's own daemon reads 12.7 MB RSS against a
3.2 MB footprint. Asserting a bound on RSS therefore measures the page cache, not the process:
it would fail a healthy daemon whose pages happen to be resident and pass a leaking one that
had released them. RSS is still printed, because the original report was in RSS and a reading
should stay comparable to it.

Two durations:
    python3 scripts/soak.py              # ~60 s, the CI gate
    python3 scripts/soak.py --hours 48   # the real soak, run on a weekend

Exit code 0 means every assertion held for the whole window.
"""

import argparse
import contextlib
import io
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
MAX_GROWTH_MB = 120               # the bug reached 2,671 MB RSS; threshold kept loose
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
    """Resident size - kept only for continuity with the original report.

    RSS is NOT memory use on macOS: it counts mapped file pages the kernel can drop at any
    moment. The daemon sits at 158 MB RSS while its physical footprint is 18.9 MB, because the
    index is memory-mapped. Asserting growth on RSS would fail a healthy daemon and pass a
    leaking one that happens to have released file pages. `footprint_mb` is the number that
    matters; this one is reported so a reading can still be compared to the 2,671 MB original.
    """
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)],
                             capture_output=True, text=True, timeout=10).stdout.strip()
        return int(out) / 1024.0 if out else None
    except (subprocess.SubprocessError, ValueError):
        return None


def footprint_mb(pid):
    """Physical footprint: the memory the process is actually holding.

    Read from `vmmap -summary`, which is slow, so this is called once per sample rather than
    per assertion. Returns None where the tool is unavailable, and the caller then falls back
    to RSS with a note rather than silently measuring the wrong thing.
    """
    try:
        out = subprocess.run(["vmmap", "-summary", str(pid)],
                             capture_output=True, text=True, timeout=30).stdout
    except subprocess.SubprocessError:
        return None
    for line in out.splitlines():
        if "Physical footprint:" in line:
            parts = line.split()
            # "Physical footprint:         18.9M"
            for tok in reversed(parts):
                if tok and tok[-1] in "MKG" and tok[:-1].replace(".", "", 1).isdigit():
                    value = float(tok[:-1])
                    return value * {"K": 1 / 1024, "M": 1.0, "G": 1024}[tok[-1]]
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
    """Ask the daemon. None means it did not answer - which is itself a failure.

    A timeout is retried once at four times the limit before it counts. Measured: the same call
    takes 7 ms at rest and up to 3.5 s while the machine sits at load 22, a 500x slowdown, so a
    busy machine can cross a fixed 10 s limit without the daemon being wedged. The six-hour run
    ended exactly that way - one failed probe at load ~100, no crash report, 69 good samples
    either side - and it was reported as "the daemon stopped answering", which is a verdict on
    the product drawn from a measurement of the machine.
    """
    for attempt, limit in ((1, timeout), (2, timeout * 4)):
        try:
            r = subprocess.run([BIN, "status"], capture_output=True, text=True,
                               env=env, timeout=limit)
            return json.loads(r.stdout)
        except (subprocess.SubprocessError, json.JSONDecodeError, OSError):
            if attempt == 2:
                return None
    return None


def run_soak(args):
    """The soak proper. `args` needs `seconds`, `hours` and `keep`."""

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
        fp0 = footprint_mb(daemon.pid)

        while time.time() - t0 < window:
            tree.churn()
            # A file created right now must become findable. Without this the soak
            # would pass on a daemon that stopped following events entirely - the
            # index would simply never change, and every ceiling below would hold.
            probe = tree.write()
            probe_name = os.path.basename(probe).replace(".txt", "")
            time.sleep(sample_every)
            found = search(env, probe_name)
            # `None` means the search itself did not come back. That used to skip the check
            # entirely, so a daemon that answered `status` but not `search` passed the one
            # assertion that matters - the same shape as every other instrument defect found
            # here: a probe that reports success when it measured nothing.
            if found is None:
                fails.append(
                    f"the daemon did not answer a search at t+{time.time() - t0:.0f}s, so the "
                    f"visibility probe could not run"
                )
            elif probe_name not in found:
                fails.append(f"a file created {sample_every:.0f}s ago ({os.path.basename(probe)}) is not findable - the follower is not keeping up")
            st = status(env)
            if st is None:
                try:
                    _load = os.getloadavg()[0]
                except (OSError, AttributeError):
                    _load = -1.0
                fails.append(
                    f"the daemon stopped answering status at t+{time.time() - t0:.0f}s "
                    f"(load {_load:.1f}; a retry at 4x the timeout also failed)"
                )
                break
            rss = rss_mb(daemon.pid)
            fp = footprint_mb(daemon.pid)
            samples.append({
                "t": round(time.time() - t0),
                "entries": st.get("entries"),
                "overlay": st.get("overlay"),
                "compactions": st.get("compactions"),
                "lag": st.get("event_lag"),
                # The global event id, so the lag can be read as a RATE rather than an
                # absolute. `event_lag` is `last_event_id - event_id` over the system-wide
                # FSEvents stream, so a machine doing other work moves it even when the
                # daemon is keeping up. Measured: two runs of the same binary over the same
                # tree - 302 s of churn (216 files) peaked at lag 85, while a 1505 s run
                # (100 files, a third of the churn rate) reached 88203 in its first four
                # minutes, during a concurrent cargo build. The churn was not the cause.
                "global": st.get("event_id"),
                "rss_mb": rss,
                "footprint_mb": fp,
            })
            elapsed_min = max((time.time() - t0) / 60.0, 1e-9)
            rate = (st.get("compactions", 0) - start_compact) / elapsed_min
            line = (f"  t+{time.time() - t0:5.0f}s  base {st.get('entries'):>5}  "
                    f"overlay {st.get('overlay'):>4}  "
                    f"compact {st.get('compactions'):>3} ({rate:5.1f}/min)  "
                    f"lag {st.get('event_lag'):>6}  fp {fp or 0:5.1f} MB  rss {rss or 0:6.1f} MB")
            print(line)

            if rate > MAX_COMPACTIONS_PER_MIN:
                fails.append(f"compactions ran at {rate:.0f}/min, over the {MAX_COMPACTIONS_PER_MIN}/min ceiling - the churn detector is not holding")
            # `event_lag` is deliberately NOT asserted here.
            #
            # It is `fsevents::current_id() - index.event_id`: a live system-wide counter
            # minus the id stamped when the index was last written. It therefore grows on an
            # idle daemon - measured on an isolated one with 21 entries and no churn, it
            # climbed 4817 -> 63064 in 60 s against an untouched index - and it moves with
            # whatever else the machine is doing. A ceiling on it reported a wedge that did
            # not exist, twice.
            #
            # The probe above is the assertion that means something: a file created now must
            # be findable a moment later. That measures "the follower is keeping up" directly.
            # Asserted on physical footprint, not RSS. See `rss_mb`: RSS on macOS counts
            # mapped file pages that the kernel reclaims on demand, so a bound on it measures
            # the page cache rather than the process, and an earlier version of this soak
            # reported "RSS bounded" for six hours while never once looking at real memory.
            growth = (fp - fp0) if (fp and fp0) else ((rss - rss0) if (rss and rss0) else None)
            metric = "footprint" if (fp and fp0) else "RSS (footprint unavailable)"
            if growth is not None and growth > MAX_GROWTH_MB:
                fails.append(f"{metric} grew {growth:.0f} MB, over the {MAX_GROWTH_MB} MB ceiling - an unbounded structure")
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
    fp_vals = [s["footprint_mb"] for s in samples if s.get("footprint_mb")]
    if fp_vals:
        print(f"  footprint     : {fp0:.1f} -> {last['footprint_mb'] or 0:.1f} MB "
              f"(peak {max(fp_vals):.1f})")
    print(f"  RSS           : {rss0:.1f} -> {last['rss_mb'] or 0:.1f} MB "
          f"(page cache included; not memory use)")

    if fails:
        for f in fails:
            print(f"  FAIL: {f}", file=sys.stderr)
        return 1
    print("  OK: compactions bounded, new files visible, memory bounded, daemon answered throughout")
    if tmp and args.keep:
        print(f"  fixture kept at {tmp}")
    return 0




def selftest():
    """Fail if this soak would pass without actually checking anything.

    A probe that cannot fail reports success, and this file already had one: when a search did
    not answer, `found` was None and the visibility check was skipped entirely, so a daemon that
    answered `status` but not `search` produced "OK: new files visible" without ever looking.
    Verified against the old logic - it returned 0 and printed OK.

    So the check lives with the tool: break `search`, run the soak, require a failure.
    """
    global search
    real = search
    search = lambda *a, **k: None
    args = argparse.Namespace(seconds=45, hours=0, keep=False)
    buf = io.StringIO()
    try:
        with contextlib.redirect_stderr(buf):
            rc = run_soak(args)
    finally:
        search = real
    if rc == 0:
        print("  SELFTEST FAILED: the soak passed with search broken - its assertions are inert")
        return 1
    if "did not answer a search" not in buf.getvalue():
        print(f"  SELFTEST FAILED: it failed, but not for the right reason: {buf.getvalue()[:160]}")
        return 1
    print("  selftest OK: breaking search makes the soak fail")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=0, help="0 means the 60 s gate window")
    ap.add_argument("--seconds", type=float, default=0, help="explicit window, overrides --hours")
    ap.add_argument("--keep", action="store_true", help="leave the fixture tree on disk")
    ap.add_argument("--selftest", action="store_true",
                    help="run with search deliberately broken; the soak must fail")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    return run_soak(args)


if __name__ == "__main__":
    sys.exit(main())
