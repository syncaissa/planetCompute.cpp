#!/usr/bin/env python3
"""Render results.csv (from validation_sim.py) as the LaTeX table used in the paper."""
import csv
import sys

src = sys.argv[1] if len(sys.argv) > 1 else "results.csv"
dst = sys.argv[2] if len(sys.argv) > 2 else "../generated/validation_table.tex"
rows = list(csv.DictReader(open(src)))
NAMES = {"none": "No validation", "q2": "Quorum $q{=}2$", "q3": "Quorum $q{=}3$",
         "adaptive": "Adaptive ($q{=}2$, spot $5\\%$)"}


def pct(x):
    x = float(x)
    return "0" if x == 0 else f"{100 * x:.2f}\\%"


out = []
for f in ("0.05", "0.2"):
    for c in ("1.0", "0.1"):
        sel = [r for r in rows if r["f"] == f and r["c"] == c]
        label = f"$f={float(f):.2f}$, $c={float(c):g}$"
        for i, r in enumerate(sel):
            banned = f"{100 * float(r['cheaters_banned_frac']):.0f}\\%" if r["policy"] != "none" else "--"
            out.append(" & ".join([
                label if i == 0 else "",
                NAMES[r["policy"]],
                pct(r["wrong_accept_rate"]),
                f"{float(r['exec_per_accepted']):.2f}",
                banned,
                r["honest_banned"] if r["policy"] != "none" else "--",
            ]) + r" \\")
        out.append(r"\midrule")
out[-1] = r"\bottomrule"

open(dst, "w").write("\n".join([
    r"\begin{tabular}{llrrrr}",
    r"\toprule",
    r"\textbf{Adversary} & \textbf{Policy} & \textbf{Wrong accepted} & \textbf{Exec./unit} & \textbf{Cheaters banned} & \textbf{Honest banned} \\",
    r"\midrule",
    *out,
    r"\end{tabular}",
    "",
]))
print("wrote", dst)
