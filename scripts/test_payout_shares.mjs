// Test (TESTING.md test 45): the bonus sent in the coins of the share set in force, a REAL devnet transfer. The given
// worker.js runs in-process against the TEST tables with the devnet treasury. A second test coin (Token-2022, 6
// decimals, like PlanetComp; held by a second wallet, "sender 2") and a set of PlanetComp 60 % + coin 2 40 % are put
// in pctest-ai-ledger-options. Without sender 2's key the transfer is refused; with it, 0.02 bonus goes out as 0.012
// PlanetComp + 0.008 coin 2 in ONE transaction. The test coin, the set and the account are deleted after.
//   AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. PCC_MINT=7vSu.. TREASURY_SECRET_FILE=.ops/devnet_treasury.secret \
//     COIN2_FILE=.ops/devnet_coin2.json SENDER2_SECRET_FILE=.ops/devnet_sender2.secret node scripts/test_payout_shares.mjs website/worker.js
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { randomBytes, createHash, createHmac } from "node:crypto";
const nacl = createRequire(process.cwd() + "/")("tweetnacl");
let src = readFileSync(process.argv[2], "utf8");
src = src.replace("async function currentUser(env, request) {", "async function currentUser(env, request) { if (globalThis.__user) return { user_id: globalThis.__user, token: 't' };");
src += "\nglobalThis.__addCredit = addCredit;\n";
src = src.replace("async function cachedUser(env, request) {", "async function cachedUser(env, request) { if (globalThis.__user) return { user_id: globalThis.__user, token: 't' };");
const tmp = join(mkdtempSync(join(tmpdir(), "ps-")), "w.mjs"); writeFileSync(tmp, src); globalThis.WebSocketRequestResponsePair = class {};
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
env.TREASURY_PUBLIC = JSON.parse(readFileSync(process.env.TREASURY_SECRET_FILE.replace("devnet_treasury.secret", "devnet_setup.json"), "utf8").trim().split("\n").pop()).treasury;
const C2 = JSON.parse(readFileSync(process.env.COIN2_FILE, "utf8")), SENDER2 = readFileSync(process.env.SENDER2_SECRET_FILE, "utf8").trim();
const LT = PREFIX + "ledger-options", S = (v) => ({ S: String(v) }), Nn = (v) => ({ N: String(v) });
// a second coin and a 60 / 40 share set in force from a second ago, written straight into the TEST table (the admin
// page only schedules sets in the future; test 44 covers that), both deleted at the end
const cid = "devtest-" + randomBytes(3).toString("hex"), eff = new Date(Date.now() - 1000).toISOString(), sid = "t" + randomBytes(5).toString("hex");
await ddb("PutItem", { TableName: LT, Item: { pk: S("COIN"), sk: S(cid), coin_id: S(cid), name: S("Devnet coin 2"), symbol: S("DEV2"), status: S("active"),
  mint_mainnet: S(""), decimals: Nn(6), token_program: S("token-2022"), address_from: S(""), mint_devnet: S(C2.coin2_mint), decimals_devnet: Nn(6), address_from_devnet: S(C2.sender2) } });
await ddb("PutItem", { TableName: LT, Item: { pk: S("SET"), sk: S(`${eff}#${sid}`), set_id: S(sid), effective_from: S(eff), status: S("active"), note: S("test 45"),
  shares: S(JSON.stringify([{ coin_id: "planetcomp", pct: 60 }, { coin_id: cid, pct: 40 }])) } });
const user = "ps" + randomBytes(5).toString("hex"); globalThis.__user = user;
await ddb("PutItem", { TableName: PREFIX + "user-credits", Item: { user_id: { S: user }, sk: { S: "BALANCE" }, available_uwu: { N: "100000000000" }, lifetime_contribution_uwu: { N: "100000000000" } } });
const kp = nacl.sign.keyPair(), addr = b58(kp.publicKey);
const st = await api("/api/wallet/link/start", { wallet: addr, kind: "browser" });
await api("/api/wallet/link/verify", { signature: b58(nacl.sign.detached(new TextEncoder().encode(st.j.message), kp.secretKey)) });
const c0 = (await api("/api/me/credit")).j;
console.log("test account", user, "bonus", c0.bonus_available, "; coin 2", C2.coin2_mint, "(Token-2022) from", C2.sender2);
// 1 the website holds no key for coin 2's send-from address: refused before anything is reserved
const nokey = await api("/api/wallet/withdraw", { amount: "0.02", to: addr });
ok("1 a coin whose send-from address the website holds no key for: refused, nothing sent, bonus unchanged", nokey.s === 503 && /holds no key/.test(nokey.j.error) && nokey.j.bonus_available === c0.bonus_available, nokey);
// 2 with the key: one transaction, PlanetComp 60 % + coin 2 40 %
env.COIN_SEND_KEYS = SENDER2;
const w = await api("/api/wallet/withdraw", { amount: "0.02", to: addr });
console.log("  transfer:", w.s, w.j.status, JSON.stringify(w.j.coins), w.j.explorer || w.j.error);
const pc = (w.j.coins || []).find((c) => c.coin_id === "planetcomp"), c2 = (w.j.coins || []).find((c) => c.coin_id === cid);
ok("2 0.02 bonus is sent as 0.012 PlanetComp (60 %) + 0.008 coin 2 (40 %), in one devnet transaction", w.s === 200 && w.j.status === "settled" && pc && pc.amount === "0.012" && c2 && c2.amount === "0.008", w.j);
const tx = await rpc("getTransaction", [w.j.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
const post = (tx && tx.meta && tx.meta.postTokenBalances || []).filter((b) => b.owner === addr);
ok("3 that one transaction moved both coins: the wallet's balances after it are 0.012 and 0.008", post.length === 2 &&
  post.some((b) => b.mint === env.PCC_MINT && b.uiTokenAmount.uiAmountString === "0.012") && post.some((b) => b.mint === C2.coin2_mint && b.uiTokenAmount.uiAmountString === "0.008"), post);
const t22 = await rpc("getTokenAccountsByOwner", [addr, { programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }, { encoding: "jsonParsed", commitment: "confirmed" }]);
ok("4 coin 2 arrived as a Token-2022 account (as PlanetComp's will on mainnet), sent from sender 2", t22.value.length === 1 && t22.value[0].account.data.parsed.info.mint === C2.coin2_mint &&
  (tx.transaction.message.accountKeys || []).some((k) => k.pubkey === C2.sender2 && k.signer), t22.value);
const c1 = (await api("/api/me/credit")).j;
ok("5 the bonus went down by exactly 0.02; the Work Units did not move", Math.abs(Number(c0.bonus_available) - Number(c1.bonus_available) - 0.02) < 1e-12 && c1.available_wu === "100000", { c0: c0.bonus_available, c1: c1.bonus_available });
const row = (await ddb("Query", { TableName: PREFIX + "user-credits", KeyConditionExpression: "user_id = :u AND begins_with(sk, :r)", ExpressionAttributeValues: { ":u": { S: user }, ":r": { S: "TX#redeem#" } } })).Items[0];
const legs = JSON.parse(row.coins.S);
ok("6 the transfer's record lists each coin, its share, amount and FROM address (and the fee payer)", legs.length === 2 && row.status.S === "settled" &&
  legs.find((l) => l.coin_id === "planetcomp").from === env.TREASURY_PUBLIC && legs.find((l) => l.coin_id === cid).from === C2.sender2 &&
  row.from_wallets.S.split(",").sort().join() === [env.TREASURY_PUBLIC, C2.sender2].sort().join() && row.fee_payer.S === env.TREASURY_PUBLIC && !!row.to_wallet.S, row);
// clean up: the test coin and set, the test account (the devnet tokens stay in the throwaway wallet)
await ddb("DeleteItem", { TableName: LT, Key: { pk: S("COIN"), sk: S(cid) } });
await ddb("DeleteItem", { TableName: LT, Key: { pk: S("SET"), sk: S(`${eff}#${sid}`) } });
await api("/api/wallet/unlink", { wallet: addr });
const all = await ddb("Query", { TableName: PREFIX + "user-credits", KeyConditionExpression: "user_id = :u", ExpressionAttributeValues: { ":u": { S: user } } });
for (const it of all.Items || []) await ddb("DeleteItem", { TableName: PREFIX + "user-credits", Key: { user_id: it.user_id, sk: it.sk } });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
