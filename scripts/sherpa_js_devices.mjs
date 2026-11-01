// JavaScript SherpaHub devices for tests (docs/TESTING.md test 68): the browser's device code (website/
// workpack_device.mjs + the WebAssembly SIMD kernel) connected to a broker until killed; prints a JSON line of
// counts every 2 s. --lie: every answer has one wrong number (the hub must strike and ban it).
// --prompts: also takes whole prompts (TASK, docs/SHERPAHUB.md section 11) for the fake models "fake-chat" (answer:
// "echo <prompt> seed <seed>", the same on every device) and "fake-image" (a 1024 x 1024 PNG of ~3 MB made from the
// seed, sent back in parts); with --lie the answers differ (the hub's check must say DIFFERENT).
//   node scripts/sherpa_js_devices.mjs <ws://broker> <count> [--lie] [--prompts] [--prefix 0a]
import { createHash } from "node:crypto";
import { makeSherpaDevice } from "../website/workpack_device.mjs";
import { makeSimdMatmul } from "../website/workpack_kernel.mjs";
import { deflateSync } from "node:zlib";
const [url, count] = [process.argv[2], Number(process.argv[3] || 1)], lie = process.argv.includes("--lie"), promptsToo = process.argv.includes("--prompts");
const pi = process.argv.indexOf("--prefix"), prefix = pi > 0 ? process.argv[pi + 1] : lie ? "0b" : "0a";
const mm = makeSimdMatmul(), devs = [];
// ---- whole prompts (fake models) ----
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, "ascii"); data.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + data.length)), 8 + data.length); return b; }
function png(seed, w = 1024, h = 1024) {                // RGB noise from the seed (incompressible: ~3 MB, several parts)
  const raw = Buffer.alloc((w * 3 + 1) * h); let x = (seed >>> 0) || 1;
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let i = 1; i <= w * 3; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; raw[y * (w * 3 + 1) + i] = x & 255; } }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}
function frame(kind, meta, bytes) {
  const j = Buffer.from(JSON.stringify(meta)), b = Buffer.alloc(12 + j.length + bytes.length);
  b.writeUInt32LE(0x50574350, 0); b[4] = kind; b[5] = 1; b.writeUInt32LE(j.length, 8); j.copy(b, 12); bytes.copy(b, 12 + j.length); return b;
}
// like the program: a prompt goes on when the connection drops; its answer is sent on the connection there is then;
// a new connection's hello lists the prompts still being made ("busy")
function answerTask(ws, buf, s) {
  const b = Buffer.from(buf), jl = b.readUInt32LE(8), t = JSON.parse(b.subarray(12, 12 + jl).toString()), seed = t.params.seed | 0;
  const key = t.job + ":" + t.n + ":" + (t.copy | 0);
  if (s.running[key]) { s.running[key].task_id = t.task_id; return; }     // already being made: answer under the new number
  s.running[key] = { job: t.job, n: t.n, copy: t.copy | 0, task_id: t.task_id };
  const t0 = Date.now(); let meta = { task_id: t.task_id, ok: true, ms: 0, ext: "png" }, file = Buffer.alloc(0);
  if (t.model === "fake-chat") meta.text = "echo " + t.prompt + " seed " + seed + (lie ? " (lie " + Math.random() + ")" : "");
  else if (t.model === "fake-image") file = png(lie ? seed + 1 : seed);
  else meta = { task_id: t.task_id, ok: false, error: "no such model here" };
  meta.ms = Date.now() - t0;
  const P = 900 * 1024, parts = Math.max(1, Math.ceil(file.length / P));
  // prompts starting with "slow" take 0.4 s, "veryslow" 8 s (so a test can stop the hub or the site in the middle)
  setTimeout(() => {
    const cur = s.running[key]; delete s.running[key];
    const m = { ...meta, task_id: cur.task_id, job: t.job, n: t.n, copy: t.copy | 0 };
    s.outbox.push([...Array(parts).keys()].map((i) => frame(6, { ...m, part: i, parts }, file.subarray(i * P, (i + 1) * P))));
    flush(s);
  }, /^veryslow/.test(t.prompt) ? 8000 : /^slow/.test(t.prompt) ? 400 : 0);
  s.tasks++;
}
for (let i = 0; i < count; i++) {
  const s = { closed: null, d: null, tasks: 0, units: 0, packs: 0, running: {}, outbox: [], ws: null };
  const go = () => {
    if (s.d) { s.units += s.d.stats.units; s.packs += s.d.stats.packs; }   // totals over every connection
    const ws = new WebSocket(`${url}/api/sherpa/device?device=${prefix}${String(i).padStart(10, "0")}&kinds=${promptsToo ? "packs,prompts" : "packs"}`); ws.binaryType = "arraybuffer";
    s.d = makeSherpaDevice({ cacheBytes: 64 << 20, sha256: async (b) => new Uint8Array(createHash("sha256").update(b).digest()),
      compute: async (us) => us.map((u) => { const c = new Int32Array(u.m * u.n); mm(u.a, u.bt, u.m, u.k, u.n, c); if (lie) c[(c.length * Math.random()) | 0] += 1; return c; }),
      send: (b) => { if (ws.readyState === 1) ws.send(b); }, rest: async () => {} });
    s.ws = ws;
    ws.onopen = () => { ws.send(JSON.stringify({ t: "hello", cache: 64 << 20, cores: 1, name: "js-" + prefix + i,
      models: promptsToo ? [{ id: "fake-chat", kind: "text" }, { id: "fake-image", kind: "image" }] : [], busy: Object.values(s.running) })); flush(s); };
    ws.onmessage = (e) => { if (typeof e.data === "string") return; if (new Uint8Array(e.data)[4] === 5) answerTask(ws, e.data, s); else s.d.push(e.data); };
    // try again a second later (once per attempt): after a close, and after a refused connection (Node's WebSocket
    // may report a refused handshake as an error only); banned (4008) stays out
    let again = false;
    const retry = () => { if (again) return; again = true; setTimeout(go, 1000); };
    ws.onclose = (e) => { s.closed = e.code; if (e.code !== 4008) retry(); };
    ws.onerror = () => { if (ws.readyState !== 1) retry(); };
  };
  go(); devs.push(s);
}
function flush(s) {                                     // whole answers, on the connection there is now
  while (s.outbox.length && s.ws && s.ws.readyState === 1) { const a = s.outbox.shift(); for (const f of a) s.ws.send(f); }
}
setInterval(() => console.log(JSON.stringify({ lie, tasks: devs.reduce((a, s) => a + s.tasks, 0), units: devs.reduce((a, s) => a + s.units + s.d.stats.units, 0), packs: devs.reduce((a, s) => a + s.packs + s.d.stats.packs, 0),
  banned: devs.filter((s) => s.closed === 4008).length, closes: devs.map((s) => s.closed) })), 2000);
