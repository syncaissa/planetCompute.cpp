// Test (TESTING.md test 39): maximized pictures and videos on the website hide their text after 3 s still, and a mouse
// move brings it back: My Content's large view (in full screen) and a share page (/u/...). The given worker.js runs
// in-process with the signed-in user and the answers faked; headless Chromium. No keys.
//   cd <folder with playwright-core and its chromium> && node <repo>/scripts/test_site_idle.mjs <worker.js> <picture.png>
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/")("playwright-core");
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
let src = readFileSync(process.argv[2], "utf8");
src = src.replace("async function currentUser(env, request) {", "async function currentUser(env, request) { return { user_id: 'u1', token: 't' };");
const tmp = join(mkdtempSync(join(tmpdir(), "idle-")), "w.mjs"); writeFileSync(tmp, src); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default, PIC = readFileSync(process.argv[3]);
const env = { AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "y", AWS_REGION: "us-east-1", DDB_PREFIX: "t-", SESSION_SECRET: "s".repeat(40), MAIL_FROM: "test@planetcompute.ai" };
const FILES = { files: [{ name: "cat.png", bytes: 1e6, at: Date.now(), type: "image/png", url: "https://planetcompute.ai/u/CAT0000001", views: 1 }], trash: [], used: 1e6, quota: 5e8 };
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
const br = await chromium.launch(), errs = [];
const pg = await br.newPage({ viewport: { width: 1200, height: 800 } }); pg.on("pageerror", (e) => errs.push(e.message));
await pg.route(/^https:\/\/planetcompute\.ai\//, async (rt) => { const u = new URL(rt.request().url());
  if (u.pathname === "/api/me") return rt.fulfill({ contentType: "application/json", body: '{"user_id":"u1","primary_email":"a@b.c"}' });
  if (u.pathname === "/api/mycontent") return rt.fulfill({ contentType: "application/json", body: JSON.stringify(FILES) });
  if (u.pathname.endsWith("/file")) return rt.fulfill({ contentType: "image/png", body: PIC });
  const res = await W.fetch(new Request(u.toString()), env); const hd = {}; res.headers.forEach((v, k) => hd[k] = v); rt.fulfill({ status: res.status, headers: hd, body: Buffer.from(await res.arrayBuffer()) }); });
await pg.route(/^https?:\/\/(?!planetcompute\.ai\/)/, (rt) => rt.abort());
await pg.goto("https://planetcompute.ai/mycontent"); await pg.waitForTimeout(1500);
await pg.evaluate(() => { const t = document.querySelector(".thumb img, .thumb"); t.click(); }); await pg.waitForTimeout(600);
const vis = () => pg.evaluate(() => [".lbbar"].map((c) => getComputedStyle(document.querySelector("#lb " + c)).opacity).join(","));
ok("1 My Content: the large view opens", await pg.evaluate(() => !document.getElementById("lb").hidden));
await pg.waitForTimeout(3600);
ok("2 not maximized: its bar stays", (await vis()) === "1");
await pg.click("#lbMax"); await pg.mouse.move(600, 300); await pg.waitForTimeout(3800);
ok("3 maximized and 3 s still: the bar with the name and buttons is gone, and the pointer", (await pg.evaluate(() => document.fullscreenElement === document.getElementById("lb"))) && (await vis()) === "0" &&
  (await pg.evaluate(() => getComputedStyle(document.getElementById("lb")).cursor)) === "none", await vis());
await pg.mouse.move(650, 330); await pg.waitForTimeout(600);
ok("4 a mouse move brings it back", (await vis()) === "1");
await pg.keyboard.press("Escape"); await pg.waitForTimeout(500);
ok("5 no script errors on My Content", !errs.length, errs);
const shareJs = src.match(/function vc\(on\)\{[^\n]*\n/); ok("6 (code check) the share page's idle code also hides a video's controls", !!shareJs && /vc\(false\)/.test(src) && /vc\(true\)/.test(src));
await br.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
