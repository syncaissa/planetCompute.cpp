// Test of the grid, step 1 (TESTING.md test 47): chat jobs from Receive Compute (POST /v1/jobs) to volunteers'
// planetCompute programs. The given worker.js runs in-process against the TEST tables (pctest-ai-*, real DynamoDB);
// its Durable Objects (the grid "grid:main" and each program's capacity-check object) run in-process too, with
// in-memory storage, and each volunteer program is a stand-in on a fake socket that answers jobs the way the program
// does (job -> job_result). Cases: no program with the model (503); one program (answered, credited, the receiver's
// received WU); two honest programs with the check forced on (checked, agree, both credited); a program that answers
// differently (checked, disagree, nobody credited); a program that leaves; the admin list (tab Grid jobs).
//   AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. node scripts/test_grid_jobs.mjs website/worker.js
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
let src = readFileSync(process.argv[2], "utf8");
const swap = (o, n) => { if (!src.includes(o)) throw new Error("not found: " + o); src = src.replace(o, n); };
// the test's model library (the test tables have none): WU per token for the models the stand-ins serve; others earn 0
swap("async function wuPerToken(env, model) {", "async function wuPerToken(env, model) { if (globalThis.__perTok) return globalThis.__perTok[model] || 0;");
globalThis.__perTok = { "qwen2.5-0.5b-q4km": 1e-5, "self-only-model-x": 1e-5 };
swap("async function currentUser(env, request) {", "async function currentUser(env, request) { if (globalThis.__user) return { user_id: globalThis.__user, token: 't' };");
swap("const GRID_QUEUE_S = 120,", "const GRID_QUEUE_S = globalThis.__queueS ?? 120,"); globalThis.__queueS = 3;   // the queue limit, short for the test
swap("Math.random() < GRID_CHECK_P ? 2 : 1", "Math.random() < (globalThis.__checkP ?? GRID_CHECK_P) ? 2 : 1");
src += "\nglobalThis.__g = { listGridJobs, ddb, M, U };";
const tmp = join(mkdtempSync(join(tmpdir(), "gj-")), "w.mjs"); writeFileSync(tmp, src); globalThis.WebSocketRequestResponsePair = class {};
const mod = await import(tmp), W = mod.default, G = globalThis.__g, PREFIX = "pctest-ai-";
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };

// the Durable Object namespace, in-process: one CapacityPolice per name, in-memory storage, fake sockets
const objs = new Map();
const NS = { idFromName: (n) => n, get: (n) => { if (!objs.has(n)) objs.set(n, mk(n)); return objs.get(n).stub; } };
function mk(name) {
  const store = new Map(), sockets = [];
  const state = { storage: { get: async (k) => structuredClone(store.get(k)), put: async (k, v) => { store.set(k, structuredClone(v)); }, setAlarm: async () => {} },
    getWebSockets: () => sockets, acceptWebSocket() {} };
  const o = { name, store, sockets, inst: null };
  o.inst = new mod.CapacityPolice(state, env);
  o.stub = { fetch: (u, init) => o.inst.fetch(new Request(u, init)) };
  return o;
}
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, AWS_REGION: "us-east-1",
  DDB_PREFIX: PREFIX, SESSION_SECRET: "s".repeat(40), MAIL_FROM: "test@planetcompute.ai", POLICE: NS };
if (!env.AWS_ACCESS_KEY_ID) { console.log("needs AWS keys in the environment"); process.exit(2); }

// a volunteer program: deterministic answers (temperature 0, the site's seed), or a different one ("liar")
const answer = (j, liar) => "Answer " + createHash("sha256").update(JSON.stringify([j.model, j.messages, j.seed])).digest("hex").slice(0, 12) + " " + "x".repeat(40) + (liar ? " (made up)" : "");
async function program(user, device, models, liar = false, delay = 10, opt = {}) {
  const o = (NS.get(`police:${user}:${device}`), objs.get(`police:${user}:${device}`));
  await o.inst.state.storage.put("who", { user, device, net: "net:test" });
  if (opt.verified !== false) await o.inst.state.storage.put("status", { verified: true });   // as after a passed capacity check
  const ws = { readyState: 1, close() {}, serializeAttachment() {}, send: (m) => { const j = JSON.parse(m); if (j.type !== "job") return;
    setTimeout(() => o.inst.webSocketMessage(ws, JSON.stringify({ type: "job_result", id: j.id, ok: true, content: answer(j, liar), finish: "stop",
      prompt_tokens: opt.pt || 20, completion_tokens: opt.ct || 30, ms: 15 })), delay); } };
  o.sockets.push(ws);
  await o.inst.webSocketMessage(ws, JSON.stringify({ type: "hello", cores: 4, gpu: false, leases: false, jobs: true, models }));
  return { o, ws, close: () => o.inst.webSocketClose(ws).then(() => { o.sockets.length = 0; }) };
}
const users = { rx: "gr" + randomBytes(4).toString("hex"), a: "ga" + randomBytes(4).toString("hex"), b: "gb" + randomBytes(4).toString("hex"), c: "gc" + randomBytes(4).toString("hex") };
const dev = () => randomBytes(6).toString("hex");
const job = (model = "qwen2.5-0.5b-q4km", extra = {}) => { globalThis.__user = users.rx; return W.fetch(new Request("https://planetcompute.ai/v1/jobs", { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "Name a planet " + Math.random() }], max_tokens: 40, ...extra }) }), env)
  .then(async (r) => ({ s: r.status, j: await r.json() })); };
const bal = async (u) => { const it = (await G.ddb(env, "GetItem", { TableName: PREFIX + "user-credits", Key: G.M({ user_id: u, sk: "BALANCE" }), ConsistentRead: true })).Item;
  const x = G.U(it) || {}; return { life: x.lifetime_contribution_uwu || 0, rec: x.lifetime_received_uwu || 0 }; };

let r = await job();
ok("1 no volunteer program has the model: 503, said plainly", r.s === 503 && /No volunteer computer has this model/.test(r.j.error.message), r);
const A = await program(users.a, dev(), ["qwen2.5-0.5b-q4km"]);
globalThis.__checkP = 0;
const a0 = await bal(users.a), r0 = await bal(users.rx);
r = await job();
const a1 = await bal(users.a), r1 = await bal(users.rx);
ok("2 one program: the job is answered (OpenAI shape + grid facts), not checked", r.s === 200 && r.j.choices[0].message.content.startsWith("Answer ") && r.j.grid.checked === false &&
  r.j.usage.completion_tokens === 30 && r.j.grid.device === A.o.name.split(":").pop(), r.j);
const wu = Math.floor(50 * 1e-5 * 1e6);
ok(`3 the volunteer is credited ${wu} micro-WU (50 tokens x the model's WU per token); the receiver's received WU goes up the same`, a1.life - a0.life === wu && r1.rec - r0.rec === wu, { a0, a1, r0, r1 });
r = await job("some-other-model");
ok("4 a model no program has: 503", r.s === 503, r);
const B = await program(users.b, dev(), ["qwen2.5-0.5b-q4km"]);
globalThis.__checkP = 1;
const b0 = await bal(users.b);
r = await job();
const b1 = await bal(users.b);
ok("5 two honest programs, check on: both ran it, answers agree, both credited", r.s === 200 && r.j.grid.checked === true && r.j.grid.agree === true && b1.life - b0.life === wu, r.j);
await B.close();
const C = await program(users.c, dev(), ["qwen2.5-0.5b-q4km"], true);
const a2 = await bal(users.a), c0 = await bal(users.c);
r = await job();
const a3 = await bal(users.a), c1 = await bal(users.c);
ok("6 an honest program and one that answers differently: checked, DISAGREE, nobody credited", r.s === 200 && r.j.grid.checked === true && r.j.grid.agree === false &&
  r.j.grid.wu === 0 && a3.life === a2.life && c1.life === c0.life, r.j);
await C.close(); await A.close();
// the queue: one computer answering in 0.4 s, five jobs at the same moment: none is refused, each waits its turn
globalThis.__checkP = 0;
const Q = await program(users.a, dev(), ["qwen2.5-0.5b-q4km"], false, 400);
const rs = await Promise.all([0, 1, 2, 3, 4].map((i) => new Promise((res) => setTimeout(res, i * 20)).then(() => job())));
const waits = rs.map((x) => x.j.grid && x.j.grid.wait_ms);
ok(`9 the queue: 5 jobs at once on 1 computer, all answered (no "busy"), each waiting its turn (waits ${waits.join(", ")} ms)`,
  rs.every((x) => x.s === 200) && waits.filter((w) => w >= 300).length >= 3 && Math.max(...waits) >= 1500, rs.map((x) => [x.s, x.j.grid && x.j.grid.wait_ms]));
ok("10 they ran in the order they came (each waited longer than the one before)", waits.every((w, i) => i === 0 || w >= waits[i - 1] - 50), waits);
await Q.close();
// a computer that takes 5 s per job and a 3 s queue limit: the second job gives up after 3 s with a clear answer
const S = await program(users.a, dev(), ["qwen2.5-0.5b-q4km"], false, 5000);
const [s1, s2] = await Promise.all([job(), new Promise((res) => setTimeout(res, 50)).then(() => job())]);
ok("11 a job that waited longer than the queue limit: 503 'stayed busy', the first still answered", s1.s === 200 && s2.s === 503 && /stayed busy/.test(s2.j.error.message), [s1.s, s2.s, s2.j]);
await S.close();
r = await job();
ok("7 the programs left (sockets closed): no program has the model again", r.s === 503, r);
const L = await G.listGridJobs(env, new URL("https://x/?day=" + new Date().toISOString().slice(0, 10)));
const mine = L.rows.filter((x) => x.receiver === users.rx);
ok("8 the admin list (tab Grid jobs) has all 13 jobs: 9 answered (1 checked agree, 1 checked disagree), 4 failed, with reasons and times",
  mine.length === 13 && mine.filter((x) => x.ok).length === 9 && mine.some((x) => x.agree === "yes") && mine.some((x) => x.agree === "no") && mine.every((x) => x.total_ms >= 0), mine.map((x) => [x.ok, x.error, x.agree]));
// priority: three test-traffic jobs ("priority": "low") queued first, then a normal one: the normal one runs next
const R = await program(users.a, dev(), ["qwen2.5-0.5b-q4km"], false, 400);
const lows = [0, 1, 2].map((i) => new Promise((res) => setTimeout(res, i * 10)).then(() => job(undefined, { priority: "low" })));
const high = new Promise((res) => setTimeout(res, 60)).then(() => job());
const [l1, l2, l3, h1] = await Promise.all([...lows, high]);
const lw = [l1, l2, l3].map((x) => x.j.grid && x.j.grid.wait_ms), hw = h1.j.grid && h1.j.grid.wait_ms;
ok(`12 priority: the normal job, sent after three low-priority ones, waits less than the last two (normal ${hw} ms, low ${lw.join(", ")} ms)`,
  [l1, l2, l3, h1].every((x) => x.s === 200) && hw < lw[1] && hw < lw[2], { hw, lw });
await R.close();
// activity: the grid holds the totals and details in memory until it writes them (every 10 minutes)
globalThis.__user = users.rx;
let A1 = await (await W.fetch(new Request("https://planetcompute.ai/api/me/activity?days=3"), env)).json();
const d1 = (A1.days || [])[0] || {};
ok(`13 My activity before the write: today's totals come from the grid's memory (received ${d1.rx_jobs}, test traffic ${d1.rx_low}), details of normal jobs only`,
  d1.rx_jobs >= 17 && d1.rx_low === 3 && A1.recent.length >= 1 && A1.recent.every((x) => x.role === "received" && !x.low), { d1, n: A1.recent.length });
await objs.get("grid:main").inst.actFlush();
const it = (await G.ddb(env, "GetItem", { TableName: PREFIX + "user-credits", Key: G.M({ user_id: users.rx, sk: "ACT#" + new Date().toISOString().slice(0, 10) }), ConsistentRead: true })).Item;
const act = G.U(it) || {}, itA = G.U((await G.ddb(env, "GetItem", { TableName: PREFIX + "user-credits", Key: G.M({ user_id: users.a, sk: "ACT#" + new Date().toISOString().slice(0, 10) }), ConsistentRead: true })).Item) || {};
ok(`14 after the write: one item per account and day in DynamoDB (receiver: ${act.rx_jobs} received, ${act.rx_failed} failed; volunteer A: ${itA.tx_jobs} answered)`,
  act.rx_jobs === d1.rx_jobs && act.rx_failed >= 4 && act.rx_disagreed === 1 && itA.tx_jobs >= 10 && itA.tx_uwu > 0, { act, itA });
A1 = await (await W.fetch(new Request("https://planetcompute.ai/api/me/activity?days=3"), env)).json();
ok("15 My activity after the write: the same totals, now read from DynamoDB", (A1.days[0] || {}).rx_jobs === d1.rx_jobs, A1.days[0]);
const rowsNow = (await G.listGridJobs(env, new URL("https://x/?day=" + new Date().toISOString().slice(0, 10)))).rows.filter((x) => x.receiver === users.rx);
ok("16 every per-job row expires after 90 days (ttl_expires)", rowsNow.length && rowsNow.every((x) => x.ttl_expires > Date.now() / 1000 + 89 * 86400), rowsNow.slice(0, 2));
// security review W1: only verified programs take jobs; token counts are capped; answering your own job earns nothing
const U1 = await program(users.c, dev(), ["qwen2.5-0.5b-q4km"], false, 10, { verified: false });
const pv = (await objs.get("grid:main").inst.state.storage.get("providers")) || {};
ok("17 a program the capacity check has not verified is not on the grid (gets no jobs)", !Object.keys(pv).some((k) => k.startsWith(`police:${users.c}:`)), Object.keys(pv));
await U1.close();
const before = await bal(users.b), BIG = await program(users.b, dev(), ["qwen2.5-0.5b-q4km"], false, 10, { pt: 1e12, ct: 1e12 });
globalThis.__checkP = 0; let rb;
for (let i = 0; i < 6 && !rb; i++) { const x = await job(); if (x.s === 200 && x.j.grid && x.j.grid.device && (await bal(users.b)).life > before.life) rb = x; }
const gained = (await bal(users.b)).life - before.life, perJobMax = (40 + Math.ceil(60 / 2) + 32) * 2;   // tokens; WU per token is tiny
ok("18 a program claiming 10^12 tokens is credited for at most the job's limit and the text's length (not 10^12)", rb && gained > 0 && gained < 1e6, { gained, usage: rb && rb.j.usage });
await BIG.close();
const selfBefore = await bal(users.rx), SELF = await program(users.rx, dev(), ["self-only-model-x"]);
const rself = await job("self-only-model-x");
ok("19 answering your own account's job earns no credit (and is not counted as received)", rself.s === 200 && (await bal(users.rx)).life === selfBefore.life && (await bal(users.rx)).rec === selfBefore.rec, { rs: rself.s, before: selfBefore, after: await bal(users.rx) });
await SELF.close();
const before2 = await bal(users.c), UL = await program(users.c, dev(), ["not-in-library-z"]);
const rul = await job("not-in-library-z");
ok("20 a model that is not in the library: the job is answered, nobody is credited", rul.s === 200 && (await bal(users.c)).life === before2.life, { s: rul.s, before2, after: await bal(users.c) });
await UL.close();
// clean up
for (const x of rowsNow) if (!mine.some((m) => m.sk === x.sk)) mine.push(x);
for (const u of Object.values(users)) {
  const q = await G.ddb(env, "Query", { TableName: PREFIX + "user-credits", KeyConditionExpression: "user_id = :u", ExpressionAttributeValues: G.M({ ":u": u }) });
  for (const it of q.Items || []) await G.ddb(env, "DeleteItem", { TableName: PREFIX + "user-credits", Key: { user_id: it.user_id, sk: it.sk } });
}
for (const x of mine) await G.ddb(env, "DeleteItem", { TableName: PREFIX + "howCreditAwarded", Key: G.M({ pk: x.pk, sk: x.sk }) });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
