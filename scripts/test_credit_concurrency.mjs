// Test that many devices of one account sharing AT THE SAME TIME are all credited, and nothing is lost or counted
// twice (TESTING.md test 37). The given worker.js runs in-process against the TEST tables (prefix pctest-ai-, never the
// live ones) with real DynamoDB, a controllable clock and the signed-in user faked: N devices (already verified by the
// capacity check) send their status reports at the same moment, several rounds; one device also sends each report 3
// times at once (racing itself). At the end each device stops (its pending credit is written) and the BALANCE must be
// exactly the sum of what every device reported.
//   AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. node scripts/test_credit_concurrency.mjs website/worker.js [devices] [rounds]
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { randomBytes } from "node:crypto";
const N = Number(process.argv[3] || 20), ROUNDS = Number(process.argv[4] || 3), PREFIX = "pctest-ai-";
let src = readFileSync(process.argv[2], "utf8");
const swap = (o, n) => { if (!src.includes(o)) throw new Error("not found: " + o); src = src.replace(o, n); };
swap("const now = () => Math.floor(Date.now() / 1000);", "const now = () => Math.floor(Date.now() / 1000) + (globalThis.__skew || 0);");
swap("const iso = () => new Date().toISOString();", "const iso = () => new Date(Date.now() + (globalThis.__skew || 0) * 1000).toISOString();");
swap("async function currentUser(env, request) {", "async function currentUser(env, request) { if (globalThis.__user) return { user_id: globalThis.__user, token: 't' };");
swap("async function cachedUser(env, request) {", "async function cachedUser(env, request) { if (globalThis.__user) return { user_id: globalThis.__user, token: 't' };");
const tmp = join(mkdtempSync(join(tmpdir(), "cc-")), "w.mjs"); writeFileSync(tmp, src); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default;
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, AWS_REGION: process.env.AWS_REGION || "us-east-1",
  DDB_PREFIX: PREFIX, SESSION_SECRET: "s".repeat(40), MAIL_FROM: "test@planetcompute.ai" };
if (!env.AWS_ACCESS_KEY_ID) { console.log("needs AWS keys in the environment"); process.exit(2); }
// DynamoDB by hand (the worker's own SigV4 is not exported): through a tiny admin-free helper using the worker itself
const { createHash, createHmac } = await import("node:crypto");
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
const user = "cc" + randomBytes(5).toString("hex"); globalThis.__user = user;
const devs = Array.from({ length: N }, () => randomBytes(6).toString("hex")), sids = devs.map(() => randomBytes(8).toString("hex"));
const t0 = Math.floor(Date.now() / 1000);
await ddb("PutItem", { TableName: PREFIX + "user", Item: { pk: { S: "USER#" + user }, sk: { S: "PROFILE" }, user_id: { S: user }, primary_email: { S: "concurrency-test@invalid" } } });
await Promise.all(devs.map((d) => ddb("PutItem", { TableName: PREFIX + "user", Item: { pk: { S: "USER#" + user }, sk: { S: "DEVICE#" + d }, user_id: { S: user }, device_id: { S: d },
  police_verified: { BOOL: true }, verified_cpu_wu_s: { N: "1000" }, verified_gpu_wu_s: { N: "0" }, last_seen: { N: String(t0 - 60) } } })));
console.log(`account ${user}: ${N} verified devices, ${ROUNDS} rounds of reports at the same moment; device 0 sends each report 3 times at once`);
const beat = (i, state, wu) => W.fetch(new Request("https://planetcompute.ai/api/volunteer/heartbeat", { method: "POST", headers: { "content-type": "application/json", origin: "https://planetcompute.ai" },
  body: JSON.stringify({ device_id: devs[i], session_id: sids[i], state, cores: 2, cpu_cap: 50, cpu_pct: 40, packs: Math.round(wu * 1000), wu, browser: "test", platform: "Linux", host: "app" }) }), env);
let errors = 0, statuses = {};
for (let k = 1; k <= ROUNDS; k++) {
  globalThis.__skew = 300 * k;                                   // 5 minutes later: every device reports its total so far
  const all = [];
  for (let i = 0; i < N; i++) for (let rep = 0; rep < (i === 0 ? 3 : 1); rep++) all.push(beat(i, "running", k * 1.0));
  const rs = await Promise.all(all.map((p) => p.then(async (r) => ({ s: r.status, b: await r.text() })).catch((e) => ({ s: 0, b: String(e) }))));
  for (const r of rs) { statuses[r.s] = (statuses[r.s] || 0) + 1; if (r.s !== 200) { errors++; if (errors <= 4) console.log("  error:", r.s, r.b.slice(0, 300)); } }
}
globalThis.__skew = 300 * (ROUNDS + 1);
const st = await Promise.all(devs.map((d, i) => beat(i, "stopped", ROUNDS * 1.0).then((r) => r.status)));
ok(`every report answered (statuses: ${JSON.stringify(statuses)}; stop: all ${st.every((s) => s === 200) ? "200" : JSON.stringify(st)})`, errors === 0 && st.every((s) => s === 200), statuses);
const bal = (await ddb("GetItem", { TableName: PREFIX + "user-credits", Key: { user_id: { S: user }, sk: { S: "BALANCE" } }, ConsistentRead: true })).Item || {};
const got = Number((bal.lifetime_contribution_uwu || { N: "0" }).N) / 1e6, avail = Number((bal.available_uwu || { N: "0" }).N) / 1e6, want = N * ROUNDS * 1.0;
ok(`the BALANCE is exactly the sum of all devices: ${got} WU (expected ${want} WU), available ${avail} WU`, Math.abs(got - want) < 1e-6 && Math.abs(avail - want) < 1e-6, { got, avail, want });
const items = await Promise.all(devs.map((d) => ddb("GetItem", { TableName: PREFIX + "user", Key: { pk: { S: "USER#" + user }, sk: { S: "DEVICE#" + d } }, ConsistentRead: true }).then((x) => x.Item)));
ok("every device item has its final report and no pending credit left", items.every((it) => it.state.S === "stopped" && Number(it.wu.N) === ROUNDS && !it.p_c), items.map((it) => [it.state.S, it.wu.N, !!it.p_c]));
ok("the device that raced itself (3 copies of each report) was not counted twice", Number(items[0].wu.N) === ROUNDS && Math.abs(got - want) < 1e-6);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
