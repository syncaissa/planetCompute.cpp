// What the account's saved Solana wallet address holds (TESTING.md test 52): GET /api/me/solana-address/holdings from
// the given worker.js in-process (signed-in user, DynamoDB and the Solana network faked), then the line on /balance in
// headless Chromium. No keys.
//   cd <folder with playwright-core and its chromium> && node <repo>/scripts/test_site_holdings.mjs <worker.js> <screenshot dir>
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/")("playwright-core");
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
let src = readFileSync(process.argv[2], "utf8");
src = src.replace("async function currentUser(env, request) {", "async function currentUser(env, request) { if (globalThis.__signed) return { user_id: 'u1', token: 't' }; return null;");
const tmp = join(mkdtempSync(join(tmpdir(), "hold-")), "w.mjs"); writeFileSync(tmp, src); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default, OUT = process.argv[3];
const ADDR = "8XwKcJJGZ1ZwGyn99vBGfuNBwjAHq2F99nbTEyRWCCuB", MINT = "HPq7scGRmP1sEiUrJKVowNqL11Xgg4QZtmzFL8UiwauK";
const PC_ACC = "B3yJmcXJ6WBkh6bnjBRaRMbW9pZ7xqzXnYTqHU3eyYt1", OTHER_ACC = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", OTHER_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
let sawIndexed = false;
let profile = { pk: { S: "USER#u1" }, sk: { S: "PROFILE" }, user_id: { S: "u1" }, solana_address: { S: ADDR } }, rpcFail = false, rpcCalls = 0;
const coin = { pk: { S: "COIN" }, sk: { S: "c1" }, coin_id: { S: "c1" }, name: { S: "PlanetComp" }, status: { S: "active" }, mint_mainnet: { S: MINT }, decimals: { N: "6" } };
let lamports = 50000000, units = 1234500000n;
const tokenData = () => { const b = new Uint8Array(165); let n = units; for (let i = 64; i < 72; i++) { b[i] = Number(n & 255n); n >>= 8n; } return btoa(String.fromCharCode(...b)); };
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const s = String(u), J = (x) => new Response(JSON.stringify(x), { headers: { "content-type": "application/json" } });
  if (s.includes("dynamodb.")) { const t = o.headers["x-amz-target"] || o.headers["X-Amz-Target"] || "";
    return J(/Query/.test(t) ? { Items: [coin] } : { Item: profile }); }
  if (s.startsWith("https://rpc.test")) { rpcCalls++; const q = JSON.parse(o.body);
    if (rpcFail) return new Response('{"jsonrpc":"2.0","error":{"code":-32000,"message":"boom"},"id":1}');
    if (q.method === "getBalance") return J({ result: { value: lamports } });
    if (q.method === "getTokenAccountsByOwner") { sawIndexed = true; const t22 = q.params[1].programId === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
      const acc = (pubkey, mint, ui) => ({ pubkey, account: { data: { parsed: { info: { mint, tokenAmount: { uiAmountString: ui } } } } } });
      return J({ result: { value: t22 ? [acc(OTHER_ACC, OTHER_MINT, "7")] : [acc(PC_ACC, MINT, "1234.5")] } }); }
    if (q.method === "getAccountInfo" && q.params[0] === MINT) return J({ result: { value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: ["", "base64"] } } });
    return J({ result: { value: { data: [tokenData(), "base64"] } } }); }
  return realFetch(u, o);
};
const env = { AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "y", AWS_REGION: "us-east-1", DDB_PREFIX: "t-", SESSION_SECRET: "s".repeat(40), MAIL_FROM: "test@planetcompute.ai",
  SOLANA_CLUSTER: "mainnet-beta", SOLANA_RPC_URL: "https://rpc.test/" };
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
const get = async (e = env) => { const r = await W.fetch(new Request("https://planetcompute.ai/api/me/solana-address/holdings"), e); return [r.status, await r.json()]; };
globalThis.__signed = true;
let [st, d] = await get();
ok("1b every account the wallet owns for our coins, each with its links, and no indexed call (the public endpoint refuses it and then blocks the site): the wallet (SOL, Solscan, Transfers, Solana Explorer, All its coins) and its PlanetComp account (address from the wallet and the coin; Solscan, Transfers, Solana Explorer, Mint)",
  !sawIndexed && d.accounts.length === 2 && d.accounts[0].kind === "wallet" && d.accounts[0].url === "https://solscan.io/account/" + ADDR && d.accounts[0].amount === "0.05" &&
  d.accounts[0].transfers_url === "https://solscan.io/account/" + ADDR + "#transfers" && d.accounts[0].explorer_url === "https://explorer.solana.com/address/" + ADDR &&
  d.accounts[0].all_url === "https://explorer.solana.com/address/" + ADDR + "/tokens" &&
  d.accounts[1].name === "PlanetComp" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(d.accounts[1].address) && d.accounts[1].amount === "1234.5" && d.accounts[1].program === "Token" &&
  d.accounts[1].url === "https://solscan.io/account/" + d.accounts[1].address && d.accounts[1].transfers_url === d.accounts[1].url + "#transfers" &&
  d.accounts[1].mint_url === "https://solscan.io/token/" + MINT, d.accounts);
ok("1 the saved address: each active coin read from its token account (6 decimals) and SOL, with a Solscan link", st === 200 && d.shown && d.address === ADDR &&
  d.coins.length === 1 && d.coins[0].name === "PlanetComp" && d.coins[0].amount === "1234.5" && d.sol === 0.05 && d.explorer === "https://solscan.io/account/" + ADDR && !d.error, d);
rpcFail = true; [st, d] = await get({ ...env, SOLANA_RPC_URL: "https://rpc.test/other" });
ok("2 the network fails: amounts unknown and the error said, not a made-up 0; the wallet's links are still listed", d.sol === null && d.coins[0].amount === null && /boom/.test(d.error) &&
  d.accounts[0].url === "https://solscan.io/account/" + ADDR && d.accounts[0].amount === null, d); rpcFail = false;
const hid = []; for (const v of ["0", "false", "False", "TRUE", "off", "no", "1", "true", ""]) hid.push(v + ":" + ((await get({ ...env, WALLET_HOLDINGS: v }))[1].shown === false));
ok("3 WALLET_HOLDINGS false, False, 0, off or no hides it (nothing read); true, 1 or unset shows it", hid.join() === "0:true,false:true,False:true,TRUE:false,off:true,no:true,1:false,true:false,:false", hid);
lamports = 0; [st, d] = await get();
ok("4a the wallet holds no SOL but holds PlanetComp: the Solscan link opens its PlanetComp account (not the 'not found' wallet), with why", d.sol === 0 &&
  d.explorer_kind === "token_account" && /^https:\/\/solscan\.io\/account\/[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(d.explorer) && d.explorer !== "https://solscan.io/account/" + ADDR && /holds no SOL/.test(d.explorer_note), d);
units = 0n; [st, d] = await get();
ok("4b no SOL and no coins: the wallet link stays", d.explorer === "https://solscan.io/account/" + ADDR && !d.explorer_kind, d);
lamports = 50000000; units = 1234500000n;
const keep = profile; profile = { ...profile }; delete profile.solana_address; [st, d] = await get();
ok("4 no address saved: nothing to read", d.shown && d.address === "", d); profile = keep;
globalThis.__signed = false; [st] = await get(); ok("5 signed out: 401", st === 401, st); globalThis.__signed = true;
// the site asks in the page now (pcConfirm), not in a browser pop-up: answer OK and keep the question (window.__asked)
const AUTO_OK = () => { if (window.__autoOk) return; window.__autoOk = 1; window.__asked = [];
  new MutationObserver(() => { const t = document.querySelector(".pc-toast.ask:not([data-seen])"); if (!t) return; t.dataset.seen = "1";
    window.__asked.push(t.querySelector(".pc-t-msg").textContent); setTimeout(() => t.querySelector(".pc-ok").click(), 0); })
    .observe(document, { childList: true, subtree: true }); };
const asked = (where) => where.evaluate(() => (window.__asked || []).slice(-1)[0] || "");
let wd = null, moved = false, confirmText = "", MODES = { transfer_site_pays: false, transfer_user_pays: true }, siteSent = null;
const br = await chromium.launch(), errs = [], pg = await br.newPage({ viewport: { width: 1300, height: 900 } }); pg.on("pageerror", (e) => errs.push(e.message));
await pg.route(/^https:\/\/planetcompute\.ai\//, async (rt) => { const u = new URL(rt.request().url());
  if (u.pathname === "/api/me") return rt.fulfill({ contentType: "application/json", body: JSON.stringify({ user_id: "u1", primary_email: "a@b.c", solana_address: ADDR, solana_address_at: "2026-10-27T10:00:00Z" }) });
  if (u.pathname === "/api/me/solana-address/holdings") return rt.fulfill({ contentType: "application/json", body: JSON.stringify({ shown: true, address: ADDR, cluster: "mainnet-beta",
    explorer: "https://solscan.io/account/" + ADDR, sol: 0.05, coins: [{ name: "PlanetComp", amount: "1234.5" }], at: "2026-10-27T22:45:00Z",
    accounts: [{ kind: "wallet", name: "SOL", address: ADDR, amount: "0.05", url: "https://solscan.io/account/" + ADDR, transfers_url: "https://solscan.io/account/" + ADDR + "#transfers",
        explorer_url: "https://explorer.solana.com/address/" + ADDR, all_url: "https://explorer.solana.com/address/" + ADDR + "/tokens" },
      { kind: "token", name: "PlanetComp", address: PC_ACC, amount: "1234.5", url: "https://solscan.io/account/" + PC_ACC, transfers_url: "https://solscan.io/account/" + PC_ACC + "#transfers",
        explorer_url: "https://explorer.solana.com/address/" + PC_ACC, mint_url: "https://solscan.io/token/" + MINT }] }) });
  if (u.pathname === "/api/me/credit") return rt.fulfill({ contentType: "application/json", body: JSON.stringify({ wallet_enabled: true, move_shown: true, cluster: "mainnet-beta", ...MODES,
    min_send: "0.01", bonus_available: moved ? "0" : "0.05", lifetime_left_wu: moved ? "0" : "3" }) });
  const JS = (o, st = 200) => rt.fulfill({ status: st, contentType: "application/json", body: JSON.stringify(o) });
  if (u.pathname === "/api/wallet/claim/quote") return JS({ address: ADDR, cluster: "mainnet-beta", fee_sol: "0.00001", deposit_sol: moved ? "0" : "0.00151384", new_account: !moved,
    need_sol: moved ? "0.00001" : "0.00152384", has_sol: "0.05", enough: true });
  if (u.pathname === "/api/wallet/history") return JS({ transfers: moved ? [{ at: "2026-10-28T01:00:00Z", tokens: "0.05", coins: [{ name: "PlanetComp", amount: "0.05" }], wu: "3", to_wallet: ADDR,
    status: "settled", status_text: "sent", explorer: "https://solscan.io/tx/abc", account: "9KbbZmAbNPW7tNyYGz884aAUGxE2p6xFTh5kEtjRyd7T", account_url: "https://solscan.io/account/9KbbZmAbNPW7tNyYGz884aAUGxE2p6xFTh5kEtjRyd7T", receipt_sent: true }] : [] });
  if (u.pathname === "/api/wallet/withdraw") { siteSent = JSON.parse(rt.request().postData()); moved = true; return JS({ ok: true, status: "settled", tokens_sent: "0.05", wu_moved: "3", explorer: "https://explorer.solana.com/tx/def" }); }
  if (u.pathname === "/api/wallet/claim/prepare") { wd = JSON.parse(rt.request().postData()); return JS({ ok: true, id: "0123456789abcdef", transaction: "AQID", tokens: "0.05", wu: "3" }); }
  if (u.pathname === "/api/wallet/claim/confirm") { moved = true; return JS({ ok: true, status: "settled", explorer: "https://explorer.solana.com/tx/abc" }); }
  if (u.pathname.startsWith("/api/")) return rt.fulfill({ contentType: "application/json", body: "{}" });
  const res = await W.fetch(new Request(u.toString()), env); const hd = {}; res.headers.forEach((v, k) => hd[k] = v); rt.fulfill({ status: res.status, headers: hd, body: Buffer.from(await res.arrayBuffer()) }); });
await pg.route(/^https?:\/\/(?!planetcompute\.ai\/)/, (rt) => rt.abort());
await pg.addInitScript((addr) => {                                   // a stand-in Phantom wallet and Solana library
  window.__signed = 0; window.solanaWeb3 = { Transaction: { from: (b) => ({ bytes: b }) } };
  window.phantom = { solana: { publicKey: { toString: () => addr }, connect: async () => ({}), signAndSendTransaction: async (tx) => { window.__signed++; return { signature: "sig1" }; } } };
}, ADDR);
await pg.addInitScript(AUTO_OK);
await pg.goto("https://planetcompute.ai/balance"); await pg.waitForTimeout(1500);
const c = await pg.evaluate(() => ({ shown: !document.getElementById("aHold").hidden, t: document.getElementById("aHold").textContent, href: (document.querySelector("#aHold a") || {}).href }));
ok("6 /balance: under the address, what it holds, when it was read, and a Solscan link", c.shown &&
  c.t.startsWith("This wallet holds: 1234.5 PlanetComp · 0.05 SOL (read from Solana mainnet at 22:45 UTC)") && c.href === "https://solscan.io/account/" + ADDR, c);
const li = await pg.evaluate(() => [...document.querySelectorAll("#aHold li")].map((x) => ({ t: x.textContent, links: [...x.querySelectorAll("a")].map((a) => a.href), btn: (x.querySelector("button") || {}).textContent })));
ok("6b under it, every account the wallet owns, each with its links: wallet (Solscan, Transfers, Solana Explorer, All its coins), PlanetComp account (Solscan, Transfers, Solana Explorer, Mint); each button says Copy address", li.length === 2 &&
  li[0].t.startsWith("Wallet (SOL): 0.05 SOL · " + ADDR) && li[0].links.join() === ["https://solscan.io/account/" + ADDR, "https://solscan.io/account/" + ADDR + "#transfers",
    "https://explorer.solana.com/address/" + ADDR, "https://explorer.solana.com/address/" + ADDR + "/tokens"].join() &&
  li[1].t.startsWith("PlanetComp account: 1234.5 PlanetComp · " + PC_ACC) && li[1].links.join() === ["https://solscan.io/account/" + PC_ACC, "https://solscan.io/account/" + PC_ACC + "#transfers",
    "https://explorer.solana.com/address/" + PC_ACC, "https://solscan.io/token/" + MINT].join() && li.every((x) => x.btn === "Copy address"), li);
await pg.evaluate(() => document.getElementById("aHold").scrollIntoView({ block: "center" })); await pg.screenshot({ path: OUT + "/balance_holdings.png" });
await pg.locator("#aHold").screenshot({ path: OUT + "/balance_accounts.png" });
let m = await pg.evaluate(() => ({ shown: !document.getElementById("mv").hidden, t: document.getElementById("mvText").textContent, dis: document.getElementById("mvGo").disabled }));
ok("8 Move my lifetime balance: the WU left (3) and the bonus to send (0.05), the button on", m.shown && /Left to move: 3 WU/.test(m.t) && /bonus of 0\.05/.test(m.t) && !m.dis, m);
const cost = await pg.textContent("#mvCost"), hist0 = await pg.textContent("#mvHist");
ok("8b next to the button, the real charge: 0.00001 SOL fee + 0.00151384 SOL one-time account deposit = 0.00152384 SOL, what the wallet holds; no transfers yet",
  /0\.00001 SOL network fee, plus 0\.00151384 SOL once, this first time/.test(cost) && /Total 0\.00152384 SOL/.test(cost) && /holds 0\.05 SOL/.test(cost) && /No transfers yet/.test(hist0), { cost, hist0 });
await pg.click("#mvGo"); await pg.waitForTimeout(1500); confirmText = await asked(pg);
m = await pg.evaluate(() => ({ msg: document.getElementById("mvMsg").textContent, t: document.getElementById("mvText").textContent, dis: document.getElementById("mvGo").disabled }));
const after = await pg.evaluate(() => ({ signed: window.__signed, hist: [...document.querySelectorAll("#mvHist tr")].map((r) => r.textContent), cost: document.getElementById("mvCost").textContent }));
ok("9 after the confirm (with the charge in it): the connected wallet is sent to prepare, the wallet approves once; says what was sent + receipt + link; 0 left, button off",
  wd && wd.wallet === ADDR && after.signed === 1 && /pays 0\.00152384 SOL/.test(confirmText) && /cannot be undone/.test(confirmText) && /Sent: 0\.05 in coins; 3 WU moved/.test(m.msg) &&
  /emailed you a receipt/.test(m.msg) && /See the transaction/.test(m.msg) && /Left to move: 0 WU/.test(m.t) && m.dis, { wd, confirmText, m, after });
const hc = await pg.evaluate(() => ({ help: (document.querySelector("#mv details summary") || {}).textContent, last: [...document.querySelectorAll("#mvHist tr")].map((r) => r.lastChild.textContent),
  href: (document.querySelector("#mvHist tr:nth-child(2) td:last-child a") || {}).href }));
ok("9c 'Can't see your PlanetComp?' help; each sent transfer links 'Your coin account' on Solscan", hc.help === "Can't see your PlanetComp?" && hc.last[0] === "Your coin account" &&
  /^PlanetComp 9Kbb…yd7T$/.test(hc.last[1]) && hc.href === "https://solscan.io/account/9KbbZmAbNPW7tNyYGz884aAUGxE2p6xFTh5kEtjRyd7T", hc);
ok("9b history: the transfer with amount, WU, wallet, 'sent' and a View link; the charge line now says fee only", after.hist.length === 2 && /0\.05 PlanetComp/.test(after.hist[1]) && /sent/.test(after.hist[1]) && /View/.test(after.hist[1]) &&
  /0\.00001 SOL network fee for each move/.test(after.cost), after);
await pg.evaluate(() => document.getElementById("mv").scrollIntoView({ block: "center" })); await pg.screenshot({ path: OUT + "/balance_move.png" });
let declined = await br.newPage(); await declined.close();
// both settings YES (as now): Move = PlanetCompute pays, no wallet app; the claim is the second button
MODES = { transfer_site_pays: true, transfer_user_pays: true }; moved = false; wd = null;
await pg.reload(); await pg.waitForTimeout(1800);
let mm = await pg.evaluate(() => ({ claimBtn: !document.getElementById("mvClaim").hidden, cost: document.getElementById("mvCost").textContent }));
ok("10 both YES: 'Free for you: PlanetCompute pays'; the second button 'Approve it in my own wallet instead' with its real charge", mm.claimBtn &&
  /^For a limited time only\.\.\. Free for you: PlanetCompute pays the network charge\. Or approve it in your own wallet/.test(mm.cost) && /Total 0\.00152384 SOL/.test(mm.cost), mm);
await pg.click("#mvGo"); await pg.waitForTimeout(1500); const conf2 = await asked(pg);
mm = await pg.evaluate(() => ({ msg: document.getElementById("mvMsg").textContent, signed: window.__signed }));
ok("11 Move with both YES: PlanetCompute pays (withdraw for the saved address), no wallet approval asked; receipt + link", siteSent && siteSent.to === ADDR && wd === null &&
  /Free for you: PlanetCompute pays/.test(conf2) && /Sent: 0\.05 in coins; 3 WU moved/.test(mm.msg) && /emailed you a receipt/.test(mm.msg) && mm.signed === 0, { siteSent, wd, conf2, mm });
await pg.evaluate(() => document.getElementById("mv").scrollIntoView({ block: "center" })); await pg.screenshot({ path: OUT + "/balance_both.png" });
const sdis = () => pg.evaluate(() => document.getElementById("aSave").disabled);
const e0 = await sdis(); await pg.fill("#aAddr", ADDR + " "); const e1 = await sdis(); await pg.fill("#aAddr", "8XStVadubKdNsBqX9u1QtzMxBw463AH7bnkqxjrsjQeV"); const e2 = await sdis(); await pg.fill("#aAddr", ADDR); const e3 = await sdis();
ok("12 Update is on only when the address was changed (same: off, same + space: off, another: on, back: off)", e0 && e1 && !e2 && e3, { e0, e1, e2, e3 });
await pg.click("#aHist"); await pg.waitForTimeout(500);
ok("13 Previous addresses with no history: says there are none", /^No previous addresses: this is the first wallet address on your account\.$/.test(await pg.textContent("#aList")), await pg.textContent("#aList"));
ok("7 no page errors", errs.length === 0, errs);
console.log(`\n${pass} passed, ${fail} failed`); await br.close(); process.exit(fail ? 1 : 0);
