// Test (TESTING.md test 53): a REAL claim on the Solana devnet (user, 2026-10-28: "go with claim 100%, add receipt email and history").
// The user's own wallet (made here, signing like Phantom) approves and PAYS: the network fee and, the first time, the deposit
// of its token account; the site signs only as the coins' send-from wallet and pays nothing. Copied setup from test 41: The given worker.js runs in-process against the TEST
// tables (pctest-ai-*) with the real devnet treasury and token: a test account gets 1000 WU available, links a wallet
// made here (signed message), sends part of its bonus to it (coins are a BONUS earned with each WU at the rule in force
// when earned; sending never takes WU); the tokens must arrive on chain, the WU stay 1000, more than the bonus left is
// refused, and a newly credited WU adds bonus at the locked rate. Devnet tokens have no value.
//   AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. PCC_MINT=.. TREASURY_SECRET_FILE=.ops/devnet_treasury.secret \
//     node scripts/test_wallet_devnet.mjs website/worker.js        (run in a folder with tweetnacl installed)
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { randomBytes, createHash, createHmac } from "node:crypto";
const nacl = createRequire(process.cwd() + "/")("tweetnacl");
let src = readFileSync(process.argv[2], "utf8");
src = src.replace("async function currentUser(env, request) {", "async function currentUser(env, request) { if (globalThis.__user) return { user_id: globalThis.__user, token: 't' };");
src += "\nglobalThis.__addCredit = addCredit; globalThis.__w = { compileMessage, signTransaction, solKeypair, toBase64, u64le, concatBytes };\n";
src = src.replace("async function sendEmail(env, { to, subject, text, html, replyTo }) {", "async function sendEmail(env, { to, subject, text, html, replyTo }) { (globalThis.__mails = globalThis.__mails || []).push({ to, subject, text }); return;");
src = src.replace("async function cachedUser(env, request) {", "async function cachedUser(env, request) { if (globalThis.__user) return { user_id: globalThis.__user, token: 't' };");
const tmp = join(mkdtempSync(join(tmpdir(), "wd-")), "w.mjs"); writeFileSync(tmp, src); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default, PREFIX = "pctest-ai-", RPC = "https://api.devnet.solana.com";
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, AWS_REGION: process.env.AWS_REGION || "us-east-1",
  DDB_PREFIX: PREFIX, SESSION_SECRET: "s".repeat(40), MAIL_FROM: "test@planetcompute.ai", WALLET_TEST: "1", SOLANA_CLUSTER: "devnet", SOLANA_RPC_URL: RPC,
  PCC_MINT: process.env.PCC_MINT, TREASURY_SECRET_KEY: readFileSync(process.env.TREASURY_SECRET_FILE, "utf8").trim() };
async function ddb(op, payload) {                                     // DynamoDB by hand, for the test's own items
  const region = env.AWS_REGION, host = `dynamodb.${region}.amazonaws.com`, body = JSON.stringify(payload);
  const t = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""), d = t.slice(0, 8), h = (x) => createHash("sha256").update(x).digest("hex"), hm = (k, x) => createHmac("sha256", k).update(x).digest();
  const headers = { "content-type": "application/x-amz-json-1.0", host, "x-amz-date": t, "x-amz-target": "DynamoDB_20120810." + op }, names = Object.keys(headers).sort();
  const creq = ["POST", "/", "", names.map((n) => `${n}:${headers[n]}`).join("\n") + "\n", names.join(";"), h(body)].join("\n"), scope = `${d}/${region}/dynamodb/aws4_request`;
  let k = hm("AWS4" + env.AWS_SECRET_ACCESS_KEY, d); k = hm(k, region); k = hm(k, "dynamodb"); k = hm(k, "aws4_request");
  const r = await fetch(`https://${host}/`, { method: "POST", body, headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${names.join(";")}, Signature=${hm(k, ["AWS4-HMAC-SHA256", t, scope, h(creq)].join("\n")).toString("hex")}` } });
  const j = await r.json(); if (!r.ok) throw new Error(op + ": " + JSON.stringify(j)); return j;
}
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (u) => { let n = BigInt("0x" + (Buffer.from(u).toString("hex") || "0")), o = ""; while (n > 0n) { o = B58[Number(n % 58n)] + o; n /= 58n; } for (const x of u) { if (x) break; o = "1" + o; } return o; };
const rpc = async (method, params) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
const api = async (path, body) => { const r = await W.fetch(new Request("https://planetcompute.ai" + path, body ? { method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", origin: "https://planetcompute.ai" } } : {}), env); return { s: r.status, j: await r.json().catch(() => ({})) }; };

const user = "cl" + randomBytes(5).toString("hex"); globalThis.__user = user;
await ddb("PutItem", { TableName: PREFIX + "user-credits", Item: { user_id: { S: user }, sk: { S: "BALANCE" }, available_uwu: { N: "100000000000" }, lifetime_contribution_uwu: { N: "100000000000" } } });
const kp = nacl.sign.keyPair(), addr = b58(kp.publicKey);
await ddb("PutItem", { TableName: PREFIX + "user", Item: { pk: { S: "USER#" + user }, sk: { S: "PROFILE" }, user_id: { S: user }, primary_email: { S: "claim-test@invalid" }, solana_address: { S: addr } } });
console.log("test account", user, "100000 WU, its own wallet", addr);
const lamports = async (a) => (await rpc("getBalance", [a, { commitment: "confirmed" }])).value;
const tokensOf = async (a) => { const r = await rpc("getTokenAccountsByOwner", [a, { mint: env.PCC_MINT }, { encoding: "jsonParsed", commitment: "confirmed" }]); return r && r.value && r.value[0] ? r.value[0].account.data.parsed.info.tokenAmount.uiAmountString : "0"; };
const wait = (ms) => new Promise((x) => setTimeout(x, ms));
const treasury = await globalThis.__w.solKeypair(env.TREASURY_SECRET_KEY);
async function userSigns(b64) {                                       // what Phantom does: sign as fee payer (slot 0) and send
  const raw = Uint8Array.from(Buffer.from(b64, "base64")), n = raw[0], msg = raw.slice(1 + 64 * n);
  raw.set(nacl.sign.detached(msg, kp.secretKey), 1);
  const r = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [Buffer.from(raw).toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }] }) })).json();
  return r;
}
const c0 = (await api("/api/me/credit")).j;
console.log("  bonus", c0.bonus_available, "left", c0.lifetime_left_wu);
let r = await api("/api/wallet/withdraw", { to: addr });
ok("1 the site paying the fees is off: /api/wallet/withdraw refused (403), points to Move my lifetime balance", r.s === 403 && /your own wallet/.test(r.j.error), r);
env.TRANSFER_CLAIM_USER_PAY = "NO"; r = await api("/api/wallet/claim/prepare", { wallet: addr }); delete env.TRANSFER_CLAIM_USER_PAY;
ok("1b TRANSFER_CLAIM_USER_PAY=NO: a claim is refused (403); nothing reserved", r.s === 403 && /switched off/.test(r.j.error) && (await api("/api/me/credit")).j.bonus_available === c0.bonus_available, r);
env.TRANSFER_PLANETCOMPUTE_PAYS = "YES"; const cy = (await api("/api/me/credit")).j; delete env.TRANSFER_PLANETCOMPUTE_PAYS;
ok("1c TRANSFER_PLANETCOMPUTE_PAYS=YES: My Balance is told PlanetCompute pays (and claims stay on)", cy.transfer_site_pays === true && cy.transfer_user_pays === true, { s: cy.transfer_site_pays, u: cy.transfer_user_pays });
r = await api("/api/wallet/claim/prepare", { wallet: b58(nacl.sign.keyPair().publicKey) });
ok("2 a wallet other than the saved address: refused, says which address to connect", r.s === 409 && r.j.saved === addr, r);
r = await api("/api/wallet/claim/prepare", { wallet: addr });
let c = (await api("/api/me/credit")).j;
ok("3 the user's wallet has no SOL: refused with how much it needs (fee + first-time deposit); nothing reserved", r.s === 409 && Number(r.j.need_sol) > 0.001 && r.j.has_sol === "0" &&
  c.bonus_available === c0.bonus_available && c.lifetime_redeemed_wu === "0" && (await api("/api/wallet/history")).j.transfers.length === 0, { r, c });
{ // fund the test user's wallet with 0.02 devnet SOL from the treasury (test setup only)
  const ix = { programId: "11111111111111111111111111111111", keys: [{ pubkey: treasury.publicKey, isSigner: true, isWritable: true }, { pubkey: addr, isSigner: false, isWritable: true }],
    data: globalThis.__w.concatBytes(Uint8Array.from([2, 0, 0, 0]), globalThis.__w.u64le(20000000n)) };
  const bh = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])).value.blockhash;
  const raw = await globalThis.__w.signTransaction(globalThis.__w.compileMessage(treasury.publicKey, bh, [ix]), [treasury]);
  await rpc("sendTransaction", [globalThis.__w.toBase64(raw), { encoding: "base64" }]);
  for (let i = 0; i < 20 && (await lamports(addr)) < 20000000; i++) await wait(1500);
}
const sol0 = await lamports(addr), tre0 = await lamports(treasury.publicKey);
const q1 = (await api("/api/wallet/claim/quote")).j, rent0 = await rpc("getMinimumBalanceForRentExemption", [165]);
ok("3b the cost shown next to the button: fee 0.00001 SOL, the one-time deposit (the network's own figure), what the wallet holds", q1.fee_sol === "0.00001" &&
  Number(q1.deposit_sol) === rent0 / 1e9 && q1.new_account === true && Number(q1.has_sol) === sol0 / 1e9 && q1.enough === true, { q1, rent0, sol0 });
const p1 = await api("/api/wallet/claim/prepare", { wallet: addr });
c = (await api("/api/me/credit")).j;
ok("4 prepared: the whole bonus and all WU left reserved (bonus 0, Transferred = Contributed); a new token account; a half-signed transaction", p1.s === 200 && p1.j.tokens === c0.bonus_available &&
  p1.j.new_account === true && p1.j.wu === "100000" && c.bonus_available === "0" && c.lifetime_redeemed_wu === "100000" && p1.j.transaction.length > 200, { p1: { ...p1.j, transaction: "…" }, c });
let h = (await api("/api/wallet/history")).j.transfers;
ok("5 history shows it waiting for the wallet", h.length === 1 && h[0].status === "claim_pending" && h[0].status_text === "waiting for your wallet", h);
r = await api("/api/wallet/claim/prepare", { wallet: addr });
ok("6 a second claim while one waits: refused", r.s === 409 && /waiting for your wallet/.test(r.j.error), r);
const sent = await userSigns(p1.j.transaction);
console.log("  user wallet sent:", sent.result || JSON.stringify(sent.error));
const cf = await api("/api/wallet/claim/confirm", { id: p1.j.id });
ok("7 confirmed: settled, with the transaction link", cf.s === 200 && cf.j.status === "settled" && cf.j.signature === sent.result && /solscan\.io\/tx\/.+cluster=devnet/.test(cf.j.explorer), cf.j);
let onchain = "0"; for (let i = 0; i < 10 && onchain === "0"; i++) { onchain = await tokensOf(addr); if (onchain === "0") await wait(2000); }
const sol1 = await lamports(addr), tre1 = await lamports(treasury.publicKey), paid = sol0 - sol1;
console.log("  user paid", paid, "lamports; site wallet", tre0, "->", tre1);
const rent = await rpc("getMinimumBalanceForRentExemption", [165]);
ok("8 the coins are in the user's wallet; the USER paid exactly the deposit of its new token account + the fee for 2 signatures; the site's wallet paid nothing",
  onchain === p1.j.tokens && paid === rent + 10000 && tre1 === tre0 && Number(p1.j.need_sol) === (rent + 10000) / 1e9, { onchain, paid, rent, need: p1.j.need_sol, tre0, tre1 });
const mails = (globalThis.__mails || []).filter((m) => m.to[0] === "claim-test@invalid");
ok("9 one receipt email: amount, the wallet, WU moved, the transaction link", mails.length === 1 && mails[0].subject.includes(p1.j.coins[0].amount) && mails[0].text.includes(addr) &&
  mails[0].text.includes("100000 WU") && mails[0].text.includes(cf.j.explorer), mails);
await api("/api/wallet/claim/confirm", { id: p1.j.id }); await api("/api/wallet/history");
ok("10 asking again sends no second email", (globalThis.__mails || []).filter((m) => m.to[0] === "claim-test@invalid").length === 1, globalThis.__mails);
const ata = ((await rpc("getTokenAccountsByOwner", [addr, { mint: env.PCC_MINT }, { encoding: "jsonParsed", commitment: "confirmed" }])).value[0] || {}).pubkey;
h = (await api("/api/wallet/history")).j.transfers;
ok("10b the user's coin account (what the network says the wallet's PlanetComp account is) is in the history (Solscan link) and in the receipt, with why the wallet may show 'does not exist'",
  !!ata && h[0].account === ata && h[0].account_url === "https://solscan.io/account/" + ata + "?cluster=devnet" && mails[0].text.includes(ata) && /account does not exist/.test(mails[0].text), { ata, h0: h[0], mail: mails[0].text });
ok("11 history: sent, with amount, WU, wallet, link, receipt sent", h.length === 1 && h[0].status_text === "sent" && h[0].tokens === p1.j.tokens && h[0].wu === "100000" && h[0].to_wallet === addr && h[0].explorer === cf.j.explorer && h[0].receipt_sent, h);
await globalThis.__addCredit(env, user, 10000000000, new Date().toISOString());   // 10000 WU more: a bonus over the minimum again
const c2 = (await api("/api/me/credit")).j;
await wait(8000);                                                    // the public devnet node limits bursts
const q2 = (await api("/api/wallet/claim/quote")).j;
ok("11b after the first transfer the cost shown is the fee only (no deposit)", q2.new_account === false && q2.deposit_sol === "0" && q2.need_sol === "0.00001", q2);
const p2 = await api("/api/wallet/claim/prepare", { wallet: addr });
ok("12 second claim: the account exists now, so the wallet needs only the fee (~0.00001 SOL)", p2.s === 200 && p2.j.new_account === false && Number(p2.j.need_sol) < 0.0001 && p2.j.wu === "10000", { ...p2.j, transaction: "…" });
console.log("  not approving it: waiting for the blockhash to expire (about 1.5-2 minutes)…");
let st = "claim_pending"; for (let i = 0; i < 30 && st === "claim_pending"; i++) { await wait(10000); st = (await api("/api/wallet/history")).j.transfers[0].status; }
const c3 = (await api("/api/me/credit")).j;
ok("13 never approved: released after its blockhash expired ('not approved in time'); bonus and Transferred back as before", st === "expired" &&
  c3.bonus_available === c2.bonus_available && c3.lifetime_redeemed_wu === "100000" && c3.lifetime_left_wu === "10000", { st, c2, c3 });
const late = await userSigns(p2.j.transaction);
ok("14 that expired transaction signed and sent now: the network refuses it (it can never pay twice)", !!late.error && !late.result, late);
const p3 = await api("/api/wallet/claim/prepare", { wallet: addr }), s3a = await lamports(addr);
const sent3 = await userSigns(p3.j.transaction), cf3 = await api("/api/wallet/claim/confirm", { id: p3.j.id });
await wait(3000); const s3b = await lamports(addr), tre3 = await lamports(treasury.publicKey);
ok("15 claimed again: settled; this time the user paid only the fee (10000 lamports, no deposit); site wallet still paid nothing", cf3.s === 200 && cf3.j.status === "settled" && (s3a - s3b) === 10000 && tre3 === tre1, { cf3: cf3.j, fee: s3a - s3b, tre1, tre3 });
const c4 = (await api("/api/me/credit")).j, bal = (await api("/api/me/balance")).j;
ok("16 everything moved: Transferred = Contributed = 110000, nothing left; Compute Shared untouched", c4.lifetime_left_wu === "0" && bal.lifetime_transferred_wu === "110000" && bal.lifetime_contributed_wu === "110000" && bal.shared_wu === "110000", { c4, bal });
h = (await api("/api/wallet/history")).j.transfers;
ok("17 history: 3 rows, newest first: sent, not approved in time, sent", h.map((x) => x.status).join() === "settled,expired,settled", h.map((x) => x.status));
// security review W2: claim, approve and send, never report it, then flood the reference with failing junk
// transactions; after expiry the claim must be found (by its exact message) and NOT released (no second payout)
await globalThis.__addCredit(env, user, 10000000000, new Date().toISOString());
const p4 = await api("/api/wallet/claim/prepare", { wallet: addr });
const sent4 = await userSigns(p4.j.transaction);
for (let i = 0; i < 6; i++) {                              // junk: a transfer the wallet cannot afford, naming the reference
  const ix = { programId: "11111111111111111111111111111111", keys: [{ pubkey: addr, isSigner: true, isWritable: true }, { pubkey: addr, isSigner: false, isWritable: true },
    { pubkey: p4.j.reference, isSigner: false, isWritable: false }], data: globalThis.__w.concatBytes(Uint8Array.from([2, 0, 0, 0]), globalThis.__w.u64le(10n ** 15n + BigInt(i))) };
  const bh = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])).value.blockhash;
  const raw = await globalThis.__w.signTransaction(globalThis.__w.compileMessage(addr, bh, [ix]), [{ publicKey: addr, sign: async (m) => nacl.sign.detached(m, kp.secretKey) }]);
  await rpc("sendTransaction", [globalThis.__w.toBase64(raw), { encoding: "base64", skipPreflight: true }]);
}
await wait(8000);
const junk = ((await rpc("getSignaturesForAddress", [p4.j.reference, { limit: 10, commitment: "confirmed" }])) || []);
console.log("  reference now named by", junk.length, "transactions,", junk.filter((x) => x.err).length, "failed");
let st4 = "claim_pending"; for (let i = 0; i < 30 && st4 === "claim_pending"; i++) { await wait(10000); st4 = (await api("/api/wallet/history")).j.transfers[0].status; }
const c5 = (await api("/api/me/credit")).j;
ok("18 the claim was sent but never reported, and the reference was flooded with failing junk: still found by its exact message (settled), NOT released (bonus stays 0, no second payout)",
  !!sent4.result && junk.filter((x) => x.err).length >= 5 && st4 === "settled" && c5.bonus_available === "0" && c5.lifetime_left_wu === "0", { st4, sent: sent4.result, c5: { b: c5.bonus_available, l: c5.lifetime_left_wu } });
// clean up the test account (the devnet tokens and SOL stay in the throwaway wallet)
const tx = await ddb("Query", { TableName: PREFIX + "user-credits", KeyConditionExpression: "user_id = :u", ExpressionAttributeValues: { ":u": { S: user } } });
for (const it of tx.Items || []) await ddb("DeleteItem", { TableName: PREFIX + "user-credits", Key: { user_id: it.user_id, sk: it.sk } });
await ddb("DeleteItem", { TableName: PREFIX + "user", Key: { pk: { S: "USER#" + user }, sk: { S: "PROFILE" } } });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
