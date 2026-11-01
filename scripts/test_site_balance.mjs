// Test of My Balance (TESTING.md test 35): GET /api/me/balance from the given worker.js in-process (the signed-in user
// and the DynamoDB answer faked), then the /balance page and the fifth button in headless Chromium. No keys.
//   cd <folder with playwright-core and its chromium> && node <repo>/scripts/test_site_balance.mjs <worker.js> <screenshot dir>
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/")("playwright-core");
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
let src = readFileSync(process.argv[2], "utf8");
src = src.replace("async function currentUser(env, request) {", "async function currentUser(env, request) { if (globalThis.__signed) return { user_id: 'u1', token: 't' }; return null;");
const tmp = join(mkdtempSync(join(tmpdir(), "bal-")), "w.mjs"); writeFileSync(tmp, src); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default, OUT = process.argv[3];
const ITEM = { user_id: { S: "u1" }, sk: { S: "BALANCE" }, lifetime_contribution_uwu: { N: "123456789" }, lifetime_redeemed_uwu: { N: "20000000" }, available_uwu: { N: "103456789" } };
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => String(u).includes("dynamodb.") ? new Response(JSON.stringify({ Item: ITEM }), { headers: { "content-type": "application/x-amz-json-1.0" } }) : realFetch(u, o);
const env = { AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "y", AWS_REGION: "us-east-1", DDB_PREFIX: "t-", SESSION_SECRET: "s".repeat(40), MAIL_FROM: "test@planetcompute.ai" };
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
globalThis.__signed = true;
const r = await W.fetch(new Request("https://planetcompute.ai/api/me/balance"), env); const b = await r.json();
ok("1 /api/me/balance: shared, received, difference, lifetime contributed, lifetime transferred (WU)", r.status === 200 && b.shared_wu === "123.456789" && b.received_wu === "0" && b.difference_wu === "123.456789" &&
  b.lifetime_contributed_wu === "123.456789" && b.lifetime_transferred_wu === "20" && b.unit === "WU", b);
ok("2 no coin wording in the answer", !/coin|token|npcc/i.test(JSON.stringify(b)), b);
ITEM.lifetime_received_uwu = { N: "200000000" };
const b2 = await (await W.fetch(new Request("https://planetcompute.ai/api/me/balance"), env)).json();
ok("3 once compute is received: the difference can go below zero", b2.received_wu === "200" && b2.difference_wu === "-76.543211", b2); delete ITEM.lifetime_received_uwu;
globalThis.__signed = false;
ok("4 signed out: 401", (await W.fetch(new Request("https://planetcompute.ai/api/me/balance"), env)).status === 401);
const br = await chromium.launch(); const errs = [];
async function page(w, h, signed) {
  const pg = await br.newPage({ viewport: { width: w, height: h } }); pg.on("pageerror", (e) => errs.push(e.message));
  await pg.route(/^https:\/\/planetcompute\.ai\//, async (rt) => { globalThis.__signed = signed; const u = new URL(rt.request().url());
    if (u.pathname === "/api/me") return rt.fulfill(signed ? { contentType: "application/json", body: '{"user_id":"u1","primary_email":"a@b.c"}' } : { status: 401, body: "{}" });
    const res = await W.fetch(new Request(u.toString(), { method: rt.request().method() }), env); const hd = {}; res.headers.forEach((v, k) => hd[k] = v); rt.fulfill({ status: res.status, headers: hd, body: Buffer.from(await res.arrayBuffer()) }); });
  await pg.route(/^https?:\/\/(?!planetcompute\.ai\/)/, (rt) => rt.abort()); return pg;
}
let pg = await page(1300, 800, true);
await pg.goto("https://planetcompute.ai/balance"); await pg.waitForTimeout(1200);
const t = await pg.evaluate(() => document.querySelector(".bal").innerText);
ok("5 the page shows the five, with commas and 2 decimals (test 76): Compute Shared 123.46, Compute Received 0.00, Difference 123.46, Lifetime Compute Contributed 123.46, Lifetime Compute Transferred 20.00 (WU)",
  /Compute Shared\s*123\.46\s*WU/i.test(t) && /Compute Received\s*0\.00\s*WU/i.test(t) && /Difference\s*123\.46\s*WU/i.test(t) && /Lifetime Compute Contributed\s*123\.46\s*WU/i.test(t) && /Lifetime Compute Transferred\s*20\.00\s*WU/i.test(t), t);
ok("6 the top bar has five buttons, My Balance lit", (await pg.evaluate(() => [...document.querySelectorAll(".pcbar .modes [data-mode]")].map((e) => e.querySelector(".lg").textContent).join("|"))) === "Share Compute|Receive Compute|My Content|Local Tunnel URL|My Balance" &&
  (await pg.evaluate(() => document.querySelector(".pcbar .modes [aria-current]").dataset.mode)) === "balance");
ok("7 no coin wording on the page except what the owner asked for (the token notice; 2026-10-30: the heading 'Your Tokens wallet address' and the token risk statement)",
  !/coin|token/i.test(await pg.evaluate(() => { const ns = [document.getElementById("aNotice"), document.querySelector("#addr h2"), document.getElementById("trBox")].filter(Boolean), d = ns.map((n) => n.style.display);
    ns.forEach((n) => { n.style.display = "none"; }); const t = document.body.innerText; ns.forEach((n, i) => { n.style.display = d[i]; }); return t; })));
await pg.screenshot({ path: OUT + "/balance.png", clip: { x: 0, y: 0, width: 1300, height: 520 } }); await pg.close();
pg = await page(1300, 800, false); await pg.goto("https://planetcompute.ai/balance"); await pg.waitForTimeout(1000);
ok("8 signed out: the email sign-in, the code step not yet", await pg.evaluate(() => !document.getElementById("signin").hidden && document.getElementById("app").hidden && getComputedStyle(document.getElementById("cForm")).display === "none"));
await pg.close();
pg = await page(1300, 800, true); await pg.goto("https://planetcompute.ai/"); await pg.waitForTimeout(1200);
await pg.evaluate(() => { const c = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "OK"); if (c) c.click(); });
await pg.click('nav.top .modes [data-mode="balance"]'); await pg.waitForTimeout(1200);
ok("9 the home page's My Balance button opens /balance", pg.url() === "https://planetcompute.ai/balance" && /Compute Shared/.test(await pg.evaluate(() => document.body.innerText)), pg.url()); await pg.close();
pg = await page(390, 844, true); await pg.goto("https://planetcompute.ai/"); await pg.waitForTimeout(1000);
const m = await pg.evaluate(() => ({ sw: document.documentElement.scrollWidth, b: [...document.querySelectorAll("nav.top .modes [data-mode]")].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.right), Math.round(r.top), e.scrollWidth <= e.clientWidth + 1]; }) }));
ok("10 phone: the five in one row, on screen, no sideways scroll, labels fit", m.sw <= 390 && m.b.length === 5 && m.b.every((x) => x[0] <= 390 && x[2]) && new Set(m.b.map((x) => x[1])).size === 1, m);
await pg.screenshot({ path: OUT + "/balance-phone.png", clip: { x: 0, y: 0, width: 390, height: 120 } }); await pg.close();
await br.close(); ok("11 no script errors", !errs.length, errs);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
