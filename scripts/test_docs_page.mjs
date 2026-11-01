// docs/TESTING.md test 97: Documentation and Disclaimer (website/docs_content.html) on the website (/docs) and in the
// program (tab Docs): the page answers, all 12 sections and the crypto disclaimer are there, nothing is wider than the
// screen (360-1280 px), the footer and account-menu links exist, no "PlanetCompute.org"; in the program the Docs tab
// shows only the docs section, the menu item opens it, and the other tabs still work.
//   cd <folder with playwright-core> && node <repo>/scripts/test_docs_page.mjs <repo>/website/worker.js <repo>/client/ui/index.html [shots dir]
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/")("playwright-core");
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const tmp = join(mkdtempSync(join(tmpdir(), "dc-")), "w.mjs"); copyFileSync(process.argv[2], tmp); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default;
const UI = readFileSync(process.argv[3], "utf8"), SHOTS = process.argv[4] || "";
const SRC = readFileSync(process.argv[2], "utf8");
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, x === undefined ? "" : JSON.stringify(x).slice(0, 300)); } };
const CRYPTO = "All PlanetComp is disbursed from the official PlanetCompute wallet. Before transferring any PlanetComp to an external crypto wallet, check the laws in your country and local area. If holding cryptocurrency is not permitted where you live, do not make the transfer, whether or not PlanetComp has any value. If PlanetComp ever gains value, that value can fall or be lost entirely at any time. By transferring PlanetComp, you acknowledge and accept these risks. Use your own discretion; you are responsible for complying with the laws that apply to you.";
const b = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell" });

// ---- website ----
for (const path of ["/docs", "/documentation"]) {
  const r = await W.fetch(new Request("https://planetcompute.ai" + path), {});
  ok(`site ${path} answers 200 text/html`, r.status === 200 && (r.headers.get("content-type") || "").includes("text/html"), r.status);
}
ok("site: no PlanetCompute.org anywhere in the worker", !SRC.includes("PlanetCompute.org"));
ok("site: account menu lists Docs and Disclaimer", SRC.includes('["Docs and Disclaimer", "/docs"]'));
for (const w of [360, 768, 1280]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 } });
  await ctx.route("**/*", async (r) => { const u = new URL(r.request().url()); if (u.hostname !== "planetcompute.ai") return r.fulfill({ body: "" });
    if (u.pathname.startsWith("/api/")) return r.fulfill({ status: 401, contentType: "application/json", body: "{}" });
    const res = await W.fetch(new Request(u.toString()), {}); const h = {}; res.headers.forEach((v, k) => h[k] = v); return r.fulfill({ status: res.status, headers: h, body: Buffer.from(await res.arrayBuffer()) }); });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto("https://planetcompute.ai/docs"); await p.waitForTimeout(500);
  const m = await p.evaluate(() => ({ h1: (document.querySelector(".pcdocs h1") || {}).textContent, h2: [...document.querySelectorAll(".pcdocs h2")].length,
    toc: [...document.querySelectorAll(".pcdocs .toc a")].every((a) => document.getElementById(a.getAttribute("href").slice(1))),
    text: document.querySelector(".pcdocs").innerText.replace(/\s+/g, " "), wide: document.documentElement.scrollWidth > innerWidth + 1, bar: !!document.querySelector(".pcbar") }));
  ok(`site ${w}px: title, 12 sections, every contents link has its section, top bar`, m.h1 === "Documentation and Disclaimer" && m.h2 === 12 && m.toc && m.bar, m);
  ok(`site ${w}px: the crypto disclaimer is there word for word`, m.text.includes(CRYPTO.replace("'", "’")) || m.text.includes(CRYPTO), m.text.slice(m.text.indexOf("Check your"), m.text.indexOf("Check your") + 120));
  ok(`site ${w}px: not wider than the screen, no script errors`, !m.wide && errs.length === 0, errs);
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/site-docs-${w}.png`, fullPage: false });
  if (w === 1280) {
    await p.goto("https://planetcompute.ai/"); await p.waitForTimeout(600);
    const f = await p.evaluate(() => [...document.querySelectorAll("footer a")].some((a) => a.getAttribute("href") === "/docs" && a.textContent === "Docs and Disclaimer"));
    ok("site home: footer links to Docs and Disclaimer", f);
  }
  await ctx.close();
}

// ---- program ----
for (const w of [480, 900, 1141, 1280, 1441]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 860 } });
  await ctx.route("**/*", async (r) => { const u = new URL(r.request().url());
    if (u.hostname === "127.0.0.1" && (u.pathname === "/" || u.pathname === "/index.html")) return r.fulfill({ contentType: "text/html", body: UI });
    if (u.hostname === "127.0.0.1") return r.fulfill({ status: 401, contentType: "application/json", body: "{}" });
    return r.fulfill({ body: "" }); });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => { if (!/HTTP 401/.test(String(e))) errs.push(String(e)); });   // the fake program answers 401 to every API call
  await p.goto("http://127.0.0.1:7526/"); await p.waitForTimeout(700);
  await p.click('header nav button[data-tab="docs"]'); await p.waitForTimeout(200);
  const m = await p.evaluate(() => ({ shown: [...document.querySelectorAll("main > section")].filter((s) => !s.hidden).map((s) => s.id),
    sel: (document.querySelector('header nav button[aria-selected="true"]') || {}).dataset.tab, h2: document.querySelectorAll("#docs .pcdocs h2").length,
    crypto: document.querySelector("#docs").innerText.replace(/\s+/g, " ").includes("you are responsible for complying with the laws that apply to you."), wide: document.documentElement.scrollWidth > innerWidth + 1,
    navWide: (() => { const n = document.querySelector("header nav"); return n.scrollWidth > n.clientWidth + 1; })() }));
  ok(`program ${w}px: Docs tab shows only the docs section, is selected, 12 sections, crypto disclaimer`, JSON.stringify(m.shown) === '["docs"]' && m.sel === "docs" && m.h2 === 12 && m.crypto, m);
  ok(`program ${w}px: page and tab bar not wider than the window, no script errors`, !m.wide && !m.navWide && errs.length === 0, { m, errs });
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/program-docs-${w}.png`, fullPage: false });
  await p.click('header nav button[data-tab="balance"]'); await p.waitForTimeout(200);
  const back = await p.evaluate(() => [...document.querySelectorAll("main > section")].filter((s) => !s.hidden).map((s) => s.id));
  ok(`program ${w}px: My Balance still opens (docs hidden again)`, JSON.stringify(back) === '["balance"]', back);
  const mi = await p.evaluate(() => !!document.querySelector('#hMenu [data-go="docs"]'));
  ok(`program ${w}px: account menu has Docs and Disclaimer`, mi);
  await ctx.close();
}
await b.close();
console.log(`docs page: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
