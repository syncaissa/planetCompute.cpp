// The browser's WorkPack kernels (docs/SHERPAHUB.md section 3): bit-identical to client/workpack/src/kernels.rs.
// Embedded in the contributor page in stage 3; tested now by scripts/test_workpack_vectors.mjs.
// matmul_i8: C (m x n, Int32Array, row-major) = A (m x k, Int8Array) x B, with B given transposed as BT (n x k).
// Int32 maths throughout (Math.imul and |0), so every JavaScript engine gives the same exact result.

export function matmulI8(a, bt, m, k, n, c) {
  if (a.length !== m * k || bt.length !== n * k || c.length !== m * n || k > 131071) throw new Error("matmulI8: bad sizes");
  const n4 = n - (n % 4);
  for (let i = 0; i < m; i++) {
    const ar = i * k, cr = i * n;
    let j = 0;
    for (; j < n4; j += 4) {
      const b0 = j * k, b1 = b0 + k, b2 = b1 + k, b3 = b2 + k;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let t = 0; t < k; t++) {
        const x = a[ar + t];
        s0 = (s0 + Math.imul(x, bt[b0 + t])) | 0;
        s1 = (s1 + Math.imul(x, bt[b1 + t])) | 0;
        s2 = (s2 + Math.imul(x, bt[b2 + t])) | 0;
        s3 = (s3 + Math.imul(x, bt[b3 + t])) | 0;
      }
      c[cr + j] = s0; c[cr + j + 1] = s1; c[cr + j + 2] = s2; c[cr + j + 3] = s3;
    }
    for (; j < n; j++) {
      const b0 = j * k;
      let s = 0;
      for (let t = 0; t < k; t++) s = (s + Math.imul(a[ar + t], bt[b0 + t])) | 0;
      c[cr + j] = s;
    }
  }
  return c;
}

// xorshift32 (seed 0 -> 0x9E3779B9), the inputs of tests and synthetic jobs; an int8 is the top byte.
export function rngFillI8(seed, out) {
  let x = (seed >>> 0) || 0x9E3779B9;
  for (let i = 0; i < out.length; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    out[i] = (x >>> 24) << 24 >> 24;
  }
  return out;
}

export const VECTORS = [[1, 1, 1, 1], [7, 4, 16, 4], [42, 17, 33, 9], [1234, 64, 64, 64], [99, 3, 4096, 5], [2026, 61, 301, 67]];

export function vectorInputs(seed, m, k, n) {
  return [rngFillI8(seed, new Int8Array(m * k)), rngFillI8((seed ^ 0xA5A5A5A5) >>> 0, new Int8Array(n * k))];
}

// ---- WebAssembly SIMD kernel (website/workpack_kernel.wat): the fast path where the engine supports SIMD ----
// WASM_SIMD_BEGIN (scripts/build_workpack_wasm.mjs from website/workpack_kernel.wat; 655 bytes, sha256 fd1eeedb13da1f6ec843886b55831fba88765e9ee4731db37808b84ef7f6049d)
const WASM_SIMD_B64 = "AGFzbQEAAAABLAZgA3t7ewF7YAF7AX9gBH9/f38Bf2ADf39/AX9gBH9/f38AYAZ/f39/f38AAwcGAAECAwQFBQMBAAEHEAIDbWVtAgAGbWF0bXVsAAUKtgQGJAAgACAB/YcBIAL9hwH9ugH9rgEgAf2IASAC/YgB/boB/a4BCxkAIAD9GwAgAP0bAWogAP0bAiAA/RsDamoLNgECfyACIQUCQANAIAUgA08NASAEIAAgBWosAAAgASAFaiwAAGxqIQQgBUEBaiEFDAALCyAEC0oCAXsCfyACQXBxIQUCQANAIAQgBU8NASADIAAgBGr9AAQAIAEgBGr9AAQAEAAhAyAEQRBqIQQMAAsLIAMQASAAIAEgBSACEAJqC9kBAwJ/BXsDfyABIAJqIQsgCyACaiEMIAwgAmohDSACQXBxIQUCQANAIAQgBU8NASAAIARq/QAEACEGIAcgBiABIARq/QAEABAAIQcgCCAGIAsgBGr9AAQAEAAhCCAJIAYgDCAEav0ABAAQACEJIAogBiANIARq/QAEABAAIQogBEEQaiEEDAALCyADIAcQASAAIAEgBSACEAJqNgIAIAMgCBABIAAgCyAFIAIQAmo2AgQgAyAJEAEgACAMIAUgAhACajYCCCADIAoQASAAIA0gBSACEAJqNgIMC5cBAQV/IAVBfHEhCAJAA0AgBiADTw0BIAAgBiAEbGohCSACIAYgBWxBAnRqIQpBACEHAkADQCAHIAhPDQEgCSABIAcgBGxqIAQgCiAHQQJ0ahAEIAdBBGohBwwACwsCQANAIAcgBU8NASAKIAdBAnRqIAkgASAHIARsaiAEEAM2AgAgB0EBaiEHDAALCyAGQQFqIQYMAAsLCw==";
// WASM_SIMD_END

const b64bytes = (s) => (typeof atob === "function" ? Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) : new Uint8Array(Buffer.from(s, "base64")));

// One instance per worker thread. Inputs are copied into its memory (A, then BT, then C, 16-byte aligned); memory
// grows only when a pack is larger than any before. Returns null where WebAssembly SIMD is not available (old
// engines): the caller then uses matmulI8 (plain JS), which gives the same exact result.
export function makeSimdMatmul() {
  if (typeof WebAssembly !== "object" || !WASM_SIMD_B64) return null;
  const bytes = b64bytes(WASM_SIMD_B64);
  if (!WebAssembly.validate(bytes)) return null;
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  const mem = inst.exports.mem, mm = inst.exports.matmul;
  const al = (x) => (x + 15) & ~15;
  return function matmulSimd(a, bt, m, k, n, c) {
    if (a.length !== m * k || bt.length !== n * k || c.length !== m * n || k > 131071) throw new Error("matmulSimd: bad sizes");
    const pa = 0, pb = al(pa + m * k), pc = al(pb + n * k), end = pc + m * n * 4;
    if (end > mem.buffer.byteLength) mem.grow(Math.ceil((end - mem.buffer.byteLength) / 65536));
    const u8 = new Int8Array(mem.buffer);
    u8.set(a, pa);
    u8.set(bt, pb);
    mm(pa, pb, pc, m, k, n);
    c.set(new Int32Array(mem.buffer, pc, m * n));
    return c;
  };
}
