#!/usr/bin/env python3
"""Validate and run montecarlo_pi.wgsl on any WebGPU-capable adapter (wgpu-native), and check pi.

  pip install "wgpu==0.19.3" numpy
  python test_wgsl_workpack.py
On a Linux machine without a GPU, install Mesa's CPU Vulkan driver first (sudo apt install mesa-vulkan-drivers)
and run with VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json
"""
import pathlib
import time

import numpy as np
import wgpu

WGSL = (pathlib.Path(__file__).parent / "montecarlo_pi.wgsl").read_text()
adapter = wgpu.gpu.request_adapter_sync(power_preference="high-performance")
print("adapter:", adapter.info.get("device"), "|", adapter.info.get("backend_type"))
dev = adapter.request_device_sync()
pipe = dev.create_compute_pipeline(layout="auto", compute={"module": dev.create_shader_module(code=WGSL), "entry_point": "main"})
hits = dev.create_buffer(size=4, usage=wgpu.BufferUsage.STORAGE | wgpu.BufferUsage.COPY_SRC | wgpu.BufferUsage.COPY_DST)
params = dev.create_buffer(size=16, usage=wgpu.BufferUsage.UNIFORM | wgpu.BufferUsage.COPY_DST)
bind = dev.create_bind_group(layout=pipe.get_bind_group_layout(0), entries=[
    {"binding": 0, "resource": {"buffer": hits, "offset": 0, "size": 4}},
    {"binding": 1, "resource": {"buffer": params, "offset": 0, "size": 16}}])
H = N = 0
for r in range(4):
    iters, groups = 256, 1024
    dev.queue.write_buffer(hits, 0, np.zeros(1, np.uint32))
    dev.queue.write_buffer(params, 0, np.array([12345 + 777 * r, iters, 0, 0], np.uint32))
    enc = dev.create_command_encoder()
    p = enc.begin_compute_pass(); p.set_pipeline(pipe); p.set_bind_group(0, bind); p.dispatch_workgroups(groups); p.end()
    t0 = time.time(); dev.queue.submit([enc.finish()])
    h = int(np.frombuffer(dev.queue.read_buffer(hits), np.uint32)[0])
    n = groups * 256 * iters; H += h; N += n
    print(f"dispatch {r}: {n / 1e6:.0f}M samples in {1000 * (time.time() - t0):.0f} ms")
pi = 4 * H / N
print(f"pi estimate: {pi:.5f}")
assert abs(pi - 3.14159) < 0.001, "shader result is wrong"
print("PASS")
