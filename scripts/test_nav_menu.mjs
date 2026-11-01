// docs/TESTING.md test 83 (user 2026-10-30): (1) "My Balance" was sometimes not shown next to Share Compute / Receive
// Compute / My Content / Local Tunnel URL: on the program's page (also the Local Tunnel URL page and Express) below ~700 px
// the five tabs did not fit and My Balance was pushed off behind a hidden scroll; now short labels and a second row, so all
// five are always on screen. (2) The account (profile) menu also lists every page ("Go to"), website and program, so
// there are two ways to each. Headless Chromium; the website from the given worker.js, the program page from its file.
//   cd <folder with playwright-core> && node <repo>/scripts/test_nav_menu.mjs <worker.js> <client/ui/index.html> [shots]
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/")("playwright-core");
import { copyFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join, dirname } from "node:path";
const tmp = join(mkdtempSync(join(tmpdir(), "nm-")), "w.mjs"); copyFileSync(process.argv[2], tmp); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default, PROG = readFileSync(process.argv[3], "utf8"), SHOTS = process.argv[4] || "";
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, x === undefined ? "" : JSON.stringify(x).slice(0, 600)); } };
const b = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell" });
const ME = { user_id: "u1", primary_email: "maria@example.com", first_name: "Maria", last_name: "Gonzalez" };
const NAV = ["Share Compute", "Receive Compute", "Models", "Local Content", "Cloud Content", "Local Tunnel URL", "My Balance", "Download planetCompute"];

// ---- the website
const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
await ctx.addInitScript(() => { try { localStorage.setItem("pc-cookies-ok", "1"); } catch (e) {} });
await ctx.route("**/*", async (r) => { const u = new URL(r.request().url()); if (u.hostname !== "planetcompute.ai") return r.fulfill({ body: "" });
  const J = (x, st = 200) => r.fulfill({ status: st, contentType: "application/json", body: JSON.stringify(x) });
  if (u.pathname === "/api/me") return J(ME);
  if (u.pathname === "/api/me/balance") return J({ shared_wu: 1, received_wu: 0, difference_wu: 1, lifetime_contributed_wu: 184.88, lifetime_transferred_wu: 0 });
  if (u.pathname.startsWith("/api/")) return J({});
  const res = await W.fetch(new Request(u.toString()), {}); const h = {}; res.headers.forEach((v, k) => h[k] = v); return r.fulfill({ status: res.status, headers: h, body: Buffer.from(await res.arrayBuffer()) }); });
const menuItems = (p) => p.$$eval(".pc-menu.open button.pc-nav", (es) => es.map((e) => e.textContent.trim()));
let p = await ctx.newPage();
await p.goto("https://planetcompute.ai/balance"); await p.waitForTimeout(800);
await p.click(".pc-end .pc-acct"); await p.waitForTimeout(150);
const got = await menuItems(p), hdr = await p.$eval(".pc-menu.open .pc-mh", (e) => e.textContent).catch(() => "");
ok("1 site: the account menu has 'Go to' with every page: " + NAV.join(", "), hdr === "Go to" && JSON.stringify(got) === JSON.stringify(NAV), { hdr, got });
if (SHOTS) await p.screenshot({ path: SHOTS + "/menu_site.png", clip: { x: 760, y: 0, width: 520, height: 760 } });
await Promise.all([p.waitForURL(/\/harness#connect$/), p.click(".pc-menu.open button.pc-nav:has-text('Local Tunnel URL')")]); await p.waitForTimeout(1500);
const htab = () => p.evaluate(() => (document.querySelector(".htabs button[aria-selected='true']") || {}).dataset?.t || "");
const lit = () => p.evaluate(() => (document.querySelector(".modes [aria-current]") || {}).dataset ? document.querySelector(".modes [aria-current]").dataset.mode : "");
ok("2 site: from My Balance, Go to > Local Tunnel URL opens /harness#connect (Connect a Browser) with Local Tunnel URL lit",
  await lit() === "url" && await htab() === "connect" && await p.isVisible("#pConnect"), { lit: await lit(), tab: await htab() });
await p.click(".pc-end .pc-acct"); await p.waitForTimeout(150); await p.click(".pc-menu.open button.pc-nav:has-text('Cloud Content')"); await p.waitForTimeout(800);
ok("3 site: on the Harness page, Go to > Cloud Content switches in place: /harness#cloud, My Content lit", /\/harness#cloud$/.test(p.url()) && await lit() === "content"
  && await htab() === "cloud" && await p.isVisible("#pCloud"), { url: p.url(), lit: await lit(), tab: await htab() });
await p.click(".pc-end .pc-acct"); await p.waitForTimeout(150); await p.click(".pc-menu.open button.pc-nav:has-text('Models')"); await p.waitForTimeout(800);
ok("4 site: Go to > Models: /harness#models (the Models tab), Receive Compute lit", /\/harness#models$/.test(p.url()) && await lit() === "harness" && await htab() === "models", { url: p.url() });
await p.click(".pc-end .pc-acct"); await p.waitForTimeout(150); await Promise.all([p.waitForURL(/\/balance$/), p.click(".pc-menu.open button.pc-nav:has-text('My Balance')")]); await p.waitForTimeout(600);
ok("5 site: Go to > My Balance opens /balance", /\/balance$/.test(p.url()) && await lit() === "balance");
await p.goto("https://planetcompute.ai/harness#inference"); await p.waitForTimeout(1200);
await p.click(".pc-end .pc-acct"); await p.waitForTimeout(150); await p.click(".pc-menu.open button.pc-nav:has-text('Share Compute')"); await p.waitForTimeout(800);
ok("6 site: Go to > Share Compute closes Receive Compute and opens the sharing panel, as the top button does", !(await p.evaluate(() => document.getElementById("harnessView").classList.contains("open"))) && await lit() === "contribute");
// a phone, cookie notice not yet read: the (now longer) menu's last items are not under the notice
const pc = await b.newContext({ viewport: { width: 390, height: 760 } });
await pc.route("**/*", async (r) => { const u = new URL(r.request().url()); if (u.hostname !== "planetcompute.ai") return r.fulfill({ body: "" });
  if (u.pathname === "/api/me") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ME) });
  if (u.pathname.startsWith("/api/")) return r.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  const res = await W.fetch(new Request(u.toString()), {}); const h = {}; res.headers.forEach((v, k) => h[k] = v); return r.fulfill({ status: res.status, headers: h, body: Buffer.from(await res.arrayBuffer()) }); });
const pp = await pc.newPage(); await pp.goto("https://planetcompute.ai/balance"); await pp.waitForTimeout(900);
const ck0 = await pp.isVisible(".pc-cookies");
await pp.click(".pc-end .pc-acct"); await pp.waitForTimeout(200);
const hitOut = await pp.evaluate(() => { const b0 = [...document.querySelectorAll(".pc-menu.open button")].pop(), r = b0.getBoundingClientRect(), e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { t: b0.textContent, hit: !!e && (e === b0 || b0.contains(e)) }; });
ok("6b site, phone, cookie notice showing: with the menu open the notice steps aside, so the last item (Sign Out) can be tapped; it is back when the menu closes",
  ck0 && hitOut.t === "Sign Out" && hitOut.hit && !(await pp.isVisible(".pc-cookies")) && (await pp.keyboard.press("Escape"), await pp.waitForTimeout(150), await pp.isVisible(".pc-cookies")), { ck0, hitOut });
await pc.close();

// ---- the program's page (also what the Local Tunnel URL and Express show)
async function prog(w) {
  const pg = await b.newPage({ viewport: { width: w, height: 860 } });
  await pg.route("**/*", (rt) => { const u = new URL(rt.request().url()), J = (o, s = 200) => rt.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(o) });
    if (u.pathname === "/local/" || u.pathname === "/") return rt.fulfill({ contentType: "text/html", body: PROG });
    if (u.pathname === "/local/info") return J({ version: "0.1.0", port: 7526, device: "abc123abc123", engine: {}, signed_in: true });
    if (u.pathname === "/api/me") return J(ME);
    if (u.pathname === "/api/me/balance") return J({ shared_wu: 1, received_wu: 0, difference_wu: 1, lifetime_contributed_wu: 3, lifetime_transferred_wu: 0 });
    if (u.pathname.startsWith("/api/") || u.pathname.startsWith("/local/")) return J({});
    return rt.abort(); });
  await pg.goto("http://127.0.0.1:7526/local/"); await pg.waitForTimeout(1200); return pg;
}
const tabsOk = (pg) => pg.evaluate(() => [...document.querySelectorAll("header nav button")].map((bt) => { const r = bt.getBoundingClientRect(), y = r.top + r.height / 2;
  const hit = [r.left + 3, r.left + r.width / 2, r.right - 3].every((x) => { const e = document.elementFromPoint(x, y); return e && (e === bt || bt.contains(e)); });
  return { t: bt.textContent.trim().replace(/\s+/g, " "), vis: getComputedStyle(bt.querySelector(".lg")).display !== "none" ? bt.querySelector(".lg").textContent : bt.querySelector(".sm").textContent, ok: r.width > 0 && r.left >= 0 && r.right <= innerWidth + 0.5 && hit }; }));
for (const w of [320, 390, 600, 700]) {
  const pg = await prog(w), t = await tabsOk(pg);
  ok(`7 program at ${w} px: all five tabs on screen and clickable, short labels (Share, Receive, My Content, Tunnel URL, Balance)`, t.every((x) => x.ok) && t.map((x) => x.vis).join("|") === "Share|Receive|My Content|Tunnel URL|Balance", t);
  if (SHOTS && w === 390) await pg.screenshot({ path: SHOTS + "/prog_390.png", clip: { x: 0, y: 0, width: 390, height: 200 } });
  await pg.close();
}
const pw = await prog(1280), tw = await tabsOk(pw);
ok("8 program at 1280 px: the full labels (Share Compute ... My Balance), all on screen", tw.every((x) => x.ok) && tw.map((x) => x.vis).join("|") === "Share Compute|Receive Compute|My Content|Local Tunnel URL|My Balance", tw);
const pitems = async () => { await pw.click("#hAvatar"); await pw.waitForTimeout(150); return pw.$$eval("#hMenu [data-go]", (es) => es.map((e) => e.textContent.trim())); };
const pi = await pitems();
ok("9 program: the account menu has 'Go to' with every page", await pw.$eval("#hMenu .hmh", (e) => e.textContent) === "Go to" && JSON.stringify(pi) === JSON.stringify(NAV.slice(0, 7)) && await pw.isVisible("#hAccount") && await pw.isVisible("#hSignOut"), pi);
if (SHOTS) await pw.screenshot({ path: SHOTS + "/menu_prog.png", clip: { x: 760, y: 0, width: 520, height: 600 } });
const state = () => pw.evaluate(() => ({ lit: (document.querySelector("header nav button[aria-selected='true']") || {}).dataset?.tab, sec: [...document.querySelectorAll("main section")].filter((s) => !s.hidden).map((s) => s.id).join(),
  sub: ((document.getElementById("harness").querySelector(".subtabs button[aria-selected='true']") || {}).dataset || {}).sub, menu: document.getElementById("hMenu").hidden }));
await pw.click("#hMenu [data-go='harness:models']"); await pw.waitForTimeout(400); let s1 = await state();
ok("10 program: Go to > Models opens Receive Compute's Models tab, Receive Compute lit, the menu closes", s1.sec === "harness" && s1.sub === "models" && s1.lit === "harness" && s1.menu, s1);
await pitems(); await pw.click("#hMenu [data-go='access']"); await pw.waitForTimeout(400); s1 = await state();
ok("11 program: Go to > Local Tunnel URL opens Connect a Browser, Local Tunnel URL lit", s1.sub === "connect" && s1.lit === "access", s1);
await pitems(); await pw.click("#hMenu [data-go='harness:cloud']"); await pw.waitForTimeout(400); s1 = await state();
ok("12 program: Go to > Cloud Content opens Cloud Content, My Content lit", s1.sub === "cloud" && s1.lit === "content", s1);
await pitems(); await pw.click("#hMenu [data-go='balance']"); await pw.waitForTimeout(500); s1 = await state();
ok("13 program: Go to > My Balance opens My Balance, lit", s1.sec === "balance" && s1.lit === "balance", s1);
await pitems(); await pw.click("#hMenu [data-go='contribute']"); await pw.waitForTimeout(400); s1 = await state();
ok("14 program: Go to > Share Compute opens Share Compute, lit", s1.sec === "contribute" && s1.lit === "contribute", s1);
await b.close(); rmSync(dirname(tmp), { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
