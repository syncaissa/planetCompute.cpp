#!/usr/bin/env python3
"""WorkPack granularity: how big should one pack be? (paper Section "Designing WorkPacks").

A job of W work units (images, video chunks, audio segments, LLM requests ...) is cut into
packs of b units. P volunteer devices pull packs from a queue (work stealing). A pack of b
units costs T_o + b * t / S_d on device d, where T_o is the fixed per-pack overhead
(claim + round trip + input/output transfer + validation) and S_d ~ LogNormal(0, sigma) is the
device's speed. A device leaves (user returns, lid closes) at rate lam; a pack in flight on a
leaving device is lost and re-queued, and a fresh device joins after a short delay.

Speed-matched sizing (optional): instead of b units for everyone, device d takes
max(1, round(b * S_d)) units, so every pack lasts about the same wall time on its own device.

End-game hedging (optional): once the queue is empty, a free device runs a backup copy of the
oldest in-flight pack that has fewer than two copies; the first copy to finish wins.

Prediction tested here: makespan(b) ~ W*T_o/(P*b) + W*t/P + kappa*b*t, so the best pack
holds b* = sqrt(W*T_o / (P*kappa*t)) units: it grows with sqrt(W*T_o/P).

Stdlib only; deterministic for a given --seed. Writes CSV to stdout (or --out).
"""
import argparse
import csv
import heapq
import math
import random
import sys


def simulate(W, b, P, T_o, *, t=1.0, sigma=0.5, lam=0.0, hedge=True, matched=False, seed=1,
             rejoin=30.0):
    rng = random.Random(seed)
    pool = W                                     # units not yet cut into a pack
    sizes, done, copies = [], [], []
    queue = []                                   # lost packs waiting for a new device
    started = {}                                 # pack -> earliest start of a live copy
    events = []                                  # (time, seq, kind, device, pack)
    seq = 0
    speed = {}
    next_dev = 0
    busy_time = 0.0
    executions = 0

    def new_device():
        nonlocal next_dev
        d = next_dev
        next_dev += 1
        speed[d] = rng.lognormvariate(0.0, sigma)
        return d

    def start(now, d):
        nonlocal seq, executions
        nonlocal pool
        p = None
        while queue:
            c = queue.pop()
            if not done[c]:
                p = c
                break
        if p is None and pool:
            k = min(pool, max(1, round(b * speed[d])) if matched else b)
            pool -= k
            p = len(sizes)
            sizes.append(k)
            done.append(False)
            copies.append(0)
        if p is None and hedge:
            live = [c for c in started if not done[c] and copies[c] < 2]
            if live:
                p = min(live, key=lambda c: started[c])
        if p is None:
            return False                         # device stays idle
        dur = T_o + sizes[p] * t / speed[d]
        copies[p] += 1
        started.setdefault(p, now)
        executions += 1
        leave = rng.expovariate(lam) if lam > 0 else math.inf
        seq += 1
        if leave < dur:
            heapq.heappush(events, (now + leave, seq, "lost", d, p))
        else:
            heapq.heappush(events, (now + dur, seq, "done", d, p))
        return True

    idle = []
    now = 0.0
    for _ in range(P):
        d = new_device()
        if not start(0.0, d):
            idle.append(d)
    while (pool or not all(done)) and events:
        now, _, kind, d, p = heapq.heappop(events)
        if kind == "join":
            if not start(now, d):
                idle.append(d)
            continue
        copies[p] -= 1
        if kind == "done":
            busy_time += sizes[p] * t / speed[d]
            if not done[p]:
                done[p] = True
                started.pop(p, None)
            elif copies[p] == 0:
                started.pop(p, None)
            if not start(now, d):
                idle.append(d)
        else:                                    # device left mid-pack
            if not done[p] and copies[p] == 0:
                started.pop(p, None)
                queue.append(p)                  # re-queue at the front
                while idle:                      # wake an idle device for it
                    if start(now, idle.pop()):
                        break
            seq += 1
            heapq.heappush(events, (now + rejoin, seq, "join", new_device(), -1))
    return {"makespan": now, "executions_per_pack": executions / len(sizes),
            "n_packs": len(sizes)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--reps", type=int, default=10)
    ap.add_argument("--out")
    a = ap.parse_args()
    P = 200
    grid_b = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128]
    rows = []
    for W in (4_000, 40_000):
        for T_o in (0.5, 2.0):
            for lam in (0.0, 1 / 600):
                for hedge, matched in ((False, False), (True, False), (True, True)):
                    for b in grid_b:
                        if W / b < P:                # fewer packs than devices: not a sizing question
                            continue
                        ms = [simulate(W, b, P, T_o, lam=lam, hedge=hedge, matched=matched,
                                       seed=a.seed + r)
                              for r in range(a.reps)]
                        rows.append({
                            "W": W, "P": P, "T_o": T_o, "lam": round(lam, 6), "hedge": hedge,
                            "matched": matched, "b": b,
                            "makespan": sum(m["makespan"] for m in ms) / a.reps,
                            "exec_per_pack": sum(m["executions_per_pack"] for m in ms) / a.reps,
                            "lower_bound": W * 1.0 / P * math.exp(-0.5 * 0.5 ** 2),
                        })
    f = open(a.out, "w") if a.out else sys.stdout
    w = csv.DictWriter(f, fieldnames=list(rows[0]))
    w.writeheader()
    w.writerows(rows)


if __name__ == "__main__":
    main()
