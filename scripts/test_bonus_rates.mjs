// Test of the standby and working bonus rates (TESTING.md test 42). The given worker.js runs in-process against the
// TEST tables (prefix pctest-ai-, never the live ones) with real DynamoDB, a controllable clock and the signed-in user
// faked. A test award rule (standby 0.0001 / hour, working at least 0.0002 / hour, 0.00000126 per WU) is put in the
// test rules table. Six devices report every 5 minutes for 15 minutes, then stop:
//   GPU  verified, running, 300 WU per 5 min (an RTX 4090, 1 WU/s)   -> per-WU pay (more than the working minimum)
//   CPU  verified, running, 0.025 WU per 5 min (one core)        -> the working minimum, 0.0002 / hour
//   CPU3 verified (3 cores), running, 0.075 WU per 5 min       -> the working minimum per verified core, 0.0006 / hour
//   CAP8 verified (8 cores), CPU cap 20%, 0.05 WU per 5 min     -> 8 x 20% = 1.6 cores of the minimum, 0.00032 / hour
//   IDLE verified, idle                                          -> standby, 0.0001 / hour
//   ZERO verified, running but no Work Units                     -> standby (running without work is not working)
//   FAKE not verified, running, claims 1,000 WU                  -> nothing
// The bonus on the BALANCE must equal the sum of each 5-minute report computed here independently, /api/me/credit must
// show it and the rates in force, and the WU credited must be unchanged by the bonus. Verified cores from the measured
// speed: at least 1, never more than the cores the program says it shares.
//   AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. node scripts/test_bonus_rates.mjs website/worker.js
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { randomBytes, createHash, createHmac } from "node:crypto";
const PREFIX = "pctest-ai-";
let src = readFileSync(process.argv[2], "utf8");
const swap = (o, n) => { if (!src.includes(o)) throw new Error("not found: " + o); src = src.replace(o, n); };
globalThis.__base = Date.now();                               // a frozen clock: only the test moves it (no drift while it runs)
swap("const now = () => Math.floor(Date.now() / 1000);", "const now = () => Math.floor(globalThis.__base / 1000) + (globalThis.__skew || 0);");
swap("const iso = () => new Date().toISOString();", "const iso = () => new Date(globalThis.__base + (globalThis.__skew || 0) * 1000).toISOString();");
swap("async function currentUser(env, request) {", "async function currentUser(env, request) { if (globalThis.__user) return { user_id: globalThis.__user, token: 't' };");
swap("async function cachedUser(env, request) {", "async function cachedUser(env, request) { if (globalThis.__user) return { user_id: globalThis.__user, token: 't' };");
src += "\nglobalThis.__vc = verifiedCores; globalThis.__spw = SAMPLES_PER_WU; globalThis.__core = CORE_WU_S;";
const tmp = join(mkdtempSync(join(tmpdir(), "br-")), "w.mjs"); writeFileSync(tmp, src); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default;
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

// the test rule: in force from now (it stays in the test rules table, so later runs use it too)
const RULE = { credit_per_wu: 0.00000126, standby_per_hour: 0.0001, work_min_per_hour: 0.0002 };
const eff = new Date(Date.now() - 1000).toISOString(), rid = "t" + randomBytes(5).toString("hex");
await ddb("PutItem", { TableName: PREFIX + "howCreditAwarded", Item: { pk: { S: "RULE" }, sk: { S: `${eff}#${rid}` }, rule_id: { S: rid }, effective_from: { S: eff },
  credit_per_wu: { N: String(RULE.credit_per_wu) }, standby_per_hour: { N: String(RULE.standby_per_hour) }, work_min_per_hour: { N: String(RULE.work_min_per_hour) },
  first_finisher_share: { N: "0.5" }, status: { S: "active" }, note: { S: "test 42: standby and working rates" }, created_at: { S: eff } } });

const user = "br" + randomBytes(5).toString("hex"); globalThis.__user = user;
const t0 = Math.floor(globalThis.__base / 1000);
const D = {                                                   // [verified, verified WU/s, state, WU per 5 minutes, verified cores, CPU cap %]
  GPU: [true, 1, "running", 300], CPU: [true, 1, "running", 0.025], CPU3: [true, 1, "running", 0.075, 3], CAP8: [true, 1, "running", 0.05, 8, 20], IDLE: [true, 1, "idle", 0], ZERO: [true, 1, "running", 0], FAKE: [false, 0, "running", 1000] };
const ids = Object.fromEntries(Object.keys(D).map((k) => [k, randomBytes(6).toString("hex")])), sids = Object.fromEntries(Object.keys(D).map((k) => [k, randomBytes(8).toString("hex")]));
await ddb("PutItem", { TableName: PREFIX + "user", Item: { pk: { S: "USER#" + user }, sk: { S: "PROFILE" }, user_id: { S: user }, primary_email: { S: "bonus-rates-test@invalid" } } });
for (const [k, [v, rate, , , vc]] of Object.entries(D)) await ddb("PutItem", { TableName: PREFIX + "user", Item: { pk: { S: "USER#" + user }, sk: { S: "DEVICE#" + ids[k] }, user_id: { S: user }, device_id: { S: ids[k] },
  police_verified: { BOOL: v }, verified_cpu_wu_s: { N: String(rate) }, verified_gpu_wu_s: { N: "0" }, ...(vc ? { verified_cores: { N: String(vc) } } : {}), last_seen: { N: String(t0) } } });
const beat = (k, state, wu) => W.fetch(new Request("https://planetcompute.ai/api/volunteer/heartbeat", { method: "POST", headers: { "content-type": "application/json", origin: "https://planetcompute.ai" },
  body: JSON.stringify({ device_id: ids[k], session_id: sids[k], state, cores: 1, cpu_cap: D[k][5] || 100, cpu_pct: 90, packs: 1, wu, browser: "test", platform: "Linux", host: "app" }) }), env).then(async (r) => ({ s: r.status, j: await r.json() }));

// the expected bonus, computed here from the decision (not from the website's code)
const expect = {};
function addExpected(k, prevState, cWu, sec) {
  const [v, , , , vc, cap] = D[k]; if (!v) return;
  const working = prevState === "running" && cWu > 0, standby = prevState === "idle" || (prevState === "running" && cWu === 0);
  const pay = (working ? Math.max(cWu * RULE.credit_per_wu, sec * RULE.work_min_per_hour * (vc || 1) * (cap || 100) / 100 / 3600) : cWu * RULE.credit_per_wu) + (standby ? sec * RULE.standby_per_hour / 3600 : 0);
  expect[k] = (expect[k] || 0) + pay;
}
let errors = 0;
for (const [k, [, , state]] of Object.entries(D)) { globalThis.__skew = 300; const r = await beat(k, state, 0); if (r.s !== 200) errors++; }   // first report: the state is set
for (let n = 2; n <= 3; n++) for (const [k, [, , state, per]] of Object.entries(D)) {
  globalThis.__skew = 300 * n; const r = await beat(k, state, per * (n - 1)); if (r.s !== 200) { errors++; console.log(r); }
  addExpected(k, state, D[k][0] ? per : 0, 300);
}
for (const [k, [, , state, per]] of Object.entries(D)) {     // stop: the last 5 minutes are counted, pending credit written
  globalThis.__skew = 300 * 4; const r = await beat(k, "stopped", per * 3); if (r.s !== 200) errors++;
  addExpected(k, state, D[k][0] ? per : 0, 300);
}
ok("every report answered", errors === 0, errors);
const bal = (await ddb("GetItem", { TableName: PREFIX + "user-credits", Key: { user_id: { S: user }, sk: { S: "BALANCE" } }, ConsistentRead: true })).Item || {};
const e21 = BigInt((bal.bonus_e21 || { N: "0" }).N), got = Number(e21) / 1e21, want = Object.values(expect).reduce((a, b) => a + b, 0);
console.log("  expected per device (coins):", Object.fromEntries(Object.entries(expect).map(([k, v]) => [k, v.toPrecision(6)])));
console.log("  bonus on the balance:", got.toPrecision(9), "expected", want.toPrecision(9));
ok("the bonus equals the sum of every 5-minute report at the decided rates (to 1e-12 coin)", Math.abs(got - want) < 1e-12, { got, want });
const wu = Number((bal.lifetime_contribution_uwu || { N: "0" }).N) / 1e6, wantWu = 3 * (300 + 0.025 + 0.075 + 0.05);
ok(`Work Units credited as before: ${wu} WU (GPU 3 x 300 + CPU 3 x 0.025 + CPU3 3 x 0.075 + CAP8 3 x 0.05; the unverified device gets none)`, Math.abs(wu - wantWu) < 1e-6, { wu, wantWu });
const g = expect.GPU / 900 * 3600, c = expect.CPU / 900 * 3600, s = expect.IDLE / 900 * 3600;
ok(`GPU earns per WU: ${g.toFixed(6)} / hour (about 0.0045)`, Math.abs(g - 0.004536) < 1e-9, g);
ok(`one CPU core earns the working minimum: ${c.toFixed(6)} / hour (0.0002 = 2 x standby)`, Math.abs(c - 0.0002) < 1e-12, c);
const c3 = expect.CPU3 / 900 * 3600;
ok(`three verified cores earn 3 x the working minimum: ${c3.toFixed(6)} / hour (0.0006)`, Math.abs(c3 - 0.0006) < 1e-12, c3);
const c8 = expect.CAP8 / 900 * 3600;
ok(`8 verified cores at a 20% CPU cap earn 1.6 x the working minimum: ${c8.toFixed(6)} / hour (0.00032)`, Math.abs(c8 - 0.00032) < 1e-12, c8);
ok(`idle earns standby: ${s.toFixed(6)} / hour (0.0001)`, Math.abs(s - 0.0001) < 1e-12, s);
ok("running with no Work Units earns only standby (0.0001 / hour)", Math.abs(expect.ZERO / 900 * 3600 - 0.0001) < 1e-12 && Math.abs(expect.ZERO - expect.IDLE) < 1e-15, expect);
ok("an unverified device earns nothing", !expect.FAKE);
const sps = (cores) => cores * globalThis.__core * globalThis.__spw;          // the measured speed of n reference cores
ok("verified cores = measured speed / one core: 3 cores measured, 4 said -> 3; 8 said, 2 measured -> 2", globalThis.__vc(sps(3), 4) === 3 && globalThis.__vc(sps(2), 8) === 2);
ok("verified cores never more than the cores said (64 measured, 4 said -> 4) and at least 1 (a slow core -> 1)", globalThis.__vc(sps(64), 4) === 4 && globalThis.__vc(sps(0.3), 1) === 1 && globalThis.__vc(sps(0.3), 16) === 1);
const cr = await W.fetch(new Request("https://planetcompute.ai/api/me/credit"), env).then((r) => r.json());
ok("/api/me/credit shows the bonus and the rates in force", Math.abs(Number(cr.bonus_available) - Math.floor(got * 1e9) / 1e9) < 1e-12 && cr.standby_per_hour === "0.0001" && cr.work_min_per_hour === "0.0002" && cr.bonus_per_wu === "0.00000126", cr);
// clean up the test account (the test rule stays: it is the rule now in force on the test tables)
const all = await ddb("Query", { TableName: PREFIX + "user-credits", KeyConditionExpression: "user_id = :u", ExpressionAttributeValues: { ":u": { S: user } } });
for (const it of all.Items || []) await ddb("DeleteItem", { TableName: PREFIX + "user-credits", Key: { user_id: it.user_id, sk: it.sk } });
for (const k of Object.keys(D)) await ddb("DeleteItem", { TableName: PREFIX + "user", Key: { pk: { S: "USER#" + user }, sk: { S: "DEVICE#" + ids[k] } } });
await ddb("DeleteItem", { TableName: PREFIX + "user", Key: { pk: { S: "USER#" + user }, sk: { S: "PROFILE" } } });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
