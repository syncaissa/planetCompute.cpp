# Windows + Tesla T4 GPU test (2026-10-22)

The same program (`planetCompute.exe`, Vulkan and CPU builds) on a rented AWS Windows Server machine with an NVIDIA
Tesla T4, through the Harness API: pictures (FLUX.1 schnell, Stable Diffusion 1.5) and a Wan 2.1 clip. `results.json`
has every timing; the pictures are compared with the RTX 4090 ones in `../linux-rtx4090-media-20261022/` (paper,
Table "The same request on two machines"; docs/TESTING.md, Windows GPU test). `run.log` is the launcher's log
(instance IDs and IP addresses masked; the machine was deleted after the run). Script: `scripts/aws_windows_gpu_test.py`.
