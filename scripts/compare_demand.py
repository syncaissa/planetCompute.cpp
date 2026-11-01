#!/usr/bin/env python3
"""Compare test traffic: hungry wolves (old) vs DemandSimulation of an in-house SherpaHub (docs/TESTING.md test 88).

Run ON the server, from /root/REMOTESERVERSACCESS:
    python3 -I compare_demand.py 2026-10-30T07:45 2026-10-30T15:39
Reads hungrywolves/logs/wolf*.jsonl (one line per job: ok, ms, device) and sherpahubs/logs/demand.jsonl (status, ms,
device) between the two UTC times (the second is optional) and prints, for each: jobs, answered, failed, jobs an hour,
median and 95th-percentile time, the computers that answered and the errors. Standard library only.
"""
import collections, glob, json, statistics, sys
from datetime import datetime

T0 = sys.argv[1] if len(sys.argv) > 1 else "0000"
T1 = sys.argv[2] if len(sys.argv) > 2 else "9999"


def load(files):
    rows = []
    for f in files:
        for line in open(f):
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if T0 <= r.get("at", "") <= T1:
                rows.append(r)
    return rows


def report(name, rows, ok):
    if not rows:
        print(name, "no jobs in the window"); return
    good = [r for r in rows if ok(r)]
    ms = sorted(r["ms"] for r in good if r.get("ms"))
    a = datetime.fromisoformat(min(r["at"] for r in rows)[:19]); b = datetime.fromisoformat(max(r["at"] for r in rows)[:19])
    hours = max((b - a).total_seconds() / 3600, 1 / 60)
    print(f"{name}: jobs {len(rows)}, answered {len(good)} ({100 * len(good) / len(rows):.1f}%), failed {len(rows) - len(good)}, "
          f"{len(rows) / hours:.0f} an hour, median {statistics.median(ms) / 1000 if ms else 0:.1f} s, "
          f"p95 {ms[int(0.95 * len(ms))] / 1000 if ms else 0:.1f} s")
    print("  computers:", collections.Counter(r.get("device") for r in good).most_common())
    print("  errors:", collections.Counter((r.get("status"), str(r.get("error"))[:70]) for r in rows if not ok(r)).most_common(5))


report("hungry wolves", load(glob.glob("hungrywolves/logs/wolf*.jsonl")), lambda r: bool(r.get("ok")))
report("DemandSimulation", load(["sherpahubs/logs/demand.jsonl"]), lambda r: r.get("status") == 200 and not r.get("error"))
