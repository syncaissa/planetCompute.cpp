// docs/TESTING.md test 75: the account menu (top right): signed out Sign In / Sign Up; signed in initials, name + email,
// My Account / Profile, Settings, Sign Out; Escape / click elsewhere close it; other pages go home with ?auth=.
//   cd <folder with playwright-core> && node <repo>/scripts/test_site_account_menu.mjs <worker.js>
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/")("playwright-core");
import { copyFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const tmp = join(mkdtempSync(join(tmpdir(), "mn-")), "w.mjs"); copyFileSync(process.argv[2], tmp); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default;
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, x === undefined ? "" : JSON.stringify(x)); } };
const b = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell" });
async function ctxFor(signed, posts) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 760 } });
  await ctx.route("**/*", async (r) => { const u = new URL(r.request().url()); if (u.hostname !== "planetcompute.ai") return r.fulfill({ body: "" });
    const J = (x, st = 200) => r.fulfill({ status: st, contentType: "application/json", body: JSON.stringify(x) });
    if (r.request().method() === "POST") posts.push(u.pathname);
    if (u.pathname === "/api/me") return signed.on ? J({ user_id: "u1", primary_email: "maria@example.com", first_name: "Maria", last_name: "Gonzalez" }) : J({ error: "x" }, 401);
    if (u.pathname === "/api/auth/signout") { signed.on = false; return J({ ok: true }); }
    if (u.pathname.startsWith("/api/")) return J(signed.on ? {} : { error: "x" }, signed.on ? 200 : 401);
    const res = await W.fetch(new Request(u.toString()), {}); const h = {}; res.headers.forEach((v, k) => h[k] = v); return r.fulfill({ status: res.status, headers: h, body: Buffer.from(await res.arrayBuffer()) }); });
  return ctx;
}
const items = (p) => p.$$eval(".pc-menu.open button, .pc-menu.open .pc-mwho", (es) => es.map((e) => e.textContent.trim()));
// signed out, another page
let posts = [], st = { on: false }, ctx = await ctxFor(st, posts), p = await ctx.newPage();
await p.goto("https://planetcompute.ai/balance"); await p.waitForTimeout(500);
await p.click(".pc-end .pc-acct"); await p.waitForTimeout(100);
ok("1 signed out: the person icon opens the Go to list (test 83), Sign In, Sign Up", JSON.stringify(await items(p)) === '["Share Compute","Receive Compute","Models","Local Content","Cloud Content","Local Tunnel URL","My Balance","Download planetCompute","Sign In","Sign Up"]', await items(p));
await p.screenshot({ path: "menu_out_390.png", clip: { x: 0, y: 0, width: 390, height: 260 } });
await p.keyboard.press("Escape"); ok("2 Escape closes it", !(await p.$(".pc-menu.open")));
await p.click(".pc-end .pc-acct"); await p.click("body", { position: { x: 20, y: 500 } }); ok("3 a click elsewhere closes it", !(await p.$(".pc-menu.open")));
await p.click(".pc-end .pc-acct"); await Promise.all([p.waitForURL(/planetcompute\.ai\/(\?|#|$)/), p.click("text=Sign Up")]); await p.waitForTimeout(700);
ok("4 Sign Up on another page goes home and opens the email sign-in", await p.evaluate(() => document.getElementById("authModal").classList.contains("open") && getComputedStyle(document.getElementById("authEmail")).display !== "none" && !location.search.includes("auth=")));
ok("5 the sign-in sheet shows the new note and button text", await p.evaluate(() => /No password needed\. We’ll email you a one-time code each time you sign in\./.test(document.getElementById("signinStd").textContent) && /nothing is saved until you enter the code/.test(document.getElementById("signinStd").textContent) && document.getElementById("sendCode").textContent === "Email me a one-time code"));
await ctx.close();
// signed in, home page
posts = []; st = { on: true }; ctx = await ctxFor(st, posts); p = await ctx.newPage();
await p.goto("https://planetcompute.ai/"); await p.waitForTimeout(700);
ok("6 signed in: the button shows the initials MG, not the person icon", await p.evaluate(() => { const b = document.querySelector(".pc-end .pc-acct"); return b.classList.contains("in") && b.querySelector(".av").textContent === "MG" && getComputedStyle(b.querySelector("svg")).display === "none"; }));
await p.click(".pc-end .pc-acct"); await p.waitForTimeout(100);
ok("7 signed in: name, email, the Go to list (test 83), My Account / Profile, Settings, Sign Out", JSON.stringify(await items(p)) === '["Maria Gonzalezmaria@example.com","Share Compute","Receive Compute","Models","Local Content","Cloud Content","Local Tunnel URL","My Balance","Download planetCompute","My Account / Profile","Settings","Sign Out"]', await items(p));
await p.screenshot({ path: "menu_in_390.png", clip: { x: 0, y: 0, width: 390, height: 300 } });
await p.click("text=My Account / Profile"); await p.waitForTimeout(300);
ok("8 My Account / Profile opens the profile sheet on the home page (no reload)", await p.evaluate(() => document.getElementById("authModal").classList.contains("open") && getComputedStyle(document.getElementById("vAccount")).display !== "none"));
await p.evaluate(() => document.getElementById("authClose").click());
await p.click(".pc-end .pc-acct"); await p.click("text=Sign Out"); await p.waitForTimeout(500);
ok("9 Sign Out signs out (POST /api/auth/signout) and the person icon is back", posts.includes("/api/auth/signout") && await p.evaluate(() => !document.querySelector(".pc-end .pc-acct").classList.contains("in")), posts);
await ctx.close();
// signed in, My Content: Settings goes home to the profile at the emails
posts = []; st = { on: true }; ctx = await ctxFor(st, posts); p = await ctx.newPage();
await p.goto("https://planetcompute.ai/mycontent"); await p.waitForTimeout(600);
await p.click(".pc-end .pc-acct"); await Promise.all([p.waitForURL(/planetcompute\.ai\/(\?|#|$)/), p.click("text=Settings")]); await p.waitForTimeout(900);
ok("10 Settings on another page: home, the profile sheet open", await p.evaluate(() => document.getElementById("authModal").classList.contains("open") && getComputedStyle(document.getElementById("vAccount")).display !== "none"));
await ctx.close(); await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
