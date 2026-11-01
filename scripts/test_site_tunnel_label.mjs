// Test of the corner label on pages from the user's computer through the device link (TESTING.md test 34): the given worker.js
// in-process with a faked user and a faked program behind the link; then Chromium. No keys.
//   cd <folder with playwright-core and its chromium> && node <repo>/scripts/test_site_tunnel_label.mjs <worker.js> <screenshot dir>
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/")("playwright-core");
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
let src = readFileSync(process.argv[2], "utf8");
src = src.replace("async function currentUser(env, request) {", "async function currentUser(env, request) { return { user_id: 'u1', token: 't' };");
const tmp = join(mkdtempSync(join(tmpdir(), "lb-")), "w.mjs"); writeFileSync(tmp, src); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default;
const APP = readFileSync("/home/ubuntu/environment/planetCompute/planetCompute-CPP/client/ui/index.html", "utf8"), PNG = readFileSync("/home/ubuntu/environment/planetCompute/planetCompute-CPP/.ops/media_samples/out/flux-cat.png");
const fakeDevice = { fetch: async (u, o) => { const path = o.headers["x-pc-path"];      // the program behind the link
  if (path.startsWith("/local/content/file/")) return new Response(PNG, { headers: { "content-type": "image/png" } });
  if (path.startsWith("/local/") && !path.includes("/local/content") && !path.includes("models") && !path.includes("info")) return new Response(APP, { headers: { "content-type": "text/html; charset=utf-8" } });
  return new Response(JSON.stringify(path.includes("content") ? { folder: "/p", files: [] } : {}), { headers: { "content-type": "application/json" } }); } };
const env = { TUNNEL: { idFromName: () => "x", get: () => fakeDevice }, AWS_ACCESS_KEY_ID: "x", SESSION_SECRET: "x".repeat(40) };
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
const page = await (await devGet("https://planetcompute.ai/device/f808264cb709/local/")).text();
ok("1 the program's page through the link carries the label", page.includes("Using a Tunnel to Your Local Machine") && page.includes("pc-tunnel"));
const pic = await devGet("https://planetcompute.ai/device/f808264cb709/local/content/file/flux-cat.png");
const bytes = Buffer.from(await pic.arrayBuffer());
ok("2 a picture through the link is unchanged (same bytes)", pic.headers.get("content-type") === "image/png" && bytes.equals(PNG), [bytes.length, PNG.length]);
const api = await (await devGet("https://planetcompute.ai/device/f808264cb709/local/content")).text();
ok("3 API answers are unchanged (no label)", !api.includes("Tunnel") && JSON.parse(api).folder === "/p");
const home = await (await W.fetch(new Request("https://planetcompute.ai/"), {})).text();
ok("4 the website's own pages have no label", !home.includes("Using a Tunnel to Your Local Machine"));
const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1300, height: 600 } });
await pg.route(ROUTE, async (r) => { const res = await devGet(r.request().url(), { method: r.request().method() }); const h = {}; res.headers.forEach((v, k) => h[k] = v); r.fulfill({ status: res.status, headers: h, body: Buffer.from(await res.arrayBuffer()) }); });
await pg.goto("https://planetcompute.ai/device/f808264cb709/local/#content"); await pg.waitForTimeout(1500);
const st = await pg.evaluate(() => { const box = document.querySelector(".pc-tunnel"), sp = box.querySelector("span"), r = box.getBoundingClientRect(), c = getComputedStyle(sp);
  const cx = r.right - 40, cy = r.top + 40, under = document.elementFromPoint(cx, cy);           // a point on the ribbon
  return { right: Math.round(r.right), vw: innerWidth, top: Math.round(r.top), rotated: c.transform !== "none", color: c.color, bg: c.backgroundColor, pe: getComputedStyle(box).pointerEvents,
    clickGoesTo: under && (under.closest(".pc-tunnel") ? "RIBBON" : under.tagName), text: sp.textContent, frame: getComputedStyle(document.getElementById("consoleFrame")).display }; });
ok("5 in the browser: a diagonal corner ribbon at the top right, yellow text on a see-through band, clicks go through to the page", st.right === st.vw && st.top === 0 && st.rotated &&
  st.color === "rgb(255, 216, 77)" && /rgba\(7, 91, 120, 0\.55\)/.test(st.bg) && st.pe === "none" && st.clickGoesTo !== "RIBBON" && st.text === "Using a Tunnel to Your Local Machine", st);
ok("5b the program's empty console frame is hidden even for older programs", st.frame === "none", st.frame);
await pg.screenshot({ path: process.argv[3] + "/label.png", clip: { x: 1000, y: 0, width: 300, height: 260 } }); await b.close();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail);
