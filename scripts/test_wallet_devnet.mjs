// Test (TESTING.md test 41): a REAL transfer on the Solana devnet. The given worker.js runs in-process against the TEST
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
src += "\nglobalThis.__addCredit = addCredit;\n";
src = src.replace("async function cachedUser(env, request) {", "async function cachedUser(env, request) { if (globalThis.__user) return { user_id: globalThis.__user, token: 't' };");
const tmp = join(mkdtempSync(join(tmpdir(), "wd-")), "w.mjs"); writeFileSync(tmp, src); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default, PREFIX = "pctest-ai-", RPC = "https://api.devnet.solana.com";
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, AWS_REGION: process.env.AWS_REGION || "us-east-1",
  DDB_PREFIX: PREFIX, SESSION_SECRET: "s".repeat(40), MAIL_FROM: "test@planetcompute.ai", WALLET_TEST: "1", SITE_PAYS_FEES: "1", SOLANA_CLUSTER: "devnet", SOLANA_RPC_URL: RPC,
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
const user = "wd" + randomBytes(5).toString("hex"); globalThis.__user = user;
await ddb("PutItem", { TableName: PREFIX + "user-credits", Item: { user_id: { S: user }, sk: { S: "BALANCE" }, available_uwu: { N: "100000000000" }, lifetime_contribution_uwu: { N: "100000000000" } } });
console.log("test account", user, "with 100000 WU available");
const kp = nacl.sign.keyPair(), addr = b58(kp.publicKey);
const st = await api("/api/wallet/link/start", { wallet: addr, kind: "browser" });
const sig = b58(nacl.sign.detached(new TextEncoder().encode(st.j.message), kp.secretKey));
const v = await api("/api/wallet/link/verify", { signature: sig });
ok("1 a wallet made here is linked by its signature", st.s === 200 && v.s === 200, { st, v });
const c0 = (await api("/api/me/credit")).j, rate = Number(c0.bonus_per_wu), bonus0 = Number(c0.bonus_available);
const since = src.match(/const BONUS_SINCE = "([^"]+)"/)[1];               // WU from before bonus tracking: the rule then
const rules = (await ddb("Query", { TableName: PREFIX + "howCreditAwarded", KeyConditionExpression: "pk = :r", ExpressionAttributeValues: { ":r": { S: "RULE" } } })).Items
  .filter((r) => (!r.status || r.status.S !== "cancelled") && r.effective_from.S <= since).sort((a, b) => (a.sk.S < b.sk.S ? -1 : 1));
const oldRate = Number(rules[rules.length - 1].credit_per_wu.N);
console.log("  rate now", rate, "per WU; rule at", since, oldRate, "; bonus", c0.bonus_available);
ok("2a 100000 WU earned before bonus tracking = 100000 x the rule in force then", rate > 0 && Math.abs(bonus0 - 100000 * oldRate) < 1e-9, { c0, oldRate });
const small = await api("/api/wallet/withdraw", { amount: "0.009999", to: addr });
ok("2b less than the minimum transfer (0.01) is refused, nothing sent", small.s === 400 && small.j.min_send === "0.01" && c0.min_send === "0.01" && /smallest transfer is 0.01/.test(small.j.error) && small.j.bonus_available === c0.bonus_available, small);
const realFetch = globalThis.fetch;                                  // the payout wallet looks empty of SOL for one try
globalThis.fetch = async (u, o) => (o && typeof o.body === "string" && o.body.includes('"getBalance"') && String(u).startsWith(RPC))
  ? new Response('{"jsonrpc":"2.0","result":{"context":{"slot":1},"value":0},"id":1}') : realFetch(u, o);
const empty = await api("/api/wallet/withdraw", { to: addr }); globalThis.fetch = realFetch;
const c0b = (await api("/api/me/credit")).j;
ok("2c payout wallet without SOL: refused before anything is reserved (bonus, Transferred unchanged)", empty.s === 503 && /not available yet/.test(empty.j.error) &&
  /Nothing was sent/.test(empty.j.error) && c0b.bonus_available === c0.bonus_available && c0b.lifetime_redeemed_wu === "0", { empty, c0b });
const part = (bonus0 / 3).toFixed(9).replace(/0+$/, "");
const w = await api("/api/wallet/withdraw", { amount: part, to: addr });
console.log("  transfer:", w.s, w.j.status, w.j.tokens_sent, "tokens", w.j.explorer || w.j.error);
ok("2 send a third of the bonus: settled on devnet, with an explorer link", w.s === 200 && w.j.status === "settled" && w.j.tokens_sent === part && /solscan\.io\/tx\/.+cluster=devnet/.test(w.j.explorer), w.j);
ok("3 the Work Units did NOT go down (still 100000 available, 100000 lifetime): the coin is a bonus", w.j.available_wu === "100000" && w.j.lifetime_contribution_wu === "100000", w.j);
ok("3b Lifetime Compute Transferred went up by the same share of what was left (a third of 100000 WU); Contributed stays 100000",
  Math.abs(Number(w.j.lifetime_transferred_wu) - 100000 * Number(part) / bonus0) < 0.001 && w.j.wu_moved === w.j.lifetime_transferred_wu, w.j);
const bal1 = (await api("/api/me/balance")).j;
ok("3c My Balance: Compute Shared and the Difference did not move; Lifetime Compute Transferred shows the move", bal1.shared_wu === "100000" &&
  bal1.difference_wu === "100000" && bal1.lifetime_contributed_wu === "100000" && bal1.lifetime_transferred_wu === w.j.lifetime_transferred_wu, bal1);
let onchain = null;
for (let i = 0; i < 10 && !onchain; i++) { const r = await rpc("getTokenAccountsByOwner", [addr, { mint: env.PCC_MINT }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  onchain = r && r.value && r.value[0] ? r.value[0].account.data.parsed.info.tokenAmount : null; if (!onchain) await new Promise((x) => setTimeout(x, 2000)); }
ok("4 the tokens are in the wallet on chain: exactly what the website said it sent", !!onchain && onchain.uiAmountString === w.j.tokens_sent, { onchain, sent: w.j.tokens_sent });
const l = await api("/api/wallet/list");
ok("5 List wallets shows the same tokens from the chain", l.j.wallets[0].tokens === w.j.tokens_sent, l.j.wallets);
const left = (await api("/api/me/credit")).j.bonus_available;
const too = await api("/api/wallet/withdraw", { amount: (Number(left) + 0.000001).toFixed(9), to: addr });
ok("6 more than the bonus left is refused, nothing sent", too.s === 409 && too.j.bonus_available === left && /bonus to send/.test(too.j.error), { left, too });
await globalThis.__addCredit(env, user, 2000000, new Date().toISOString());       // 2 WU credited now
const c2 = (await api("/api/me/credit")).j;
ok("7 2 WU credited now: WU 100002, bonus up by exactly 2 x the rate in force (locked at earn time)", c2.available_wu === "100002" &&
  Math.abs(Number(c2.bonus_available) - Number(left) - 2 * rate) < 1e-9, { left, c2 });
const all = await api("/api/wallet/withdraw", { to: addr });          // Move my lifetime balance to my wallet: everything left
console.log("  move all:", all.s, all.j.status, all.j.tokens_sent, all.j.explorer || all.j.error);
ok("8 move everything left: settled; Lifetime Compute Transferred = Contributed (100002), nothing left to move", all.s === 200 && all.j.status === "settled" &&
  all.j.tokens_sent === c2.bonus_available && all.j.lifetime_transferred_wu === "100002" && all.j.lifetime_contribution_wu === "100002" && all.j.bonus_available === "0", all.j);
const c3 = (await api("/api/me/credit")).j, bal2 = (await api("/api/me/balance")).j;
ok("9 after it: 0 WU left to move; Compute Shared 100002 and the Difference unchanged; Transferred = Contributed on My Balance", c3.lifetime_left_wu === "0" &&
  bal2.shared_wu === "100002" && bal2.difference_wu === "100002" && bal2.lifetime_transferred_wu === bal2.lifetime_contributed_wu, { c3, bal2 });
let total = null;
for (let i = 0; i < 10; i++) { const r = await rpc("getTokenAccountsByOwner", [addr, { mint: env.PCC_MINT }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  total = r && r.value && r.value[0] ? r.value[0].account.data.parsed.info.tokenAmount.uiAmountString : null;
  if (total && Math.abs(Number(total) - Number(w.j.tokens_sent) - Number(all.j.tokens_sent)) < 1e-9) break; await new Promise((x) => setTimeout(x, 2000)); }
ok("10 on chain the wallet holds both transfers exactly", total && Math.abs(Number(total) - Number(w.j.tokens_sent) - Number(all.j.tokens_sent)) < 1e-9, { total, a: w.j.tokens_sent, b: all.j.tokens_sent });
const again = await api("/api/wallet/withdraw", { to: addr });
ok("11 moving again: refused, nothing sent, Transferred unchanged", again.s === 400 && /No bonus to send/.test(again.j.error) &&
  (await api("/api/me/balance")).j.lifetime_transferred_wu === "100002", again);
// security review W3: the network stops answering status checks right after a transfer was sent: it must stay pending
// (NOT given back), then settle once the network answers again; no second payout
await globalThis.__addCredit(env, user, 10000000000, new Date().toISOString());
const realFetch3 = globalThis.fetch; let blocked = 0;
globalThis.fetch = async (u, o) => { if (o && typeof o.body === "string" && o.body.includes('"getSignatureStatuses"') && String(u).startsWith(RPC)) { blocked++; throw new Error("network down"); } return realFetch3(u, o); };
const w3 = await api("/api/wallet/withdraw", { to: addr }); globalThis.fetch = realFetch3;
const c6 = (await api("/api/me/credit")).j;
ok("12 status checks fail after sending: the transfer is 'pending', the bonus is NOT given back", w3.s === 200 && w3.j.status === "pending" && blocked > 0 && c6.bonus_available === "0", { s: w3.s, st: w3.j.status, err: w3.j.error, blocked, b: c6.bonus_available });
let h3 = []; for (let i = 0; i < 10; i++) { await new Promise((x) => setTimeout(x, 3000)); h3 = (await api("/api/wallet/history")).j.transfers; if (h3[0] && h3[0].status === "settled") break; }
const c7 = (await api("/api/me/credit")).j, again3 = await api("/api/wallet/withdraw", { to: addr });
ok("13 once the network answers: settled (it had landed); still nothing to send again", h3[0] && h3[0].status === "settled" && c7.bonus_available === "0" && again3.s === 400, { h: h3[0] && h3[0].status, b: c7.bonus_available, again: again3.s });
// clean up the test account (the devnet tokens stay in the throwaway wallet)
await api("/api/wallet/unlink", { wallet: addr });
const tx = await ddb("Query", { TableName: PREFIX + "user-credits", KeyConditionExpression: "user_id = :u", ExpressionAttributeValues: { ":u": { S: user } } });
for (const it of tx.Items || []) await ddb("DeleteItem", { TableName: PREFIX + "user-credits", Key: { user_id: it.user_id, sk: it.sk } });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
