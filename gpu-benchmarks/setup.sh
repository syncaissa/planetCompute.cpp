#!/usr/bin/env bash
# Install everything bench.py needs on a Linux machine with an NVIDIA GPU and PyTorch 2.4 + CUDA 12.4
# (e.g. the image runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04). Takes 3-5 minutes.
set -euo pipefail
pip install -q "diffusers==0.32.2" "transformers==4.46.3" "accelerate==1.1.1" \
  "huggingface_hub[hf_transfer]==0.26.5" sentencepiece protobuf numpy pillow imageio
# vLLM pins its own torch, so it lives in a separate virtual environment.
pip install -q uv
uv venv -q /opt/venv-vllm --python 3.11
uv pip install -q --python /opt/venv-vllm/bin/python "vllm==0.6.3.post1" "transformers==4.46.3" \
  setuptools hf_transfer "huggingface_hub[hf_transfer]"
echo "setup done"
