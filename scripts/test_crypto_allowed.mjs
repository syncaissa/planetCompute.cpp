// docs/TESTING.md test 82: the crypto confirmation next to "Your Tokens wallet address" (was "Your Solana wallet address") on My Balance (website and program).
// User 2026-10-30: "I confirm that cryptocurrency transactions are permitted in my country, and I accept responsibility for
// complying with local laws." Every check and uncheck is a row in <prefix>crypto-allowed (timestamp + user id); the
// latest row sets the box on page refresh. Since 2026-10-30 the token section (address, transfers, notice) shows only when
// BOTH statements are checked; "Where your compute is being shared" moved off My Balance to the bottom of Local Tunnel URL
// (/harness#connect). Headless Chromium; the given worker.js answers in-process with a fake
// DynamoDB. The program's page is tested as the site serves it (planetcompute.ai/express/local/#balance: the same file).
//   cd <folder with playwright-core> && node <repo>/scripts/test_crypto_allowed.mjs <worker.js> [screenshot dir]
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/")("playwright-core");
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
const tmp = join(mkdtempSync(join(tmpdir(), "ca-")), "w.mjs"); writeFileSync(tmp, readFileSync(process.argv[2], "utf8")); globalThis.WebSocketRequestResponsePair = class {};
const SHOTS = process.argv[3] || "";
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, x === undefined ? "" : JSON.stringify(x).slice(0, 500)); } };
const SECRET = "s", sha = (s) => createHash("sha256").update(s).digest("hex"), TOK = "testsessiontoken-alice-0123456789";
const TEXT = "I confirm that cryptocurrency transactions are permitted in my country, and I accept responsibility for complying with local laws.";
// ---- fake DynamoDB: the session, the profile, and the crypto-allowed rows
const items = new Map(), K = (t, k) => t + "|" + JSON.stringify(Object.keys(k).sort().map((x) => [x, k[x]]));
items.set(K("planetcompute-ai-user", { pk: { S: `SESSION#${sha(`${SECRET}|session|${TOK}`)}` }, sk: { S: "SESSION" } }), { user_id: { S: "alice" }, expires_at: { N: String(Math.floor(Date.now() / 1000) + 3600) } });
items.set(K("planetcompute-ai-user", { pk: { S: "USER#alice" }, sk: { S: "PROFILE" } }), { pk: { S: "USER#alice" }, sk: { S: "PROFILE" }, user_id: { S: "alice" }, primary_email: { S: "alice@example.com" }, first_name: { S: "Alice" } });
const rows = [], risk = new Map(); let riskPuts = 0;   // crypto-allowed rows; token-risk-accepted (one per account)                                           // what was written to planetcompute-ai-crypto-allowed
let failPut = false;
function ddb(op, b) {
  const k = b.Key ? K(b.TableName, b.Key) : "", v = b.ExpressionAttributeValues || {};
  if (b.TableName === "planetcompute-ai-crypto-allowed") {
    if (op === "PutItem") { if (failPut) throw new Error("down"); rows.push(b.Item); return {}; }
    if (op === "Query") { const r = rows.filter((x) => x.user_id.S === v[":u"].S).sort((a, c) => (a.sk.S < c.sk.S ? 1 : -1)); return { Items: b.ScanIndexForward === false ? r.slice(0, b.Limit || 100) : r.reverse() }; }
  }
  if (b.TableName === "planetcompute-ai-token-risk-accepted") {
    if (op === "GetItem") return risk.has(b.Key.user_id.S) ? { Item: risk.get(b.Key.user_id.S) } : {};
    if (op === "PutItem") { if (failPut) throw new Error("down"); riskPuts++;
      if (risk.has(b.Item.user_id.S)) { const e = new Error("cond"); e.cond = true; throw e; } risk.set(b.Item.user_id.S, b.Item); return {}; }
  }
  if (op === "GetItem") return items.has(k) ? { Item: items.get(k) } : {};
  // the credit rules (an old rule and the one in force) and the coin set in force: for the "Current rate" line
  if (op === "Query" && /howCreditAwarded$/.test(b.TableName)) return { Items: [
    { pk: { S: "RULE" }, sk: { S: "2026-10-01T00:00:00Z#r1" }, rule_id: { S: "r1" }, effective_from: { S: "2026-10-01T00:00:00Z" }, status: { S: "active" }, credit_per_wu: { N: "0.0000003" } },
    { pk: { S: "RULE" }, sk: { S: "2026-10-27T05:27:34.000Z#r2" }, rule_id: { S: "r2" }, effective_from: { S: "2026-10-27T05:27:34.000Z" }, status: { S: "active" }, credit_per_wu: { N: "0.00000126" } }] };
  if (op === "Query" && /ledger-options$/.test(b.TableName)) return { Items: v[":p"].S === "COIN"
    ? [{ pk: { S: "COIN" }, sk: { S: "planetcomp" }, coin_id: { S: "planetcomp" }, name: { S: "PlanetComp" }, status: { S: "active" } }]
    : v[":p"].S === "SET" ? [{ pk: { S: "SET" }, sk: { S: "2026-10-27T13:18:28Z#s1" }, set_id: { S: "s1" }, effective_from: { S: "2026-10-27T13:18:28Z" }, status: { S: "active" }, shares: { S: '[{"coin_id":"planetcomp","pct":100}]' } }] : [] };
  if (op === "Query" || op === "Scan") return { Items: [] };
  return {};
}
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (/dynamodb\./.test(url)) { const op = String((init.headers || {})["x-amz-target"] || "").split(".").pop();
    try { return J(ddb(op, JSON.parse(init.body || "{}"))); }
    catch (e) { return e.cond ? J({ __type: "com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException", message: "The conditional request failed" }, 400) : J({ __type: "InternalServerError", message: e.message }, 500); } }
  if (/b2_authorize_account|backblazeb2|b2test|api\.cloudflare\.com|solana|resend/.test(url)) return J({}, 503);
  return realFetch(input, init);
};
const W = (await import(tmp)).default;
const env = { AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "y", SESSION_SECRET: SECRET, MAIL_FROM: "t@invalid" };
const b = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell" });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
await ctx.addCookies([{ name: "pc_session", value: TOK, domain: "planetcompute.ai", path: "/", secure: true }]);
await ctx.addInitScript(() => { localStorage.setItem("pc-cookies-ok", "1"); });
await ctx.route("**/*", async (r) => {
  const u = new URL(r.request().url());
  if (u.hostname !== "planetcompute.ai") return r.fulfill({ body: "" });
  if (/\/api\/me\/activity$/.test(u.pathname)) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ days: [{ day: "2026-10-29", rx_jobs: 0, tx_jobs: 11711, rx_uwu: 0, tx_uwu: 10295400, rx_tokens: 0, tx_tokens: 534765 }],
    jobs: [{ at: "2026-10-29T10:00:00Z", role: "answered", model: "qwen3-4b", ok: true, tokens: 46, wait_ms: 10, run_ms: 900, checked: true, agree: "yes", wu: 0.001 }] }) });
  if (u.pathname === "/api/me/devices") { devCalls++; return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sharing_now: 0, devices: DEVS }) }); }
  if (u.pathname === "/api/tunnel/devices") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ devices: [{ device: "3eb5be2903d4", name: "WASMONE", online: true, since: "2026-10-30T01:00:00Z", url: "https://planetcompute.ai/t/x" }] }) });
  const res = await W.fetch(new Request(u.toString(), { method: r.request().method(), headers: r.request().headers(), body: ["GET", "HEAD"].includes(r.request().method()) ? undefined : r.request().postDataBuffer() }), env)
    .catch(() => new Response("error", { status: 500 }));          // as Cloudflare answers a Worker that throws
  const h = {}; res.headers.forEach((v, k2) => { h[k2] = v; });
  return r.fulfill({ status: res.status, headers: h, body: Buffer.from(await res.arrayBuffer()) });
});
let devCalls = 0;
const DEVS = ["WASMONE", "LAPTOP", "OFFICE-PC"].map((n, i) => ({ device: "d" + i + "aaaaaaaaaa", kind: "program", name: n, active: false, state: "stopped", cores: 4, cpu_cap: 50, cpu_pct: 0, gpu_on: false, packs: 1200 + i, wu: 1.5, verified: true, seconds_ago: 4000 }))
  .concat([{ device: "b3aaaaaaaaaa", kind: "browser", browser: "Chrome", platform: "Windows", active: false, state: "idle", cores: 2, cpu_cap: 30, cpu_pct: 0, gpu_on: false, packs: 10, wu: 0.01, verified: false, seconds_ago: 90000 }]);
const latest = () => rows.filter((x) => x.user_id.S === "alice").sort((a, c) => (a.sk.S < c.sk.S ? 1 : -1))[0];

// ---- the website: planetcompute.ai/balance
const page = await ctx.newPage();
const vis = (sel) => page.isVisible(sel);
await page.goto("https://planetcompute.ai/balance"); await page.waitForSelector("#caOk", { state: "visible", timeout: 10000 }); await page.waitForTimeout(800);
const label = await page.$eval("#caOk", (e) => e.closest("label").textContent.trim());
const h2 = await page.$eval("#caOk", (e) => e.closest("section").querySelector("h2").textContent);
ok("1 site: the box sits under 'Your Tokens wallet address' with the exact sentence; no record yet -> unchecked", label === TEXT && h2 === "Your Tokens wallet address" && !(await page.isChecked("#caOk")), { label, h2 });
const rate = await page.textContent("#rateLine").catch(() => "");
ok("1b site: 'Current rate: 1 WU = 0.00000126 PlanetComp' (the latest rule in force, not the old 0.0000003), shown above the box even unchecked",
  await vis("#rateLine") && /^Current rate: 1 WU = 0\.00000126 PlanetComp \(the rate in force now/.test(rate), rate);
const gone = await page.evaluate(() => !/Where your compute is being shared/.test(document.body.innerText) && !document.getElementById("devList"));
ok("2 site: unchecked -> the token section is hidden (address field, Update, notice); My activity stays; 'Where your compute is being shared' is no longer on My Balance (moved to Local Tunnel URL)",
  !(await vis("#aAddr")) && !(await vis("#aSave")) && !(await vis("#aNotice")) && await vis("#act") && gone && await vis("#again"), { gone });
if (SHOTS) await page.$eval("#addr", (e) => e.scrollIntoView()).then(() => page.screenshot({ path: SHOTS + "/crypto_site_off.png" }));
await page.check("#caOk"); await page.waitForTimeout(600);
ok("3 site: checked -> a row {user_id, at, allowed: true, text, email, via: website} is written (the token section still hidden: the second box is not checked)",
  rows.length === 1 && latest().allowed.BOOL === true && latest().user_id.S === "alice" && /^\d{4}-\d\d-\d\dT/.test(latest().at.S) && latest().sk.S.startsWith(latest().at.S + "#")
  && latest().text.S === TEXT && latest().email.S === "alice@example.com" && latest().via.S === "website" && !(await vis("#aAddr")), rows.map((x) => x.allowed));
// the second statement (permanent): the token section needs BOTH boxes (user 2026-10-30)
const RISK = "I understand that PlanetComp is a ledger record only, may have no real value, and could lose 100% of any value it ever has. I accept it at my own discretion and risk.";
ok("3a site: the second box under the first with [Token Name] = PlanetComp; not accepted yet -> unchecked, can be checked; only the first checked -> the token section stays hidden",
  (await page.textContent("#trText")) === RISK && !(await page.isChecked("#trOk")) && !(await page.isDisabled("#trOk")) && !(await vis("#aAddr")), await page.textContent("#trText"));
await page.check("#trOk"); await page.waitForTimeout(700);
ok("3c site: both checked -> the token section shows (address field, Update, notice)", await vis("#aAddr") && await vis("#aSave") && await vis("#aNotice"));
if (SHOTS) await page.screenshot({ path: SHOTS + "/crypto_site_on.png" });
const para = await page.$eval("#addr p.lead", (e) => e.textContent);
ok("3b site: the paragraph starts 'Your Solana wallet address: the address of your own wallet (Phantom, Solflare, ...). Transfers'", /^Your Solana wallet address: the address of your own wallet \(Phantom, Solflare, \.\.\.\)\. Transfers from your account are sent there\./.test(para), para.slice(0, 120));
await page.uncheck("#caOk"); await page.waitForTimeout(600);
ok("4 site: unchecked again -> a second row (allowed: false) and hidden again", rows.length === 2 && latest().allowed.BOOL === false && !(await vis("#aAddr")), rows.length);
await page.reload(); await page.waitForSelector("#caOk", { state: "visible" }); await page.waitForTimeout(1200);
ok("5 site: refresh -> the latest record (unchecked) sets the box", !(await page.isChecked("#caOk")) && !(await vis("#aAddr")));
await page.check("#caOk"); await page.waitForTimeout(600); await page.reload(); await page.waitForSelector("#caOk", { state: "visible" }); await page.waitForTimeout(1200);
ok("6 site: checked, refresh -> checked and the wallet part shown (3 rows kept, none changed)", await page.isChecked("#caOk") && await vis("#aAddr") && rows.length === 3
  && rows.map((x) => x.allowed.BOOL).join() === "true,false,true");
failPut = true; await page.uncheck("#caOk"); await page.waitForTimeout(800); failPut = false;
ok("7 site: saving fails -> the box goes back (checked) with 'Could not save that just now'", await page.isChecked("#caOk") && /Could not save/.test(await page.textContent("#caMsg")) && rows.length === 3);
const api = await W.fetch(new Request("https://planetcompute.ai/api/me/crypto-allowed", { method: "POST", headers: { cookie: `pc_session=${TOK}`, "content-type": "application/json", origin: "https://planetcompute.ai" }, body: JSON.stringify({ allowed: "yes" }) }), env);
const anon = await W.fetch(new Request("https://planetcompute.ai/api/me/crypto-allowed"), env);
ok("8 API: allowed must be true/false (400); signed out -> 401", api.status === 400 && anon.status === 401, [api.status, anon.status]);

// the second statement (checked in 3c): once checked it cannot be unchecked; one row in token-risk-accepted
const rk = risk.get("alice");
ok("8c site: checked -> ONE row {user_id, sk ACCEPTED, at, accepted, token_name PlanetComp, text, email, via website}; the box is locked",
  rk && rk.sk.S === "ACCEPTED" && rk.accepted.BOOL === true && rk.token_name.S === "PlanetComp" && rk.text.S === RISK && rk.email.S === "alice@example.com" && rk.via.S === "website" && /^\d{4}-/.test(rk.at.S)
  && await page.isChecked("#trOk") && await page.isDisabled("#trOk"), rk && Object.keys(rk));
await page.click("#trBox", { force: true }).catch(() => {}); await page.waitForTimeout(300);
ok("8d site: it cannot be unchecked (a click changes nothing)", await page.isChecked("#trOk") && risk.size === 1);
await page.reload(); await page.waitForSelector("#trOk", { state: "visible" }); await page.waitForTimeout(1200);
ok("8e site: refresh -> still checked and locked, with 'Accepted on ...' as its title", await page.isChecked("#trOk") && await page.isDisabled("#trOk") && /^Accepted on \d{4}-/.test(await page.getAttribute("#trBox", "title")));
const H = { cookie: `pc_session=${TOK}`, "content-type": "application/json", origin: "https://planetcompute.ai" };
const un = await W.fetch(new Request("https://planetcompute.ai/api/me/token-risk", { method: "POST", headers: H, body: JSON.stringify({ accepted: false }) }), env);
const again = await W.fetch(new Request("https://planetcompute.ai/api/me/token-risk", { method: "POST", headers: H, body: JSON.stringify({ accepted: true }) }), env);
const aj = await again.json();
ok("8f API: accepted false -> 400 'cannot be withdrawn'; accepting again -> ok, already, the first row kept (not rewritten)", un.status === 400 && /cannot be withdrawn/.test((await un.json()).error) && again.status === 200 && aj.already && risk.get("alice") === rk, [un.status, again.status, aj]);

// My activity: the AI text column is "Input/output words" (was "Tokens", confused with PlanetComp; user 2026-10-30)
const ah = await page.evaluate(() => [...document.querySelectorAll("#actDays th")].map((x) => x.textContent));
const av = await page.evaluate(() => [...document.querySelectorAll("#actDays tr:nth-child(2) td")].map((x) => x.textContent));
ok("15 site: My activity's column 'Input/output words' (no 'Tokens' column): 534,765 on 2026-10-29", ah.includes("Input/output words") && !ah.includes("Tokens") && av[ah.indexOf("Input/output words")] === "534,765", { ah, av });

// ---- the program's page (client/ui/index.html; the site serves the same file in Express mode)
rows.length = 0;
const p2 = await ctx.newPage();
await p2.goto("https://planetcompute.ai/express/local/#balance"); await p2.waitForTimeout(2500);
const fr = p2.frames().find((x) => x.url().includes("/express/local/")) || p2.mainFrame();
await fr.evaluate(() => { const t = document.querySelector('[data-tab="balance"]'); t && t.click(); }); await fr.waitForTimeout(1500);
const pv = (sel) => fr.isVisible(sel);
const plabel = await fr.$eval("#caOk", (e) => e.closest("label").textContent.trim()).catch(() => "");
ok("9 program: the same sentence under 'Your Tokens wallet address'; unchecked -> address field hidden",
  plabel === TEXT && await pv("#caOk") && !(await fr.isChecked("#caOk")) && !(await pv("#aAddr")), { plabel });
const prate = await fr.textContent("#rateLine").catch(() => "");
ok("9b program: the same 'Current rate: 1 WU = 0.00000126 PlanetComp' line", await pv("#rateLine") && /^Current rate: 1 WU = 0\.00000126 PlanetComp \(/.test(prate), prate);
await fr.check("#caOk"); await fr.waitForTimeout(800);
const pah = await fr.evaluate(() => [...document.querySelectorAll("#actDays th")].map((x) => x.textContent));
ok("15b program: My activity's column 'Input/output words' (no 'Tokens' column)", pah.includes("Input/output words") && !pah.includes("Tokens"), pah);
ok("10 program: checked -> a row (allowed: true) and the address field shows", rows.length === 1 && latest().allowed.BOOL === true && await pv("#aAddr"), rows.length);
await fr.uncheck("#caOk"); await fr.waitForTimeout(800);
ok("11 program: unchecked -> a second row (allowed: false) and hidden", rows.length === 2 && latest().allowed.BOOL === false && !(await pv("#aAddr")));
await fr.check("#caOk"); await fr.waitForTimeout(600); await p2.reload(); await p2.waitForTimeout(2500);
const fr2 = p2.frames().find((x) => x.url().includes("/express/local/")) || p2.mainFrame();
await fr2.evaluate(() => { const t = document.querySelector('[data-tab="balance"]'); t && t.click(); }); await fr2.waitForTimeout(1500);
ok("12 program: refresh -> the latest record (checked) sets the box and the wallet part shows", await fr2.isChecked("#caOk") && await fr2.isVisible("#aAddr"));
risk.clear();
const fr3 = p2.frames().find((x) => x.url().includes("/express/local/")) || p2.mainFrame();
await p2.reload(); await p2.waitForTimeout(2500); const fr4 = p2.frames().find((x) => x.url().includes("/express/local/")) || p2.mainFrame();
await fr4.evaluate(() => { const t = document.querySelector('[data-tab="balance"]'); t && t.click(); }); await fr4.waitForTimeout(1500);
const ph = await fr4.evaluate(() => ({ h: document.querySelector("#addr h2").textContent, p: document.querySelector("#addr p.muted").textContent }));
ok("12b program: heading 'Your Tokens wallet address'; the paragraph starts 'Your Solana wallet address: the address of your own wallet'", ph.h === "Your Tokens wallet address" && /^Your Solana wallet address: the address of your own wallet \(Phantom, Solflare, \.\.\.\)\. Transfers/.test(ph.p), ph);
ok("12c program: the second box with PlanetComp, unchecked; the first checked but not the second -> the address field hidden", (await fr4.textContent("#trText")) === RISK && !(await fr4.isChecked("#trOk")) && await fr4.isChecked("#caOk") && !(await fr4.isVisible("#aAddr")));
await fr4.check("#trOk"); await fr4.waitForTimeout(800);
ok("12d program: checked -> one row, locked (cannot be unchecked); both checked -> the address field shows", risk.size === 1 && await fr4.isChecked("#trOk") && await fr4.isDisabled("#trOk") && await fr4.isVisible("#aAddr"));
await p2.reload(); await p2.waitForTimeout(2500); const fr5 = p2.frames().find((x) => x.url().includes("/express/local/")) || p2.mainFrame();
await fr5.evaluate(() => { const t = document.querySelector('[data-tab="balance"]'); t && t.click(); }); await fr5.waitForTimeout(1500);
ok("12e program: refresh -> still checked and locked", await fr5.isChecked("#trOk") && await fr5.isDisabled("#trOk"));
// "Where your compute is being shared": now at the bottom of Local Tunnel URL (the Harness page's Connect a Browser tab)
const p3 = await ctx.newPage();
await p3.goto("https://planetcompute.ai/harness?embed=1#connect"); await p3.waitForTimeout(2000);
const sh = await p3.evaluate(() => { const c = document.getElementById("pConnect"), sec = document.getElementById("shared");
  return { inConnect: !!(sec && c.contains(sec)), last: c.lastElementChild === sec || (sec && !sec.nextElementSibling), h: sec && sec.querySelector("h2").textContent,
    sum: document.getElementById("devSum").textContent, rows: document.querySelectorAll("#devList .dv").length, afterLinks: !!(document.getElementById("mineList").compareDocumentPosition(sec) & Node.DOCUMENT_POSITION_FOLLOWING),
    first: (document.querySelector("#devList .dv b") || {}).textContent }; });
ok("13 Local Tunnel URL: 'Where your compute is being shared' at the very bottom of the tab (after the computer links), with '0 of your 4 devices sharing right now. Every device is credited on its own; they all add up in your balance.' and the 4 devices",
  sh.inConnect && sh.last && sh.afterLinks && sh.h === "Where your compute is being shared" && sh.sum === "0 of your 4 devices sharing right now. Every device is credited on its own; they all add up in your balance." && sh.rows === 4
  && /^planetCompute program on WASMONE · Not reporting/.test(sh.first) && await p3.isVisible("#shared"), sh);
if (SHOTS) await p3.screenshot({ path: SHOTS + "/shared_connect.png", fullPage: true });
const c0 = devCalls; await p3.click("#sharedAgain"); await p3.waitForTimeout(500);
ok("14 Local Tunnel URL: its Refresh asks again", devCalls === c0 + 1, { c0, devCalls });
await b.close(); rmSync(dirname(tmp), { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
