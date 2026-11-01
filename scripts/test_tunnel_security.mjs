// Tunnel security (TESTING.md test 58; security review T2, T3, T4): the website's DeviceTunnel code in Node with an
// in-memory storage and stand-in WebSockets. No keys, no network.
//   node scripts/test_tunnel_security.mjs <path to worker.js>
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
globalThis.WebSocketRequestResponsePair = class { constructor(a, b) { this.a = a; this.b = b; } };
let closes = [];
globalThis.WebSocketPair = class { constructor() { const mk = () => ({ readyState: 1, sent: [], att: null, send(m) { this.sent.push(m); }, close(c, r) { this.readyState = 3; closes.push(c); },
  serializeAttachment(a) { this.att = a; }, deserializeAttachment() { return this.att; } }); return [mk(), mk()]; } };
let src = readFileSync(process.argv[2], "utf8").replaceAll("return new Response(null, { status: 101, webSocket: pair[0] });", "return new Response(null, { status: 200 });");   // Node has no 101
const tmp = join(mkdtempSync(join(tmpdir(), "ts-")), "w.mjs"); writeFileSync(tmp, src);
const { DeviceTunnel } = await import(tmp);
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
const objects = new Map();
function state() { const store = new Map(), sockets = [];
  return { store, sockets, setWebSocketAutoResponse() {}, getWebSockets: () => sockets.filter((w) => w.readyState === 1), acceptWebSocket(ws) { sockets.push(ws); },
    storage: { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, v); }, delete: async (k) => store.delete(k), list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix))), setAlarm: async () => {} } }; }
const env = { TUNNEL: { idFromName: (n) => n, get: (n) => { if (!objects.has(n)) { const st = state(); objects.set(n, { st, obj: new DeviceTunnel(st, env) }); }
  const o = objects.get(n).obj; return { fetch: (u, init) => o.fetch(new Request(u, init)) }; } } };
const dev = (id) => env.TUNNEL.get(`tunnel:u1:${id}`), st = (id) => objects.get(`tunnel:u1:${id}`).st;
const connect = (id, key, sess = "S1") => dev(id).fetch("https://tunnel.internal/connect", { headers: { upgrade: "websocket", "x-pc-user": "u1", "x-pc-device": id, "x-pc-name": "pc",
  "x-pc-sess": sess, ...(key ? { "x-pc-device-key": key } : {}) } });
const A = "aaaaaaaaaaaa";
let r = await connect(A, "key-1");
ok("1 T2: the first connection binds the program's device key to the link", r.status === 200 && !!st(A).store.get("keyh") && st(A).sockets.length === 1, r.status);
closes = []; r = await connect(A, "", "S-thief");
ok("2 T2: a connection without the key is refused and does NOT replace the program", r.status === 403 && closes.length === 0 && st(A).sockets.filter((w) => w.readyState === 1).length === 1, { s: r.status, closes });
r = await connect(A, "key-2", "S-thief");
ok("3 T2: a connection with another key is refused", r.status === 403 && closes.length === 0, r.status);
r = await connect(A, "key-1");
ok("4 T2: the program itself (same key) reconnects and replaces its old connection", r.status === 200 && closes.includes(4000), { s: r.status, closes });
r = await connect("bbbbbbbbbbbb", ""); const t5 = await r.clone().json().catch(() => ({}));
ok("5 T2: a program without a device key is refused even on a new link (permanent, no setting), and told to update", r.status === 403 && /install the latest/.test(t5.error || "") && !st("bbbbbbbbbbbb").store.get("keyh") && st("bbbbbbbbbbbb").sockets.length === 0, { s: r.status, t5 });
env.TUNNEL_REQUIRE_KEY = "0"; r = await connect("cccccccccccc", ""); delete env.TUNNEL_REQUIRE_KEY;
ok("6 T2: the old TUNNEL_REQUIRE_KEY setting no longer matters (=0 still refuses a program without a key)", r.status === 403, r.status);
r = await dev(A).fetch("https://tunnel.internal/kick"); const k = await r.json();
ok("7 T2/T4: Delete closes the link (4003) and names the session that registered it (to sign it out)", k.ok && k.sess === "S1" && closes.includes(4003), k);
r = await connect(A, "key-1");
const rr = await dev(A).fetch("https://tunnel.internal/relay", { method: "POST", headers: { "x-pc-method": "GET", "x-pc-path": "/local/" } });
ok("8 T4: a deleted link is refused inside the link itself: on connect (even with the right key) and on every request", r.status === 410 && rr.status === 410, [r.status, rr.status]);
const D = "dddddddddddd"; await connect(D, "kd");
const sock = st(D).sockets.at(-1); const tunnel = objects.get(`tunnel:u1:${D}`).obj;
const reqs = []; for (let i = 0; i < 17; i++) reqs.push(dev(D).fetch("https://tunnel.internal/relay", { method: "POST", headers: { "x-pc-method": "GET", "x-pc-path": "/local/x" + i } }));
await new Promise((x) => setTimeout(x, 50));
const r17 = await Promise.race([reqs[16], new Promise((x) => setTimeout(() => x(null), 200))]);
const sent16 = sock.sent.filter((m) => m.includes('"t":"req"')).length;
ok("9 T3: at most 16 requests to one computer at once; the 17th waits its turn (not refused, not sent yet)", r17 === null && tunnel.inflight === 16 && tunnel.waiting.length === 1 && sent16 === 16, { s: r17 && r17.status, inflight: tunnel.inflight, waiting: tunnel.waiting.length, sent16 });
const answer = async () => { for (const m of sock.sent.splice(0)) { try { const j = JSON.parse(m); if (j.t === "req") await tunnel.webSocketMessage(sock, JSON.stringify({ t: "res", id: j.id, status: 200, ct: "text/plain", body: "" })); } catch (e) {} } };
await answer(); await Promise.all(reqs.slice(0, 16)); await new Promise((x) => setTimeout(x, 20)); await answer();
const r17b = await Promise.race([reqs[16], new Promise((x) => setTimeout(() => x(null), 500))]);
ok("9b T3: when a slot frees, the waiting request is sent to the computer and answered (200); nothing left in line", r17b && r17b.status === 200 && tunnel.waiting.length === 0 && tunnel.inflight === 0, { s: r17b && r17b.status, waiting: tunnel.waiting.length, inflight: tunnel.inflight });
tunnel.inflight = 16; for (let i = 0; i < 400; i++) tunnel.waiting.push({ res() {}, t: null });
const rFull = await dev(D).fetch("https://tunnel.internal/relay", { method: "POST", headers: { "x-pc-method": "GET", "x-pc-path": "/local/full" } });
ok("9c T3: the line is capped (400 waiting): one more is refused at once (429, 'very busy', retry-after)", rFull.status === 429 && /very busy/.test((await rFull.json()).error) && rFull.headers.get("retry-after") === "30", rFull.status);
tunnel.waiting.length = 0; tunnel.inflight = 0;
const list = env.TUNNEL.get("tunnels:u2"), allow = async (id) => (await list.fetch(`https://tunnel.internal/allow?device=${id}`)).json();
const ids = Array.from({ length: 25 }, (_, i) => i.toString(16).padStart(12, "0"));
let made = 0, hourly = null;
for (const id of ids) { const a = await allow(id); if (a.ok) { made++; await list.fetch("https://tunnel.internal/set", { method: "POST", body: JSON.stringify({ device: id, name: "x" }) }); } else { hourly = a; break; } }
ok("10 T4: at most 10 new links an hour per account", made === 10 && /this hour/.test(hourly.error), { made, hourly });
const s2 = objects.get("tunnels:u2").st; s2.store.set("made", []);
for (const id of ids.slice(10)) { const a = await allow(id); if (a.ok) await list.fetch("https://tunnel.internal/set", { method: "POST", body: JSON.stringify({ device: id, name: "x" }) }); else { hourly = a; break; } }
ok("11 T4: at most 20 links per account (the 21st is refused; links already made still connect)", /already has 20/.test(hourly.error) && (await allow(ids[0])).ok, hourly);
await list.fetch("https://tunnel.internal/revoke", { method: "POST", body: JSON.stringify({ devices: [ids[1]] }) });
const rv = await allow(ids[1]); s2.store.set(`rev:${ids[1]}`, Date.now() - 31 * 24 * 3600 * 1000); s2.store.set("made", []);
const rv2 = await allow(ids[1]);
ok("12 T4: a deleted link stays refused, and the deletion is forgotten after 30 days (no growing list)", rv.revoked && !rv2.revoked && !s2.store.has(`rev:${ids[1]}`), { rv, rv2 });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
