// Test of the website's downloads and the email sign-in on My content (TESTING.md test 31), in headless Chromium: the
// given worker.js answers every planetcompute.ai request in-process. The account is faked; the downloads read the
// real B2 client/LATEST.json when B2_KEY_ID / B2_APPLICATION_KEY are in the environment (read only), else they say
// "Not available".
//   cd <folder with playwright-core and its chromium> && node <repo>/scripts/test_site_download_signin.mjs <worker.js> <screenshot dir>
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/")("playwright-core");
import { copyFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const tmp = join(mkdtempSync(join(tmpdir(), "dl-")), "w.mjs"); copyFileSync(process.argv[2], tmp);
globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default, OUT = process.argv[3];
const ENV = process.env.B2_KEY_ID ? { B2_MODELS_KEY_ID: process.env.B2_KEY_ID, B2_MODELS_APP_KEY: process.env.B2_APPLICATION_KEY } : {};
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, x === undefined ? "" : JSON.stringify(x)); } };
let signedIn = false, devices = [];
const posted = [];
const FILES = { files: [{ name: "fox.png", bytes: 500000, at: Date.now() - 6e4, views: 3, type: "image/png", url: "https://planetcompute.ai/u/AAAAAAAAAA" },
                        { name: "waves.webm", bytes: 900000, at: Date.now() - 3e4, views: 0, type: "video/webm", url: "https://planetcompute.ai/u/BBBBBBBBBB" }],
  trash: [], used: 1400000, quota: 5e8, trash_days: 30 };
async function route(r) {
  const u = new URL(r.request().url()), p = u.pathname, m = r.request().method();
  const J = (x, st = 200, h = {}) => r.fulfill({ status: st, contentType: "application/json", headers: h, body: JSON.stringify(x) });
  if (m === "POST") posted.push([p, JSON.parse(r.request().postData() || "{}")]);
  if (p === "/api/auth/start") return J({ ok: true });
  if (p === "/api/auth/verify") { const b = JSON.parse(r.request().postData()); if (b.code !== "123456") return J({ error: "That code is not right." }, 401); signedIn = true; return J({ user_id: "u1", primary_email: b.email, name: "" }); }
  if (p === "/api/me") return signedIn ? J({ user_id: "u1", primary_email: "a@b.c" }) : J({ error: "Not signed in." }, 401);
  if (p === "/api/mycontent") return signedIn ? J(FILES) : J({ error: "Not signed in." }, 401);
  if (p === "/api/tunnel/devices") return signedIn ? J({ devices }) : J({ error: "Not signed in." }, 401);
  if (p.startsWith("/api/")) return J({ error: "Not signed in." }, 401);
  if (p.startsWith("/u/")) return r.fulfill({ status: 200, contentType: "image/png", body: Buffer.alloc(0) });
  if (p.startsWith("/device/")) return r.fulfill({ status: 200, contentType: "text/html", headers: { "x-frame-options": "SAMEORIGIN" }, body: "<body>PROGRAM</body>" });
  if (p.startsWith("/download/") && m === "GET") {            // only the headers of a real download (HEAD), not 100 MB
    const res = await W.fetch(new Request(u.toString(), { method: "HEAD" }), ENV); const h = {}; res.headers.forEach((v, k) => h[k] = v);
    return r.fulfill({ status: res.status, headers: h, body: "" });
  }
  const res = await W.fetch(new Request(u.toString(), { method: m }), ENV); const h = {}; res.headers.forEach((v, k) => h[k] = v);
  return r.fulfill({ status: res.status, headers: h, body: Buffer.from(await res.arrayBuffer()) });
}
const b = await chromium.launch(); const errs = [];
async function page(w, h) {
  const pg = await b.newPage({ viewport: { width: w, height: h } });
  pg.on("pageerror", (e) => errs.push(e.message));
  pg.on("console", (m) => { if (m.type() === "error" && !/401|Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 200)); });
  await pg.route(/^https:\/\/planetcompute\.ai\//, route); await pg.route(/^https?:\/\/(?!planetcompute\.ai\/)/, (r) => r.abort());
  return pg;
}
// ---- Harness Compute, Inference: the download line
let pg = await page(1400, 900);
await pg.goto("https://planetcompute.ai/harness#inference"); await pg.waitForTimeout(1500);
const ga = await pg.evaluate(() => { const g = document.getElementById("getApp"), dl = document.getElementById("xDl");
  return { oldBox: getComputedStyle(g).display, buttons: [...document.querySelectorAll("#xBanner a.btn")].filter((a) => getComputedStyle(a).display !== "none").map((a) => a.textContent + " " + a.getAttribute("href")),
    other: document.getElementById("xOther").getAttribute("href"), banner: getComputedStyle(document.getElementById("xBanner")).display !== "none" }; });
// user 2026-10-29: "we do not need download all here - who needs all? Just one of the three" (the Express banner, test 77)
ok("1 Inference with no PC, signed out: the old three-button line is gone; the Express banner has ONE button: Sign In (signed in it is one download button for this system: test_express_mode.mjs)",
  ga.oldBox === "none" && ga.banner && ga.buttons.length === 1 && ga.buttons[0] === "Sign In /?auth=signin", ga);
await pg.screenshot({ path: OUT + "/dl-inference.png" });
// ---- /download
await pg.goto("https://planetcompute.ai/download"); await pg.waitForTimeout(800);
const dl = await pg.evaluate(() => ({ h1: document.querySelector("h1").textContent, buttons: [...document.querySelectorAll(".dl a.btn")].map((a) => a.getAttribute("href")), cards: document.querySelectorAll(".dl").length, text: document.body.innerText }));
if (ENV.B2_MODELS_KEY_ID) ok("2 /download: the page with Windows, Mac, Linux, Linux with a GPU, size and SHA-256 of each", dl.h1 === "Website may not activate all features, to get all features, Download our client app for Windows, Mac or Linux." && dl.cards === 4 && dl.buttons.join() === "/download/windows,/download/mac,/download/linux,/download/linux-vulkan" && /SHA-256/.test(dl.text), dl.buttons);
else ok("2 /download without B2 keys: the four systems, each 'Not available right now'", dl.cards === 4 && (dl.text.match(/Not available right now/g) || []).length === 4);
await pg.screenshot({ path: OUT + "/dl-page.png", fullPage: true });
if (ENV.B2_MODELS_KEY_ID) {
  for (const [k, name] of [["windows", "planetCompute.exe"], ["mac", "planetCompute"], ["linux", "planetCompute"]]) {
    const res = await W.fetch(new Request("https://planetcompute.ai/download/" + k, { method: "HEAD" }), ENV);
    ok(`3 /download/${k}: the file as ${name}, its size`, res.status === 200 && res.headers.get("content-disposition") === `attachment; filename="${name}"` && +res.headers.get("content-length") > 3e7, [res.status, res.headers.get("content-disposition"), res.headers.get("content-length")]);
  }
}
const old = await W.fetch(new Request("https://planetcompute.ai/download/planetComputeClient.exe"), ENV);
ok("4 the old link /download/planetComputeClient.exe goes to /download/windows", old.status === 302 && old.headers.get("location") === "https://planetcompute.ai/download/windows");
// ---- Cloud Content: sign in by email, then the files
await pg.goto("https://planetcompute.ai/harness#cloud"); await pg.waitForTimeout(1500);
let mc = pg.frames().find((f) => f.url().includes("/mycontent?embed=1"));
ok("5 Cloud Content signed out: an email box and 'Email me a one-time code' (no link away), the code step not shown yet", !!mc && await mc.evaluate(() => !document.getElementById("signin").hidden && !document.getElementById("sForm").hidden && document.getElementById("app").hidden &&
  getComputedStyle(document.getElementById("cForm")).display === "none"));
await pg.screenshot({ path: OUT + "/dl-cloud-signin.png" });
await mc.fill("#sEmail", "new.user@example.com"); await mc.click("#sGo"); await pg.waitForTimeout(500);
ok("6 the code is asked for that address; the code box shows", posted.some((x) => x[0] === "/api/auth/start" && x[1].email === "new.user@example.com") && await mc.evaluate(() => !document.getElementById("cForm").hidden && document.getElementById("sTo").textContent === "new.user@example.com"));
await mc.fill("#sCode", "000000"); await mc.click("#sOk"); await pg.waitForTimeout(500);
ok("7 a wrong code: the reason shows, still signed out", /not right/.test(await mc.evaluate(() => document.getElementById("sMsg").textContent)) && await mc.evaluate(() => document.getElementById("app").hidden));
await mc.fill("#sCode", "123456"); await mc.click("#sOk"); await pg.waitForTimeout(1200);
ok("8 the right code: signed in, the pictures and videos show at once", await mc.evaluate(() => document.getElementById("signin").hidden && !document.getElementById("app").hidden && /fox\.png/.test(document.body.innerText) && /waves\.webm/.test(document.body.innerText) && /My files \(2\)/.test(document.body.innerText)));
await pg.screenshot({ path: OUT + "/dl-cloud-files.png" });
// ---- already signed in: the files at once
await pg.goto("https://planetcompute.ai/harness#cloud"); await pg.waitForTimeout(1500);
mc = pg.frames().find((f) => f.url().includes("/mycontent?embed=1"));
ok("9 already signed in: Cloud Content shows the files, no sign-in form", await mc.evaluate(() => document.getElementById("signin").hidden && /fox\.png/.test(document.body.innerText)));
await pg.close();
// ---- the home page learns about a sign-in made inside Harness Compute
signedIn = false; pg = await page(1400, 900);
await pg.goto("https://planetcompute.ai/"); await pg.waitForTimeout(1200);
await pg.evaluate(() => { const c = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "OK"); if (c) c.click(); });
const before = await pg.evaluate(() => document.getElementById("acctBtn").className);
await pg.click('nav.top .modes [data-mode="content"]'); await pg.waitForTimeout(1500);
mc = pg.frames().find((f) => f.url().includes("/mycontent?embed=1"));
await mc.fill("#sEmail", "a@b.c"); await mc.click("#sGo"); await pg.waitForTimeout(400); await mc.fill("#sCode", "123456"); await mc.click("#sOk"); await pg.waitForTimeout(1500);
const after = await pg.evaluate(() => document.getElementById("acctBtn").className);
ok("10 signing in inside Cloud Content signs in the page around it (the header's account button)", !/\bin\b/.test(before) && /\bin\b/.test(after), [before, after]);
await pg.close();
// ---- phone
signedIn = false; pg = await page(390, 844);
await pg.goto("https://planetcompute.ai/harness#inference"); await pg.waitForTimeout(1200);
ok("11 phone: the download line fits, no sideways scroll", await pg.evaluate(() => document.documentElement.scrollWidth <= 390 && document.getElementById("getApp").getBoundingClientRect().right <= 390));
await pg.screenshot({ path: OUT + "/dl-phone.png" });
await pg.close(); await b.close();
ok("12 no script errors", errs.length === 0, errs);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
