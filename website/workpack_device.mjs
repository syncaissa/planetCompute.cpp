// The browser's SherpaHub device (docs/SHERPAHUB.md section 10) = client/workpack/src/device.rs in JavaScript: keeps
// the hub's blocks (checked by SHA-256, least recently used dropped first), answers a PACK with RESULT, or with NEED
// when blocks are missing. Wire format: docs/SHERPAHUB.md section 4 (client/workpack/src/wire.rs).
// Embedded in the contributor page next to workpack_kernel.mjs (scripts/embed_workpack.mjs); tested in Node by
// scripts/test_sherpa_e2e.mjs against the real SherpaHub. No backslashes, backticks or dollar-braces in this file:
// it is placed inside the site's page template.
//
// makeSherpaDevice({ cacheBytes, sha256, compute, send, rest })
//   sha256(Uint8Array) -> Promise<Uint8Array(32)>          (crypto.subtle in the page)
//   compute(units)     -> Promise<Int32Array[]>             units: [{ unit, m, k, n, a: Int8Array, bt: Int8Array }]
//   send(Uint8Array)                                        to the hub
//   rest(ms)           -> Promise                          after each computed pack (the CPU cap)
// .push(ArrayBuffer) handles messages strictly in order (a BLOCK is stored before the PACK that uses it).

export const PCWP_MAGIC = 0x50574350;
const KIND_PACK = 1, KIND_RESULT = 2, KIND_NEED = 3, KIND_BLOCK = 4, KERNEL_MATMUL_I8 = 2, DIM_MAX = 4096;

export function makeSherpaDevice(o) {
  const blocks = new Map();                  // id hex -> Int8Array; Map order = least recently used first
  let used = 0, chain = Promise.resolve();
  const stats = { blocks: 0, packs: 0, units: 0, needs: 0, refused: 0, ms: 0 };
  const hex = (b, s, e) => { let h = ""; for (let i = s; i < e; i++) h += (b[i] < 16 ? "0" : "") + b[i].toString(16); return h; };
  const touch = (id) => { const v = blocks.get(id); blocks.delete(id); blocks.set(id, v); return v; };
  function header(kind, len) {
    const out = new Uint8Array(len), v = new DataView(out.buffer);
    v.setUint32(0, PCWP_MAGIC, true); out[4] = kind; out[5] = 1;
    return { out, v };
  }
  async function onBlock(b, v) {
    if (b.length < 28) return stats.refused++;
    const len = v.getUint32(24, true);
    if (len === 0 || 28 + len !== b.length || len > o.cacheBytes) return stats.refused++;
    const bytes = b.slice(28), d = await o.sha256(bytes);
    for (let i = 0; i < 16; i++) if (d[i] !== b[8 + i]) return stats.refused++;   // corrupted: never used
    const id = hex(b, 8, 24);
    if (blocks.has(id)) return;
    while (used + len > o.cacheBytes && blocks.size) { const [k, x] = blocks.entries().next().value; blocks.delete(k); used -= x.length; }
    blocks.set(id, new Int8Array(bytes.buffer)); used += len; stats.blocks++;
  }
  async function onPack(b, v) {
    const count = b[29];
    if (b.length < 32 || b[28] !== KERNEL_MATMUL_I8 || count === 0 || b.length !== 32 + count * 48) return stats.refused++;
    const units = [], missing = [];
    for (let i = 0, p = 32; i < count; i++, p += 48) {
      const u = { unit: v.getUint32(p, true), m: v.getUint32(p + 4, true), k: v.getUint32(p + 8, true), n: v.getUint32(p + 12, true), ia: hex(b, p + 16, p + 32), ib: hex(b, p + 32, p + 48), pa: p + 16, pb: p + 32 };
      if (!u.m || !u.k || !u.n || u.m > DIM_MAX || u.k > DIM_MAX || u.n > DIM_MAX) return stats.refused++;
      for (const [id, at] of [[u.ia, u.pa], [u.ib, u.pb]]) if (!blocks.has(id) && !missing.some((x) => x[0] === id)) missing.push([id, at]);
      units.push(u);
    }
    if (missing.length) {                     // NEED: job, pack, epoch (bytes 8..28 of the PACK), count, ids
      const { out, v: w } = header(KIND_NEED, 32 + missing.length * 16);
      out.set(b.subarray(8, 28), 8); w.setUint32(28, missing.length, true);
      missing.forEach(([, at], i) => out.set(b.subarray(at, at + 16), 32 + i * 16));
      stats.needs++; o.send(out); return;
    }
    for (const u of units) {
      u.a = touch(u.ia); u.bt = touch(u.ib);
      if (u.a.length !== u.m * u.k || u.bt.length !== u.n * u.k) return stats.refused++;   // sizes do not match its blocks
    }
    const t0 = Date.now(), cs = await o.compute(units), ms = Date.now() - t0;
    let len = 36;
    units.forEach((u) => { len += 12 + u.m * u.n * 4; });
    const { out, v: w } = header(KIND_RESULT, len);
    out.set(b.subarray(8, 28), 8); w.setUint32(28, Math.min(ms, 0xffffffff), true); out[32] = count;
    let p = 36;
    units.forEach((u, i) => {
      w.setUint32(p, u.unit, true); w.setUint32(p + 4, u.m, true); w.setUint32(p + 8, u.n, true); p += 12;
      const c = cs[i];
      for (let j = 0; j < c.length; j++, p += 4) w.setInt32(p, c[j], true);
    });
    stats.packs++; stats.units += count; stats.ms += ms;
    o.send(out);
    if (o.rest) await o.rest(ms);
  }
  async function handle(buf) {
    const b = new Uint8Array(buf), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (b.length < 8 || v.getUint32(0, true) !== PCWP_MAGIC || b[5] !== 1) return stats.refused++;
    if (b[4] === KIND_BLOCK) return onBlock(b, v);
    if (b[4] === KIND_PACK) return onPack(b, v);
    stats.refused++;
  }
  return {
    stats,
    cached: () => blocks.size,
    push(buf) { chain = chain.then(() => handle(buf)).catch(() => { stats.refused++; }); return chain; },
  };
}
