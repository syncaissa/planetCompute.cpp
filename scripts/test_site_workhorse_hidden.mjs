// Test (TESTING.md test 40): the copies running on workhorse servers are left out of the account's own lists (Your
// computers on Receive Compute, Delete all links, My Balance and the program: /api/tunnel/devices, /api/me/devices); the
// admin Workhorses tab links each copy instead. The given worker.js runs in-process, DynamoDB and the tunnel faked. No keys.
//   node scripts/test_site_workhorse_hidden.mjs <worker.js>
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
let src = readFileSync(process.argv[2], "utf8");
src = src.replace("async function currentUser(env, request) {", "async function currentUser(env, request) { return { user_id: 'u1', token: 't' };");
src = src.replace("async function cachedUser(env, request) {", "async function cachedUser(env, request) { return { user_id: 'u1', token: 't' };");
const tmp = join(mkdtempSync(join(tmpdir(), "whh-")), "w.mjs"); writeFileSync(tmp, src); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default, t = Math.floor(Date.now() / 1000);
const S = (v) => ({ S: v }), N = (v) => ({ N: String(v) });
const dev = (id) => ({ pk: S("USER#u1"), sk: S("DEVICE#" + id), device_id: S(id), last_seen: N(t - 10), state: S("running"), host: S("app") });
globalThis.fetch = async (u, o) => {
  const target = (o.headers["x-amz-target"] || "").split(".")[1], b = JSON.parse(o.body);
  let out = {};
  if (target === "Scan" && /Workhorses$/.test(b.TableName)) out = { Items: [{ server_id: S("cb6de2a66794"), sk: S("SERVER"), name: S("interserver-1"),
    agent_state: S(JSON.stringify({ instances: [{ i: 1, device: "3eb5be2903d4" }, { i: 2, device: "bd68a6636d91" }] })) }] };
  else if (target === "Query") out = { Items: [dev("f808264cb709"), dev("3eb5be2903d4"), dev("bd68a6636d91")] };
  return new Response(JSON.stringify(out), { headers: { "content-type": "application/x-amz-json-1.0" } });
};
const revoked = [];
const TUNNEL = { idFromName: (n) => n, get: () => ({ fetch: async (u, o) => {
  if (String(u).endsWith("/list")) return new Response(JSON.stringify({ devices: ["f808264cb709", "3eb5be2903d4", "bd68a6636d91"].map((d) => ({ device: d, name: d === "f808264cb709" ? "WASMONE" : "process.storage.bz", online: true })) }));
  if (String(u).endsWith("/revoke")) revoked.push(...JSON.parse(o.body).devices); return new Response("{}"); } }) };
const env = { AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "y", AWS_REGION: "us-east-1", DDB_PREFIX: "t-", SESSION_SECRET: "s".repeat(40), MAIL_FROM: "t@planetcompute.ai", TUNNEL };
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
const get = async (p, body) => (await W.fetch(new Request("https://planetcompute.ai" + p, body ? { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: "https://planetcompute.ai" } } : {}), env)).json();
const links = await get("/api/tunnel/devices");
ok("1 Your computers (device links): only the account's own computer, not the workhorse copies", links.devices.length === 1 && links.devices[0].device === "f808264cb709", links);
const mine = await get("/api/me/devices"), arr = Array.isArray(mine) ? mine : mine.devices;
ok("2 /api/me/devices (My Balance, the program): the workhorse copies are left out", arr.length === 1 && arr[0].device === "f808264cb709", mine);
await get("/api/tunnel/devices/delete-all", {});
ok("3 Delete all links leaves the workhorse links alone", revoked.length === 1 && revoked[0] === "f808264cb709", revoked);
ok("4 the admin Workhorses tab links each copy's device page", /dl\.href = "\/device\/" \+ x\.device/.test(src));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
