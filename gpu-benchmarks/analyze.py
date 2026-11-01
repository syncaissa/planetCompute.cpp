#!/usr/bin/env python3
"""Summarise RunPod benchmark results (paper/bench/results/<gpu>/*.json) into
paper/bench/summary.json and the LaTeX tables paper/generated/bench_*.tex.

Usage: python analyze.py [results_dir]   (needs numpy + pillow + scikit-image for SSIM)
"""
import itertools
import json
import pathlib
import statistics as st
import sys

import numpy as np
from PIL import Image
from skimage.metrics import structural_similarity

HERE = pathlib.Path(__file__).resolve().parent
RES = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "results"
GEN = HERE / "tables"
GEN.mkdir(exist_ok=True)
GPUS = [g for g in ("3090", "4090", "a100") if (RES / g).exists()]
NAME = {"3090": "RTX 3090", "4090": "RTX 4090", "a100": "A100 80GB"}


def load(g, f):
    p = RES / g / f
    return json.loads(p.read_text()) if p.exists() else None


def fnum(x, d=2):
    return "--" if x is None else f"{x:.{d}f}"


summary = {"gpus": {g: NAME[g] for g in GPUS}}

# ---------------- B1 / B3 throughput ----------------
b1 = {}
for g in GPUS:
    d, v, m, vid, l = (load(g, f) for f in ("diffusion.json", "vllm.json", "music.json", "video.json", "llm.json"))
    row = {}
    if d:
        row["sdxl_s_img_b1"] = d["B1_batch1"]["s_per_image"]
        row["sdxl_s_img_b4"] = d["B1_batch4"]["s_per_image"]
        row["sdxl_s_step"] = d["B1_batch1"]["s_per_step"]
        row["sdxl_dl_MBps"] = d["B3"]["bytes"] / d["B3"]["download_s"] / 1e6
        row["sdxl_load_s"] = d["B3"]["load_to_gpu_s"]
        row["sdxl_GB"] = d["B3"]["bytes"] / 1e9
    if v:
        for repo, r in v["models"].items():
            k = repo.split("-")[1].lower()          # 7b / 14b / 32b
            row[f"llm{k}_tok_b1"] = r["batch1"]["tok_per_s"]
            row[f"llm{k}_tok_b32"] = r["batch32"]["tok_per_s"]
            row[f"llm{k}_GB"] = r["bytes"] / 1e9
    if m:
        for repo, r in m["models"].items():
            k = repo.split("-")[1]
            row[f"music_{k}_b1"] = r["batch1"]["s_per_10s_audio"]
            row[f"music_{k}_b4"] = r["batch4"]["s_per_10s_audio"]
    if vid:
        row["video_chunk_s"] = vid["B1_chunk_49f_704x480_30steps_s"]
        row["video_offload"] = vid["B3"]["cpu_offload"]
    if l:
        row["llm_hf_gen_s"] = st.median(a["gen_s"] for a in l["answers"])
        row["llm_hf_audit_s"] = st.median(a["audit_s"] for a in l["answers"])
    b1[g] = row
summary["B1_B3"] = b1

# ---------------- B4 cross-GPU diffusion ----------------
b4 = {"same_gpu": {}, "final_image": [], "audit": []}
for g in GPUS:
    d = load(g, "diffusion.json")
    if d:
        b4["same_gpu"][g] = d["B4_same_gpu_rerun"]
for a, b in itertools.combinations(GPUS, 2):
    for i in range(4):
        pa, pb = RES / a / "traces" / f"img{i}.png", RES / b / "traces" / f"img{i}.png"
        if pa.exists() and pb.exists():
            x, y = np.asarray(Image.open(pa).convert("RGB")), np.asarray(Image.open(pb).convert("RGB"))
            b4["final_image"].append({"pair": f"{a}-{b}", "img": i, "identical": bool((x == y).all()),
                                      "ssim": float(structural_similarity(x, y, channel_axis=2, data_range=255)),
                                      "mean_abs_px": float(np.abs(x.astype(int) - y.astype(int)).mean())})
for g in GPUS:
    for f in sorted((RES / g).glob("audit_diff_from_*.json")):
        src = f.stem.replace("audit_diff_from_", "")
        rows = json.loads(f.read_text())["rows"]
        b4["audit"].append({"verifier": g, "worker": src,
                            "step_rel_err_max": max(r["cross_gpu_step_rel_err"] for r in rows),
                            "step_rel_err_median": st.median(r["cross_gpu_step_rel_err"] for r in rows),
                            "trajectory_rel_diff_final": st.median(r["trajectory_rel_diff"] for r in rows if r["k"] == 29)
                            if "trajectory_rel_diff" in rows[0] else None})
summary["B4"] = b4

# ---------------- B5 cross-GPU seeded LLM sampling ----------------
b5 = []
for g in GPUS:
    l = load(g, "llm.json")
    if l:
        ag = [x for a in l["answers"] for x in a["self_agree"]]
        mm = [m for a in l["answers"] for x, m in zip(a["self_agree"], a["gen_margins"]) if not x]
        b5.append({"verifier": g, "worker": g, "positions": len(ag), "mismatch_rate": 1 - sum(ag) / len(ag),
                   "max_gen_margin_at_mismatch": max(mm) if mm else None})
    for f in sorted((RES / g).glob("audit_llm_from_*.json")):
        j = json.loads(f.read_text())
        ag = [x for r in j["rows"] for x in r["agree"]]
        # Only the first mismatch of an answer is a clean comparison: after it, the verifier is
        # conditioning on tokens it would not itself have produced, which is fine for an audit.
        mm = [m for r in j["rows"] for x, m in zip(r["agree"], r["gen_margins"]) if not x]
        allm = [m for r in j["rows"] for m in r["gen_margins"]]
        b5.append({"verifier": g, "worker": f.stem.replace("audit_llm_from_", ""), "positions": len(ag),
                   "mismatch_rate": 1 - sum(ag) / len(ag),
                   "max_gen_margin_at_mismatch": max(mm) if mm else None,
                   "frac_positions_margin_below_0.5": sum(m < 0.5 for m in allm) / len(allm),
                   "frac_positions_margin_below_0.1": sum(m < 0.1 for m in allm) / len(allm)})
summary["B5"] = b5

# ---------------- B7 audit cost ----------------
b7 = {}
for g in GPUS:
    d, l, v = load(g, "diffusion.json"), load(g, "llm.json"), load(g, "vllm.json")
    r = {}
    if d:
        r["diffusion_audit_s"] = d["B7_diffusion_audit"]["s_per_audit_step"]
        r["diffusion_audit_fraction"] = d["B7_diffusion_audit"]["fraction_of_generation"]
    if l:
        r["llm_audit_s"] = st.median(a["audit_s"] for a in l["answers"])
        r["llm_audit_vs_hf_gen"] = r["llm_audit_s"] / st.median(a["gen_s"] for a in l["answers"])
    if l and v and "Qwen/Qwen2.5-7B-Instruct-AWQ" in v["models"]:
        # time vLLM needs to decode 256 tokens at batch 1 (AWQ 4-bit; the fp16 audit is conservative)
        t256 = 256 / v["models"]["Qwen/Qwen2.5-7B-Instruct-AWQ"]["batch1"]["tok_per_s"]
        r["llm_audit_vs_vllm_gen"] = r["llm_audit_s"] / t256
    b7[g] = r
summary["B7"] = b7

(HERE / "summary.json").write_text(json.dumps(summary, indent=1))
print(json.dumps(summary, indent=1))

# ---------------- LaTeX ----------------
cols = GPUS
head = " & ".join(r"\textbf{" + NAME[g] + "}" for g in cols)


def line(label, key, d=2, scale=1.0):
    vals = [fnum(b1[g].get(key) * scale if b1[g].get(key) is not None else None, d) for g in cols]
    return f"{label} & " + " & ".join(vals) + r" \\"


rows = [
    line("SDXL $1024^2$, 30 steps: s/image (batch 1)", "sdxl_s_img_b1"),
    line("SDXL: s/image (batch 4)", "sdxl_s_img_b4"),
    line("SDXL: s/denoising step", "sdxl_s_step", 3),
    line("LLM 7B AWQ: tokens/s, batch 1", "llm7b_tok_b1", 0),
    line("LLM 7B AWQ: tokens/s, batch 32", "llm7b_tok_b32", 0),
    line("LLM 14B AWQ: tokens/s, batch 1", "llm14b_tok_b1", 0),
    line("LLM 14B AWQ: tokens/s, batch 32", "llm14b_tok_b32", 0),
    line("LLM 32B AWQ: tokens/s, batch 1", "llm32b_tok_b1", 0),
    line("LLM 32B AWQ: tokens/s, batch 32", "llm32b_tok_b32", 0),
    line("MusicGen small: s per 10 s audio (batch 1)", "music_small_b1"),
    line("MusicGen medium: s per 10 s audio (batch 1)", "music_medium_b1"),
    line("MusicGen medium: s per 10 s audio (batch 4)", "music_medium_b4"),
    line("LTX-Video: s per 49-frame $704{\\times}480$ chunk", "video_chunk_s", 1),
    line("Load SDXL to GPU (s)", "sdxl_load_s"),
]
(GEN / "bench_throughput.tex").write_text("\n".join(
    [r"\begin{tabular}{@{}l" + "r" * len(cols) + "@{}}", r"\toprule", r"\textbf{Measurement} & " + head + r" \\",
     r"\midrule", *rows, r"\bottomrule", r"\end{tabular}", ""]))

vrows = []
for g in cols:
    if g in b7:
        r = b7[g]
        vrows.append(f"{NAME[g]} & {fnum(r.get('diffusion_audit_s'), 3)} & {fnum(100 * r['diffusion_audit_fraction'] if 'diffusion_audit_fraction' in r else None, 1)}\\% & "
                     f"{fnum(r.get('llm_audit_s'), 3)} & {fnum(100 * r['llm_audit_vs_vllm_gen'] if 'llm_audit_vs_vllm_gen' in r else None, 1)}\\% \\\\")
(GEN / "bench_audit.tex").write_text("\n".join(
    [r"\begin{tabular}{@{}lrrrr@{}}", r"\toprule",
     r"\textbf{GPU} & \textbf{Diffusion audit (s)} & \textbf{of one image} & \textbf{LLM audit (s)} & \textbf{of decoding the answer} \\",
     r"\midrule", *vrows, r"\bottomrule", r"\end{tabular}", ""]))

crows = []
for e in b5:
    crows.append(f"{NAME[e['worker']]} & {NAME[e['verifier']]} & {e['positions']} & {100 * e['mismatch_rate']:.2f}\\% & "
                 f"{fnum(e['max_gen_margin_at_mismatch'], 3)} \\\\")
(GEN / "bench_llm_agree.tex").write_text("\n".join(
    [r"\begin{tabular}{@{}llrrr@{}}", r"\toprule",
     r"\textbf{Generated on} & \textbf{Audited on} & \textbf{Tokens} & \textbf{Disagree} & \textbf{Largest margin at a disagreement} \\",
     r"\midrule", *crows, r"\bottomrule", r"\end{tabular}", ""]))

drows = []
pairs = sorted({e["pair"] for e in b4["final_image"]})
for pr in pairs:
    es = [e for e in b4["final_image"] if e["pair"] == pr]
    a, b = pr.split("-")
    au = [x for x in b4["audit"] if {x["verifier"], x["worker"]} == {a, b}]
    drows.append(f"{NAME[a]} vs {NAME[b]} & {sum(e['identical'] for e in es)}/{len(es)} & "
                 f"{min(e['ssim'] for e in es):.4f} & {max(e['mean_abs_px'] for e in es):.2f} & "
                 f"{fnum(max(x['step_rel_err_max'] for x in au) if au else None, 5)} \\\\")
(GEN / "bench_diffusion_cross.tex").write_text("\n".join(
    [r"\begin{tabular}{@{}lrrrr@{}}", r"\toprule",
     r"\textbf{GPU pair} & \textbf{Bit-identical} & \textbf{Min SSIM} & \textbf{Max mean $|\Delta|$ (0--255)} & \textbf{Max one-step audit error} \\",
     r"\midrule", *drows, r"\bottomrule", r"\end{tabular}", ""]))
print("wrote LaTeX tables to", GEN)
