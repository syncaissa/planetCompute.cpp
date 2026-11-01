#!/usr/bin/env python3
"""Monte Carlo simulation of PlanetCompute result validation (paper Section 4, experiment E4).

Models a volunteer population in which a fraction f of devices is controlled by a
colluding adversary that returns the same wrong result hash with probability c per unit.
Honest devices return a random (non-colluding) wrong result with probability e.

Policies:
  none      every unit run once, accepted as-is (no validation)
  q2        quorum 2: replicate until one result hash has 2 matching votes
  q3        quorum 3
  adaptive  quorum 2, but a unit first handed to a *trusted* device (>= T consecutive
            validated results) is accepted on that single result with probability
            1 - audit; plus known-answer spot checks at rate s for every device.

Spot checks: a device failing a known-answer unit, or whose result loses a quorum
vote, loses its trust streak and gets a strike; 3 strikes ban it. On a ban, every unit
the device helped accept is invalidated and re-queued (retroactive invalidation), so
the reported wrong-accept rate is the rate *after* clean-up.

Stdlib only; deterministic for a given --seed. Writes CSV to stdout (or --out).
"""
import argparse
import collections
import math
import csv
import random
import sys

MAX_REPLICAS = 8
TRUST_T = 10
BAN_STRIKES = 3


def simulate(policy, f, c, *, n_devices=2000, n_units=100_000, e=0.001,
             spot=0.05, audit=0.10, seed=1):
    rng = random.Random(seed)
    n_bad = int(round(f * n_devices))
    malicious = [i < n_bad for i in range(n_devices)]
    streak = [0] * n_devices          # consecutive validated results (trust)
    strikes = [0] * n_devices
    banned = [False] * n_devices
    first_ban_at = [None] * n_devices
    contributed = [[] for _ in range(n_devices)]   # units each device helped accept
    outcome = {}                       # unit -> accepted result hash
    retro = policy != "none"           # retroactive invalidation on ban
    queue = collections.deque(range(n_units))
    issued = executions = spot_runs = failed = requeued = 0
    wrong_id = 0

    def compute(dev):
        nonlocal wrong_id
        if malicious[dev] and rng.random() < c:
            return "COLLUDE"
        if rng.random() < e:
            wrong_id += 1
            return f"err{wrong_id}"
        return "OK"

    def pick(exclude):
        while True:
            d = rng.randrange(n_devices)
            if d not in exclude and not banned[d]:
                return d

    def strike(dev):
        nonlocal requeued
        streak[dev] = 0
        strikes[dev] += 1
        if strikes[dev] >= BAN_STRIKES and not banned[dev]:
            banned[dev] = True
            first_ban_at[dev] = issued
            if retro:
                for u in contributed[dev]:
                    if u in outcome:
                        del outcome[u]
                        queue.append(u)
                        requeued += 1
                contributed[dev].clear()

    while queue:
        u = queue.popleft()
        issued += 1

        # Known-answer spot checks (indistinguishable from real units).
        if policy == "adaptive" and rng.random() < spot:
            d = pick(())
            executions += 1
            spot_runs += 1
            if compute(d) != "OK":
                strike(d)
            else:
                streak[d] += 1

        if policy == "none":
            executions += 1
            outcome[u] = compute(pick(()))
            continue

        q = 3 if policy == "q3" else 2
        first = pick(())
        if policy == "adaptive" and streak[first] >= TRUST_T and rng.random() >= audit:
            executions += 1
            outcome[u] = compute(first)
            contributed[first].append(u)
            continue

        votes, devs, results = {}, [first], {}
        while True:
            d = devs[-1]
            executions += 1
            r = compute(d)
            results[d] = r
            votes[r] = votes.get(r, 0) + 1
            winner = next((h for h, v in votes.items() if v >= q), None)
            if winner is not None or len(devs) >= MAX_REPLICAS:
                break
            devs.append(pick(devs))
        if winner is None:
            failed += 1
            continue
        outcome[u] = winner
        for d, r in results.items():
            if r == winner:
                streak[d] += 1
                contributed[d].append(u)
            else:
                strike(d)

    accepted = len(outcome)
    wrong = sum(r != "OK" for r in outcome.values())
    bad_ids = [i for i in range(n_devices) if malicious[i]]
    ban_times = sorted(first_ban_at[i] for i in bad_ids if first_ban_at[i] is not None)
    return {
        "policy": policy, "f": f, "c": c,
        "units": n_units, "accepted": accepted, "failed": failed,
        "wrong_accept_rate": wrong / max(accepted, 1),
        "exec_per_accepted": executions / max(accepted, 1),
        "spot_runs": spot_runs, "requeued": requeued,
        "cheaters_banned_frac": sum(banned[i] for i in bad_ids) / max(len(bad_ids), 1),
        "honest_banned": sum(banned[i] for i in range(n_devices) if not malicious[i]),
        "median_ban_unit": ban_times[len(ban_times) // 2] if ban_times else "",
    }


def race(f, q):
    """Closed form: P(colluders reach q matching votes before honest devices do)."""
    return sum(math.comb(q - 1 + k, k) * f**q * (1 - f)**k for k in range(q))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--units", type=int, default=100_000)
    ap.add_argument("--out")
    a = ap.parse_args()
    rows = []
    for f in (0.01, 0.05, 0.10, 0.20):
        for c in (1.0, 0.1):
            for policy in ("none", "q2", "q3", "adaptive"):
                row = simulate(policy, f, c, n_units=a.units, seed=a.seed)
                row["race_q2"] = race(f, 2)
                row["race_q3"] = race(f, 3)
                rows.append(row)
    out = open(a.out, "w", newline="") if a.out else sys.stdout
    w = csv.DictWriter(out, fieldnames=list(rows[0]))
    w.writeheader()
    w.writerows(rows)


if __name__ == "__main__":
    main()
