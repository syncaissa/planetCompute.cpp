#!/usr/bin/env python3
"""Competitive redundant dispatch of WorkPacks (paper Section 5, experiment E4b).

Each WorkPack is sent *simultaneously* to n devices on n distinct networks (IP prefixes).
A result is accepted when q=3 matching results from distinct networks agree. The first
finisher in the accepted cluster earns the large share alpha of the pack reward; the other
matching finishers split the remaining (1 - alpha) as consolation. Non-matching results earn
nothing and a strike; 3 strikes ban a device, and every pack it helped accept is re-queued
and its reward clawed back (retroactive invalidation).

Adversary: a fraction f of devices, spread over S_bad networks, returns the same wrong
result hash *without computing*, so it always finishes first.

Acceptance rules:
  first-q   accept the first hash to collect q matching results, in arrival order
  window    wait until every live replica reports (or the deadline), then accept the hash
            with the most votes if it has >= q votes and a strict plurality
  hybrid    accept as in first-q (low latency), but keep the pack open until the deadline:
            later matching results still earn consolation, later mismatches still get strikes

Stdlib only; deterministic for a given --seed. Writes CSV to stdout (or --out).
"""
import argparse
import collections
import csv
import math
import random
import sys

BAN_STRIKES = 3
ALPHA = 0.5          # winner's share of the pack reward
P_DROP = 0.05        # honest replica never reports (closed lid, network loss)
ERR = 0.001          # honest random error


def simulate(rule, n, f, s_bad, *, q=3, n_devices=2000, n_packs=20_000,
             penalties=True, seed=1):
    rng = random.Random(seed)
    n_bad = int(round(f * n_devices))
    bad = [i < n_bad for i in range(n_devices)]
    # Honest devices sit on their own network; adversary devices share s_bad networks.
    net = [i % s_bad if bad[i] else 1_000_000 + i for i in range(n_devices)]
    speed = [rng.lognormvariate(0.0, 0.5) for _ in range(n_devices)]
    strikes = [0] * n_devices
    banned = [False] * n_devices
    accepted_by = [[] for _ in range(n_devices)]
    credit = collections.defaultdict(float)          # (device, pack) -> reward
    outcome = {}
    queue = collections.deque(range(n_packs))
    executions = reissued = requeued = 0
    latency_sum = single_sum = 0.0
    latency_n = 0
    wrong_id = 0

    def strike(d):
        nonlocal requeued
        strikes[d] += 1
        if penalties and strikes[d] >= BAN_STRIKES and not banned[d]:
            banned[d] = True
            for p in accepted_by[d]:
                if p in outcome:
                    del outcome[p]
                    for key in [k for k in credit if k[1] == p]:
                        del credit[key]
                    queue.append(p)
                    requeued += 1
            accepted_by[d].clear()

    def pick_pack_devices():
        chosen, nets = [], set()
        while len(chosen) < n:
            d = rng.randrange(n_devices)
            if banned[d] or net[d] in nets:
                continue
            chosen.append(d)
            nets.add(net[d])
        return chosen

    while queue:
        p = queue.popleft()
        devs = pick_pack_devices()
        replies = []                                   # (finish_time, device, hash)
        for d in devs:
            executions += 1
            if bad[d]:
                replies.append((0.05 * rng.random(), d, "COLLUDE"))
                continue
            if rng.random() < P_DROP:
                continue
            t = rng.uniform(0.9, 1.1) / speed[d]
            if rng.random() < ERR:
                wrong_id += 1
                h = f"err{wrong_id}"
            else:
                h = "OK"
            replies.append((t, d, h))
            single_sum += t
        replies.sort()

        winner, t_accept = None, None
        if rule in ("first-q", "hybrid"):
            votes = collections.Counter()
            for t, d, h in replies:
                votes[h] += 1
                if votes[h] >= q:
                    winner, t_accept = h, t
                    break
        else:
            votes = collections.Counter(h for _, _, h in replies)
            if votes:
                (h1, v1), *rest = votes.most_common()
                if v1 >= q and (not rest or rest[0][1] < v1):
                    winner = h1
                    t_accept = replies[-1][0]
        if winner is None:
            reissued += 1
            queue.append(p)
            continue

        outcome[p] = winner
        latency_sum += t_accept
        latency_n += 1
        cluster = [(t, d) for t, d, h in replies if h == winner and (rule != "first-q" or t <= t_accept)]
        first = cluster[0][1]
        others = [d for _, d in cluster[1:]]
        credit[(first, p)] = ALPHA if others else 1.0
        for d in others:
            credit[(d, p)] = (1 - ALPHA) / len(others)
        for _, d in cluster:
            accepted_by[d].append(p)
        for t, d, h in replies:
            if h != winner and (rule != "first-q" or t <= t_accept):
                strike(d)

    wrong = sum(h != "OK" for h in outcome.values())
    total_credit = sum(credit.values())
    bad_credit = sum(v for (d, _), v in credit.items() if bad[d])
    # Fairness: reward per honest device, fastest vs slowest speed quartile.
    honest = sorted((i for i in range(n_devices) if not bad[i]), key=lambda i: speed[i])
    per_dev = collections.defaultdict(float)
    for (d, _), v in credit.items():
        per_dev[d] += v
    qsize = len(honest) // 4
    slow = sum(per_dev[i] for i in honest[:qsize]) / qsize
    fast = sum(per_dev[i] for i in honest[-qsize:]) / qsize
    return {
        "rule": rule, "n": n, "q": q, "f": f, "s_bad": s_bad, "penalties": penalties,
        "packs": n_packs, "accepted": len(outcome),
        "wrong_accept_rate": wrong / max(1, len(outcome)),
        "exec_per_pack": executions / max(1, len(outcome)),
        "reissued": reissued, "requeued": requeued,
        "adversary_reward_share": bad_credit / total_credit if total_credit else 0.0,
        "cheaters_banned_frac": sum(banned[i] for i in range(n_bad)) / max(1, n_bad),
        "honest_banned": sum(banned[i] for i in range(n_bad, n_devices)),
        "reward_fast_over_slow": fast / slow if slow else math.inf,
        "slow_quartile_mean_reward": slow,
        "accept_latency": latency_sum / max(1, latency_n),
    }


def binom_tail(n, p, k):
    return sum(math.comb(n, j) * p**j * (1 - p)**(n - j) for j in range(k, n + 1))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--packs", type=int, default=20_000)
    ap.add_argument("--out")
    a = ap.parse_args()
    rows = []
    for f in (0.05, 0.20):
        n_bad = int(round(f * 2000))
        for s_bad in (2, 20, n_bad):
            for n in (3, 5):
                for rule in ("first-q", "window", "hybrid"):
                    for pen in (False, True):
                        if n == 3 and rule != "first-q":
                            continue          # identical to first-q when n == q
                        r = simulate(rule, n, f, s_bad, penalties=pen,
                                     n_packs=a.packs, seed=a.seed)
                        r["theory_first_q_no_pen"] = binom_tail(n, f, 3) if s_bad >= 3 else 0.0
                        rows.append(r)
    out = open(a.out, "w", newline="") if a.out else sys.stdout
    w = csv.DictWriter(out, fieldnames=list(rows[0]))
    w.writeheader()
    w.writerows(rows)


if __name__ == "__main__":
    main()
