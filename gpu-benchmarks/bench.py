#!/usr/bin/env python3
"""PlanetCompute GPU benchmarks (design document Section 9, B1 B3 B4 B5 B7).

Run on a GPU pod:  python bench.py <phase> --out /workspace/out/<tag>
Phases
  diffusion   SDXL 1024^2: download/load time (B3), time per image and per step at batch 1
              and 4 (B1), seeded traces of every latent + final image (B4), and the cost of
              auditing one step against the trace (B7).
  llm         Qwen2.5-7B-Instruct fp16: seeded Gumbel sampling of 16 prompts x 256 tokens with
              per-token margins (B5), and a teacher-forced audit of the same answers in one
              prefill pass, timed against generation (B7).
  audit_llm   teacher-forced audit of ANOTHER GPU's answers (cross-GPU B5).  --src <dir>
  audit_diff  recompute random steps of ANOTHER GPU's diffusion traces (cross-GPU B4).  --src <dir>
  vllm        decode throughput of 7B/14B AWQ models at batch 1 and 32 (B1). Run in the vllm venv.
  music       MusicGen small/medium: time per 10 s of audio (B1).
  video       LTX-Video: time per 49-frame 704x480 chunk (B1).
Every phase writes JSON (and .npy/.png traces) into --out; nothing is uploaded anywhere.
"""
import argparse
import hashlib
import json
import os
import pathlib
import random
import time

import torch

DEV = "cuda"
DIFF_PROMPTS = [
    "a lighthouse on a rocky coast at sunset, oil painting",
    "a red fox in fresh snow, telephoto photograph",
    "a futuristic city with gardens on every roof, aerial view",
    "a bowl of ramen on a wooden table, studio lighting",
]
LLM_PROMPTS = [
    "Explain how a refrigerator works to a ten-year-old.",
    "Write a short poem about the ocean at night.",
    "Summarise the causes of the First World War in five bullet points.",
    "Write a Python function that checks whether a string is a palindrome.",
    "What are the pros and cons of electric cars?",
    "Describe the water cycle.",
    "Give me a recipe for a simple tomato soup.",
    "Explain the difference between TCP and UDP.",
    "Write a haiku about autumn leaves.",
    "How does compound interest work? Give an example.",
    "Translate into French: The library opens at nine and closes at five.",
    "List five tips for better sleep.",
    "Explain what a hash function is and why it is useful.",
    "Write a SQL query that finds the top three customers by total order value.",
    "What is photosynthesis?",
    "Tell a short story about a robot who learns to paint.",
]


def save(out, name, obj):
    out.mkdir(parents=True, exist_ok=True)
    (out / name).write_text(json.dumps(obj, indent=1))
    print("wrote", out / name, flush=True)


def sync():
    torch.cuda.synchronize()


def gpu_info():
    p = torch.cuda.get_device_properties(0)
    return {"gpu": p.name, "mem_gb": round(p.total_memory / 2**30, 1), "torch": torch.__version__,
            "cuda": torch.version.cuda, "capability": f"{p.major}.{p.minor}"}


def dir_bytes(path):
    return sum(f.stat().st_size for f in pathlib.Path(path).rglob("*") if f.is_file())


def timed_download(repo, **kw):
    from huggingface_hub import snapshot_download
    t0 = time.time()
    path = snapshot_download(repo, **kw)
    return path, time.time() - t0, dir_bytes(path)


# ---------------------------------------------------------------------------
# Diffusion (SDXL) with an explicit Euler loop so generation and audit share the same code.

class SDXL:
    def __init__(self, path):
        from diffusers import EulerDiscreteScheduler, StableDiffusionXLPipeline
        t0 = time.time()
        self.pipe = StableDiffusionXLPipeline.from_pretrained(path, torch_dtype=torch.float16, variant="fp16",
                                                              use_safetensors=True).to(DEV)
        self.pipe.vae.to(torch.float32)          # SDXL VAE overflows in fp16
        sync()
        self.load_s = time.time() - t0
        self.sched = EulerDiscreteScheduler.from_config(self.pipe.scheduler.config)

    def cond(self, prompts):
        p = self.pipe
        pe, npe, pooled, npooled = p.encode_prompt(prompts, device=DEV, num_images_per_prompt=1,
                                                   do_classifier_free_guidance=True, negative_prompt=[""] * len(prompts))
        tid = p._get_add_time_ids((1024, 1024), (0, 0), (1024, 1024), dtype=pe.dtype,
                                  text_encoder_projection_dim=p.text_encoder_2.config.projection_dim).to(DEV)
        tid = tid.repeat(2 * len(prompts), 1)
        return torch.cat([npe, pe]), {"text_embeds": torch.cat([npooled, pooled]), "time_ids": tid}

    def setup(self, steps):
        self.sched.set_timesteps(steps, device=DEV)
        self.sigmas = self.sched.sigmas.to(DEV, torch.float32)
        self.timesteps = self.sched.timesteps

    def step(self, x, k, emb, added, cfg=5.0):
        """One Euler step k: x_k (float32) -> x_{k+1}. Deterministic, stateless."""
        s, s_next = self.sigmas[k], self.sigmas[k + 1]
        xin = torch.cat([x, x]) / torch.sqrt(s * s + 1)
        eps = self.pipe.unet(xin.half(), self.timesteps[k], encoder_hidden_states=emb,
                             added_cond_kwargs=added, return_dict=False)[0].float()
        e_u, e_c = eps.chunk(2)
        eps = e_u + cfg * (e_c - e_u)
        return x + (s_next - s) * eps

    def init_latents(self, seeds):
        xs = [torch.randn((1, 4, 128, 128), generator=torch.Generator("cpu").manual_seed(s), dtype=torch.float32)
              for s in seeds]
        return torch.cat(xs).to(DEV) * self.sigmas[0]

    @torch.no_grad()
    def generate(self, prompts, seeds, steps=30, trace=False):
        self.setup(steps)
        emb, added = self.cond(prompts)
        x = self.init_latents(seeds)
        lat = [x.cpu()] if trace else None
        for k in range(steps):
            x = self.step(x, k, emb, added)
            if trace:
                lat.append(x.cpu())
        img = self.pipe.vae.decode(x / self.pipe.vae.config.scaling_factor, return_dict=False)[0]
        return img, lat

    @torch.no_grad()
    def audit(self, prompt, x_k, k, steps=30):
        self.setup(steps)
        emb, added = self.cond([prompt])
        return self.step(x_k.to(DEV), k, emb, added).cpu()


def to_png(img, path):
    import numpy as np
    from PIL import Image
    a = ((img.clamp(-1, 1) + 1) * 127.5).round().byte().permute(1, 2, 0).cpu().numpy()
    Image.fromarray(a).save(path)
    return hashlib.sha256(a.tobytes()).hexdigest()


def phase_diffusion(out):
    import numpy as np
    res = {"info": gpu_info()}
    path, dl_s, nbytes = timed_download("stabilityai/stable-diffusion-xl-base-1.0",
                                        allow_patterns=["*.json", "*.txt", "*fp16.safetensors", "tokenizer*/*"])
    m = SDXL(path)
    res["B3"] = {"download_s": dl_s, "bytes": nbytes, "load_to_gpu_s": m.load_s}
    m.generate(DIFF_PROMPTS[:1], [99], steps=4)                          # warm-up
    for bs in (1, 4):
        times = []
        for r in range(3 if bs == 1 else 2):
            sync(); t0 = time.time()
            m.generate(DIFF_PROMPTS[:bs], list(range(100 + r * bs, 100 + (r + 1) * bs)), steps=30)
            sync(); times.append(time.time() - t0)
        res[f"B1_batch{bs}"] = {"s_per_batch": times, "s_per_image": min(times) / bs,
                                "s_per_step": min(times) / 30}
    # B4 traces: 4 prompts x seed 0..3, all latents saved; seed 0 run twice for same-GPU determinism
    tr = out / "traces"; tr.mkdir(parents=True, exist_ok=True)
    hashes = {}
    for i, (prompt, seed) in enumerate(zip(DIFF_PROMPTS, range(4))):
        img, lat = m.generate([prompt], [seed], steps=30, trace=True)
        np.save(tr / f"lat{i}.npy", torch.cat(lat).numpy())
        hashes[i] = to_png(img[0], tr / f"img{i}.png")
    img, lat2 = m.generate([DIFF_PROMPTS[0]], [0], steps=30, trace=True)
    lat0 = np.load(tr / "lat0.npy")
    res["B4_same_gpu_rerun"] = {"png_sha_equal": to_png(img[0], tr / "img0_rerun.png") == hashes[0],
                                "max_abs_latent_diff": float(np.abs(torch.cat(lat2).numpy() - lat0).max())}
    # B7 audit cost: recompute 5 random steps of trace 0 on this GPU
    rng = random.Random(7)
    errs, ts = [], []
    for k in rng.sample(range(30), 5):
        sync(); t0 = time.time()
        y = m.audit(DIFF_PROMPTS[0], torch.from_numpy(lat0[k:k + 1]), k)
        sync(); ts.append(time.time() - t0)
        ref = torch.from_numpy(lat0[k + 1:k + 2])
        errs.append(float((y - ref).norm() / ref.norm()))
    res["B7_diffusion_audit"] = {"s_per_audit_step": sum(ts) / len(ts), "same_gpu_rel_err": errs,
                                 "fraction_of_generation": (sum(ts) / len(ts)) / res["B1_batch1"]["s_per_image"]}
    save(out, "diffusion.json", res)


def phase_audit_diff(out, src):
    import numpy as np
    m = SDXL(timed_download("stabilityai/stable-diffusion-xl-base-1.0",
                            allow_patterns=["*.json", "*.txt", "*fp16.safetensors", "tokenizer*/*"])[0])
    rows = []
    for i, prompt in enumerate(DIFF_PROMPTS):
        lat = np.load(pathlib.Path(src) / "traces" / f"lat{i}.npy")
        mine = np.load(out / "traces" / f"lat{i}.npy") if (out / "traces" / f"lat{i}.npy").exists() else None
        for k in (0, 5, 10, 15, 20, 25, 29):
            y = m.audit(prompt, torch.from_numpy(lat[k:k + 1]), k)
            ref = torch.from_numpy(lat[k + 1:k + 2])
            row = {"trace": i, "k": k, "cross_gpu_step_rel_err": float((y - ref).norm() / ref.norm())}
            if mine is not None:   # how far the two GPUs' whole trajectories have drifted by step k+1
                row["trajectory_rel_diff"] = float(np.linalg.norm(mine[k + 1] - lat[k + 1]) / np.linalg.norm(lat[k + 1]))
            rows.append(row)
    save(out, f"audit_diff_from_{pathlib.Path(src).name}.json", {"info": gpu_info(), "rows": rows})


# ---------------------------------------------------------------------------
# LLM: seeded Gumbel sampling and teacher-forced audit (HF transformers, fp16)

LLM_REPO = "Qwen/Qwen2.5-7B-Instruct"
TEMP = 0.8


def gumbel(seed, pos, vocab):
    g = torch.Generator("cpu").manual_seed(seed * 1_000_003 + pos)
    u = torch.rand(vocab, generator=g, dtype=torch.float64).clamp_(1e-12, 1 - 1e-12)
    return (-torch.log(-torch.log(u))).float()


def load_llm():
    from transformers import AutoModelForCausalLM, AutoTokenizer
    path, dl_s, nbytes = timed_download(LLM_REPO, allow_patterns=["*.json", "*.safetensors", "*.txt", "tokenizer*"])
    t0 = time.time()
    tok = AutoTokenizer.from_pretrained(path)
    model = AutoModelForCausalLM.from_pretrained(path, torch_dtype=torch.float16, attn_implementation="sdpa").to(DEV).eval()
    sync()
    return tok, model, {"download_s": dl_s, "bytes": nbytes, "load_to_gpu_s": time.time() - t0}


def prompt_ids(tok, text):
    msgs = [{"role": "user", "content": text}]
    return tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt").to(DEV)


@torch.no_grad()
def seeded_generate(model, ids, seed, n_new):
    vocab = model.config.vocab_size
    out = model(ids, use_cache=True)
    past, logits = out.past_key_values, out.logits[0, -1].float()
    toks, margins = [], []
    for i in range(n_new):
        z = logits.cpu() / TEMP + gumbel(seed, i, logits.shape[-1])
        top2 = torch.topk(z, 2)
        t = int(top2.indices[0])
        toks.append(t); margins.append(float(top2.values[0] - top2.values[1]))
        out = model(torch.tensor([[t]], device=DEV), past_key_values=past, use_cache=True)
        past, logits = out.past_key_values, out.logits[0, -1].float()
    return toks, margins


@torch.no_grad()
def teacher_forced(model, ids, toks, seed):
    """One parallel pass over prompt + answer; recompute every seeded choice."""
    full = torch.cat([ids, torch.tensor([toks], device=DEV)], dim=1)
    sync(); t0 = time.time()
    logits = model(full).logits[0, ids.shape[1] - 1:-1].float().cpu()
    sync(); dt = time.time() - t0
    agree, margins = [], []
    for i, t in enumerate(toks):
        z = logits[i] / TEMP + gumbel(seed, i, logits.shape[-1])
        top2 = torch.topk(z, 2)
        agree.append(int(top2.indices[0]) == t)
        margins.append(float(z[t] - z[int(top2.indices[0])]) if int(top2.indices[0]) != t
                       else float(top2.values[0] - top2.values[1]))
    return agree, margins, dt


def phase_llm(out, n_new=256):
    tok, model, b3 = load_llm()
    res = {"info": gpu_info(), "B3": b3, "temperature": TEMP, "answers": []}
    seeded_generate(model, prompt_ids(tok, "Hello"), 1, 8)               # warm-up
    for j, p in enumerate(LLM_PROMPTS):
        ids = prompt_ids(tok, p)
        sync(); t0 = time.time()
        toks, margins = seeded_generate(model, ids, 1000 + j, n_new)
        sync(); gen_s = time.time() - t0
        agree, amarg, audit_s = teacher_forced(model, ids, toks, 1000 + j)
        res["answers"].append({"prompt": p, "seed": 1000 + j, "tokens": toks, "gen_margins": margins,
                               "gen_s": gen_s, "audit_s": audit_s, "self_agree": agree, "self_margins": amarg,
                               "text_head": tok.decode(toks[:40])})
        print(j, f"gen {gen_s:.1f}s audit {audit_s * 1000:.0f}ms self-agree {sum(agree)}/{len(agree)}", flush=True)
    save(out, "llm.json", res)


def phase_audit_llm(out, src):
    tok, model, _ = load_llm()
    srcj = json.loads((pathlib.Path(src) / "llm.json").read_text())
    rows = []
    for a in srcj["answers"]:
        agree, margins, dt = teacher_forced(model, prompt_ids(tok, a["prompt"]), a["tokens"], a["seed"])
        rows.append({"seed": a["seed"], "agree": agree, "margins": margins, "gen_margins": a["gen_margins"],
                     "audit_s": dt})
    save(out, f"audit_llm_from_{pathlib.Path(src).name}.json",
         {"info": gpu_info(), "src_gpu": srcj["info"]["gpu"], "rows": rows})


# ---------------------------------------------------------------------------
# Throughput phases

def phase_vllm(out):
    from vllm import LLM, SamplingParams
    import gc
    res = {"info": gpu_info(), "models": {}}
    mem = torch.cuda.get_device_properties(0).total_memory / 2**30
    models = ["Qwen/Qwen2.5-7B-Instruct-AWQ", "Qwen/Qwen2.5-14B-Instruct-AWQ"]
    if mem > 30:
        models.append("Qwen/Qwen2.5-32B-Instruct-AWQ")
    for repo in models:
        path, dl_s, nbytes = timed_download(repo)
        t0 = time.time()
        llm = LLM(path, max_model_len=4096, gpu_memory_utilization=0.90, enforce_eager=False)
        load_s = time.time() - t0
        sp = SamplingParams(max_tokens=512, ignore_eos=True, temperature=0.8, seed=1)
        llm.generate(["Hello"], SamplingParams(max_tokens=16))
        r = {"download_s": dl_s, "bytes": nbytes, "load_s": load_s}
        for bs in (1, 32):
            prompts = [LLM_PROMPTS[i % len(LLM_PROMPTS)] for i in range(bs)]
            t0 = time.time()
            outs = llm.generate(prompts, sp)
            dt = time.time() - t0
            n = sum(len(o.outputs[0].token_ids) for o in outs)
            r[f"batch{bs}"] = {"s": dt, "tokens": n, "tok_per_s": n / dt}
        res["models"][repo] = r
        print(repo, r, flush=True)
        del llm; gc.collect(); torch.cuda.empty_cache()
        save(out, "vllm.json", res)


def phase_music(out):
    from transformers import AutoProcessor, MusicgenForConditionalGeneration
    res = {"info": gpu_info(), "models": {}}
    for repo in ("facebook/musicgen-small", "facebook/musicgen-medium"):
        path, dl_s, nbytes = timed_download(repo, allow_patterns=["*.json", "*.safetensors", "*.bin", "*.txt", "*.model"])
        proc = AutoProcessor.from_pretrained(path)
        model = MusicgenForConditionalGeneration.from_pretrained(path, torch_dtype=torch.float16).to(DEV)
        inp = proc(text=["upbeat acoustic folk with guitar and whistling"] * 4, padding=True, return_tensors="pt").to(DEV)
        model.generate(**{k: v[:1] for k, v in inp.items()}, max_new_tokens=50)
        r = {"download_s": dl_s, "bytes": nbytes}
        for bs in (1, 4):
            sync(); t0 = time.time()
            model.generate(**{k: v[:bs] for k, v in inp.items()}, max_new_tokens=500, do_sample=True)   # 10 s at 50 Hz
            sync(); dt = time.time() - t0
            r[f"batch{bs}"] = {"s": dt, "s_per_10s_audio": dt / bs}
        res["models"][repo] = r
        print(repo, r, flush=True)
        save(out, "music.json", res)
        del model; torch.cuda.empty_cache()


def phase_video(out):
    from diffusers import LTXPipeline
    res = {"info": gpu_info()}
    path, dl_s, nbytes = timed_download("Lightricks/LTX-Video", allow_patterns=[
        "model_index.json", "scheduler/*", "text_encoder/*", "tokenizer/*", "transformer/*", "vae/*"])
    t0 = time.time()
    pipe = LTXPipeline.from_pretrained(path, torch_dtype=torch.bfloat16)
    mem = torch.cuda.get_device_properties(0).total_memory / 2**30
    if mem < 40:
        pipe.enable_model_cpu_offload()
    else:
        pipe.to(DEV)
    res["B3"] = {"download_s": dl_s, "bytes": nbytes, "load_s": time.time() - t0, "cpu_offload": mem < 40}
    prompt = "a red fox walking through fresh snow in a pine forest, cinematic"
    pipe(prompt=prompt, width=704, height=480, num_frames=9, num_inference_steps=4)
    sync(); t0 = time.time()
    pipe(prompt=prompt, width=704, height=480, num_frames=49, num_inference_steps=30,
         generator=torch.Generator("cpu").manual_seed(0))
    sync()
    res["B1_chunk_49f_704x480_30steps_s"] = time.time() - t0
    save(out, "video.json", res)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("phase")
    ap.add_argument("--out", required=True)
    ap.add_argument("--src")
    a = ap.parse_args()
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    {"diffusion": lambda: phase_diffusion(out), "llm": lambda: phase_llm(out),
     "audit_llm": lambda: phase_audit_llm(out, a.src), "audit_diff": lambda: phase_audit_diff(out, a.src),
     "vllm": lambda: phase_vllm(out), "music": lambda: phase_music(out),
     "video": lambda: phase_video(out)}[a.phase]()


if __name__ == "__main__":
    main()
