// Hand-assembles the PlanetCompute demo WorkPack and tests it.   Usage: node build_wasm_workpack.mjs
// Export: pc_mc_pi(seed: i32, n: i32) -> i32. No imports, so the module can only do arithmetic.
// = how many of n xorshift32 points land inside the quarter circle of radius 2^15.
const sleb = v => { const o = []; for (;;) { const b = v & 0x7f; v >>= 7;
  if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) { o.push(b); return o; } o.push(b | 0x80); } };
const uleb = v => { const o = []; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; o.push(b); } while (v); return o; };
const c = v => [0x41, ...sleb(v)];
const get = i => [0x20, i], set = i => [0x21, i], tee = i => [0x22, i];
const body = [
  1, 2, 0x7f,                                   // 2 extra i32 locals: count(2), u(3)
  0x02, 0x40, 0x03, 0x40,                       // block, loop
  ...get(1), 0x45, 0x0d, 1,                     // if n == 0 break
  ...get(0), ...get(0), ...c(13), 0x74, 0x73, ...set(0),
  ...get(0), ...get(0), ...c(17), 0x76, 0x73, ...set(0),
  ...get(0), ...get(0), ...c(5), 0x74, 0x73, ...tee(0),
  ...c(0x7fff), 0x71, ...tee(3), ...get(3), 0x6c,
  ...get(0), ...c(15), 0x76, ...c(0x7fff), 0x71, ...tee(3), ...get(3), 0x6c,
  0x6a, ...c(0x40000000), 0x49,                 // u*u + v*v < 2^30 (unsigned)
  ...get(2), 0x6a, ...set(2),
  ...get(1), ...c(1), 0x6b, ...set(1),
  0x0c, 0, 0x0b, 0x0b,                          // br loop, end loop, end block
  ...get(2), 0x0b,
];
const sec = (id, bytes) => [id, ...uleb(bytes.length), ...bytes];
const name = [...Buffer.from("pc_mc_pi")];
const wasm = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
  ...sec(1, [1, 0x60, 2, 0x7f, 0x7f, 1, 0x7f]),
  ...sec(3, [1, 0]),
  ...sec(7, [1, name.length, ...name, 0x00, 0]),
  ...sec(10, [1, ...uleb(body.length), ...body]),
]);
const { instance } = await WebAssembly.instantiate(wasm);
const n = 5_000_000, hits = instance.exports.pc_mc_pi(12345, n);
const t0 = Date.now(); instance.exports.pc_mc_pi(99, 50_000_000); const ms = Date.now() - t0;
console.log("bytes", wasm.length, "pi ~", (4 * hits / n).toFixed(4), "50M samples in", ms, "ms");
if (Math.abs(4 * hits / n - Math.PI) > 0.01) throw new Error("WorkPack result is wrong");
console.log("sha256", (await import("node:crypto")).createHash("sha256").update(wasm).digest("hex"));
console.log("BASE64", Buffer.from(wasm).toString("base64"));
console.log("PASS");
