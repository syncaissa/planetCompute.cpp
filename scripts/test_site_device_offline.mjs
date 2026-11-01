// Test of the device link's offline and sign-in pages (TESTING.md test 36): the given worker.js in-process, the user and
// the device faked (connected or not), then headless Chromium: the message, Try again, the automatic retry, and both
// shown inside Receive Compute's frame (no refused-frame page). No keys.
//   cd <folder with playwright-core and its chromium> && node <repo>/scripts/test_site_device_offline.mjs <worker.js> <screenshot dir>
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/")("playwright-core");
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
let src = readFileSync(process.argv[2], "utf8");
{ const i = src.indexOf("async function handleDevice("), k = "const who = await currentUser(env, request);", j = src.indexOf(k, i);
  src = src.slice(0, j) + "const who = globalThis.__signed ? { user_id: 'u1' } : null;" + src.slice(j + k.length); }
const tmp = join(mkdtempSync(join(tmpdir(), "off-")), "w.mjs"); writeFileSync(tmp, src); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default, OUT = process.argv[3];
let connected = false;
const device = { fetch: async () => connected ? new Response("<!doctype html><body>PROGRAM PAGE</body>", { headers: { "content-type": "text/html" } })
  : new Response("", { status: 404, headers: { "x-pc-tunnel": "offline" } }) };
const env = { TUNNEL: { idFromName: () => "x", get: () => device }, AWS_ACCESS_KEY_ID: "x", SESSION_SECRET: "x".repeat(40) };
// device pages are on device.planetcompute.ai (security review T1): follow planetcompute.ai -> ticket -> the link's cookie
const devCookies = {};
async function devGet(u, init = {}) {
  let url = u;
  for (let i = 0; i < 5; i++) {
    const h = new URL(url).hostname === "device.planetcompute.ai" ? { cookie: Object.values(devCookies).join("; ") } : {};
    const r = await W.fetch(new Request(url, { redirect: "manual", ...init, headers: { ...(init.headers || {}), ...h } }), env);
    const sc = r.headers.get("set-cookie"); if (sc) devCookies[sc.split("=")[0]] = sc.split(";")[0];
    if (r.status !== 302) return r;
    url = new URL(r.headers.get("location"), url).toString();
  }
  throw new Error("too many redirects");
}
const ROUTE = /^https:\/\/(device\.)?planetcompute\.ai\//, OTHER = /^https?:\/\/(?!(device\.)?planetcompute\.ai\/)/;
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
globalThis.__signed = true;
const r = await devGet("https://planetcompute.ai/device/f808264cb709/");
ok("1 not connected: on the device host, a page that only planetcompute.ai may frame (no refused frame)", r.status === 503 && !r.headers.get("x-frame-options") && /frame-ancestors https:\/\/planetcompute\.ai/.test(r.headers.get("content-security-policy")), [r.status, r.headers.get("x-frame-options")]);
const b = await chromium.launch(); const errs = [];
async function page(w, h) { const pg = await b.newPage({ viewport: { width: w, height: h } }); pg.on("pageerror", (e) => errs.push(e.message));
  await pg.route(ROUTE, async (rt) => { const u = new URL(rt.request().url());
    if (u.pathname === "/api/tunnel/devices") return rt.fulfill({ contentType: "application/json", body: JSON.stringify(globalThis.__signed ? { devices: [{ device: "f808264cb709", name: "DESKTOP-HOME", online: true, link: "https://planetcompute.ai/device/f808264cb709/" }] } : {}) , status: globalThis.__signed ? 200 : 401 });
    if (u.pathname.startsWith("/api/")) return rt.fulfill({ status: 401, contentType: "application/json", body: "{}" });
    const res = u.pathname.startsWith("/device/") ? await devGet(u.toString()) : await W.fetch(new Request(u.toString()), env); const hd = {}; res.headers.forEach((v, k) => hd[k] = v); rt.fulfill({ status: res.status, headers: hd, body: Buffer.from(await res.arrayBuffer()) }); });
  await pg.route(OTHER, (rt) => rt.abort()); return pg; }
let pg = await page(1200, 800);
await pg.goto("https://planetcompute.ai/device/f808264cb709/"); await pg.waitForTimeout(1500);
const t = await pg.evaluate(() => document.body.innerText);
ok("2 opened directly: the message, Try again, Get planetCompute, and the automatic retry counting down", /not connected right now/i.test(t) && /Try again/.test(t) && /Get planetCompute/.test(t) && /Trying again in 1[0-4] s/.test(t), t.slice(0, 300));
await pg.screenshot({ path: OUT + "/offline-direct.png" });
connected = true; await pg.click("#again"); await pg.waitForTimeout(1200);
ok("3 Try again after the program starts: the program's page opens", /PROGRAM PAGE/.test(await pg.evaluate(() => document.body.innerText)));
connected = false; await pg.close();
pg = await page(1300, 800); await pg.goto("https://planetcompute.ai/harness#local"); await pg.waitForTimeout(2500);
const fr = pg.frames().find((f) => f.url().includes("/device/f808264cb709/"));
const ft = fr ? await fr.evaluate(() => document.body.innerText).catch((e) => "ERR " + e.message) : "NO FRAME";
ok("4 inside Receive Compute, Local Content: the message shows in the frame (not the browser's refused-frame face)", /not connected right now/i.test(ft), ft.slice(0, 200));
await pg.screenshot({ path: OUT + "/offline-frame.png" }); await pg.close();
globalThis.__signed = false;
const s = await W.fetch(new Request("https://planetcompute.ai/device/f808264cb709/"), env);
const st = await s.text();
ok("5 signed out: the sign-in page, framable by this site, with Sign in and Try again", s.status === 401 && s.headers.get("x-frame-options") === "SAMEORIGIN" && /Sign in to open your computer/.test(st) && /Try again/.test(st));
await b.close(); ok("6 no script errors", !errs.length, errs);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
