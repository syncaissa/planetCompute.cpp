#!/usr/bin/env python3
"""Render race_results.csv (from race_sim.py) as the LaTeX table used in the paper."""
import csv
import sys

src = sys.argv[1] if len(sys.argv) > 1 else "race_results.csv"
dst = sys.argv[2] if len(sys.argv) > 2 else "../generated/race_table.tex"
rows = [r for r in csv.DictReader(open(src)) if r["f"] == "0.2" and r["s_bad"] == "400"]
RULE = {"first-q": "First 3 matching", "window": "Wait for all", "hybrid": "Hybrid (ours)"}


def pct(x):
    x = float(x)
    return "0" if x == 0 else f"{100 * x:.2f}\\%"


out = []
for r in rows:
    out.append(" & ".join([
        f"$n={r['n']}$",
        RULE[r["rule"]] if r["n"] != "3" else "Unanimous (3 of 3)",
        "\\cmark" if r["penalties"] == "True" else "\\xmark",
        pct(r["wrong_accept_rate"]),
        f"{float(r['exec_per_pack']):.2f}",
        f"{float(r['accept_latency']):.2f}",
        f"{float(r['reward_fast_over_slow']):.1f}$\\times$",
    ]) + r" \\")
open(dst, "w").write("\n".join([
    r"\begin{tabular}{@{}llcrrrr@{}}",
    r"\toprule",
    r"\textbf{Dispatch} & \textbf{Acceptance} & \textbf{Penalties} & \textbf{Wrong accepted} & \textbf{Exec./pack} & \textbf{Latency} & \textbf{Fast/slow credit} \\",
    r"\midrule",
    *out,
    r"\bottomrule",
    r"\end{tabular}",
    "",
]))
print("wrote", dst)
