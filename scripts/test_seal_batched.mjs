// docs/TESTING.md test 100: the batched balance seal (SealJob Durable Object, sealBatch / sealFinish in website/worker.js).
// In-process with a fake DynamoDB (paged Scan), a fake Solana RPC and a generated treasury key: nothing real is touched.
//   node scripts/test_seal_batched.mjs website/worker.js
// Checks: 25,000 accounts sealed in 3 batches of at most 10,000, ONE transaction on chain, every sampled account's proof
// (its batch path joined with the batch's top path, as /api/me/credit returns it) folds to the epoch root the way the
// My Balance page checks it; a 7-account seal (one batch: top root = batch root); a write failing AFTER the transaction
// is retried without sending the transaction again; a second Start while one runs does not start another; the cron.
import { createHash, generateKeyPairSync } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = await import(pathToFileURL(resolve(process.argv[2] || "website/worker.js")).href);
const W = mod.default, SealJob = mod.SealJob;
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("PASS " + name); } else { fail++; console.log("FAIL " + name, extra === undefined ? "" : JSON.stringify(extra).slice(0, 300)); } };
const sha = (s) => createHash("sha256").update(s).digest("hex");

// --- a treasury key in the site's format: base58 of 64 bytes (32-byte seed, 32-byte public key) ---
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes) { let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of bytes) { if (b) break; s = "1" + s; } return s; }
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32), pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const TREASURY = b58(Buffer.concat([seed, pub]));

// --- fake DynamoDB: one table, items kept as DynamoDB JSON; Scan pages of PAGE items in key order ---
const PAGE = 2500;
const db = new Map(), key = (it) => it.user_id.S + "|" + it.sk.S;
let failBatchTopOnce = false;
function ddbCall(target, b) {
  if (target === "Scan") {
    const all = [...db.keys()].sort(), from = b.ExclusiveStartKey ? all.indexOf(b.ExclusiveStartKey.user_id.S + "|" + b.ExclusiveStartKey.sk.S) + 1 : 0;
    const page = all.slice(from, from + PAGE), items = page.map((k) => db.get(k)).filter((it) => it.sk.S === "BALANCE");
    const last = from + PAGE < all.length ? db.get(page[page.length - 1]) : null;
    return { Items: items, ...(last ? { LastEvaluatedKey: { user_id: last.user_id, sk: last.sk } } : {}) };
  }
  if (target === "Query") {
    const e = b.ExpressionAttributeValues[":e"].S;
    const items = [...db.values()].filter((it) => it.user_id.S === e).sort((x, y) => (x.sk.S < y.sk.S ? -1 : 1));
    if (b.ScanIndexForward === false) items.reverse();
    return { Items: items.slice(0, b.Limit || items.length) };
  }
  if (target === "GetItem") { const it = db.get(b.Key.user_id.S + "|" + b.Key.sk.S); return it ? { Item: it } : {}; }
  if (target === "PutItem") { db.set(key(b.Item), b.Item); return {}; }
  if (target === "BatchWriteItem") {
    const reqs = Object.values(b.RequestItems)[0];
    if (failBatchTopOnce && reqs.some((r) => /#BATCH$/.test(r.PutRequest.Item.user_id.S))) { failBatchTopOnce = false; throw new Error("injected DynamoDB failure"); }
    for (const r of reqs) db.set(key(r.PutRequest.Item), r.PutRequest.Item);
    return { UnprocessedItems: {} };
  }
  throw new Error("fake DynamoDB: " + target);
}
const chain = { sent: [] };
globalThis.fetch = async (req, init = {}) => {
  const url = typeof req === "string" ? req : req.url, h = new Headers(init.headers || {}), t = h.get("x-amz-target") || "";
  if (t.startsWith("DynamoDB_")) {
    try { return new Response(JSON.stringify(ddbCall(t.split(".")[1], JSON.parse(init.body)))); }
    catch (e) { return new Response(JSON.stringify({ __type: "InternalServerError", message: e.message }), { status: 500 }); }
  }
  if (url.startsWith("https://rpc.test")) {
    const { method, params } = JSON.parse(init.body);
    const result = method === "getLatestBlockhash" ? { value: { blockhash: b58(Buffer.alloc(32, 7)), lastValidBlockHeight: 1 } }
      : method === "sendTransaction" ? (chain.sent.push(params[0]), "sig" + chain.sent.length)
      : method === "getSignatureStatuses" ? { value: [{ confirmationStatus: "confirmed", err: null }] } : null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  }
  if (/resend/.test(url)) return new Response(JSON.stringify({ id: "mail" }));
  return new Response("{}");
};
const env = { AWS_ACCESS_KEY_ID: "test-key-id", AWS_SECRET_ACCESS_KEY: "x", AWS_REGION: "us-east-1", DDB_PREFIX: "pctest-ai-",
  PCC_MINT: "So11111111111111111111111111111111111111112", SOLANA_RPC_URL: "https://rpc.test", SOLANA_CLUSTER: "devnet",
  TREASURY_SECRET_KEY: TREASURY, TREASURY_TOKEN_ACCOUNT: "So11111111111111111111111111111111111111112", ADMIN_EMAILS: "admin@example.com", RESEND_API_KEY: "re_x" };

// --- a fake Durable Object: storage + alarm; run() fires alarms until none is set ---
function makeDO() {
  const store = new Map(); let alarm = null;
  const state = { storage: { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, structuredClone(v)); }, delete: async (k) => store.delete(k),
    setAlarm: async (t) => { alarm = t; }, getAlarm: async () => alarm } };
  const job = new SealJob(state, env);
  return { job, store, run: async () => { let steps = 0; while (alarm !== null && steps < 1000) { alarm = null; await job.alarm(); steps++; } return steps; } };
}
const start = (d, by = "test") => d.job.fetch(new Request("https://seal.internal/start", { method: "POST", body: JSON.stringify({ by }) })).then((r) => r.json());
function addAccounts(n, off = 0) {
  for (let i = 0; i < n; i++) { const u = (off + i).toString(16).padStart(12, "0");
    db.set(u + "|BALANCE", { user_id: { S: u }, sk: { S: "BALANCE" }, balance_npcc: { N: String((i * 7919) % 100000) }, available_uwu: { N: String(i * 13) } }); }
}
// the proof exactly as /api/me/credit builds it, checked exactly as the My Balance page checks it
function checkAccount(n, u) {
  const lf = db.get(`EPOCH#${n}#${u}|LEAF`), ep = [...db.values()].find((x) => x.user_id.S === "EPOCH" && x.n.N === String(n));
  if (!lf || !ep) return false;
  let proof = JSON.parse(lf.proof.S);
  if (lf.batch) proof = proof.concat(JSON.parse(db.get(`EPOCH#${n}#BATCH|${String(Number(lf.batch.N)).padStart(6, "0")}`).proof.S));
  let h = sha(`pc-leaf|${u}|${lf.balance_npcc.N}|${lf.available_uwu.N}`);
  if (h !== lf.leaf.S) return false;
  for (const p of proof) h = sha(p.left ? p.hash + h : h + p.hash);
  return h === ep.root.S;
}

// 1. 25,000 accounts
addAccounts(25000);
let d = makeDO();
const s1 = await start(d);
ok("start: epoch 1 started", s1.ok && s1.started && s1.epoch === 1, s1);
const again = await start(d);
ok("a second Start while one runs does not start another", again.already === true && again.epoch === 1, again);
const steps = await d.run();
const ep1 = db.get("EPOCH|EPOCH#00000001");
ok("25,000 accounts sealed in 3 batches (at most 10,000 each)", ep1 && ep1.accounts.N === "25000" && ep1.batches.N === "3", ep1 && { a: ep1.accounts.N, b: ep1.batches.N, steps });
ok("ONE transaction on chain for the whole seal", chain.sent.length === 1, chain.sent.length);
const sample = [0, 1, 9999, 10000, 12345, 19999, 20000, 24999].map((i) => i.toString(16).padStart(12, "0"));
ok("every sampled account's proof (batch path + top path) folds to the epoch root", sample.every((u) => checkAccount(1, u)), sample.filter((u) => !checkAccount(1, u)));
const lfx = db.get(`EPOCH#1#${sample[3]}|LEAF`); lfx && (lfx.balance_npcc = { N: "999999999" });
ok("a changed balance no longer matches its leaf (the check catches it)", !checkAccount(1, sample[3]));
ok("the job is cleared and the result kept", !d.store.get("job") && d.store.get("last") && d.store.get("last").ok === true, d.store.get("last"));

// 2. a write failing AFTER the transaction: retried, the transaction is not sent again
failBatchTopOnce = true;
d = makeDO();
await start(d);
await d.run();
const ep2 = db.get("EPOCH|EPOCH#00000002");
ok("a failure after the transaction is retried; still ONE transaction for epoch 2", ep2 && chain.sent.length === 2 && ep2.signature.S === "sig2", { sent: chain.sent.length, sig: ep2 && ep2.signature.S });
ok("epoch 2 proofs still fold to its root", sample.slice(0, 4).every((u) => checkAccount(2, u)));

// 3. a small seal: 7 accounts, one batch, top root = batch root
db.clear(); addAccounts(7, 0xabc000);
d = makeDO();
await start(d); await d.run();
const ep3 = db.get("EPOCH|EPOCH#00000001"), bt3 = db.get("EPOCH#1#BATCH|000000");
ok("7 accounts: one batch, the top root is that batch's root", ep3 && ep3.batches.N === "1" && bt3 && bt3.root.S === ep3.root.S, ep3 && ep3.batches.N);
ok("7 accounts: every proof folds to the root", [0, 3, 6].every((i) => checkAccount(1, (0xabc000 + i).toString(16).padStart(12, "0"))));

// 4. the monthly cron starts the job through the SEALJOB binding (and skips without wallets)
let started = 0;
const fakeNs = { idFromName: (n) => n, get: () => ({ fetch: async () => { started++; return Response.json({ ok: true, started: true, epoch: 9 }); } }) };
const ctx = { p: [], waitUntil(x) { this.p.push(x); } };
await W.scheduled({ cron: "23 3 1 * *" }, { ...env, SEALJOB: fakeNs }, ctx); await Promise.all(ctx.p); ctx.p = [];
ok("the monthly cron starts the seal job", started === 1, started);
await W.scheduled({ cron: "23 3 1 * *" }, { ...env, PCC_MINT: "", SEALJOB: fakeNs }, ctx); await Promise.all(ctx.p);
ok("without wallets configured the cron does nothing", started === 1, started);

console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
