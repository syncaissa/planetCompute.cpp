"""Harness speed on this computer: time to the first token and generation speed (tokens per second), streamed,
with the GPU's peak use when nvidia-smi exists. Run it where planetCompute runs (or through ssh -L 7526:...).
   python3 scripts/bench_harness.py <model id> [label]     (the model must be downloaded; see docs/TESTING.md test 11)"""
import json, subprocess, sys, threading, time, urllib.request

B = "http://localhost:7526/v1/chat/completions"
model, label = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "")
PROMPT = "Explain in detail how a lighthouse works, its history, and how lighthouse keepers lived. Write at least 600 words."


def gpu():
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=5).stdout.strip()
        u, m = out.split(",")
        return int(u), int(m)
    except Exception:
        return None


def run(max_tokens):
    body = json.dumps({"model": model, "messages": [{"role": "user", "content": PROMPT}], "max_tokens": max_tokens,
                       "temperature": 0.7, "seed": 1, "stream": True}).encode()
    rq = urllib.request.Request(B, data=body, headers={"content-type": "application/json"})
    t0 = time.time(); first = None; n = 0; peak = [0, 0]; stop = False

    def watch():
        while not stop:
            g = gpu()
            if g:
                peak[0], peak[1] = max(peak[0], g[0]), max(peak[1], g[1])
            time.sleep(0.5)
    th = threading.Thread(target=watch, daemon=True); th.start()
    buf = b""
    with urllib.request.urlopen(rq, timeout=900) as r:
        while True:
            piece = r.read1(4096)
            if not piece:
                break
            buf += piece
            while b"\n\n" in buf:
                ev, buf = buf.split(b"\n\n", 1)
                line = ev.decode().replace("data: ", "", 1)
                if line == "[DONE]":
                    continue
                d = json.loads(line)
                if d["choices"][0]["delta"].get("content"):
                    n += 1
                    if first is None:
                        first = time.time() - t0
    total = time.time() - t0
    stop = True
    gen = (n - 1) / (total - first) if n > 1 else 0
    return first, n, total, gen, peak


run(8)                                            # warm-up: loads the model
first, n, total, gen, peak = run(512)
print(f"{label:8s} {model:24s} first token {first:5.2f}s | {n} tokens in {total:5.1f}s | generation {gen:6.1f} tokens/s"
      + (f" | GPU peak {peak[0]}% , {peak[1]} MiB" if peak[1] else ""))
