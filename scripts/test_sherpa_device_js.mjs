// docs/TESTING.md test 66: the browser's SherpaHub device code (website/workpack_device.mjs + workpack_kernel.mjs, the
// same text the contributor page runs) through the REAL broker (website/worker.js SherpaBroker in `wrangler dev`),
// against the JavaScript test hub (scripts/sherpa_test_hub.mjs). Run: start the broker as in test 65, then
// `node scripts/test_sherpa_device_js.mjs [http://127.0.0.1:8799]`.
import { createHash } from "node:crypto";
import { makeSherpaDevice } from "../website/workpack_device.mjs";
import { matmulI8, makeSimdMatmul } from "../website/workpack_kernel.mjs";
import { makeJob, runHub } from "./sherpa_test_hub.mjs";
const BASE = process.argv[2] || "http://127.0.0.1:8799", WS = BASE.replace(/^http/, "ws");
let pass = 0, fail = 0;
const ok = (c, what) => { if (c) { pass++; console.log("PASS", what); } else { fail++; console.log("FAIL", what); } };
const simd = makeSimdMatmul();
ok(!!simd, "0. WebAssembly SIMD kernel available in this engine");

function device(id, cacheBytes, kernel) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS}/api/sherpa/device?device=${id}`); ws.binaryType = "arraybuffer";
    const d = makeSherpaDevice({ cacheBytes,
      sha256: async (b) => new Uint8Array(createHash("sha256").update(b).digest()),
      compute: async (units) => units.map((u) => { const c = new Int32Array(u.m * u.n); kernel(u.a, u.bt, u.m, u.k, u.n, c); return c; }),
      send: (b) => ws.send(b), rest: async () => {} });
    ws.onopen = () => { ws.send(JSON.stringify({ t: "hello", cache: cacheBytes, cores: 1 })); resolve({ ws, d }); };
    ws.onmessage = (e) => { if (typeof e.data !== "string") d.push(e.data); };
  });
}
const job = makeJob({ M: 256, K: 512, N: 256, T: 64 });     // 16 units, blocks of 32 KiB

// 1. one device, big cache, SIMD kernel; the first block it gets is corrupted (refused, asked for again)
let hub = runHub(`${WS}/api/sherpa/hub?device=feed00000001`, job, { perPack: 4, corruptFirstBlock: true });
await new Promise((r) => setTimeout(r, 300));
let d1 = await device("0d0000000001", 64 << 20, simd);
let st = await hub;
ok(st.ok === 16 && st.bad === 0, `1. all 16 units exact through the broker (${st.ms} ms)`);
ok(st.needs >= 1, `1. NEED path used (${st.needs} NEEDs)`);
ok(d1.d.stats.refused >= 1, `1. corrupted block refused by the device (${d1.d.stats.refused})`);
d1.ws.close();

// 2. three devices; one with a cache of 2 blocks only (evicts, asks again, still exact); plain-JS kernel on one
await new Promise((r) => setTimeout(r, 500));
const job2 = makeJob({ M: 512, K: 1024, N: 256, T: 64, seed: 99 });   // 32 units, blocks of 64 KiB
hub = runHub(`${WS}/api/sherpa/hub?device=feed00000002`, job2, { perPack: 3 });
await new Promise((r) => setTimeout(r, 300));
const ds = [await device("0d0000000002", 64 << 20, simd), await device("0d0000000003", 2 * 65536, simd), await device("0d0000000004", 64 << 20, matmulI8)];
st = await hub;
ok(st.ok === 32 && st.bad === 0, `2. 32 units exact with 3 devices (${st.devices.size} took part, ${st.ms} ms)`);
ok(ds[1].d.cached() <= 2, `2. small-cache device kept at most 2 blocks (${ds[1].d.cached()})`);
ok(ds.every((x) => x.d.stats.refused === 0), "2. nothing refused");
ds.forEach((x) => x.ws.close());
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
