#!/usr/bin/env bash
# Step 2: run every single-GPU benchmark.   Usage: bash run_gpu.sh <tag>      e.g. bash run_gpu.sh 4090
# Results go to out/<tag>/ ; each phase also writes <phase>.log. About 45-60 minutes on an RTX 4090.
set -uo pipefail
TAG=${1:?usage: run_gpu.sh <tag>}
export HF_HUB_ENABLE_HF_TRANSFER=1
for phase in diffusion llm music video; do
  python bench.py "$phase" --out "out/$TAG" > "$phase.log" 2>&1; echo "$phase exit $?"
done
/opt/venv-vllm/bin/python bench.py vllm --out "out/$TAG" > vllm.log 2>&1; echo "vllm exit $?"
