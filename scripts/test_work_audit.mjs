// Test of the commit + random audit of a device's work (TESTING.md test 43). The given worker.js runs in-process
// against the TEST tables (prefix pctest-ai-, never the live ones) with real DynamoDB. Its capacity-check object
// (CapacityPolice) is driven directly with a stand-in for the Durable Object (storage in memory, one fake socket),
// and this script plays the device: it takes a lease, computes the WorkPacks (pc_mc_pi on the server's seeds),
// commits to them with a Merkle root, and answers the audit. Cases:
//   1 honest device          -> passes; every pack's Work Units credited, bonus = max(WU pay, time x minimum x proven cores)
//   2 lazy device (half the packs faked, the commitment consistent) -> fails "wrong result", nothing credited, a strike
//   3 forged proof (right results, wrong path)                      -> fails "proof does not match the commit"
//   4 a third strike in a row                                       -> the device is held: no new lease
//   5 a commit after the lease ran out                              -> void (no credit, no strike)
//   6 a heartbeat of a device on leases credits no WU (the audits do), and the admin list shows every audit
//   7 the browser console's own lease code (from the served page): SHA-256, seeds, two workers, commit, proofs pass
//   8 GPU leases with the console's own code: honest passes and is credited; made-up counts and an inflated total fail
// It also prints the reference vectors the program's Rust tests use (lease_seed, the Merkle root).
//   AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. node scripts/test_work_audit.mjs website/worker.js
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { randomBytes, createHash, createHmac } from "node:crypto";
const PREFIX = "pctest-ai-";
let src = readFileSync(process.argv[2], "utf8");
const swap = (o, n) => { if (!src.includes(o)) throw new Error("not found: " + o); src = src.replace(o, n); };
swap("async function currentUser(env, request) {", "async function currentUser(env, request) { if (globalThis.__user) return { user_id: globalThis.__user, token: 't' };");
swap("async function cachedUser(env, request) {", "async function cachedUser(env, request) { if (globalThis.__user) return { user_id: globalThis.__user, token: 't' };");
src += "\nglobalThis.__w = { leaseSeed, cpuChunkHits, gpuGroupHits, listAudits, LEASE_N, AUDIT_K, SAMPLES_PER_WU, CORE_WU_S, GPU_ITERS_L, GPU_AUDIT_K };";
const tmp = join(mkdtempSync(join(tmpdir(), "wa-")), "w.mjs"); writeFileSync(tmp, src); globalThis.WebSocketRequestResponsePair = class {};
const mod = await import(tmp), W = mod.default, X = globalThis.__w;
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, AWS_REGION: process.env.AWS_REGION || "us-east-1",
  DDB_PREFIX: PREFIX, SESSION_SECRET: "s".repeat(40), MAIL_FROM: "test@planetcompute.ai" };
if (!env.AWS_ACCESS_KEY_ID) { console.log("needs AWS keys in the environment"); process.exit(2); }
async function ddb(op, payload) {
  const region = env.AWS_REGION, host = `dynamodb.${region}.amazonaws.com`, body = JSON.stringify(payload);
  const t = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""), d = t.slice(0, 8), h = (x) => createHash("sha256").update(x).digest("hex"), hm = (k, x) => createHmac("sha256", k).update(x).digest();
  const headers = { "content-type": "application/x-amz-json-1.0", host, "x-amz-date": t, "x-amz-target": "DynamoDB_20120810." + op }, names = Object.keys(headers).sort();
  const creq = ["POST", "/", "", names.map((n) => `${n}:${headers[n]}`).join("\n") + "\n", names.join(";"), h(body)].join("\n"), scope = `${d}/${region}/dynamodb/aws4_request`;
  let k = hm("AWS4" + env.AWS_SECRET_ACCESS_KEY, d); k = hm(k, region); k = hm(k, "dynamodb"); k = hm(k, "aws4_request");
  const r = await fetch(`https://${host}/`, { method: "POST", body, headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${names.join(";")}, Signature=${hm(k, ["AWS4-HMAC-SHA256", t, scope, h(creq)].join("\n")).toString("hex")}` } });
  const j = await r.json(); if (!r.ok) throw new Error(op + ": " + JSON.stringify(j)); return j;
}
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };

// the device's side: the leaves, the tree, the proofs (the same rules as the program's contribute.rs)
const sha = (b) => createHash("sha256").update(b).digest();
const leaf = (i, hits) => { const b = Buffer.alloc(8); b.writeUInt32LE(i, 0); b.writeUInt32LE(hits >>> 0, 4); return sha(b); };
function tree(hits) {
  let w = 1; while (w < hits.length) w *= 2;
  const levels = [Array.from({ length: w }, (_, i) => (i < hits.length ? leaf(i, hits[i]) : Buffer.alloc(32)))];
  while (levels[levels.length - 1].length > 1) { const p = levels[levels.length - 1], n = []; for (let i = 0; i < p.length; i += 2) n.push(sha(Buffer.concat([p[i], p[i + 1]]))); levels.push(n); }
  return levels;
}
const proof = (levels, i) => levels.slice(0, -1).map((lv, l) => lv[(i >> l) ^ 1].toString("hex"));

// the stand-in Durable Object: storage in memory, one socket whose messages we collect
let clock = 0; const realNow = Date.now; Date.now = () => realNow() + clock * 1000;
function fakeState() {
  const store = new Map(), out = [];
  const ws = { readyState: 1, send: (m) => out.push(JSON.parse(m)), close() {}, serializeAttachment() {} };
  return { out, ws, state: { storage: { get: async (k) => structuredClone(store.get(k)), put: async (k, v) => { store.set(k, structuredClone(v)); }, setAlarm: async () => {} },
    getWebSockets: () => [ws], acceptWebSocket() {} } };
}
const user = "wa" + randomBytes(5).toString("hex"), device = randomBytes(6).toString("hex"); globalThis.__user = user;
await ddb("PutItem", { TableName: PREFIX + "user", Item: { pk: { S: "USER#" + user }, sk: { S: "PROFILE" }, user_id: { S: user }, primary_email: { S: "work-audit-test@invalid" } } });
await ddb("PutItem", { TableName: PREFIX + "user", Item: { pk: { S: "USER#" + user }, sk: { S: "DEVICE#" + device }, user_id: { S: user }, device_id: { S: device },
  police_verified: { BOOL: true }, verified_cpu_wu_s: { N: "0.0001" }, verified_gpu_wu_s: { N: "0" }, verified_cores: { N: "4" } } });
const F = fakeState(), P = new mod.CapacityPolice(F.state, env);
const CPU_SPS = 4e5;                                        // a small measured speed, so a lease is a few dozen packs
await F.state.storage.put("who", { user, device, net: "net:test" });
await F.state.storage.put("status", { verified: true, fails: 0, cpu_sps: CPU_SPS, cores: 4, cpu_band: 0.0001 });
const send = (o) => P.webSocketMessage(F.ws, JSON.stringify(o));
const last = (type) => [...F.out].reverse().find((m) => m.type === type);
const balance = async () => { const b = (await ddb("GetItem", { TableName: PREFIX + "user-credits", Key: { user_id: { S: user }, sk: { S: "BALANCE" } }, ConsistentRead: true })).Item || {};
  return { uwu: Number((b.lifetime_contribution_uwu || { N: "0" }).N), e21: BigInt((b.bonus_e21 || { N: "0" }).N) }; };
const rules = (await ddb("Query", { TableName: PREFIX + "howCreditAwarded", KeyConditionExpression: "pk = :r", ExpressionAttributeValues: { ":r": { S: "RULE" } } })).Items
  .filter((r) => (!r.status || r.status.S !== "cancelled") && r.effective_from.S <= new Date().toISOString()).sort((a, b) => (a.sk.S < b.sk.S ? -1 : 1));
const rule = rules[rules.length - 1], RATE = Number(rule.credit_per_wu.N), WMIN = Number((rule.work_min_per_hour || { N: "0" }).N);
console.log("rule in force on the test tables:", RATE, "per WU, working minimum", WMIN, "per hour per core");

// one lease, worked by a device that computes the packs with `cheat` (i -> hits or null for honest)
async function work(L, cheat) { const hits = []; for (let i = 0; i < L.count; i++) { const c = cheat && cheat(i); hits.push(c == null ? X.cpuChunkHits(X.leaseSeed(L.base, i), L.n) : c); } return hits; }

// 1 honest
await send({ type: "hello", cores: 4, gpu: false, leases: true });
let L = last("lease");
ok("1a hello with leases: a lease of server-chosen seeds sized to the measured speed x 10 minutes", !!L && L.n === X.LEASE_N && L.count === Math.ceil(CPU_SPS * 600 * 1.25 / X.LEASE_N) && L.lease_s === 600, L);
let hits = await work(L), lv = tree(hits);
clock += 600;
await send({ type: "commit", id: L.id, done: hits.length, root: lv[lv.length - 1][0].toString("hex") });
let A = last("audit");
ok(`1b the commitment is answered with ${X.AUDIT_K} distinct packs to prove, chosen after it`, !!A && A.id === L.id && new Set(A.idx).size === Math.min(X.AUDIT_K, hits.length) && A.idx.every((i) => i >= 0 && i < hits.length), A);
const b0 = await balance();
await send({ type: "proof", id: L.id, items: A.idx.map((i) => ({ i, hits: hits[i], path: proof(lv, i) })) });
let R = last("audit_result");
const samples = hits.length * L.n, wantUwu = Math.floor(samples / X.SAMPLES_PER_WU * 1e6), sec = 600;
const cores = Math.min(4, samples / sec / (X.CORE_WU_S * X.SAMPLES_PER_WU));
const wantB = Math.round(Math.max(wantUwu / 1e6 * RATE, sec * WMIN * cores / 3600) * 1e15);
const b1 = await balance();
ok("1c the honest device passes", R && R.pass === true && R.id === L.id, R);
ok(`1d all ${hits.length} packs credited: ${wantUwu} micro-WU (= packs x samples / samples per WU)`, b1.uwu - b0.uwu === wantUwu, { b0, b1, wantUwu });
ok(`1e bonus = max(WU pay, 600 s x minimum x ${cores.toFixed(4)} proven cores) = ${wantB / 1e15}`, b1.e21 - b0.e21 === BigInt(wantB) * 1000000n, { got: String(b1.e21 - b0.e21), wantB });
const L2 = last("lease");
ok("1f the next lease follows at once, with new seeds", L2 && L2.id !== L.id && L2.base !== L.base, L2);

// 2 lazy: computes only even packs; the odd ones are made up (the commitment matches what it made up)
L = L2; hits = await work(L, (i) => (i % 2 ? (Math.random() * 1e6) | 0 : null)); lv = tree(hits); clock += 600;
await send({ type: "commit", id: L.id, done: hits.length, root: lv[lv.length - 1][0].toString("hex") }); A = last("audit");
await send({ type: "proof", id: L.id, items: A.idx.map((i) => ({ i, hits: hits[i], path: proof(lv, i) })) }); R = last("audit_result");
const b2 = await balance();
ok("2 half the packs faked: caught (wrong result), nothing credited, strike 1", R.pass === false && R.reason === "wrong result" && R.strikes === 1 && b2.uwu === b1.uwu && b2.e21 === b1.e21, R);

// 3 forged: right results but the paths do not lead to the root it committed
L = last("lease"); hits = await work(L); lv = tree(hits); clock += 600;
const fake = "ab".repeat(32);
await send({ type: "commit", id: L.id, done: hits.length, root: fake }); A = last("audit");
await send({ type: "proof", id: L.id, items: A.idx.map((i) => ({ i, hits: hits[i], path: proof(lv, i) })) }); R = last("audit_result");
ok("3 proofs that do not match the commitment: fail, strike 2", R.pass === false && R.reason === "proof does not match the commit" && R.strikes === 2, R);

// 5 late (before the third strike, to show it is not one)
L = last("lease"); hits = await work(L); lv = tree(hits); clock += 600 + 121;
await send({ type: "commit", id: L.id, done: hits.length, root: lv[lv.length - 1][0].toString("hex") }); R = last("audit_result");
ok("5 a commit after the lease ran out (10 min + 2 min grace): void, no credit, no strike (still 2)", R.id === L.id && R.pass === false && R.reason === "not committed in time" && R.strikes === 2, R);

// 4 third strike: a missing proof
L = last("lease"); hits = await work(L); lv = tree(hits); clock += 600;
await send({ type: "commit", id: L.id, done: hits.length, root: lv[lv.length - 1][0].toString("hex") }); A = last("audit");
const nOut = F.out.length;
await send({ type: "proof", id: L.id, items: A.idx.slice(1).map((i) => ({ i, hits: hits[i], path: proof(lv, i) })) }); R = last("audit_result");
ok("4a a third strike in a row (a proof left out): the device is held for an hour", R.pass === false && R.reason === "missing proof" && !!R.hold_until && Date.parse(R.hold_until) > Date.now() + 3500e3, R);
ok("4b while held, no new lease is offered", !F.out.slice(nOut).some((m) => m.type === "lease"), F.out.slice(nOut));
const dev = (await ddb("GetItem", { TableName: PREFIX + "user", Key: { pk: { S: "USER#" + user }, sk: { S: "DEVICE#" + device } }, ConsistentRead: true })).Item;
ok("4c the device row: audited work, 1 passed, 3 failed, held, the audited WU", dev.audit_mode.BOOL === true && dev.audits_passed.N === "1" && dev.audits_failed.N === "3" &&
  !!dev.audit_hold_until.S && Number(dev.audited_uwu.N) === wantUwu, dev);

// 6 a heartbeat of this device credits no WU; the admin list
clock = 0;
const hb = (state, wu) => W.fetch(new Request("https://planetcompute.ai/api/volunteer/heartbeat", { method: "POST", headers: { "content-type": "application/json", origin: "https://planetcompute.ai" },
  body: JSON.stringify({ device_id: device, session_id: "s" + device, state, cores: 4, cpu_cap: 100, cpu_pct: 90, packs: 1, wu, browser: "test", platform: "Linux", host: "app" }) }), env).then((r) => r.json());
await hb("running", 0); clock = 300; const h2 = await hb("running", 50); clock = 600; await hb("stopped", 100);
const b6 = await balance();
ok("6a heartbeats of a device on leases credit no WU (50 WU reported: 0 credited, \"credited by audits of the work\")", b6.uwu === b2.uwu && h2.credited_wu === 0 && /audits/.test(h2.note || ""), { h2, b6, b2 });
const la = await X.listAudits(env, new URL("https://x/?day=" + new Date().toISOString().slice(0, 10)));
const mine = la.rows.filter((r) => r.device_id === device);
ok("6b the admin list (tab Audits) has all 5 audits of this device: 1 passed, 3 failed, 1 void, with reasons", mine.length === 5 && mine.filter((r) => r.pass).length === 1 &&
  mine.filter((r) => !r.pass && r.strike).length === 3 && mine.some((r) => r.reason === "not committed in time" && !r.strike), mine.map((r) => [r.pass, r.reason, r.strike]));

// 7 the browser console's own lease code (taken from the served /contribute page) against the same checks
const page = await (await W.fetch(new Request("https://planetcompute.ai/contribute"), env)).text();
const a0 = page.indexOf("  var lease = null, committed = null, auditResult = null;"), a1 = page.indexOf("  setInterval(function () {                          // the lease's time is up");
const sent = [], cw = { police: { ws: { send: (m) => sent.push(JSON.parse(m)) } }, workers: [] };
const C = new Function("police", "workers", page.slice(a0, a1) + "\nreturn { leaseStart, leaseDone, leaseCommit, leaseProve, sha256, leaseSeed, get lease() { return lease; } };")(cw.police, cw.workers);
const rnd = randomBytes(77);
ok("7a the console's SHA-256 = Node's, its lease seeds = the server's", Buffer.from(C.sha256(rnd)).equals(sha(rnd)) && Buffer.from(C.sha256(new Uint8Array(64))).equals(sha(Buffer.alloc(64))) &&
  [0, 5, 262143].every((i) => C.leaseSeed(0xdeadbeef, i) === X.leaseSeed(0xdeadbeef, i)));
const F2 = fakeState(), P2 = new mod.CapacityPolice(F2.state, env), dev2 = randomBytes(6).toString("hex");
await F2.state.storage.put("who", { user, device: dev2, net: "net:test" });
await F2.state.storage.put("status", { verified: true, fails: 0, cpu_sps: CPU_SPS, cores: 2, cpu_band: 0.0001 });
await P2.webSocketMessage(F2.ws, JSON.stringify({ type: "hello", cores: 2, gpu: false, leases: true }));
const LL = F2.out.find((m) => m.type === "lease");
// two stand-in Web Workers: each computes the job it is given (as the console's worker does) when told to run
const jobs = new Map(); const mk = () => { const w = { postMessage: (m) => { if (m.job) jobs.set(w, m.job); } }; cw.workers.push(w); return w; };
const w1 = mk(), w2 = mk();
C.leaseStart(LL);
for (let guard = 0; guard < 1e6 && jobs.size; guard++) for (const w of [w1, w2]) { const j = jobs.get(w); if (!j) continue; jobs.delete(w); C.leaseDone(w, { hits: X.cpuChunkHits(j.seed, j.n), n: j.n, ms: 1, i: j.i, lease: j.lease }); }
clock += 600; C.leaseCommit();
const cm = sent.find((m) => m.type === "commit");
ok(`7b the console computed all ${LL.count} packs of its lease on two workers and committed to them`, cm && cm.done === LL.count && /^[0-9a-f]{64}$/.test(cm.root), cm);
await P2.webSocketMessage(F2.ws, JSON.stringify(cm));
C.leaseProve(F2.out.find((m) => m.type === "audit"));
await P2.webSocketMessage(F2.ws, JSON.stringify(sent.find((m) => m.type === "proof")));
const R2 = F2.out.find((m) => m.type === "audit_result");
ok("7c its proofs pass the server's audit; the Work Units are credited", R2 && R2.pass === true && R2.wu === Math.floor(LL.count * LL.n / X.SAMPLES_PER_WU * 1e6) / 1e6, R2);
const la2 = await X.listAudits(env, new URL("https://x/?day=" + new Date().toISOString().slice(0, 10)));
mine.push(...la2.rows.filter((r) => r.device_id === dev2));

// 8 GPU leases: the console's own graphics card lease code (from the served page), its dispatches computed here by
// the police kernel's arithmetic (gpuGroupHits) in place of WebGPU
const gsent = [], gpuStub = {}, totals = { packs: 0, hits: 0, n: 0 };
globalThis.gpuWindowN = 0; globalThis.gpuBusy = 0;                     // the console's GPU speed counters
const C3 = new Function("police", "workers", "gpu", "totals", "noteSpeed", page.slice(a0, a1) +
  "\nreturn { gleaseStart, gleaseDispatch, gleaseCommit, gleaseProve, get glease() { return glease; } };")({ ws: { send: (m) => gsent.push(JSON.parse(m)) } }, [], gpuStub, totals, () => {});
const F3 = fakeState(), P3 = new mod.CapacityPolice(F3.state, env), dev3 = randomBytes(6).toString("hex");
await F3.state.storage.put("who", { user, device: dev3, net: "net:test" });
await F3.state.storage.put("status", { verified: true, fails: 0, cpu_sps: CPU_SPS, cores: 2, cpu_band: 0.0001, gpu_sps: 1e9, gpu_band: 0.0002 });
await P3.webSocketMessage(F3.ws, JSON.stringify({ type: "hello", cores: 2, gpu: true, leases: true, gpu_leases: true }));
let GL = F3.out.find((m) => m.type === "glease");
ok("8a hello with a graphics card: a GPU lease (site seeds, 16,384 samples per invocation, at most 8,192 groups a dispatch)", !!GL && GL.iters === X.GPU_ITERS_L && GL.max_groups === 8192, GL);
const honest = (seed, G, iters) => Array.from({ length: G }, (_, g) => X.gpuGroupHits(seed, g, iters));
async function gpuRound(L, run, n) {
  gpuStub.runCounts = run; C3.gleaseStart(L); C3.glease.G = 3;
  for (let i = 0; i < n; i++) { await C3.gleaseDispatch(C3.glease); C3.glease.G = 1 + (i % 3); }   // varying group counts
  clock += 600; gsent.length = 0; C3.gleaseCommit();
  const cm = gsent.find((m) => m.type === "gcommit"); await P3.webSocketMessage(F3.ws, JSON.stringify(cm));
  const ga = F3.out.filter((m) => m.type === "gaudit").pop(); await C3.gleaseProve(ga);
  for (const pr of gsent.filter((m) => m.type === "gproof")) await P3.webSocketMessage(F3.ws, JSON.stringify(pr));
  return { cm, ga, res: F3.out.filter((m) => m.type === "audit_result" && m.kind === "gpu" && m.id === L.id).pop() };
}
const b7 = await balance();
let g1 = await gpuRound(GL, honest, 6);
const wantG = Math.floor(Math.min(g1.cm.total * 256 * X.GPU_ITERS_L, 1e9 * 600 * 2) / X.SAMPLES_PER_WU * 1e6);
ok(`8b the console committed ${g1.cm.done} dispatches / ${g1.cm.total} groups; ${X.GPU_AUDIT_K} random groups audited, recomputed again on its "GPU": pass`,
  g1.res && g1.res.pass === true && g1.ga.r.length === X.GPU_AUDIT_K && g1.cm.done === 6, { cm: g1.cm, res: g1.res });
const b8 = await balance();
ok(`8c the groups' Work Units are credited (${wantG} micro-WU)`, b8.uwu - b7.uwu === wantG && g1.res.wu === wantG / 1e6, { got: b8.uwu - b7.uwu, wantG });
GL = F3.out.filter((m) => m.type === "glease").pop();
ok("8d the next GPU lease follows, with new seeds", GL.id !== g1.cm.id && GL.base !== g1.ga.base, GL);
// a faking graphics card: made-up counts (consistent, so its own re-run agrees with its commitment)
const fakeG = (seed, G) => Array.from({ length: G }, (_, g) => (Math.imul(seed ^ g, 2654435761) >>> 12) % 1000000);
const g2 = await gpuRound(GL, fakeG, 5);
ok("8e made-up graphics card results: caught (wrong result), nothing credited, a strike", g2.res && g2.res.pass === false && g2.res.reason === "wrong result" && g2.res.strikes === 1 && (await balance()).uwu === b8.uwu, g2.res);
// a commitment that claims more groups than its dispatches hold
GL = F3.out.filter((m) => m.type === "glease").pop(); gpuStub.runCounts = honest; C3.gleaseStart(GL); C3.glease.G = 2;
for (let i = 0; i < 4; i++) await C3.gleaseDispatch(C3.glease);
clock += 600; gsent.length = 0; C3.gleaseCommit();
const big = { ...gsent.find((m) => m.type === "gcommit") }; big.total = big.total * 50;
await P3.webSocketMessage(F3.ws, JSON.stringify(big)); await C3.gleaseProve(F3.out.filter((m) => m.type === "gaudit").pop());
for (const pr of gsent.filter((m) => m.type === "gproof")) await P3.webSocketMessage(F3.ws, JSON.stringify(pr));
let g3 = F3.out.filter((m) => m.type === "audit_result" && m.kind === "gpu" && m.id === GL.id).pop();
if (!g3) { clock += 200; await P3.offerGpuLease(); g3 = F3.out.filter((m) => m.type === "audit_result" && m.kind === "gpu" && m.id === GL.id).pop(); }   // nothing to prove: runs out
ok("8f a commitment claiming 50 x the groups it holds: no credit (a proof that does not add up = strike; numbers beyond its work cannot be proved = void)",
  g3 && g3.pass === false && (g3.reason === "proof does not match the commit" ? g3.strikes === 2 : g3.reason === "no proof") && (await balance()).uwu === b8.uwu, g3);
mine.push(...(await X.listAudits(env, new URL("https://x/?day=" + new Date().toISOString().slice(0, 10)))).rows.filter((r) => r.device_id === dev3));

// reference vectors for the program (client/src/contribute.rs tests)
const vs = [0, 1, 2, 1000, 262143].map((i) => X.leaseSeed(0x12345678, i)), vh = [0, 1, 2].map((i) => X.cpuChunkHits(X.leaseSeed(0x12345678, i), 100000));
const vt = tree(vh);
console.log("  vectors: lease_seed(0x12345678, [0,1,2,1000,262143]) =", vs.join(", "), "; hits(n=100000) =", vh.join(", "), "; root =", vt[vt.length - 1][0].toString("hex"));

// clean up
const all = await ddb("Query", { TableName: PREFIX + "user-credits", KeyConditionExpression: "user_id = :u", ExpressionAttributeValues: { ":u": { S: user } } });
for (const it of all.Items || []) await ddb("DeleteItem", { TableName: PREFIX + "user-credits", Key: { user_id: it.user_id, sk: it.sk } });
for (const sk of ["PROFILE", "DEVICE#" + device, "DEVICE#" + dev2, "DEVICE#" + dev3]) await ddb("DeleteItem", { TableName: PREFIX + "user", Key: { pk: { S: "USER#" + user }, sk: { S: sk } } });
const cs = await ddb("Query", { TableName: PREFIX + "user", KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": { S: "USER#" + user } } });
for (const it of cs.Items || []) await ddb("DeleteItem", { TableName: PREFIX + "user", Key: { pk: it.pk, sk: it.sk } });
for (const r of mine) await ddb("DeleteItem", { TableName: PREFIX + "howCreditAwarded", Key: { pk: { S: r.pk }, sk: { S: r.sk } } });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
