// docs/TESTING.md test 106: signing out halts Share Compute at once, and every page follows one source of truth for
// signed in / signed out (user 2026-11-01). In-process: the site's real CapacityPolice class with fake sockets, a fake
// DynamoDB, the real account-button script of the pages (in a small fake browser), and the program's page (text checks).
//   node scripts/test_signout_halts.mjs website/worker.js client/ui/index.html
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import vm from "node:vm";

const mod = await import(pathToFileURL(resolve(process.argv[2] || "website/worker.js")).href);
const W = mod.default, CapacityPolice = mod.CapacityPolice;
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n, x === undefined ? "" : JSON.stringify(x).slice(0, 300)); } };

// --- a fake DynamoDB: one account, two sign-ins (A = this browser, B = the program), three devices ---
const db = new Map(), K = (x) => x.pk.S + "|" + x.sk.S;
const UID = "0123456789ab", put = (pk, sk, more = {}) => db.set(pk + "|" + sk, { pk: { S: pk }, sk: { S: sk }, ...more });
globalThis.fetch = async (req, init = {}) => {
  const h = new Headers(init.headers || {}), t = h.get("x-amz-target") || "";
  if (t.startsWith("DynamoDB_")) {
    const op = t.split(".")[1], b = JSON.parse(init.body);
    if (op === "GetItem") { const it = db.get(K(b.Key)); return new Response(JSON.stringify(it ? { Item: it } : {})); }
    if (op === "DeleteItem") { db.delete(K(b.Key)); return new Response("{}"); }
    if (op === "PutItem") { db.set(K(b.Item), b.Item); return new Response("{}"); }
    if (op === "BatchGetItem") { const [tn, q] = Object.entries(b.RequestItems)[0]; return new Response(JSON.stringify({ Responses: { [tn]: q.Keys.map((k) => db.get(K(k))).filter(Boolean) } })); }
    if (op === "Query" && b.IndexName === "by-user") {                  // the account's sign-ins (user_id + sk SESSION)
      const u = b.ExpressionAttributeValues[":u"].S;
      return new Response(JSON.stringify({ Items: [...db.values()].filter((x) => x.sk.S === "SESSION" && x.user_id && x.user_id.S === u) }));
    }
    if (op === "Query") {
      const v = b.ExpressionAttributeValues || {}, pk = (v[":p"] || v[":pk"] || v[":u"] || {}).S, pre = (v[":d"] || v[":e"] || {}).S || "";
      return new Response(JSON.stringify({ Items: [...db.values()].filter((x) => x.pk.S === pk && x.sk.S.startsWith(pre)) }));
    }
    return new Response("{}");
  }
  return new Response("{}");
};
// the real capacity-check rooms, one per device, with fake sockets that remember how they were closed
const rooms = new Map(), seen = [];
function room(name) {
  if (!rooms.has(name)) {
    const socks = [], store = new Map();
    const state = { getWebSockets: () => socks.filter((s) => !s.closed), acceptWebSocket: (s) => socks.push(s),
      storage: { get: async (k) => store.get(k), put: async (k, v) => store.set(k, v), delete: async (k) => store.delete(k), getAlarm: async () => 1, setAlarm: async () => {} } };
    rooms.set(name, { obj: new CapacityPolice(state, env), socks });
  }
  return rooms.get(name);
}
const sock = (sess) => { const s = { closed: null, att: { user: UID, device: "", sess }, deserializeAttachment() { return this.att; }, close(code, why) { this.closed = { code, why }; }, send() {} }; return s; };
const POLICE = { idFromName: (n) => n, get: (n) => ({ fetch: async (u, init) => { const r = typeof u === "string" ? new Request(u, init) : u; seen.push({ name: n, url: r.url, sess: r.headers.get("x-pc-sess") });
  if (new URL(r.url).pathname === "/api/police/ws") return new Response("upgraded", { status: 200 });
  return room(n).obj.fetch(r); } }) };
const env = { AWS_ACCESS_KEY_ID: "test-key-id", AWS_SECRET_ACCESS_KEY: "x", AWS_REGION: "us-east-1", DDB_PREFIX: "pctest-ai-", SESSION_SECRET: "test-secret", RESEND_API_KEY: "re_test", RESEND_FROM: "codes@example.com", POLICE };
const TA = "a".repeat(40), TB = "b".repeat(40);
async function call(path, token, init = {}) {
  const r = await W.fetch(new Request("https://planetcompute.ai" + path, { method: init.method || "POST", body: init.body, headers: { "content-type": "application/json", origin: "https://planetcompute.ai",
    cookie: token ? "pc_session=" + token : "", "user-agent": "Mozilla/5.0", ...(init.headers || {}) } }), env, { waitUntil() {}, passThroughOnException() {} });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// sessions: their table key is the site's own hash of the token (found by asking the site which one it reads)
async function hashOf(token) {
  // the site reads SESSION#<hash>: record what it asks for
  const before = new Set(db.keys()); let asked = "";
  const real = globalThis.fetch;
  globalThis.fetch = async (req, init = {}) => { const h = new Headers(init.headers || {}); if ((h.get("x-amz-target") || "").endsWith("GetItem")) { const b = JSON.parse(init.body); if (b.Key.pk.S.startsWith("SESSION#")) asked = b.Key.pk.S.slice(8); } return real(req, init); };
  await call("/api/me", token, { method: "GET" });
  globalThis.fetch = real; void before; return asked;
}
const hA = await hashOf(TA), hB = await hashOf(TB);
ok("the site hashes each sign-in's token (two different keys)", /^[0-9a-f]{64}$/.test(hA) && /^[0-9a-f]{64}$/.test(hB) && hA !== hB, [hA, hB]);
const far = Math.floor(Date.now() / 1000) + 86400;
put(`SESSION#${hA}`, "SESSION", { user_id: { S: UID }, expires_at: { N: String(far) }, browser: { S: "Chrome" } });
put(`SESSION#${hB}`, "SESSION", { user_id: { S: UID }, expires_at: { N: String(far) }, browser: { S: "planetCompute program" } });
put(`USER#${UID}`, "PROFILE", { user_id: { S: UID }, primary_email: { S: "owner@example.com" } });
for (const d of ["d00000000001", "d00000000002", "d00000000003"]) put(`USER#${UID}`, `DEVICE#${d}`, { device_id: { S: d } });

// 1. the socket carries its sign-in
let r = await call("/api/police/ws?device=d00000000001", TA, { method: "GET", headers: { upgrade: "websocket" } });
const up = seen.find((x) => x.url.includes("/api/police/ws"));
ok("1 the capacity-check socket is opened with the sign-in it belongs to (x-pc-sess)", up && up.sess === hA, up);

// sockets: device 1 = this browser (A); device 2 = the program (B); device 3 = another tab of A
const s1 = sock(hA), s2 = sock(hB), s3 = sock(hA);
room(`police:${UID}:d00000000001`).socks.push(s1); room(`police:${UID}:d00000000002`).socks.push(s2); room(`police:${UID}:d00000000003`).socks.push(s3);

// 2. signing out closes that sign-in's sockets on every device, and only those
r = await call("/api/auth/signout", TA, { body: "{}" });
ok("2 sign out: ok, the cookie is cleared, the sign-in is gone", r.status === 200 && !db.has(`SESSION#${hA}|SESSION`), r);
ok("3 its sockets on both devices are closed at once (code 4401 'signed out')", s1.closed && s1.closed.code === 4401 && s3.closed && s3.closed.code === 4401, [s1.closed, s3.closed]);
ok("4 the other sign-in's socket (the program) stays open", !s2.closed, s2.closed);
r = await call("/api/me", TA, { method: "GET" });
ok("5 afterwards /api/me says not signed in (401): what the page and the program ask", r.status === 401, r);

// 3. "Sign out everywhere else" closes the others' sockets too
put(`SESSION#${hA}`, "SESSION", { user_id: { S: UID }, expires_at: { N: String(far) }, browser: { S: "Chrome" } });
r = await call("/api/me/sessions/signout", TA, { body: JSON.stringify({ all_others: true }) });
ok("6 'Sign out everywhere else': the program's sign-in ends and its socket is closed", r.status === 200 && r.body.signed_out === 1 && s2.closed && s2.closed.code === 4401, [r, s2.closed]);

// 4. the pages' account script: one tab signs out, the other tab (and the program window around a page) follow
const home = await (await W.fetch(new Request("https://planetcompute.ai/"), env, { waitUntil() {}, passThroughOnException() {} })).text();
const acct = (home.match(/<script>(\(function \(\) \{\n  \/\/ The account button[\s\S]*?)<\/script>/) || [])[1];
ok("7 every page has the account script with the shared sign-in check", !!acct && acct.includes("BroadcastChannel(\"pc-auth\")") && acct.includes("pc-auth-changed"));
const channels = [];
function tab(signedIn, framed) {
  const L = {}, ls = {}, posted = [], refreshed = [];
  const parent = framed ? { postMessage: (m) => posted.push(m) } : null;
  const win = {
    addEventListener: (k, f) => { (L[k] = L[k] || []).push(f); }, dispatchEvent() {}, location: { origin: "https://planetcompute.ai", href: "https://planetcompute.ai/", reload() {} },
    innerWidth: 1000, document: { getElementById: () => null, documentElement: { classList: { add() {}, remove() {} }, style: { setProperty() {} } }, addEventListener: (k, f) => { (L["doc:" + k] = L["doc:" + k] || []).push(f); }, visibilityState: "visible" },
    localStorage: { setItem: (k, v) => { ls[k] = v; } }, CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
    fetch: async () => ({ ok: !!win.__me, status: win.__me ? 200 : 401, json: async () => win.__me }),
    BroadcastChannel: function () { this.postMessage = (m) => channels.filter((c) => c !== this).forEach((c) => c.onmessage && c.onmessage({ data: m })); channels.push(this); },
  };
  win.window = win; win.self = win; win.top = framed ? {} : win; win.parent = framed ? parent : win;
  win.__me = signedIn ? { user_id: UID, primary_email: "owner@example.com" } : null;
  vm.createContext(win); vm.runInContext(acct, win);
  win.pcAccount.hooks({ refresh: (p) => refreshed.push(p) });
  return { win, posted, refreshed, L };
}
const A = tab(true, false), B = tab(true, false), F = tab(true, true);
for (const t of [A, B, F]) t.win.pcAccount.set(t.win.__me);              // each page loads signed in
ok("8 loading a page signed in tells nobody (no messages)", !A.posted.length && !F.posted.length);
for (const t of [A, B, F]) t.win.__me = null;                            // the site now says: signed out (one source of truth)
A.win.pcAccount.set(null);                                               // tab A signs out
await new Promise((res) => setTimeout(res, 20));
ok("9 tab A signs out: tab B asks /api/me and is told 'signed out' (its console then stops)", B.refreshed.length === 1 && B.refreshed[0] === null, B.refreshed);
ok("10 a page inside the program's window follows too, and tells the program's window", F.refreshed.length === 1 && F.refreshed[0] === null, F.refreshed);
for (const t of [A, B, F]) t.win.__me = { user_id: UID, primary_email: "owner@example.com" };
F.win.pcAccount.set(F.win.__me);                                          // signed in inside the program window's page
await new Promise((res) => setTimeout(res, 20));
ok("11 signing in on one page: the others repaint as signed in (no stale 'Sign in' at the top right)", B.refreshed.at(-1) && B.refreshed.at(-1).user_id === UID && A.refreshed.at(-1) && A.refreshed.at(-1).user_id === UID, [A.refreshed, B.refreshed]);
ok("12 ... and the program's window around that page is told ('pc-auth-changed')", F.posted.includes("pc-auth-changed"), F.posted);
B.win.__me = null; B.win.document.visibilityState = "visible";
vm.runInContext("var __now = Date.now; Date.now = function () { return __now() + 5000; };", B.win);   // 5 s later
for (const f of B.L["doc:visibilitychange"] || []) f();
await new Promise((res) => setTimeout(res, 20));
ok("13 a tab coming back into view asks again (signed out elsewhere: it stops)", B.refreshed.at(-1) === null, B.refreshed.length);
const nB = B.refreshed.length; for (const f of B.L["doc:visibilitychange"] || []) f(); await new Promise((res) => setTimeout(res, 20));
ok("14 ... at most once in 3 seconds, and no repaint when nothing changed", B.refreshed.length === nB);
// the home page: the console stops when told signed out, the socket's close asks again
ok("15 home console: the refresh hook calls setMe (which stops sharing when signed out)", home.includes("refresh: function (p) { var was = me; setMe(p);") && home.includes("if (!me && running) stop();"));
ok("16 home console: the capacity-check socket closing makes it ask /api/me at once", home.includes("ws.onclose = function () { police.ws = null; if (me && window.pcAuthRecheck) window.pcAuthRecheck(true); }"));

// 5. the program's window (client/ui/index.html) and the program (Rust): text checks; the Rust is built and tested on RunPod
const prog = readFileSync(process.argv[3] || "client/ui/index.html", "utf8");
ok("17 program window: tells its website pages when its sign-in changes, and listens to them", prog.includes("function tellFrames(skip)") && prog.includes("postMessage('pc-auth-changed', '*')")
  && prog.includes("if (e.data !== 'pc-auth-changed' && e.data !== 'pc-signed-in') return;") && prog.includes("show('signin'); authIs('');"));
ok("18 program window: asks again when it comes into view; no polling every minute", prog.includes("document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') authRecheck(false); });") && !/setInterval\(\(\) => authRecheck/.test(prog));
let bad = 0;
for (const page of [home, prog]) for (const m of page.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)) { if (/\btype="module"/.test(m[0])) continue; try { new vm.Script(m[1]); } catch (e) { bad++; } }
ok("19 every inline script of the home page and the program page parses", bad === 0, bad);
const rs = readFileSync("client/src/contribute.rs", "utf8") + readFileSync("client/src/server.rs", "utf8");
ok("20 program (no window): sharing runs only while signed in; a sign-out stops the threads; a closed socket asks /api/me",
  rs.includes("self.settings.lock().unwrap().running && self.signed_in.load(SeqCst)") && rs.includes("e.set_signed_in(token.is_some());") && rs.includes("crate::server::check_signed_in(&st, &token).await;"));

console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
