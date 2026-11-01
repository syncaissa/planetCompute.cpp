// docs/TESTING.md test 67: the contributor page (the given worker.js, in-process, in headless Chromium) computes
// SherpaHub packs: signed in (faked /api/me), Start computing, the page finds a hub (/api/sherpa/status), and its
// /api/sherpa/device socket is piped to the REAL broker (`wrangler dev`, test 65), where the JavaScript test hub
// (scripts/sherpa_test_hub.mjs) leads a job and checks every unit. Also: WebAssembly SIMD used, pi WorkPacks resume.
//   cd <folder with playwright-core and chromium> && node <repo>/scripts/test_sherpa_page.mjs <worker.js> [http://127.0.0.1:8799] [screenshot]
import { createRequire } from "node:module";
const req = createRequire(process.cwd() + "/"), { chromium } = req("playwright-core");
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { makeJob, runHub } from "./sherpa_test_hub.mjs";
const tmp = join(mkdtempSync(join(tmpdir(), "sp-")), "w.mjs"); writeFileSync(tmp, readFileSync(process.argv[2], "utf8")); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default, BROKER = (process.argv[3] || "http://127.0.0.1:8799").replace(/^http/, "ws");
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };

const job = makeJob({ M: 512, K: 1024, N: 512, T: 64, seed: 2026 });        // 64 units
const hub = runHub(`${BROKER}/api/sherpa/hub?device=feed000000aa`, job, { perPack: 8, timeout: 90000 });
const br = await chromium.launch();
const pg = await br.newPage({ viewport: { width: 1100, height: 900 } }), errs = [];
pg.on("pageerror", (e) => errs.push(e.message));
pg.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 200)); });
await pg.route(/^https:\/\/planetcompute\.ai\//, async (rt) => { const u = new URL(rt.request().url());
  if (u.pathname === "/api/me") return rt.fulfill({ contentType: "application/json", body: JSON.stringify({ user_id: "u1", primary_email: "t@invalid", emails: [] }) });
  if (u.pathname === "/api/sherpa/status") return rt.fulfill({ contentType: "application/json", body: JSON.stringify({ hubs: 1 }) });
  if (u.pathname.startsWith("/api/")) return rt.fulfill({ contentType: "application/json", body: "{}" });
  const res = await W.fetch(new Request(u.toString()), {}); const hd = {}; res.headers.forEach((v, k) => hd[k] = v);
  rt.fulfill({ status: res.status, headers: hd, body: Buffer.from(await res.arrayBuffer()) }); });
await pg.route(/^https?:\/\/(?!planetcompute\.ai\/)/, (rt) => rt.abort());
let piped = 0;
await pg.routeWebSocket(/.*/, (ws) => {
  const u = new URL(ws.url());
  if (u.pathname !== "/api/sherpa/device") return ws.close();
  piped++;
  const up = new WebSocket(`${BROKER}/api/sherpa/device${u.search}`); up.binaryType = "arraybuffer";
  const early = [];
  up.onopen = () => { early.forEach((m) => up.send(m)); early.length = 0; };
  up.onmessage = (e) => ws.send(typeof e.data === "string" ? e.data : Buffer.from(e.data));
  up.onclose = () => ws.close();
  ws.onMessage((m) => { if (up.readyState === 1) up.send(m); else early.push(m); });
  ws.onClose(() => up.close());
});
await pg.goto("https://planetcompute.ai/?console=1"); await pg.waitForTimeout(2500);
await pg.evaluate(() => { const a = document.getElementById("agree"); if (!a.checked) a.click(); }); await pg.waitForTimeout(300);
await pg.evaluate(() => { const c = document.getElementById("cores"); if (c) { c.value = String(Math.min(2, Number(c.max) || 2)); c.dispatchEvent(new Event("input")); c.dispatchEvent(new Event("change")); } });
await pg.click("#startBtn");
let st = null;
try { st = await hub; } catch (e) { ok("1. the page computed the whole job", false, e.message); }
if (st) {
  ok(`1. the page computed all 64 units, every one exact (${st.ms} ms, ${st.results} RESULTs, ${st.needs} NEEDs)`, st.ok === 64 && st.bad === 0, st);
  ok("1. one device connection (the page)", piped === 1 && st.devices.size === 1, { piped, devices: st.devices.size });
}
await pg.waitForTimeout(800);
const meter = await pg.$eval("#mSherpa", (e) => e.textContent), note = await pg.$eval("#mSherpaNote", (e) => e.textContent);
ok(`2. meter shows the pieces done ("${meter}", "${note}")`, /^64 pieces$/.test(meter), meter);
ok("2. WebAssembly SIMD used (not plain JavaScript)", !/plain JavaScript/.test(note), note);
const p0 = await pg.$eval("#mPacks", (e) => e.textContent); await pg.waitForTimeout(2500); const p1 = await pg.$eval("#mPacks", (e) => e.textContent);
ok(`3. pi WorkPacks run again after the packs (${p0} -> ${p1})`, Number(p1.replace(/\D/g, "")) > Number(p0.replace(/\D/g, "")), { p0, p1 });
ok("4. no script error", errs.length === 0, errs);
if (process.argv[4]) await pg.screenshot({ path: process.argv[4] });
await pg.click("#pauseBtn").catch(() => {}); await br.close();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
