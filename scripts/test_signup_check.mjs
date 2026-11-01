// docs/TESTING.md test 84 (browser part): a NEW account needs the Cloudflare Turnstile check (user 2026-10-30: not a free
// storage). Home page: the site answers 428 need_turnstile, the check shows, passing it sends the code. /balance (and
// /mycontent): a new address goes to the home page's sign-up with the email. The program: a button opens the sign-up on
// planetcompute.ai in the browser. Headless Chromium; the website from the given worker.js, the program from its file;
// the sign-in API and Turnstile faked.
//   cd <folder with playwright-core> && node <repo>/scripts/test_signup_check.mjs <worker.js> <client/ui/index.html>
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/")("playwright-core");
import { copyFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join, dirname } from "node:path";
const tmp = join(mkdtempSync(join(tmpdir(), "sc-")), "w.mjs"); copyFileSync(process.argv[2], tmp); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default, PROG = readFileSync(process.argv[3], "utf8");
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, x === undefined ? "" : JSON.stringify(x).slice(0, 500)); } };
const b = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell" });
const starts = [];
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript(() => { try { localStorage.setItem("pc-cookies-ok", "1"); } catch (e) {} });
await ctx.route("**/*", async (r) => { const u = new URL(r.request().url());
  if (u.hostname === "challenges.cloudflare.com")   // a stand-in Turnstile: renders, then passes at once
    return r.fulfill({ contentType: "text/javascript", body: "window.turnstile={render:function(el,o){var d=document.querySelector(el);d.setAttribute('data-ts',o.sitekey);setTimeout(function(){o.callback('good-token')},100);return 'w1'},reset:function(){}};window.pcTurnstileReady&&window.pcTurnstileReady();" });
  if (u.hostname !== "planetcompute.ai") return r.fulfill({ body: "" });
  const J = (x, st = 200) => r.fulfill({ status: st, contentType: "application/json", body: JSON.stringify(x) });
  if (u.pathname === "/api/me") return J({ error: "Not signed in." }, 401);
  if (u.pathname === "/api/auth/start") { const bd = JSON.parse(r.request().postData() || "{}"); starts.push(bd);
    return bd.turnstile === "good-token" ? J({ ok: true }) : J({ need_turnstile: true, sitekey: "site-key-1", error: "New account: please complete the check below, then press the button again." }, 428); }
  if (u.pathname.startsWith("/api/")) return J({ error: "Not signed in." }, 401);
  const res = await W.fetch(new Request(u.toString()), {}); const h = {}; res.headers.forEach((v, k) => h[k] = v); return r.fulfill({ status: res.status, headers: h, body: Buffer.from(await res.arrayBuffer()) }); });
let p = await ctx.newPage();
await p.goto("https://planetcompute.ai/?auth=signup"); await p.waitForTimeout(900);
await p.fill("#authEmail", "sam@newmail.example"); await p.click("#sendCode"); await p.waitForTimeout(1500);
const st = await p.evaluate(() => ({ chk: !document.getElementById("suCheck").hidden, key: document.getElementById("suCheck").getAttribute("data-ts"), code: document.getElementById("vCode").classList.contains("show"), to: document.getElementById("codeTo").textContent }));
ok("1 home, a new address: the site asks for the check (428), the Turnstile box shows with the site key; passing it sends again with the token -> the code step",
  starts.length === 2 && !starts[0].turnstile && starts[1].turnstile === "good-token" && st.key === "site-key-1" && st.code && st.to === "sam@newmail.example", { starts, st });
starts.length = 0;
await p.goto("https://planetcompute.ai/balance"); await p.waitForTimeout(900);
await p.fill("#sEmail", "kim@newmail.example");
await Promise.all([p.waitForURL(/planetcompute\.ai\/(\?|$|#)/, { timeout: 8000 }).catch(() => {}), p.click("#sGo")]); await p.waitForTimeout(2000);
const st2 = await p.evaluate(() => ({ url: location.href, email: (document.getElementById("authEmail") || {}).value, code: document.getElementById("vCode") && document.getElementById("vCode").classList.contains("show") }));
ok("2 /balance, a new address: to the home page's sign-up with the email filled in, the check passed, the code step",
  /planetcompute\.ai\/(\?|$|#)/.test(st2.url) && !/auth=|email=/.test(st2.url) && st2.email === "kim@newmail.example" && st2.code && starts.some((x) => x.turnstile === "good-token" && x.email === "kim@newmail.example"), { st2, starts });
await ctx.close();
// the program
const pg = await b.newPage({ viewport: { width: 1280, height: 900 } }); let opened = null;
await pg.route("**/*", (rt) => { const u = new URL(rt.request().url()), J = (o, s = 200) => rt.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(o) });
  if (u.pathname === "/local/" || u.pathname === "/") return rt.fulfill({ contentType: "text/html", body: PROG });
  if (u.pathname === "/local/info") return J({ version: "0.1.0", port: 7526, device: "abc123abc123", engine: {}, signed_in: false });
  if (u.pathname === "/api/me") return J({ error: "Not signed in." }, 401);
  if (u.pathname === "/api/auth/start") return J({ need_turnstile: true, sitekey: "site-key-1", error: "New account: please complete the check below, then press the button again." }, 428);
  if (u.pathname === "/local/open") { opened = JSON.parse(rt.request().postData()).url; return J({ ok: true }); }
  if (u.pathname.startsWith("/api/") || u.pathname.startsWith("/local/")) return J({});
  return rt.abort(); });
await pg.goto("http://127.0.0.1:7526/local/"); await pg.waitForTimeout(1200);
await pg.evaluate(() => { const t = document.querySelector('[data-sub="account"]'); t && t.click(); }); await pg.waitForTimeout(300);
await pg.fill("#email", "lee@newmail.example"); await pg.evaluate(() => document.getElementById("signin").requestSubmit()); await pg.waitForTimeout(600);
const perr = await pg.textContent("#err");
ok("3 program, a new address: 'New account: please sign up on planetcompute.ai first ...' and a button", /^New account: please sign up on planetcompute\.ai first/.test(perr) && await pg.isVisible("#signupWeb"), perr);
await pg.click("#signupWeb"); await pg.waitForTimeout(300);
ok("4 program: the button opens https://planetcompute.ai/?auth=signup&email=<the address> in the browser", opened === "https://planetcompute.ai/?auth=signup&email=lee%40newmail.example", opened);
// issue 3: "Where you are signed in" on the profile sheet (signed in; the list and the sign-out calls faked)
const c2 = await b.newContext({ viewport: { width: 1280, height: 900 } }), outs = [];
await c2.addInitScript(() => { try { localStorage.setItem("pc-cookies-ok", "1"); } catch (e) {} });
await c2.route("**/*", async (r) => { const u = new URL(r.request().url()); if (u.hostname !== "planetcompute.ai") return r.fulfill({ body: "" });
  const J = (x, st = 200) => r.fulfill({ status: st, contentType: "application/json", body: JSON.stringify(x) });
  if (u.pathname === "/api/me") return J({ user_id: "u1", primary_email: "pat@example.com", first_name: "Pat", emails: [{ email: "pat@example.com", primary: true }] });
  if (u.pathname === "/api/me/sessions") return J({ sessions: [{ id: "a1", current: true, kind: "browser", browser: "Firefox on Mac", country: "DE", created_at: "2026-10-30T06:00:00Z" },
    { id: "b2", current: false, kind: "browser", browser: "Chrome on Windows", country: "US", created_at: "2026-10-29T10:00:00Z" }, { id: "c3", current: false, kind: "server", browser: "planetCompute server", created_at: "2026-10-29T00:00:00Z" }] });
  if (u.pathname === "/api/me/sessions/signout") { outs.push(JSON.parse(r.request().postData())); return J({ ok: true, signed_out: 1 }); }
  if (u.pathname.startsWith("/api/")) return J({});
  const res = await W.fetch(new Request(u.toString()), {}); const h = {}; res.headers.forEach((v, k) => h[k] = v); return r.fulfill({ status: res.status, headers: h, body: Buffer.from(await res.arrayBuffer()) }); });
const p5 = await c2.newPage(); await p5.goto("https://planetcompute.ai/?auth=settings#sessions"); await p5.waitForTimeout(1500);
const li = await p5.$$eval("#sessList li", (es) => es.map((e) => ({ t: e.querySelector("span").textContent, b: !!e.querySelector("button") })));
ok("5 profile: 'Where you are signed in' lists this one first ('this one', no button), the others with Sign out, the in-house server without", li.length === 3 && /^Firefox on Mac · DE · since 2026-10-30 06:00 UTC · this one$/.test(li[0].t) && !li[0].b
  && /^Chrome on Windows · US/.test(li[1].t) && li[1].b && /in-house server$/.test(li[2].t) && !li[2].b, li);
await p5.click("#sessList li:nth-child(2) button"); await p5.waitForTimeout(400); await p5.click("#sessOut"); await p5.waitForTimeout(400);
ok("6 profile: Sign out sends that one's ID; Sign out everywhere else sends all_others", JSON.stringify(outs) === JSON.stringify([{ id: "b2" }, { all_others: true }]) && /Signed out of 1 other place\./.test(await p5.textContent("#msgSess")), outs);
await c2.close();
await b.close(); rmSync(dirname(tmp), { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
