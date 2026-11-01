// A small SherpaHub in JavaScript for tests of DEVICES (docs/TESTING.md tests 65-67): connects to the broker as a
// hub, gives every device that says hello packs of a fixed int8 matrix product, and checks every RESULT against the
// plain kernel (website/workpack_kernel.mjs matmulI8). Not the real hub (client/workpack/src/hub.rs): no sizing,
// hedging or checkpoints; it exercises the device side of the wire format: PACK -> NEED -> BLOCKs -> PACK -> RESULT.
import { createHash } from "node:crypto";
import { matmulI8, rngFillI8 } from "../website/workpack_kernel.mjs";

const MAGIC = 0x50574350;
const sha16 = (b) => new Uint8Array(createHash("sha256").update(b).digest()).subarray(0, 16);
function hdr(kind, len) { const o = new Uint8Array(len), v = new DataView(o.buffer); v.setUint32(0, MAGIC, true); o[4] = kind; o[5] = 1; return { o, v }; }
export function blockMsg(bytes, corrupt) {
  const { o, v } = hdr(4, 28 + bytes.length); o.set(sha16(bytes), 8); v.setUint32(24, bytes.length, true); o.set(bytes, 28);
  if (corrupt) o[28] ^= 1;                       // id no longer matches the bytes
  return o;
}
export function packMsg(job, pack, epoch, units) {   // units: [{ unit, m, k, n, aId, btId }]
  const { o, v } = hdr(1, 32 + units.length * 48);
  v.setBigUint64(8, BigInt(job), true); v.setBigUint64(16, BigInt(pack), true); v.setUint32(24, epoch, true); o[28] = 2; o[29] = units.length;
  units.forEach((u, i) => { const p = 32 + i * 48; v.setUint32(p, u.unit, true); v.setUint32(p + 4, u.m, true); v.setUint32(p + 8, u.k, true); v.setUint32(p + 12, u.n, true); o.set(u.aId, p + 16); o.set(u.btId, p + 32); });
  return o;
}

// The job: C (M x N) = A (M x K) x B; tiles T x T; unit u = (row block u / cols, col block u % cols)
export function makeJob({ M = 256, K = 512, N = 256, T = 64, seed = 7 } = {}) {
  const A = rngFillI8(seed, new Int8Array(M * K)), BT = rngFillI8(seed ^ 0x5a5a5a5a, new Int8Array(N * K));
  const rows = M / T, cols = N / T, ablk = [], bblk = [];
  for (let i = 0; i < rows; i++) ablk.push(new Uint8Array(A.buffer.slice(i * T * K, (i + 1) * T * K)));
  for (let j = 0; j < cols; j++) bblk.push(new Uint8Array(BT.buffer.slice(j * T * K, (j + 1) * T * K)));
  const want = [];
  for (let u = 0; u < rows * cols; u++) { const i = Math.floor(u / cols), j = u % cols, c = new Int32Array(T * T);
    matmulI8(new Int8Array(ablk[i].buffer), new Int8Array(bblk[j].buffer), T, K, T, c); want.push(c); }
  return { M, K, N, T, rows, cols, units: rows * cols, ablk, bblk, aId: ablk.map(sha16), bId: bblk.map(sha16), want };
}

// run(wsUrl, job, { perPack, corruptFirstBlock }) -> resolves { ok, bad, needs, devices, ms } when every unit is right
export function runHub(wsUrl, job, opt = {}) {
  const perPack = opt.perPack || 4;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl); ws.binaryType = "arraybuffer";
    const st = { ok: 0, bad: 0, needs: 0, devices: new Set(), resent: 0, results: 0, t0: Date.now() }, done = new Uint8Array(job.units);
    let next = 0, packNo = 0, corrupted = !opt.corruptFirstBlock;
    const packs = new Map();                      // pack -> { dev, units }
    const send = (dev, msg) => { const f = new Uint8Array(msg.length + 4); new DataView(f.buffer).setUint32(0, dev, true); f.set(msg, 4); ws.send(f); };
    function give(dev) {                          // units of one column (they share the BT block)
      const units = [];
      for (let tries = 0; tries < job.units && units.length < perPack; tries++) { const u = next++ % job.units; if (!done[u] && !units.includes(u)) units.push(u); }
      if (!units.length) return;
      const pack = ++packNo;
      packs.set(pack, { dev, units });
      send(dev, packMsg(1, pack, 1, units.map((u) => ({ unit: u, m: job.T, k: job.K, n: job.T, aId: job.aId[Math.floor(u / job.cols)], btId: job.bId[u % job.cols] }))));
    }
    ws.onopen = () => ws.send(JSON.stringify({ t: "status", job: 1, done: 0, total: job.units, open: true }));
    ws.onerror = (e) => reject(new Error("hub socket error"));
    ws.onmessage = (e) => {
      if (typeof e.data === "string") { const m = JSON.parse(e.data); if (m.t === "hello") { st.devices.add(m.dev); give(m.dev); } return; }
      const b = new Uint8Array(e.data), v = new DataView(e.data), dev = v.getUint32(0, true), kind = b[8];
      const pack = Number(v.getBigUint64(4 + 16, true)), rec = packs.get(pack);
      if (!rec) return;
      if (kind === 3) {                           // NEED: send the blocks asked for, then the pack again
        st.needs++;
        const count = v.getUint32(4 + 28, true);
        for (let i = 0; i < count; i++) {
          const id = b.subarray(4 + 32 + i * 16, 4 + 48 + i * 16), hex = Buffer.from(id).toString("hex");
          const ai = job.aId.findIndex((x) => Buffer.from(x).toString("hex") === hex), bi = job.bId.findIndex((x) => Buffer.from(x).toString("hex") === hex);
          const bytes = ai >= 0 ? job.ablk[ai] : job.bblk[bi];
          if (!corrupted) { corrupted = true; send(dev, blockMsg(bytes, true)); }   // refused by the device: it asks again
          send(dev, blockMsg(bytes, false));
        }
        send(dev, packMsg(1, pack, 1, rec.units.map((u) => ({ unit: u, m: job.T, k: job.K, n: job.T, aId: job.aId[Math.floor(u / job.cols)], btId: job.bId[u % job.cols] }))));
        return;
      }
      if (kind !== 2) return;
      st.results++;
      let p = 4 + 36;
      for (let i = 0; i < b[4 + 32]; i++) {
        const unit = v.getUint32(p, true), m = v.getUint32(p + 4, true), n = v.getUint32(p + 8, true); p += 12;
        const c = new Int32Array(m * n); for (let j = 0; j < c.length; j++, p += 4) c[j] = v.getInt32(p, true);
        const w = job.want[unit], same = c.length === w.length && c.every((x, j) => x === w[j]);
        if (same && !done[unit]) { done[unit] = 1; st.ok++; } else if (!same) st.bad++;
      }
      packs.delete(pack);
      if (st.ok === job.units) { st.ms = Date.now() - st.t0; ws.close(); resolve(st); return; }
      give(dev);
    };
    setTimeout(() => reject(new Error("hub timed out: " + JSON.stringify({ ...st, devices: st.devices.size }))), opt.timeout || 60000);
  });
}
