# PlanetCompute

PlanetCompute turns spare computing power from everyday computers into one shared AI cloud
(https://planetcompute.ai). This repository has the planetCompute program (Rust and Tauri 2, with llama.cpp and
stable-diffusion.cpp), the website and its backend, the database setup, the paper, and everything needed to
reproduce the paper's simulations, GPU measurements and tests.

| Folder | What it is |
|---|---|
| [`client/`](#the-planetcompute-program) | The planetCompute program: Tauri 2 (Rust), llama.cpp linked through `llama-cpp-2`, the WorkPack kernels and SherpaHub (`client/workpack/`), the window (`client/ui/`) |
| `llama.cpp/`, `stable-diffusion.cpp/` | The pinned engine sources the program is built from (third-party, MIT) |
| `.github/workflows/` | CI: builds for Windows, macOS and Linux (CPU, Metal, Vulkan, server) and the WorkPack tests |
| `models/` | The model library catalogue (`catalog.json`: names, files, SHA-256) |
| `aws/` | The IAM policy the website's AWS user needs (account ID replaced by `<AWS_ACCOUNT_ID>`) |
| [`website/`](#website) | The whole website as one Cloudflare Worker (`worker.js`): pages, sign-in, browser volunteer console, capacity check, Compute Credit, admin page, devnet token transfers |
| [`database/`](#database) | `CreateTables.py` creates the DynamoDB tables and indexes; `makeThisUserAdmin.py` gives a user admin rights |
| [`solana-devnet/`](#solana-devnet) | Request free test SOL on Solana devnet |
| [`paper/`](#paper) | The paper's LaTeX source, generated tables, build tools, and the built PDF, HTML and Word files |
| [`coin-logo/`](#coin-logo) | The PlanetComp Coin logo |
| `simulations/`, `browser-workpack/`, `gpu-benchmarks/` | Reproducible tests (below) |
| `scripts/` | Every test and operations script (site tests, SherpaHub tests, GPU and pod runs, release publishing) |
| `docs/` | How each part works, `TESTING.md` (every test step by step, with results) and `docs/results/` (raw test logs) |
| `workhorse/`, `hbserver/` | The agent that runs program copies on a server (`whagent.py`, `whctl`) and the heartbeat server |
| `simulations/gridSim/results/` | Every orchestrator run (JSON + logs), including the million-device and cost runs |
| `gpu-benchmarks/reference-results/` | Raw GPU results, logs, the SDXL images and their latent arrays |
| [`old-testing-code-retired/`](old-testing-code-retired/README.md) | The hungry wolves and generous cows that first tested the live grid, retired on 30 October 2026 (replaced by an in-house SherpaHub's DemandSimulation and SupplySimulation) |

No keys or passwords are in this repository (the Cloudflare zone and account identifiers in `website/worker.js` are
identifiers, not credentials). Put your own in environment variables or a
`.env` file, which `.gitignore` keeps out of git.

## The planetCompute program

```
planetCompute               the window: Share Compute, Receive Compute, My Content, Local Tunnel URL, My Balance, Docs and Disclaimer
planetCompute --headless    share a server's cores from a terminal, no window (Ubuntu servers)
planetCompute --help        every option
```

Built by `.github/workflows/client.yml` for Windows (`planetCompute.exe`), macOS and Linux; `scripts/build_linux_cuda.sh`
makes the Linux NVIDIA (CUDA) build. Builds are signed with the project's Ed25519 release key (not yet code-signed by
Microsoft or Apple, so those systems warn the first time). Every test, step by step with our results:
[docs/TESTING.md](docs/TESTING.md).

## Website

`website/worker.js` is a single-file Cloudflare Worker with a `CapacityPolice` Durable Object
(`wrangler.toml`). Deploy with:

```bash
cd website
npx wrangler deploy
```

Set these as Worker variables or secrets in the Cloudflare dashboard:

| Variable | Purpose |
|---|---|
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `DDB_PREFIX` | DynamoDB access and table name prefix (for example `planetcompute-ai-`) |
| `AUTH_SECRET`, `SESSION_SECRET` | Random strings used to sign sign-in codes and sessions |
| `RESEND_API_KEY`, `RESEND_FROM`, `MAIL_FROM` | Sending sign-in emails |
| `ADMIN_EMAILS` | Comma-separated emails that are admins |
| `SOLANA_CLUSTER`, `SOLANA_RPC_URL`, `PCC_MINT`, `PCC_DECIMALS`, `TREASURY_SECRET_KEY`, `TREASURY_TOKEN_ACCOUNT`, `WITHDRAW_MAX_WU` | Devnet token bookkeeping |
| `CLIENT_DOWNLOAD_URL` | Desktop app download link |
| `HB_SERVER_SECRET` | Shared with the heartbeat servers: signs volunteers' passes and the servers' batches (optional: without it volunteers report to the Worker directly) |

`wrangler.toml` also sets an hourly Cron Trigger (`17 * * * *`): it health-checks the heartbeat servers and emails
the admins when none is running.

**Heartbeat servers** (optional): small always-on Linux machines behind Cloudflare's proxy that take the
volunteers' status reports first and hand them to the Worker in signed batches, which cuts the cost per volunteer;
with none running, volunteers report to the Worker as before. How they work, how to install one and how to run
them: [docs/HEARTBEAT_SERVERS.md](docs/HEARTBEAT_SERVERS.md). The cost study behind them: the paper, section
"The Cost of Running It".

`planetcompute-worker-iam-policy.json` is the least-privilege AWS policy for the Worker; replace
`<AWS_ACCOUNT_ID>` with yours.

## Database

```bash
pip install boto3
python database/CreateTables.py                 # creates <prefix>user, <prefix>user-credits,
                                                # <prefix>Contributor-Sessions, <prefix>howCreditAwarded
python database/makeThisUserAdmin.py someone@example.com
```

The docstring of `CreateTables.py` documents every table, key and index. All admin lists are index
queries with pagination, so they scale to millions of users, devices and contributor sessions.

## Solana devnet

```bash
python solana-devnet/sendTestMoney2DevnetSolana.py --address <devnet address>
```

Devnet SOL has no value; it only pays devnet transaction fees while testing.

## Paper

```bash
cd paper
latexmk -pdf planetcompute.tex          # PDF
python tools/build_formats.py           # PDF + HTML + Word into dist/
```

## Coin logo

`coin-logo/PlanetComputeCoin.jpg` and a transparent `PlanetComputeCoinNoBGLow.png`.

---

# Reproducible tests

Everything needed to reproduce the simulations and GPU measurements in the PlanetCompute paper,
step by step. Each folder has the scripts, and the numbers we got are in `reference-results/`, so you
can compare your run with ours.

| Folder | What it reproduces | Needs | Time | Cost |
|---|---|---|---|---|
| [`simulations/`](#1-simulations) | Validation policies, competitive dispatch, WorkPack size (the square-root law); the orchestrator at a million devices (`gridSim/`) | Python 3.9+ and Node 20+, nothing else | ~2 min (1M run: ~20 min, ~3 GB) | free |
| [`browser-workpack/`](#2-the-browser-workpack) | The 133-byte WebAssembly WorkPack and the WebGPU shader used by the browser volunteer | Node 18+; Python + `wgpu` | 1 min | free |
| [`gpu-benchmarks/`](#3-gpu-benchmarks) | Speed, cross-GPU reproducibility and audit cost on real GPUs | 1–3 NVIDIA GPUs (we used RunPod) | ~1 h per GPU | ~$2 for three GPUs |

---

## 1. Simulations

Pure Python standard library, deterministic for a given `--seed`.

```bash
cd simulations

# 1a. Validation policies under collusion (paper: "Validation and Credit")
python validation_sim.py --out validation_results.csv          # ~20 s
python make_table.py validation_results.csv validation_table.tex

# 1b. Competitive dispatch with first-finisher and consolation rewards (paper: "Competitive Dispatch")
python race_sim.py --out race_results.csv                      # ~15 s
python make_race_table.py race_results.csv race_table.tex

# 1c. How big a WorkPack should be (paper: "Designing WorkPacks for Inference")
python packsize_sim.py --out packsize_results.csv              # ~1 min
python make_packsize_table.py packsize_results.csv packsize_table.tex   # also prints the fit
```

**Check:** with the default seed your CSVs are identical to the files in
`simulations/reference-results/`:

```bash
cmp validation_results.csv reference-results/validation_results.csv && echo same
cmp race_results.csv       reference-results/race_results.csv       && echo same
cmp packsize_results.csv   reference-results/packsize_results.csv   && echo same
```

What to look for:

- **1a:** with quorum, strikes and retroactive invalidation, *wrong accepted* is 0 in every row.
- **1b:** "first 3 matching" without penalties accepts about 6.1% wrong packs (the closed form
  predicts 5.8%). With penalties all rules reach 0, and the hybrid rule has both the low latency
  (1.10) and the fair reward ratio (2.7×).
- **1c:** the fitted overhead term `A` is 0.94–1.19× its prediction `W·T_o/P` when hedging is on, and
  the best pack size grows like the square root of work × overhead.


### 1d. The orchestrator at a million devices (paper: "Testing the Orchestrator at a Million Devices")

Plain Node.js, nothing to install, seeded. `gridSim/core/` holds the orchestrator objects as plain
classes; `gridSim/sim/` runs them against simulated volunteers and consumers.

```bash
cd simulations/gridSim
node sim/run.js --devices 100000 --name pull-100k                                   # ~1.5 min
node --max-old-space-size=6200 sim/run.js --devices 1000000 --name pull-1M         # ~20 min, ~3 GB
bash sim/scenarios.sh                                                               # 14 scenarios at 100k
node sim/summary.js                                                                 # one table from results/
```

Our reports are in `gridSim/results/`. See `gridSim/README.md` for what each number means.

## 2. The browser WorkPack

The browser volunteer runs one calculation (Monte Carlo estimation of π) in two places: as a
WebAssembly module on the processor and as a WebGPU compute shader on the graphics card.

```bash
cd browser-workpack

# 2a. Build the WebAssembly WorkPack byte by byte, run it, check pi, print its hash and base64
node build_wasm_workpack.mjs
#   expected: bytes 133, pi ~ 3.14, PASS

# 2b. Validate and run the WebGPU shader
pip install "wgpu==0.19.3" numpy
python test_wgsl_workpack.py
#   expected: pi estimate 3.1415x, PASS
```

No GPU? On Linux, install Mesa's software Vulkan driver and point wgpu at it:

```bash
sudo apt install mesa-vulkan-drivers
VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json python test_wgsl_workpack.py
```

## 3. GPU benchmarks

`bench.py` measures, on one GPU:

| Phase | Benchmark | What it measures |
|---|---|---|
| `diffusion` | B1, B3, B4, B7 | SDXL 1024², 30 steps: seconds per image and per step; download/load time; a seeded trace of every latent; cost of auditing one step |
| `llm` | B5, B7 | Qwen2.5-7B-Instruct: 16 answers × 256 tokens with *seeded* Gumbel sampling, then a teacher-forced audit of each answer in one pass |
| `music` | B1 | MusicGen small and medium: seconds per 10 s of audio |
| `video` | B1 | LTX-Video: seconds per 49-frame 704×480 chunk |
| `vllm` | B1 | vLLM, 7B/14B (and 32B on ≥ 40 GB) AWQ models: tokens/s at batch 1 and 32 |
| `audit_llm`, `audit_diff` | B4, B5 | Audit *another* GPU's answers and diffusion traces on this GPU |

All models are public on Hugging Face; no login token is needed.

### Step 1: get a GPU machine

Any Linux machine with an NVIDIA GPU (24 GB recommended), PyTorch 2.4 and CUDA 12.4 works. To rent
one on RunPod (prices change; we paid $0.22–$1.39 per hour):

```bash
export RUNPOD_API_KEY=...            # from runpod.io → Settings → API Keys. Never commit it.
cd gpu-benchmarks/runpod
python runpod_api.py gpus                                         # what is available now
python runpod_api.py create "NVIDIA GeForce RTX 4090" bench-4090 ~/.ssh/id_ed25519.pub
python runpod_api.py ssh <pod_id>                                 # repeat until it prints an ssh command
```

### Step 2: run the single-GPU benchmarks

```bash
scp -P <port> gpu-benchmarks/{bench.py,setup.sh,run_gpu.sh,run_cross_audit.sh} root@<ip>:/workspace/
ssh -p <port> root@<ip>
cd /workspace
bash setup.sh                        # 3–5 min
nohup bash run_gpu.sh 4090 > run.log 2>&1 &     # ~45–60 min; survives a dropped connection
tail -f run.log                      # each phase prints "<phase> exit 0"
```

Use any short tag instead of `4090`, such as `3090` or `a100`. Results land in `out/<tag>/`.

### Step 3 (optional): audit across GPU types

Do Step 2 on two or three different GPUs. Then, on each machine, copy the *other* machines'
`out/<other>/llm.json` and `out/<other>/traces/lat*.npy` into `src/<other>/` and `src/<other>/traces/`,
and run:

```bash
bash run_cross_audit.sh 4090 3090 a100          # this machine's tag, then the others'
```

Check that copied files are complete (each `lat*.npy` is 8,126,592 bytes) before auditing.

### Step 4: copy results back, stop billing

```bash
scp -P <port> -r root@<ip>:/workspace/out/4090 gpu-benchmarks/results/
python runpod_api.py terminate <pod_id>          # do not forget: pods bill until terminated
python runpod_api.py status                      # spend per hour should be 0
```

### Step 5: analyse

```bash
cd gpu-benchmarks
pip install -r requirements-analysis.txt
python analyze.py results                       # your runs  → summary.json + tables/*.tex
python analyze.py reference-results             # our runs, for comparison
```

### Our results (RTX 3090 · RTX 4090 · A100 80GB)

| Measurement | RTX 3090 | RTX 4090 | A100 80GB |
|---|---|---|---|
| SDXL 1024², 30 steps, s/image | 9.37 | 3.74 | 3.24 |
| 7B AWQ, tokens/s, batch 1 / 32 | 122 / 2,216 | 146 / 3,183 | 155 / 3,159 |
| 14B AWQ, tokens/s, batch 1 / 32 | 70 / 1,228 | 83 / 1,900 | 98 / 2,100 |
| 32B AWQ, tokens/s, batch 1 / 32 | – | – | 55 / 1,278 |
| LTX-Video 49-frame chunk, s | 22.0 | 18.6 | 6.1 |
| Diffusion audit, % of one image | 3.3% | 4.2% | 4.4% |
| LLM audit, % of decoding the answer | 7.9% | 8.8% | 8.9% |

- **Same GPU type:** seeded SDXL is bit-identical on a re-run on all three.
- **Different GPU types:** never bit-identical, but SSIM 0.986–0.998, and one recomputed step agrees
  within 5.3×10⁻⁴.
- **Seeded LLM sampling:** the audit reproduces 99.88–99.95% of tokens across GPU types, and every
  disagreement is at a near-tie (score margin ≤ 0.035).
- **MusicGen and the seeded LLM loop are limited by the host CPU** in these reference
  implementations, so their times reflect the machine's processor as much as its GPU.

### What these results mean for volunteer machines

The RTX 3090 and 4090 pods use the same GeForce cards people have in gaming desktops; the A100 is a
server GPU. That decides what carries over:

- **Directly:** agreement between runs and audit cost as a share of the work. These are set by the
  GPU architecture, kernels and library versions, not by the data centre.
- **As a scale only:** seconds per image or token. Home cards run at about the same speed when cool
  and idle. Laptop GPUs, the volunteer's CPU cap and heat over a long night lower it. PlanetCompute
  measures each device's own speed when it joins.
- **Not at all:** download speed, latency, churn and electricity.

The benchmarks use PyTorch/CUDA. Volunteers will run ONNX Runtime (desktop app) or WebGPU (browser),
so repeat the tests in those runtimes before relying on the tolerances.

### Known differences you may see

- **Download times** depend on the data centre's network (we saw 80–400 MB/s) and say nothing about
  home connections.
- **Cross-GPU agreement** varies slightly with driver and library versions. Pin the versions in
  `setup.sh` to compare like with like.
- **Out-of-memory errors:** LTX-Video uses CPU offload automatically below 40 GB of GPU memory. The
  32B model is skipped below 30 GB.
