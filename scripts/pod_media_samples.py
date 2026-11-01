"""Sample pictures and video clips made by the planetCompute program itself on a rented GPU (RunPod), shown at
https://planetcompute.ai/temp/ . Also the first test of Harness images/video on a real GPU (docs/TESTING.md).
   python3 -I scripts/pod_media_samples.py <client CI run id>       (from planetCompute-CPP/, on Cloud9)
Steps: download that run's linux-x86_64-vulkan program (GitHub artifact) -> create ONE GPU pod (24 GB first, else
16 GB) -> copy the program -> run it with --headless -> download SD 1.5, FLUX.1 schnell, Wan 2.1 from the library
(publishers; no sign-in) -> make the pictures and clips through /local/image -> copy them back -> upload to B2 TEMP/
(scripts/b2_temp.py) -> DELETE the pod (also on any error). Keys come from ../.env and are never sent to the pod.
The pod ID is printed and written to ../.ops/media_pod.txt while it exists."""
import base64, io, json, os, subprocess, sys, time, urllib.request, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(ROOT, "planetCompute-CPP", ".ops", "media_samples")
env = {}
for l in open(os.path.join(ROOT, ".env")):
    l = l.strip()
    if "=" in l and not l.startswith("#"):
        k, v = l.split("=", 1); env[k.strip()] = v.strip().strip('"').strip("'")
UA = {"User-Agent": "planetcompute-ops/1"}
KEY = os.path.expanduser("~/.ssh/planetcompute_pod")
SSH = ["-i", KEY, "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=30", "-o", "LogLevel=ERROR"]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def rp(method, path, body=None):
    r = urllib.request.Request("https://rest.runpod.io/v1" + path, method=method, data=json.dumps(body).encode() if body else None,
                               headers={"Authorization": "Bearer " + env["RUNPOD_API_KEY"], "content-type": "application/json", **UA})
    with urllib.request.urlopen(r, timeout=60) as x:
        t = x.read()
        return json.loads(t) if t else {}


def gql(q):
    r = urllib.request.Request("https://api.runpod.io/graphql", data=json.dumps({"query": q}).encode(),
                               headers={"Authorization": "Bearer " + env["RUNPOD_API_KEY"], "content-type": "application/json", **UA})
    return json.load(urllib.request.urlopen(r, timeout=60))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def gh(path, raw=False):
    r = urllib.request.Request("https://api.github.com/repos/syncaissa/planetCompute.cpp" + path,
                               headers={"Authorization": "Bearer " + env["GITHUB_TOKEN"], "Accept": "application/vnd.github+json", **UA})
    if not raw:
        return json.load(urllib.request.urlopen(r, timeout=300))
    # an artifact download answers 302 to a signed storage address, which must be fetched WITHOUT the GitHub token
    try:
        urllib.request.build_opener(_NoRedirect).open(r, timeout=60)
        raise RuntimeError("expected a redirect")
    except urllib.error.HTTPError as e:
        if e.code not in (301, 302, 303, 307):
            raise
        return urllib.request.urlopen(urllib.request.Request(e.headers["Location"], headers=UA), timeout=600).read()


def program(run):
    p = os.path.join(OUT, "planetCompute-vulkan")
    if os.path.exists(p):
        return p
    art = [a for a in gh(f"/actions/runs/{run}/artifacts")["artifacts"] if a["name"] == "linux-x86_64-vulkan"][0]
    z = zipfile.ZipFile(io.BytesIO(gh(f"/actions/artifacts/{art['id']}/zip", raw=True)))
    name = [n for n in z.namelist() if "linux-x86_64-vulkan" in n and not n.endswith(".lock")][0]
    open(p, "wb").write(z.read(name)); os.chmod(p, 0o755)
    log("program", name, os.path.getsize(p), "bytes")
    return p


# what to make: (file name, model id, request, title)
JOBS = [
    ("flux-lighthouse.png", "flux1-schnell-q4", {"prompt": "a lighthouse on a rocky coast at sunset, dramatic sky, oil painting", "width": 1024, "height": 1024, "steps": 4, "seed": 11}),
    ("flux-city.png", "flux1-schnell-q4", {"prompt": "a futuristic city at night with neon lights and rain, cinematic", "width": 1024, "height": 768, "steps": 4, "seed": 12}),
    ("flux-cat.png", "flux1-schnell-q4", {"prompt": "a fluffy orange cat sleeping on a sunny windowsill, cozy, photograph", "width": 1024, "height": 1024, "steps": 4, "seed": 13}),
    ("flux-sign.png", "flux1-schnell-q4", {"prompt": "a wooden sign in a green forest that says PlanetCompute, morning light, photograph", "width": 1024, "height": 768, "steps": 4, "seed": 14}),
    ("sd15-lighthouse.png", "sd15-q8", {"prompt": "a lighthouse on a rocky coast at sunset, dramatic sky, oil painting", "negative": "blurry, low quality, deformed, text, watermark", "width": 512, "height": 512, "steps": 20, "seed": 1001}),
    ("sd15-apple.png", "sd15-q8", {"prompt": "a red apple on a wooden table, soft window light, photograph", "negative": "blurry, low quality, deformed, text, watermark", "width": 512, "height": 512, "steps": 20, "seed": 1002}),
    ("sd15-city.png", "sd15-q8", {"prompt": "a futuristic city at night with neon lights and rain, digital art", "negative": "blurry, low quality, deformed, text, watermark", "width": 512, "height": 512, "steps": 20, "seed": 1003}),
    ("sd15-cat.png", "sd15-q8", {"prompt": "a fluffy orange cat sleeping on a windowsill, cozy, photograph", "negative": "blurry, low quality, deformed, text, watermark", "width": 512, "height": 512, "steps": 20, "seed": 1004}),
    ("wan-boat.webm", "wan21-t2v-1.3b-q8", {"prompt": "a small sailing boat on a calm lake at sunrise, mountains in the background, gentle waves", "width": 832, "height": 480, "frames": 33, "steps": 20, "seed": 7}),
    ("wan-fox.webm", "wan21-t2v-1.3b-q8", {"prompt": "a red fox running through fresh snow in a pine forest, slow motion", "width": 832, "height": 480, "frames": 33, "steps": 20, "seed": 8}),
]
NAMES = {"flux1-schnell-q4": "FLUX.1 schnell (4-bit)", "sd15-q8": "Stable Diffusion 1.5 (8-bit)", "wan21-t2v-1.3b-q8": "Wan 2.1 text to video 1.3B (8-bit)"}

# runs ON THE POD: start the program, download the models, make everything, write results.json
POD_SCRIPT = r'''
set -u
cd /root/pc
export DEBIAN_FRONTEND=noninteractive
(apt-get update -qq && apt-get install -y -qq libvulkan1 vulkan-tools libwebkit2gtk-4.1-0 libgtk-3-0 > apt.log 2>&1) || echo "apt failed"
mkdir -p /usr/share/vulkan/icd.d
[ -f /usr/share/vulkan/icd.d/nvidia_icd.json ] || [ -f /etc/vulkan/icd.d/nvidia_icd.json ] || echo '{"file_format_version":"1.0.0","ICD":{"library_path":"libGLX_nvidia.so.0","api_version":"1.3"}}' > /usr/share/vulkan/icd.d/nvidia_icd.json
vulkaninfo --summary 2>&1 | grep -E 'deviceName|deviceType' | head -4
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
nohup ./planetCompute --headless > app.log 2>&1 &
for i in $(seq 1 60); do curl -sf localhost:7526/local/info > /dev/null && break; sleep 1; done
curl -sf localhost:7526/local/image/info
for m in sd15-q8 flux1-schnell-q4 wan21-t2v-1.3b-q8; do curl -s -X POST -H 'content-type: application/json' -d "{\"id\":\"$m\"}" localhost:7526/local/models/download > /dev/null; done
python3 - <<'PY'
import json, time, urllib.request, subprocess
B = "http://localhost:7526"
def get(p): return json.load(urllib.request.urlopen(B + p, timeout=30))
def post(p, b):
    r = urllib.request.Request(B + p, data=json.dumps(b).encode(), headers={"content-type": "application/json"})
    try: return json.load(urllib.request.urlopen(r, timeout=60))
    except urllib.error.HTTPError as e: return json.loads(e.read() or b"{}")
need = {"sd15-q8", "flux1-ae", "flux1-clip-l-q8", "flux1-t5xxl-q4k", "flux1-schnell-q4", "wan21-t2v-1.3b-q8", "wan21-vae", "umt5-xxl-q4km"}
t0 = time.time()
while time.time() - t0 < 3600:
    d = {m["id"]: m for m in get("/local/models")["downloaded"]}
    ok = [i for i in need if d.get(i, {}).get("state") == "ready" and d[i].get("verified")]
    bad = [i + ": " + d[i].get("error", "") for i in need if d.get(i, {}).get("state") == "error"]
    print("downloads", len(ok), "of", len(need), "ready", bad, round(time.time() - t0), "s", flush=True)
    if len(ok) == len(need) or bad: break
    time.sleep(20)
print("downloads done in", round(time.time() - t0), "s", flush=True)
jobs = json.load(open("jobs.json")); res = []
for name, model, req in jobs:
    q = dict(req); q["model"] = model
    st = post("/local/image", q)
    if "id" not in st: res.append({"name": name, "error": st.get("error", str(st))}); print(name, st, flush=True); continue
    peak = [0, 0]
    while True:
        time.sleep(1)
        j = get("/local/image/job/" + st["id"])
        try:
            u, m = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=5).stdout.strip().split(",")
            peak = [max(peak[0], int(u)), max(peak[1], int(m))]
        except Exception: pass
        if j["state"] in ("done", "error", "cancelled"): break
        if j["seconds"] > 1800:   # a paid server: never let one job (e.g. a slow fallback to the CPU) run for hours
            post("/local/image/cancel", {"id": st["id"]}); time.sleep(5); j = get("/local/image/job/" + st["id"]); j["error"] = "stopped after 30 min"; break
    if j["state"] == "done":
        data = urllib.request.urlopen(B + "/local/image/file/" + st["id"]).read()
        open("out/" + name, "wb").write(data)
    res.append({"name": name, "model": model, "state": j["state"], "seconds": j["seconds"], "ran_on": j.get("ran_on"), "retried": j.get("retried"),
                "error": j.get("error"), "gpu_peak_util": peak[0], "gpu_peak_mem_mb": peak[1], "req": req})
    print(json.dumps(res[-1]), flush=True)
    json.dump(res, open("out/results.json", "w"), indent=1)
PY
grep -m3 -i 'vulkan' app.log
'''


def main():
    run = sys.argv[1]
    os.makedirs(OUT, exist_ok=True)
    prog = program(run)
    pub = open(KEY + ".pub").read().strip()
    pod = None
    for gpus in (["NVIDIA RTX A5000", "NVIDIA GeForce RTX 3090", "NVIDIA GeForce RTX 4090", "NVIDIA RTX A6000", "NVIDIA L40S"], ["NVIDIA RTX A4000", "NVIDIA RTX 4000 Ada Generation"]):
        for cloud in ("SECURE", "COMMUNITY"):
            try:
                pod = rp("POST", "/pods", {"name": "pc-media-samples", "imageName": "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04",
                                            "gpuTypeIds": gpus, "gpuCount": 1, "cloudType": cloud, "containerDiskInGb": 60, "ports": ["22/tcp"],
                                            "supportPublicIp": True, "env": {"PUBLIC_KEY": pub, "NVIDIA_DRIVER_CAPABILITIES": "all"}})
                break
            except urllib.error.HTTPError as e:
                log("no pod with", gpus[0], cloud, e.code, e.read()[:200])
        if pod:
            break
    if not pod:
        sys.exit("no GPU pod available")
    pid = pod["id"]
    open(os.path.join(ROOT, "planetCompute-CPP", ".ops", "media_pod.txt"), "w").write(pid + "\n")
    log("POD", pid, pod.get("machine", {}).get("gpuTypeId", ""), "cost/h", pod.get("costPerHr"))
    try:
        ip = port = None
        for _ in range(90):
            d = gql('query { pod(input: {podId: "%s"}) { runtime { ports { ip isIpPublic privatePort publicPort } } } }' % pid)
            ports = ((d.get("data") or {}).get("pod") or {}).get("runtime") or {}
            for p in ports.get("ports") or []:
                if p["privatePort"] == 22 and p["isIpPublic"]:
                    ip, port = p["ip"], p["publicPort"]
            if ip:
                break
            time.sleep(10)
        if not ip:
            raise RuntimeError("no SSH address")
        log("ssh", ip, port)
        ssh = ["ssh", "-p", str(port), *SSH, "root@" + ip]
        for _ in range(30):
            if subprocess.run(ssh + ["true"], capture_output=True).returncode == 0:
                break
            time.sleep(10)
        subprocess.run(ssh + ["mkdir -p /root/pc/out"], check=True)
        open(os.path.join(OUT, "jobs.json"), "w").write(json.dumps(JOBS))
        open(os.path.join(OUT, "pod.sh"), "w").write(POD_SCRIPT)
        scp = ["scp", "-P", str(port), *SSH]
        subprocess.run(scp + [prog, "root@%s:/root/pc/planetCompute" % ip], check=True)
        subprocess.run(scp + [os.path.join(OUT, "jobs.json"), os.path.join(OUT, "pod.sh"), "root@%s:/root/pc/" % ip], check=True)
        log("running on the pod")
        subprocess.run(ssh + ["bash /root/pc/pod.sh 2>&1 | tee /root/pc/pod.log"])
        subprocess.run(scp + ["-r", "root@%s:/root/pc/out" % ip, OUT], check=False)
        subprocess.run(scp + ["root@%s:/root/pc/pod.log" % ip, "root@%s:/root/pc/app.log" % ip, OUT], check=False)
    finally:
        for _ in range(5):
            try:
                rp("DELETE", "/pods/" + pid); log("POD DELETED", pid); break
            except Exception as e:
                log("delete failed, again", e); time.sleep(10)
        os.remove(os.path.join(ROOT, "planetCompute-CPP", ".ops", "media_pod.txt"))
    res = json.load(open(os.path.join(OUT, "out", "results.json")))
    gpu = subprocess.run(["grep", "-m1", ",", os.path.join(OUT, "pod.log")], capture_output=True, text=True).stdout.strip()
    entries = []
    for r in res:
        f = os.path.join(OUT, "out", r["name"])
        if r.get("state") != "done" or not os.path.exists(f):
            continue
        q = r["req"]
        size = f'{q["width"]} x {q["height"]}' + (f', {q["frames"]} frames (2 s at 16 fps)' if "frames" in q else "")
        on = f'on the {r["ran_on"]} ({gpu.split(",")[0]})' if r.get("ran_on") == "GPU" else f'on the {r.get("ran_on")}'
        entries.append({"path": f, "name": r["name"], "title": q["prompt"],
                        "note": f'{NAMES[r["model"]]}, {size}, {q["steps"]} steps, {on} in {r["seconds"]:.0f} s, by the planetCompute program (Harness, This computer). 2026-10-22.'})
    json.dump(entries, open(os.path.join(OUT, "entries.json"), "w"), indent=1)
    subprocess.run([sys.executable, "-I", os.path.join(HERE, "b2_temp.py"), os.path.join(OUT, "entries.json")], check=True)
    log("done:", len(entries), "of", len(res), "uploaded")


if __name__ == "__main__":
    main()
