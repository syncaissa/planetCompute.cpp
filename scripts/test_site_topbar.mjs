// Test of the website top bar and Receive Compute (Harness) tabs (TESTING.md test 30), in headless Chromium: the given worker.js
// answers every planetcompute.ai request in-process; the account and its computers are faked (no keys, nothing live).
//   cd <folder with playwright-core and its chromium> && node <repo>/scripts/test_site_topbar.mjs <worker.js> <screenshot dir> [in|out]
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/")("playwright-core");
import { copyFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const tmp = join(mkdtempSync(join(tmpdir(), "tb-")), "w.mjs"); copyFileSync(process.argv[2], tmp);
globalThis.WebSocketRequestResponsePair = class {};
// the site asks in the page now (pcConfirm), not in a browser pop-up: answer OK and keep the question (window.__asked)
const AUTO_OK = () => { if (window.__autoOk) return; window.__autoOk = 1; window.__asked = [];
  new MutationObserver(() => { const t = document.querySelector(".pc-toast.ask:not([data-seen])"); if (!t) return; t.dataset.seen = "1";
    window.__asked.push(t.querySelector(".pc-t-msg").textContent); setTimeout(() => t.querySelector(".pc-ok").click(), 0); })
    .observe(document, { childList: true, subtree: true }); };
const asked = (where) => where.evaluate(() => (window.__asked || []).slice(-1)[0] || "");
const W = (await import(tmp)).default, OUT = process.argv[3], signed = process.argv[4] !== "out";
const DEVS = { devices: [{ device: "aaaaaaaaaaaa", name: "DESKTOP-HOME", online: true, since: "2026-10-26T10:00:00Z", link: "https://planetcompute.ai/device/aaaaaaaaaaaa/" },
                         { device: "bbbbbbbbbbbb", name: "LAPTOP", online: false, since: "2026-10-20T10:00:00Z", link: "https://planetcompute.ai/device/bbbbbbbbbbbb/" }] };
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, x === undefined ? "" : JSON.stringify(x)); } };
const posted = [];
async function route(r) {
  const u = new URL(r.request().url()), p = u.pathname;
  const J = (x, st = 200) => r.fulfill({ status: st, contentType: "application/json", body: JSON.stringify(x) });
  if (r.request().method() === "POST") posted.push(p);
  if (p === "/api/me") return signed ? J({ user_id: "u1", email: "a@b.c", name: "Test User", admin: false }) : J({ error: "Not signed in." }, 401);
  if (p === "/api/tunnel/devices") return signed ? J(DEVS) : J({ error: "Not signed in." }, 401);
  if (p.startsWith("/api/tunnel/devices/delete")) return J({ ok: true });
  if (p.startsWith("/api/")) return J({ error: "Not signed in." }, 401);
  if (p.startsWith("/device/")) return r.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><body style="background:#123;color:#fff;font:20px sans-serif">PROGRAM ${p}${u.search}${u.hash}</body>`,
    headers: { "x-frame-options": "SAMEORIGIN", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox allow-scripts allow-same-origin allow-forms" } });
  const res = await W.fetch(new Request(u.toString(), { method: r.request().method(), headers: r.request().headers() }), {});
  const headers = {}; res.headers.forEach((v, k) => headers[k] = v);
  return r.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
}
const b = await chromium.launch();
const errs = [];
async function page(w, h) {
  const pg = await b.newPage({ viewport: { width: w, height: h } });
  pg.on("pageerror", (e) => errs.push(e.message));
  pg.on("console", (m) => { if (m.type() === "error" && !/401|Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 200)); });
  await pg.route(/^https:\/\/planetcompute\.ai\//, route);
  await pg.route(/^https?:\/\/(?!planetcompute\.ai\/)/, (r) => r.abort());
  return pg;
}
const cur = (pg) => pg.evaluate(() => [...document.querySelectorAll("nav.top .modes [aria-current]")].map((e) => e.dataset.mode).join());
const hframe = (pg) => pg.frames().find((f) => f.url().includes("/harness?embed=1"));
// ---- wide, home page
let pg = await page(1400, 900);
await pg.goto("https://planetcompute.ai/"); await pg.waitForTimeout(1500);
await pg.evaluate(() => { const c = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "OK"); if (c) c.click(); });
ok("1 five buttons on top, in order: Share Compute, Receive Compute, My Content, Local Tunnel URL, My Balance", (await pg.evaluate(() => [...document.querySelectorAll("nav.top .modes [data-mode]")].map((e) => e.querySelector(".lg").textContent).join("|"))) === "Share Compute|Receive Compute|My Content|Local Tunnel URL|My Balance");
ok("2 no bottom tab bar", !(await pg.$("#tabbar")));
await pg.screenshot({ path: OUT + "/tb-home-wide.png" });
await pg.click('nav.top .modes [data-mode="harness"]'); await pg.waitForTimeout(2000);
let hf = hframe(pg);
ok("3 Harness Compute: address /harness#inference, Harness lit", pg.url().endsWith("/harness#inference") && (await cur(pg)) === "harness", [pg.url(), await cur(pg)]);
const dsrc = async () => { const at = await hf.evaluate(() => document.getElementById("devFrame").dataset.at); const fr = pg.frames().find((f) => f.url().includes("/device/aaaaaaaaaaaa/")); return fr && fr.url().endsWith(at) ? at : "frame at " + (fr && fr.url()) + " but asked " + at; };
if (signed) {
  ok("4 Inference shows the computer that is on, through its link (program tab, embed)", (await dsrc()) === "/device/aaaaaaaaaaaa/local/?embed=1&tab=inference#harness", await dsrc());
  const pf = pg.frames().find((f) => f.url().includes("/device/aaaaaaaaaaaa/local/"));
  ok("5 the program's page loads inside (frame allowed)", !!pf && /PROGRAM \/device\/aaaaaaaaaaaa\/local\//.test(await pf.evaluate(() => document.body.textContent)));
  ok("6 computer picker: on one chosen, off one listed but not choosable", await hf.evaluate(() => { const s = document.getElementById("devSel"); return !document.getElementById("devRow").hidden && s.value === "aaaaaaaaaaaa" && s.options.length === 2 && s.options[1].disabled; }));
  await pg.screenshot({ path: OUT + "/tb-harness-inference.png" });
  await hf.click('.htabs [data-t="models"]'); await pg.waitForTimeout(800);
  ok("7 Models tab: the program's Models, address follows, Harness still lit", (await dsrc()) === "/device/aaaaaaaaaaaa/local/?embed=1&tab=models#models" && pg.url().endsWith("/harness#models") && (await cur(pg)) === "harness", [await dsrc(), pg.url()]);
  await hf.click('.htabs [data-t="local"]'); await pg.waitForTimeout(800);
  ok("8 Local Content tab: the program's Local Content, My Content lit", (await dsrc()) === "/device/aaaaaaaaaaaa/local/?embed=1&tab=local#content" && (await cur(pg)) === "content", [await dsrc(), await cur(pg)]);
  await hf.click('.htabs [data-t="inference"]'); await pg.waitForTimeout(500);
}
await pg.click('nav.top .modes [data-mode="content"]'); await pg.waitForTimeout(1500);
hf = hframe(pg);
ok("9 My Content (top): Cloud Content tab with planetcompute.ai/mycontent inside, My Content lit", pg.url().endsWith("/harness#cloud") && (await cur(pg)) === "content" &&
  (await hf.evaluate(() => !document.getElementById("pCloud").hidden && document.getElementById("cloudFrame").getAttribute("src") === "/mycontent?embed=1")), [pg.url(), await cur(pg)]);
const mc = pg.frames().find((f) => f.url().includes("/mycontent?embed=1"));
ok("10 My Content page loads in the frame, without its own top bar, no stray text", !!mc && (await mc.evaluate(() => getComputedStyle(document.querySelector(".pcbar")).display)) === "none" && !(await mc.evaluate(() => document.body.innerText.includes("window.top"))));
await pg.screenshot({ path: OUT + "/tb-mycontent.png" });
await pg.click('nav.top .modes [data-mode="url"]'); await pg.waitForTimeout(1200);
ok("11 Local Tunnel URL (top): Connect a Browser tab, Local Tunnel URL lit", pg.url().endsWith("/harness#connect") && (await cur(pg)) === "url" && (await hf.evaluate(() => !document.getElementById("pConnect").hidden)), [pg.url(), await cur(pg)]);
if (signed) {
  ok("12 the links: both computers, on / off, Open Copy Delete; Delete all", await hf.evaluate(() => { const t = document.getElementById("mineList").textContent; return /DESKTOP-HOME/.test(t) && /LAPTOP/.test(t) && /on now/.test(t) && /off/.test(t) && document.querySelectorAll("#mineList .acts button").length === 6 && !document.getElementById("delAll").hidden; }));
  await hf.evaluate(AUTO_OK);
  await hf.evaluate(() => [...document.querySelectorAll("#mineList .acts button")].find((b) => b.textContent === "Delete").click()); await pg.waitForTimeout(600);
  ok("13 Delete asks (in the page), then deletes that link", /Delete the link to DESKTOP-HOME/.test(await asked(hf)) && posted.includes("/api/tunnel/devices/delete"), posted);
  await pg.screenshot({ path: OUT + "/tb-connect.png" });
}
await pg.goBack({ waitUntil: "commit", timeout: 5000 }).catch(() => {}); await pg.waitForTimeout(800);
ok("14 Back goes to the previous tab, at once (no steps inside the frames)", pg.url().endsWith("/harness#cloud") && (await cur(pg)) === "content" && (await hf.evaluate(() => !document.getElementById("pCloud").hidden)), [pg.url(), await cur(pg)]);
await pg.click('nav.top .modes [data-mode="contribute"]'); await pg.waitForTimeout(800);
ok("15 Contribute Compute closes Harness and opens the volunteer pop-up", (await pg.evaluate(() => !document.getElementById("harnessView").classList.contains("open"))) && (await cur(pg)) === "contribute");
await pg.close();
// ---- phone
pg = await page(390, 844);
await pg.goto("https://planetcompute.ai/"); await pg.waitForTimeout(1500);
await pg.evaluate(() => { const c = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "OK"); if (c) c.click(); });
const m = await pg.evaluate(() => ({ sw: document.documentElement.scrollWidth, btns: [...document.querySelectorAll("nav.top .modes [data-mode]")].map((e) => { const r = e.getBoundingClientRect(); return [e.textContent.trim().replace(/\s+/g, " "), r.right <= 391 && r.width > 40, r.top | 0]; }),
  acct: (() => { const a = document.getElementById("acctBtn"); const r = a.getBoundingClientRect(); return r.width > 0 && r.right <= 391; })() }));
ok("16 phone: no sideways scroll, the four buttons in one row on screen, account button visible", m.sw <= 390 && m.btns.length === 5 && m.btns.every((x) => x[1]) && new Set(m.btns.map((x) => x[2])).size === 1 && m.acct, m);
await pg.screenshot({ path: OUT + "/tb-home-phone.png" });
await pg.click('nav.top .modes [data-mode="harness"]'); await pg.waitForTimeout(1500);
await pg.screenshot({ path: OUT + "/tb-harness-phone.png" });
await pg.close();
// ---- standalone /harness
pg = await page(1400, 900);
await pg.goto("https://planetcompute.ai/harness#connect"); await pg.waitForTimeout(1500);
ok("17 /harness on its own: four buttons, Local Tunnel URL lit for #connect, tabs", (await pg.evaluate(() => [...document.querySelectorAll(".bar .modes [data-mode]")].length)) === 5 &&
  (await pg.evaluate(() => [...document.querySelectorAll(".bar .modes [aria-current]")].map((e) => e.dataset.mode).join())) === "url" && (await pg.evaluate(() => document.querySelectorAll(".htabs button").length)) === 5);
await pg.click('.bar .modes [data-mode="harness"]'); await pg.waitForTimeout(600);
ok("18 its Harness Compute button: Inference tab, no reload", pg.url().endsWith("/harness#inference") && (await pg.evaluate(() => document.querySelector('.htabs [aria-selected=true]').dataset.t)) === "inference");
if (!signed) ok("19 signed out: Inference says sign in (Express banner, test 77), and shows no computer row or empty program frame", /Sign in to use Express mode or to connect your PC/.test(await pg.evaluate(() => document.getElementById("xTitle").textContent)) &&
  (await pg.evaluate(() => getComputedStyle(document.getElementById("devFrame")).display === "none" && getComputedStyle(document.getElementById("devRow")).display === "none")));
await pg.screenshot({ path: OUT + "/tb-standalone-" + (signed ? "in" : "out") + ".png" });
await pg.close(); await b.close();
ok("20 no script errors", errs.length === 0, errs);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
