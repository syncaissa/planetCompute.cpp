#!/usr/bin/env bash
# Build the Linux NVIDIA (CUDA) planetCompute client on a many-core RunPod CPU pod instead of GitHub's 4-core runner.
# Adapted from sushila.cpp's build_linux_cuda.sh. Ubuntu 22.04 (glibc 2.35), CUDA 12.8, GPU generations
# 75;80;86;89;90;120, llama.cpp static (llama-cpp-2 crate), CUDA runtime next to the program.
# No GPU is needed to compile CUDA code.
# Usage on the pod: V=0.1.0 SRC=/workspace/src bash build_linux_cuda.sh    (SRC = this repository: client/, LICENSE)
# Output: /workspace/out/planetCompute-$V-linux-x86_64-cuda.tar.gz
# Then upload with the one-time B2 link made on Cloud9 (B2 keys never go on a pod), verify the hash, and only then
# delete the pod.
set -euo pipefail
V=${V:-0.1.0}; SRC=${SRC:-/workspace/src}; B=/workspace/b; OUT=/workspace/out; mkdir -p $B $OUT
J=$(nproc)
log() { echo "[$(date -u +%H:%M:%S)] $*"; }
if ! command -v nvcc > /dev/null && [ ! -x /usr/local/cuda-12.8/bin/nvcc ]; then
  cd /tmp && wget -q https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb && dpkg -i cuda-keyring_1.1-1_all.deb > /dev/null
  apt-get update -qq > /dev/null && apt-get install -y -qq cmake git build-essential cuda-nvcc-12-8 cuda-cudart-dev-12-8 cuda-cccl-12-8 libcublas-12-8 libcublas-dev-12-8 > $B/apt.log 2>&1
fi
apt-get install -y -qq libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev clang libclang-dev curl > $B/apt2.log 2>&1
export PATH=/usr/local/cuda-12.8/bin:$HOME/.cargo/bin:$PATH CUDA_HOME=/usr/local/cuda-12.8 CMAKE_CUDA_ARCHITECTURES="75;80;86;89;90;120"
command -v cargo > /dev/null || { curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal > $B/rustup.log 2>&1; }
log "nvcc $(nvcc --version | tail -n 1), $(cargo --version), $J cores"
# tar keeps old timestamps: touch the sources so cargo and cmake rebuild them (a stale binary was a real sushila.cpp bug)
find $SRC/client -path $SRC/client/target -prune -o -type f -exec touch {} +
CARGO_TARGET_DIR=$B/target cargo build --release --manifest-path $SRC/client/Cargo.toml --features cuda -j $J > $B/build.log 2>&1
log "planetCompute built"
P=$B/pkg; rm -rf $P; mkdir -p $P
cp $B/target/release/planetCompute $P/planetCompute
for l in libcudart.so.12 libcublas.so.12 libcublasLt.so.12; do cp -L "$(find /usr/local/cuda* /usr/lib/x86_64-linux-gnu -name "$l" 2>/dev/null | head -1)" $P/; done
cp $SRC/LICENSE $P/ 2>/dev/null || true
$P/planetCompute --version | tee $B/version.txt
grep -q CUDA $B/version.txt || { echo "the program does not report CUDA: stale or wrong build"; exit 1; }
tar -czf $OUT/planetCompute-$V-linux-x86_64-cuda.tar.gz -C $P .
ls -la $OUT; sha256sum $OUT/*.tar.gz
log BUILD_DONE
