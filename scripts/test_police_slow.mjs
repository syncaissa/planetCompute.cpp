// docs/TESTING.md test 80: the capacity check accepts a RIGHT answer that came late (user 2026-10-29: the program kept showing
// "PlanetCompute's capacity check failed: the answer arrived too late" at 4 cores 20% + GPU 30%). Drives the CapacityPolice
// Durable Object of the given worker.js with a fake storage: right + 2x late -> pass at the measured speed; right + 10x late
// -> fail "too slow" but the speed is kept (the next check fits the machine); a wrong answer -> fail, speed not taken.
//   node scripts/test_police_slow.mjs <worker.js>
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const tmp = join(mkdtempSync(join(tmpdir(), "ps-")), "w.mjs"); writeFileSync(tmp, readFileSync(process.argv[2], "utf8")); globalThis.WebSocketRequestResponsePair = class {};
globalThis.fetch = async () => new Response("{}");                       // DynamoDB / grid calls: answered empty
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, x === undefined ? "" : JSON.stringify(x)); } };
const { CapacityPolice } = await import(tmp);
function make() {
  const store = new Map(), sent = [];
  const state = { storage: { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, v); }, delete: async (k) => store.delete(k), list: async () => new Map(), setAlarm: async () => {}, getAlarm: async () => null },
    getWebSockets: () => [{ send: (x) => sent.push(x), serializeAttachment() {}, deserializeAttachment() { return {}; } }], acceptWebSocket() {}, setWebSocketAutoResponse() {} };
  const env = { AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "y" };
  const p = new CapacityPolice(state, env);
  return { p, store };
}
async function answer(lateFactor, right) {
  const { p, store } = make();
  // a challenge of 3 CPU chunks with no spot checks (so any numbers are "right"); deadline 10 s
  const deadline = 10, n = 1000;
  store.set("challenge", { id: "c1", sent_at: Date.now() - lateFactor * deadline * 1000, deadline_s: deadline, cpu: { n, seeds: [1, 2, 3] }, gpu: null, check: { cpu: [], gpu: [] } });
  store.set("status", { fails: 0, cpu_sps: 0, gpu_sps: 0 });
  await p.webSocketMessage(p.state.getWebSockets()[0], JSON.stringify({ type: "answer", id: "c1", cpu: right ? [5, 6, 7] : [5] }));
  return store.get("status");
}
let st = await answer(2, true);
ok("1 right answer, 2x past the deadline: passes (verified), speed measured from it", st.fails === 0 && st.cpu_sps > 0 && Math.abs(st.cpu_sps - 3000 / 20) < 5, st);
st = await answer(0.5, true);
ok("2 right answer in time: passes as before", st.fails === 0 && Math.abs(st.cpu_sps - 3000 / 5) < 20, st);
st = await answer(10, true);
ok("3 right answer 10x late (a tab asleep): fails, but the measured speed is kept so the next check is sized to it", st.fails === 1 && Math.abs(st.cpu_sps - 3000 / 100) < 2, st);
st = await answer(1, false);
ok("4 a wrong answer (missing chunks): fails and its speed is not taken", st.fails === 1 && st.cpu_sps === 0, st);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
