// docs/TESTING.md test 63 part 2: the browser's matmul_i8 (website/workpack_kernel.mjs) against the conformance
// hashes of the Rust kernel (client/workpack). No keys, no network.
//   node scripts/test_workpack_vectors.mjs [file with lines "VECTOR <seed> <m>x<k>x<n> <sha256>" from the Rust side]
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { matmulI8, makeSimdMatmul, VECTORS, vectorInputs } from "../website/workpack_kernel.mjs";

const want = {};
if (process.argv[2]) for (const l of readFileSync(process.argv[2], "utf8").split("\n")) {
  const m = /^VECTOR (\d+) (\d+)x(\d+)x(\d+) ([0-9a-f]{64})/.exec(l.trim());
  if (m) want[`${m[1]} ${m[2]}x${m[3]}x${m[4]}`] = m[5];
}
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, x || ""); } };
const naive = (a, bt, m, k, n) => { const c = new Int32Array(m * n); for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) { let s = 0; for (let t = 0; t < k; t++) s += a[i * k + t] * bt[j * k + t]; c[i * n + j] = s; } return c; };
const simd = makeSimdMatmul();
ok("WebAssembly SIMD kernel available in this engine", !!simd);
const kernels = [["js", matmulI8], ...(simd ? [["simd", simd]] : [])];
const hex = (c) => createHash("sha256").update(Buffer.from(c.buffer, c.byteOffset, c.byteLength)).digest("hex");
for (const [name, mm] of kernels) {
  for (const [seed, m, k, n] of VECTORS) {
    const [a, bt] = vectorInputs(seed, m, k, n);
    const c = mm(a, bt, m, k, n, new Int32Array(m * n));
    const h = hex(c), key = `${seed} ${m}x${k}x${n}`;
    ok(`${name} ${key}: = naive`, Buffer.compare(Buffer.from(c.buffer, c.byteOffset, c.byteLength), Buffer.from(naive(a, bt, m, k, n).buffer)) === 0);
    if (Object.keys(want).length) ok(`${name} ${key}: same hash as the Rust kernel`, want[key] === h, `${h} vs ${want[key]}`);
    else console.log("VECTOR", key, h);
  }
  // 200 random shapes (odd sizes: the 16-byte and 4-column edges), and the extremes at k = 4096
  let x = 12345, bad = 0;
  const r = (lim) => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return 1 + (x % lim); };
  for (let t = 0; t < 200; t++) {
    const [m, k, n] = [r(67), r(301), r(71)], [a, bt] = vectorInputs(t + 1, m, k, n);
    const c = mm(a, bt, m, k, n, new Int32Array(m * n)), w = naive(a, bt, m, k, n);
    if (Buffer.compare(Buffer.from(c.buffer, c.byteOffset, c.byteLength), Buffer.from(w.buffer))) bad++;
  }
  ok(`${name}: 200 random shapes = naive`, bad === 0, bad + " differ");
  for (const [va, vb] of [[-128, -128], [127, 127], [-128, 127]]) {
    const [m, k, n] = [3, 4096, 5], c = mm(new Int8Array(m * k).fill(va), new Int8Array(n * k).fill(vb), m, k, n, new Int32Array(m * n));
    ok(`${name}: extremes ${va} x ${vb} x 4096 exact`, c.every((v) => v === va * vb * k));
  }
}
// speed (logged): one core, the size the Rust kernel is measured at
const [m, k, n] = [256, 1024, 256], [a, bt] = vectorInputs(7, m, k, n), c = new Int32Array(m * n);
for (const [name, mm] of kernels) {
  let reps = 0; const t0 = performance.now(); while (performance.now() - t0 < 1500) { mm(a, bt, m, k, n, c); reps++; }
  console.log(`SPEED ${name} matmul_i8 ${m}x${k}x${n} one core (${process.version}): ${(2 * m * k * n * reps / ((performance.now() - t0) / 1000) / 1e9).toFixed(2)} GOP/s`);
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
