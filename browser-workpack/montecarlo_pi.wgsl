// PlanetCompute demo WorkPack for the graphics card (WebGPU compute shader).
// Each invocation runs xorshift32 Monte Carlo sampling and adds its hits to one atomic counter.
struct Params { seed: u32, iters: u32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<storage, read_write> hits: atomic<u32>;
@group(0) @binding(1) var<uniform> P: Params;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  var x: u32 = (P.seed ^ (gid.x * 2654435761u)) | 1u;
  for (var w: u32 = 0u; w < 8u; w++) { x ^= x << 13u; x ^= x >> 17u; x ^= x << 5u; }
  var c: u32 = 0u;
  for (var i: u32 = 0u; i < P.iters; i++) {
    x ^= x << 13u; x ^= x >> 17u; x ^= x << 5u;
    let u = x & 0x7fffu; let v = (x >> 15u) & 0x7fffu;
    if (u * u + v * v < 0x40000000u) { c++; }
  }
  atomicAdd(&hits, c);
}
