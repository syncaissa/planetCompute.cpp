// docs/TESTING.md test 78: the account's computer list is corrected live (user 2026-10-29: "it is not connecting to my PC ...
// keeps saying Your PC WASMONE is offline ... it has to query and get the active tunnel connection"): /api/tunnel/devices?verify=1
// asks each computer's tunnel (tunnel:<user>:<device>/status) and fixes a stale entry of tunnels:<user>. Fake DOs, no keys.
//   node scripts/test_tunnel_verify.mjs <worker.js>
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { createHash } from "node:crypto";
const tmp = join(mkdtempSync(join(tmpdir(), "tv-")), "w.mjs"); writeFileSync(tmp, readFileSync(process.argv[2], "utf8")); globalThis.WebSocketRequestResponsePair = class {};
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, x === undefined ? "" : JSON.stringify(x)); } };
const SECRET = "s", sha = (s) => createHash("sha256").update(s).digest("hex"), tok = "testsessiontoken-alice-0123456789";
const items = new Map([["SESSION#" + sha(`${SECRET}|session|${tok}`), { user_id: { S: "alice" }, expires_at: { N: String(Math.floor(Date.now() / 1000) + 3600) } }]]);
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (/dynamodb\./.test(url)) {
    const op = String((init.headers || {})["x-amz-target"] || "").split(".").pop(), b = JSON.parse(init.body || "{}");
    if (op === "GetItem" && b.Key && b.Key.pk && items.has(b.Key.pk.S)) return new Response(JSON.stringify({ Item: items.get(b.Key.pk.S) }));
    if (op === "Scan" || op === "Query") return new Response(JSON.stringify({ Items: [] }));
    return new Response("{}");
  }
  return realFetch(input, init);
};
// the account list says both are offline (a lost "online" message); WASMONE's tunnel really has a connection
const list = { WASMONEaaaaa: null }, sets = [];
const devs = [{ device: "aaaaaaaaaaaa", name: "WASMONE", online: false, since: "2026-10-29T10:00:00Z" }, { device: "bbbbbbbbbbbb", name: "LAPTOP", online: false, since: "2026-10-28T10:00:00Z" }];
const OPEN = { aaaaaaaaaaaa: 1, bbbbbbbbbbbb: 0 };
const TUNNEL = { idFromName: (n) => n, get: (n) => ({ fetch: async (u, init) => {
  const p = new URL(u).pathname;
  if (n === "tunnels:alice" && p === "/list") return new Response(JSON.stringify({ devices: devs.map((d) => ({ ...d })) }));
  if (n === "tunnels:alice" && p === "/set") { const d = JSON.parse(init.body); sets.push(d); const x = devs.find((y) => y.device === d.device); if (x) Object.assign(x, d); return new Response("ok"); }
  const m = /^tunnel:alice:([0-9a-f]{12})$/.exec(n);
  if (m && p === "/status") return new Response(JSON.stringify({ open: OPEN[m[1]] || 0 }));
  return new Response("not found", { status: 404 }); } }) };
const W = (await import(tmp)).default;
const env = { AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "y", SESSION_SECRET: SECRET, MAIL_FROM: "test@invalid", TUNNEL };
const get = async (q) => { const r = await W.fetch(new Request("https://planetcompute.ai/api/tunnel/devices" + q, { headers: { cookie: "pc_session=" + tok } }), env); return r.json(); };
let j = await get("");
ok("1 without verify: the stored list as it is (WASMONE offline)", j.devices && j.devices.find((d) => d.name === "WASMONE").online === false, j);
j = await get("?verify=1");
ok("2 verify=1: WASMONE's tunnel is connected -> online true", j.devices.find((d) => d.name === "WASMONE").online === true, j);
ok("3 the stale entry is corrected in the account list (one /set, for WASMONE only)", sets.length === 1 && sets[0].device === "aaaaaaaaaaaa" && sets[0].online === true, sets);
ok("4 LAPTOP (really off) stays offline", j.devices.find((d) => d.name === "LAPTOP").online === false);
j = await get("");
ok("5 afterwards the plain list is right too", j.devices.find((d) => d.name === "WASMONE").online === true);
OPEN.aaaaaaaaaaaa = 0; j = await get("?verify=1");
ok("6 and the other way: a list that says online while no connection is open is set offline", j.devices.find((d) => d.name === "WASMONE").online === false && sets.at(-1).online === false);
const src = readFileSync(process.argv[2], "utf8");
ok("7 the tunnel repeats 'online' every 5 minutes while connected (alarm) and retries the notice", /async alarm\(\)/.test(src) && /TUNNEL_REASSERT_MS = 5 \* 60 \* 1000/.test(src) && /for \(let i = 0; i < 3; i\+\+\)/.test(src));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
