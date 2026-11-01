#!/usr/bin/env python3
"""How alike are the same requests made on two machines? (paper: table "The same request on two machines")

Compares the pictures made by the program on Linux + RTX 4090 (docs/results/linux-rtx4090-media-20261022/) with the
same requests on Windows + Tesla T4 (docs/results/windows-t4-gpu-20261022/): same model, prompt, size, steps and seed.

    python3 scripts/compare_pictures.py            (needs numpy and Pillow: pip install numpy pillow)

Per pair: share of pixels exactly equal (all three colour values), mean absolute difference of the colour values
(0-255), share of pixels whose three values are all within 8 levels,
and SSIM on grey levels with a 7x7 uniform window (the scikit-image default: sample covariance, K1 0.01, K2 0.03,
data range 255, mean over the area the window fits; grey = Pillow's "L"). For contrast, the SSIM of different
pictures from the same model, one from each machine, wherever the sizes match.
Writes docs/results/compare_pictures.txt.
"""
import os
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
LIN = os.path.join(ROOT, "docs", "results", "linux-rtx4090-media-20261022")
WIN = os.path.join(ROOT, "docs", "results", "windows-t4-gpu-20261022")
PAIRS = [  # label, Linux file, Windows file
    ("FLUX.1 schnell, cat (13)", "flux-cat.png", "win-gpu-flux-cat.png"),
    ("FLUX.1 schnell, sign (14)", "flux-sign.png", "win-gpu-flux-sign.png"),
    ("Stable Diffusion 1.5, lighthouse (1001)", "sd15-lighthouse.png", "win-gpu-sd15-lighthouse.png"),
    ("Stable Diffusion 1.5, apple (1002)", "sd15-apple.png", "win-gpu-sd15-apple.png"),
]


def rgb(p):
    return np.asarray(Image.open(p).convert("RGB"), dtype=np.float64)


def grey(p):
    return np.asarray(Image.open(p).convert("L"), dtype=np.float64)


def box(x, w=7):
    """Mean over every w x w window that fits (valid area), via a summed-area table."""
    c = np.pad(x, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    return (c[w:, w:] - c[:-w, w:] - c[w:, :-w] + c[:-w, :-w]) / (w * w)


def ssim(a, b, w=7, L=255.0):
    n = w * w
    ma, mb = box(a, w), box(b, w)
    va = (box(a * a, w) - ma * ma) * n / (n - 1)
    vb = (box(b * b, w) - mb * mb) * n / (n - 1)
    cov = (box(a * b, w) - ma * mb) * n / (n - 1)
    c1, c2 = (0.01 * L) ** 2, (0.03 * L) ** 2
    s = ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2))
    return float(s.mean())


def main():
    out = ["Same request, two machines (Linux + RTX 4090 vs Windows + Tesla T4); made by scripts/compare_pictures.py", "",
           f"{'Picture (model, seed)':42s} {'Pixels equal':>12s} {'Mean diff':>10s} {'Within 8':>9s} {'SSIM':>7s}"]
    for label, l, w in PAIRS:
        a, b = rgb(os.path.join(LIN, l)), rgb(os.path.join(WIN, w))
        if a.shape != b.shape:
            out.append(f"{label:42s} sizes differ: {a.shape} vs {b.shape}")
            continue
        d = np.abs(a - b)
        px = d.max(axis=2)   # a pixel's largest difference over its three colour values
        s = ssim(grey(os.path.join(LIN, l)), grey(os.path.join(WIN, w)))
        out.append(f"{label:42s} {100 * (px == 0).mean():11.1f}% {d.mean():10.2f} {100 * (px <= 8).mean():8.1f}% {s:7.3f}")
    out += ["", "Different pictures, same model, one from each machine (contrast):"]
    vals = []
    for l in sorted(f for f in os.listdir(LIN) if f.endswith(".png")):
        for w in sorted(f for f in os.listdir(WIN) if f.startswith("win-gpu-") and f.endswith(".png")):
            model, subject = l.split("-", 1)[0], l.split("-", 1)[1]
            if w.split("-")[2] != model or w.split("-", 3)[3] == subject:
                continue
            a, b = grey(os.path.join(LIN, l)), grey(os.path.join(WIN, w))
            if a.shape == b.shape:
                vals.append(ssim(a, b))
                out.append(f"  {l:22s} vs {w:28s} SSIM {vals[-1]:.3f}")
    out.append(f"  range {min(vals):.2f}-{max(vals):.2f}")
    text = "\n".join(out) + "\n"
    print(text, end="")
    with open(os.path.join(ROOT, "docs", "results", "compare_pictures.txt"), "w") as f:
        f.write(text)


if __name__ == "__main__":
    main()
