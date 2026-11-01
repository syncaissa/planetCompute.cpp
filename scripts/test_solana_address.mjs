// Test of the account's Solana wallet address (TESTING.md test 46). The given worker.js runs in-process against the
// TEST tables (pctest-ai-user, pctest-ai-address-audit, ...; real DynamoDB) and the real Solana devnet (read only,
// and one real transfer from the devnet treasury); emails are captured, not sent. Headless Chromium uses the profile
// panel (/contribute, Account) and My Balance (/balance): both show the same address, Update saves a new one (the
// old one goes to the address-audit table with its time), Previous addresses lists them; a transfer goes to it.
//   cd <folder with playwright-core, tweetnacl and chromium> && AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. \
//     PCC_MINT=7vSu.. TREASURY_SECRET_FILE=.ops/devnet_treasury.secret node <repo>/scripts/test_solana_address.mjs <worker.js> <screenshot dir>
import { createRequire } from "node:module";
const req = createRequire(process.cwd() + "/"), { chromium } = req("playwright-core"), nacl = req("tweetnacl");
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { randomBytes } from "node:crypto";
let src = readFileSync(process.argv[2], "utf8");
const swap = (o, n) => { if (!src.includes(o)) throw new Error("not found: " + o); src = src.replace(o, n); };
swap("async function currentUser(env, request) {", "async function currentUser(env, request) { if (globalThis.__user) return { user_id: globalThis.__user, token: 't' };");
swap("async function cachedUser(env, request) {", "async function cachedUser(env, request) { if (globalThis.__user) return { user_id: globalThis.__user, token: 't' };");
swap("async function sendCodeEmail(env, to, code, purpose) {", "async function sendCodeEmail(env, to, code, purpose) { (globalThis.__codes ||= []).push({ to, code, purpose }); return;");
swap("async function sendEmail(env, { to, subject, text, html, replyTo }) {", "async function sendEmail(env, { to, subject, text, html, replyTo }) { (globalThis.__mails ||= []).push({ to, subject, text }); return;");
src += "\nglobalThis.__x = { ddb, M, U };";
const tmp = join(mkdtempSync(join(tmpdir(), "sa-")), "w.mjs"); writeFileSync(tmp, src); globalThis.WebSocketRequestResponsePair = class {};
// the site asks in the page now (pcConfirm), not in a browser pop-up: answer OK and keep the question (window.__asked)
const AUTO_OK = () => { if (window.__autoOk) return; window.__autoOk = 1; window.__asked = [];
  new MutationObserver(() => { const t = document.querySelector(".pc-toast.ask:not([data-seen])"); if (!t) return; t.dataset.seen = "1";
    window.__asked.push(t.querySelector(".pc-t-msg").textContent); const inp = t.querySelector("input");
    setTimeout(async () => { if (inp) inp.value = await window.__code(); t.querySelector(".pc-ok").click(); }, 0); })
    .observe(document, { childList: true, subtree: true }); };
const asked = (where) => where.evaluate(() => (window.__asked || []).slice(-1)[0] || "");
const lastCode = (purpose) => ((globalThis.__codes || []).filter((c) => c.purpose === purpose).at(-1) || {}).code || "";
const W = (await import(tmp)).default, X = globalThis.__x, OUT = process.argv[3], PREFIX = "pctest-ai-";
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, AWS_REGION: "us-east-1",
  DDB_PREFIX: PREFIX, SESSION_SECRET: "s".repeat(40), MAIL_FROM: "test@planetcompute.ai", TRANSFER_PLANETCOMPUTE_PAYS: "YES", SOLANA_CLUSTER: "devnet", SOLANA_RPC_URL: "https://api.devnet.solana.com",
  PCC_MINT: process.env.PCC_MINT, TREASURY_SECRET_KEY: readFileSync(process.env.TREASURY_SECRET_FILE, "utf8").trim() };
if (!env.AWS_ACCESS_KEY_ID) { console.log("needs AWS keys in the environment"); process.exit(2); }
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (u) => { let n = BigInt("0x" + (Buffer.from(u).toString("hex") || "0")), o = ""; while (n > 0n) { o = B58[Number(n % 58n)] + o; n /= 58n; } for (const x of u) { if (x) break; o = "1" + o; } return o; };
const wallet = () => b58(nacl.sign.keyPair().publicKey);
const user = "sa" + randomBytes(5).toString("hex"); globalThis.__user = user; const MAIL = `address-test-${user}@invalid`;   // its own address each run (code limits per address)
await X.ddb(env, "PutItem", { TableName: PREFIX + "user", Item: X.M({ pk: "USER#" + user, sk: "PROFILE", user_id: user, primary_email: "" + MAIL + "", first_name: "Addr", last_name: "Test", created_at: new Date().toISOString() }) });
await X.ddb(env, "PutItem", { TableName: PREFIX + "user-credits", Item: X.M({ user_id: user, sk: "BALANCE" }) });
const api = async (path, body) => { const r = await W.fetch(new Request("https://planetcompute.ai" + path, body ? { method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", origin: "https://planetcompute.ai" } } : {}), env); return { s: r.status, j: await r.json().catch(() => ({})) }; };
const A1 = wallet(), A2 = wallet(), A3 = wallet(), TOKEN_ACCT = "BAbQwYKX3Eq7R2sBcrrvoE2t8DxwbWCJQyTpNBeCfuUz";   // the devnet treasury's token account

// API
let r = await api("/api/me");
ok("1 a new account has no wallet address", r.s === 200 && r.j.solana_address === "", r.j);
r = await api("/api/me/solana-address", { address: "my secret phrase words" });
ok("2 something that is not a Solana address is refused (address only, never a key)", r.s === 400 && /not a Solana wallet address/.test(r.j.error), r);
r = await api("/api/me/solana-address", { address: TOKEN_ACCT });
ok("3 a token account (checked on devnet) is refused: coins sent there would be lost", r.s === 400 && /token account/.test(r.j.error), r);
r = await api("/api/me/solana-address", { address: A1 });
ok("4a security review W6: saving an address first emails a code to the account (428); nothing is saved yet", r.s === 428 && r.j.need_code === true && /a…@invalid/.test(r.j.sent_to) &&
  lastCode("wallet").length === 6 && (await api("/api/me")).j.solana_address === "", r);
r = await api("/api/me/solana-address", { address: A1, code: String((Number(lastCode("wallet")) + 1) % 1000000).padStart(6, "0") });
ok("4b a wrong code: refused, nothing saved", r.s === 401 && (await api("/api/me")).j.solana_address === "", r);
await new Promise((x) => setTimeout(x, 31000));          // a new code may be asked for after 30 s
r = await api("/api/me/solana-address", { address: A1 }); r = await api("/api/me/solana-address", { address: A1, code: lastCode("wallet") });
ok("4 with the emailed code the first address is saved on the profile", r.s === 200 && r.j.solana_address === A1 && (await api("/api/me")).j.solana_address === A1, r);
r = await api("/api/me/solana-address", { address: A1 });
ok("5 the same address again: refused (nothing to change)", r.s === 409, r);
await new Promise((x) => setTimeout(x, 20));
await new Promise((x) => setTimeout(x, 31000)); r = await api("/api/me/solana-address", { address: A2 }); r = await api("/api/me/solana-address", { address: A2, code: lastCode("wallet") });
const h = (await api("/api/me/solana-address/history")).j.changes;
ok("6 a change: the profile has the new address; the audit table has both changes, newest first, old -> new, with times",
  r.s === 200 && h.length === 2 && h[0].old_address === A1 && h[0].new_address === A2 && h[1].old_address === "" && h[1].new_address === A1 && h[0].changed_at > h[1].changed_at && !!h[0].old_since, h);
ok("7 each change emails the owner's primary address (from / to)", globalThis.__mails.length === 2 && globalThis.__mails[1].to[0] === "" + MAIL + "" &&
  globalThis.__mails[1].text.includes(A1) && globalThis.__mails[1].text.includes(A2), globalThis.__mails);
r = await api("/api/wallet/withdraw", { amount: "0.01", to: wallet() });
ok("8 a transfer to an address that is not the account's is refused", r.s === 400 && /not one of yours/.test(r.j.error), r);

// the browser: the profile panel and My Balance
const br = await chromium.launch(), errs = [];
const pg = await br.newPage({ viewport: { width: 1300, height: 900 } }); pg.on("pageerror", (e) => errs.push(e.message));
await pg.exposeFunction("__code", () => lastCode("wallet")); await pg.addInitScript(AUTO_OK); await pg.evaluate(AUTO_OK);
await pg.route(/^https:\/\/planetcompute\.ai\//, async (rt) => { const u = new URL(rt.request().url()), rq = rt.request();
  const res = await W.fetch(new Request(u.toString(), { method: rq.method(), headers: { "content-type": "application/json", origin: "https://planetcompute.ai" }, body: rq.method() === "POST" ? rq.postData() : undefined }), env);
  const hd = {}; res.headers.forEach((v, k) => hd[k] = v); rt.fulfill({ status: res.status, headers: hd, body: Buffer.from(await res.arrayBuffer()) }); });
await pg.route(/^https?:\/\/(?!planetcompute\.ai\/)/, (rt) => rt.abort());
await pg.goto("https://planetcompute.ai/contribute"); await pg.waitForTimeout(1500);
await pg.click("#acctBtn"); await pg.waitForTimeout(800);
ok("9 the profile panel shows the wallet address, an Update and a Previous addresses button", (await pg.inputValue("#solAddr")) === A2 && await pg.isVisible("#solSave") && await pg.isVisible("#solHist"));
await new Promise((x) => setTimeout(x, 31000)); await pg.fill("#solAddr", A3); await pg.click("#solSave"); await pg.waitForTimeout(3500);
ok("10 Update on the profile (after confirming From / To and entering the emailed code in the page): saved, the owner is told an email was sent", (await api("/api/me")).j.solana_address === A3 &&
  /We emailed a 6-digit code to a…@invalid/.test(await asked(pg)) && /Saved/.test(await pg.innerText("#msgSol")), { d: (await asked(pg)), m: await pg.innerText("#msgSol") });
await pg.click("#solHist"); await pg.waitForTimeout(1500);
const ph = await pg.innerText("#solList");
ok("11 Previous addresses on the profile lists all three changes", ph.includes(A1) && ph.includes(A2) && ph.includes(A3) && ph.split("\n").filter(Boolean).length === 3, ph);
const below = async (inp, note) => { const a = await pg.locator(inp).boundingBox(), b = await pg.locator(note).boundingBox(); return !!a && !!b && b.y > a.y + a.height - 1; };
const NOTE = /awarded free of charge by PlanetCompute\.ai solely as a record \(ledger\) of contribution[\s\S]*accepts no liability for resulting losses\./;
ok("11b the token notice is on the profile, under the address field", NOTE.test(await pg.innerText("#solNotice")) && await pg.isVisible("#solNotice") && await below("#solAddr", "#solNotice"));
await pg.screenshot({ path: OUT + "/profile_address.png" });
await pg.goto("https://planetcompute.ai/balance"); await pg.waitForTimeout(2000);
ok("12 My Balance shows the same address (the profile's)", (await pg.inputValue("#aAddr")) === A3 && /Since/.test(await pg.innerText("#aSince")));
const A4 = wallet(); await new Promise((x) => setTimeout(x, 31000)); await pg.fill("#aAddr", A4); await pg.click("#aSave"); await pg.waitForTimeout(3500);
await pg.click("#aHist"); await pg.waitForTimeout(1500);
const bh = await pg.innerText("#aList");
ok("13 Update on My Balance goes to the same tables: the profile has it, Previous addresses lists 4 changes", (await api("/api/me")).j.solana_address === A4 && bh.split("\n").filter(Boolean).length === 4 && bh.includes(A3 + " -> " + A4), bh);
ok("14 the page text never asks for a key, and does not talk about coins", /key and recovery phrase stay with you/.test(await pg.innerText("#addr")) && !/coin/i.test(await pg.innerText("#addr")));
ok("14b the token notice is on My Balance, under the address field", NOTE.test(await pg.innerText("#aNotice")) && await pg.isVisible("#aNotice") && await below("#aAddr", "#aNotice"));
await pg.screenshot({ path: OUT + "/balance_address.png" });
ok("15 no page errors", errs.length === 0, errs);
await br.close();

// a real devnet transfer goes to the account's address (no wallet linked)
await X.ddb(env, "PutItem", { TableName: PREFIX + "user-credits", Item: X.M({ user_id: user, sk: "BALANCE", available_uwu: 100000000000, lifetime_contribution_uwu: 100000000000 }) });
r = await api("/api/wallet/withdraw", { amount: "0.01" });
ok("15b security review W6: a move within 24 hours of an address change is refused (the hold), nothing sent", r.s === 409 && /24 hours after the change/.test(r.j.error) && !!r.j.hold_until, r);
await X.ddb(env, "UpdateItem", { TableName: PREFIX + "user", Key: X.M({ pk: "USER#" + user, sk: "PROFILE" }), UpdateExpression: "SET solana_address_at = :t",
  ExpressionAttributeValues: X.M({ ":t": new Date(Date.now() - 25 * 3600 * 1000).toISOString() }) });   // as if the change was 25 hours ago
r = await api("/api/wallet/withdraw", { amount: "0.01" });
const bal = await (await fetch(env.SOLANA_RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner",
  params: [A4, { mint: env.PCC_MINT }, { encoding: "jsonParsed", commitment: "confirmed" }] }) })).json();
console.log("  transfer:", r.s, r.j.status, r.j.explorer || r.j.error);
ok("16 a transfer with no wallet linked goes to the account's address: 0.01 arrives there on devnet", r.s === 200 && r.j.status === "settled" &&
  bal.result.value.length === 1 && bal.result.value[0].account.data.parsed.info.tokenAmount.uiAmountString === "0.01", { r: r.j, bal: bal.result });

// clean up
for (const t of ["user-credits", "address-audit"]) {
  const q = await X.ddb(env, "Query", { TableName: PREFIX + t, KeyConditionExpression: "user_id = :u", ExpressionAttributeValues: X.M({ ":u": user }) });
  for (const it of q.Items || []) await X.ddb(env, "DeleteItem", { TableName: PREFIX + t, Key: { user_id: it.user_id, sk: it.sk } });
}
await X.ddb(env, "DeleteItem", { TableName: PREFIX + "user", Key: X.M({ pk: "USER#" + user, sk: "PROFILE" }) });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
