#!/usr/bin/env python3
"""Fit makespan(b) = A/b + B + C*b to packsize_results.csv and render the paper's LaTeX table.

A is compared with the prediction W*T_o/P, kappa = C/t (t = 1) is the tail coefficient, and
b_fit = sqrt(A/C) is the fitted optimum pack size. Also prints the table to stdout.
"""
import collections
import csv
import math
import sys

src = sys.argv[1] if len(sys.argv) > 1 else "packsize_results.csv"
dst = sys.argv[2] if len(sys.argv) > 2 else "../generated/packsize_table.tex"


def lstsq3(X, y):
    """Least squares for 3 unknowns via the normal equations (stdlib only)."""
    A = [[sum(r[i] * r[j] for r in X) for j in range(3)] for i in range(3)]
    v = [sum(r[i] * yy for r, yy in zip(X, y)) for i in range(3)]
    for i in range(3):
        p = max(range(i, 3), key=lambda k: abs(A[k][i]))
        A[i], A[p], v[i], v[p] = A[p], A[i], v[p], v[i]
        for k in range(i + 1, 3):
            f = A[k][i] / A[i][i]
            A[k] = [a - f * c for a, c in zip(A[k], A[i])]
            v[k] -= f * v[i]
    x = [0.0] * 3
    for i in reversed(range(3)):
        x[i] = (v[i] - sum(A[i][c] * x[c] for c in range(i + 1, 3))) / A[i][i]
    return x


groups = collections.defaultdict(list)
for r in csv.DictReader(open(src)):
    key = (int(r["W"]), int(r["P"]), float(r["T_o"]), float(r["lam"]), r["hedge"] == "True",
           r["matched"] == "True")
    groups[key].append((int(r["b"]), float(r["makespan"]), float(r["exec_per_pack"]),
                        float(r["lower_bound"])))

POLICY = {(False, False): "Fixed size", (True, False): "+ hedging", (True, True): "+ speed-matched"}
out = []
prev = None
for (W, P, T_o, lam, hedge, matched), v in sorted(groups.items()):
    A, B, C = lstsq3([[1 / b, 1.0, b] for b, *_ in v], [m for _, m, *_ in v])
    b_fit = math.sqrt(A / C)
    best = min(v, key=lambda x: x[1])
    one = next(x for x in v if x[0] == 1)
    lb = v[0][3]
    print(f"W={W} T_o={T_o} lam={lam:.5f} {POLICY[hedge, matched]:16s} A/pred={A / (W * T_o / P):.2f} "
          f"kappa={C:.2f} b_fit={b_fit:.1f} b_grid={best[0]} T(1)={one[1]:.0f} "
          f"T(best)={best[1]:.0f} LB={lb:.0f} exec/pack={best[2]:.2f}")
    group = (W, T_o, lam)
    if prev is not None and group != prev:
        out.append(r"\midrule")
    first = group != prev
    prev = group
    out.append(" & ".join([
        f"{W:,}".replace(",", "{,}") if first else "",
        f"{T_o:g}" if first else "",
        ("--" if lam == 0 else "1/600") if first else "",
        POLICY[hedge, matched],
        f"{A / (W * T_o / P):.2f}",
        f"{C:.2f}",
        f"{b_fit:.1f}",
        f"{one[1]:.0f}",
        f"{best[1]:.0f}",
        f"{100 * (best[1] / lb - 1):.0f}\\%",
    ]) + r" \\")

open(dst, "w").write("\n".join([
    r"\begin{tabular}{@{}rrllrrrrrr@{}}",
    r"\toprule",
    r"$W$ & $T_o$ & \textbf{Churn} $\lambda$ & \textbf{Policy} & $\hat A/\tfrac{W T_o}{P}$ & $\hat\kappa$ & $\hat b^\star$ & $T(1)$ & $T(\hat b^\star)$ & \textbf{Over bound} \\",
    r"\midrule",
    *out,
    r"\bottomrule",
    r"\end{tabular}",
    "",
]))
print("wrote", dst)
