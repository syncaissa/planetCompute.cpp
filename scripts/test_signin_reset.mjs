// docs/TESTING.md test 103: a successful sign-in resets the counters (website/worker.js authReset, otpDayCheck).
// In-process: the site's real rate limiter (ContactGuard) on fake storage, a fake DynamoDB and a fake email service.
//   node scripts/test_signin_reset.mjs website/worker.js
// Checks: one network asking for more than 10 codes in 10 minutes is refused ("too many sign-in attempts from your
// network"); after a successful sign-in from that network it can ask again; the per-address daily counter (10, then a
// 24-hour hold) starts again after a successful sign-in, so 30 sign-ins in a row never hold the address; the signed
// operator clear refuses a wrong signature and clears every network's counters with the right one.
import { createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = await import(pathToFileURL(resolve(process.argv[2] || "website/worker.js")).href);
const W = mod.default, ContactGuard = mod.ContactGuard;
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n, x === undefined ? "" : JSON.stringify(x).slice(0, 300)); } };

const db = new Map(), mails = [];
db.set("EMAIL#owner@example.com|EMAIL", { pk: { S: "EMAIL#owner@example.com" }, sk: { S: "EMAIL" }, user_id: { S: "0123456789ab" } });
db.set("USER#0123456789ab|PROFILE", { pk: { S: "USER#0123456789ab" }, sk: { S: "PROFILE" }, user_id: { S: "0123456789ab" }, primary_email: { S: "owner@example.com" } });
globalThis.fetch = async (req, init = {}) => {
  const url = typeof req === "string" ? req : req.url, h = new Headers(init.headers || {}), t = h.get("x-amz-target") || "";
  if (t.startsWith("DynamoDB_")) {
    const op = t.split(".")[1], b = JSON.parse(init.body), k = (x) => x.pk.S + "|" + x.sk.S;
    if (op === "GetItem") { const it = db.get(k(b.Key)); return new Response(JSON.stringify(it ? { Item: it } : {})); }
    if (op === "PutItem") { db.set(k(b.Item), b.Item); return new Response("{}"); }
    if (op === "DeleteItem") { db.delete(k(b.Key)); return new Response("{}"); }
    if (op === "Query") return new Response(JSON.stringify({ Items: [] }));
    return new Response("{}");
  }
  if (url.includes("api.resend.com")) { mails.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: "m" })); }
  return new Response("{}");
};
// the real ContactGuard on fake Durable Object storage
const store = new Map();
const guard = new ContactGuard({ storage: { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, v); }, delete: async (k) => store.delete(k),
  list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix))), getAlarm: async () => 1, setAlarm: async () => {} } });
const CONTACT = { idFromName: (n) => n, get: () => ({ fetch: (u, init) => guard.fetch(new Request(u, init)) }) };
const env = { AWS_ACCESS_KEY_ID: "test-key-id", AWS_SECRET_ACCESS_KEY: "x", AWS_REGION: "us-east-1", DDB_PREFIX: "pctest-ai-",
  SESSION_SECRET: "test-secret", RESEND_API_KEY: "re_test", RESEND_FROM: "codes@example.com", CONTACT, HB_SERVER_SECRET: "hb-test-secret" };
const PROGRAM = "planetCompute/0.1.0+5047691.1793541417";        // the program path: no Turnstile, so the limits are what is tested
const realNow = Date.now; let shift = 0; Date.now = () => realNow() + shift;
async function call(path, body, ip = "198.51.100.7", headers = {}) {
  const r = await W.fetch(new Request("https://planetcompute.ai" + path, { method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", "user-agent": PROGRAM, origin: "https://planetcompute.ai", "cf-connecting-ip": ip, ...headers } }), env, { waitUntil() {}, passThroughOnException() {} });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const lastCode = () => { const m = (mails[mails.length - 1] || {}).text || ""; return (m.match(/code is (\d{6})/) || [])[1]; };
async function signIn(ip) {
  shift += 31000;                                                   // past the 30-second gap between two codes
  const s = await call("/api/auth/start", { email: "owner@example.com" }, ip);
  if (s.status !== 200) return { stage: "start", ...s };
  const v = await call("/api/auth/verify", { email: "owner@example.com", code: lastCode() }, ip);
  return { stage: "verify", ...v };
}

// 1. a network asking for too many codes is refused; a successful sign-in from it resets that
let refused = null;
for (let i = 0; i < 12; i++) { shift += 31000; const r = await call("/api/auth/start", { email: "x" + i + "@example.com" }); if (r.status === 429) { refused = r; break; } }
ok("one network asking for more than 10 codes in 10 minutes is refused", refused && /from your network/.test(refused.body.error || ""), refused);
store.clear();                                                      // (the test's own requests above: start clean)
db.forEach((v, k) => { if (k.startsWith("OTP")) db.delete(k); });
for (let i = 0; i < 9; i++) { shift += 31000; await call("/api/auth/start", { email: "y" + i + "@example.com" }); }
let r = await signIn();
ok("a successful sign-in on the 10th request of the window", r.stage === "verify" && r.status === 200, r);
let after = []; for (let i = 0; i < 5; i++) { shift += 31000; after.push((await call("/api/auth/start", { email: "z" + i + "@example.com" })).body.error || "ok"); }
ok("after it, the same network can ask again: no 'sign-in attempts from your network' refusal (its counters were reset)", after.every((e) => !/sign-in attempts from your network/.test(e)), after);

// 2. thirty sign-ins in a row (testing) never hold the address and never lock the network
store.clear(); db.forEach((v, k) => { if (k.startsWith("OTP")) db.delete(k); });
const results = [];
for (let i = 0; i < 30; i++) { shift += 13 * 60 * 1000; results.push(await signIn()); }   // spread over the hours, like a day of testing
ok("30 sign-ins in a row all succeed (no network lock, no daily hold)", results.every((x) => x.stage === "verify" && x.status === 200), results.filter((x) => x.status !== 200).slice(0, 2));
ok("no 'on hold' email was sent", !mails.some((m) => /on hold/.test(m.subject)), mails.filter((m) => /on hold/.test(m.subject)).length);

// 3. without signing in, the daily hold still works (11th request)
store.clear(); db.forEach((v, k) => { if (k.startsWith("OTP")) db.delete(k); });
let held = null;
for (let i = 0; i < 11; i++) { shift += 61 * 60 * 1000; const x = await call("/api/auth/start", { email: "owner@example.com" }, "198.51.100." + (20 + i)); if (/on hold/.test(x.body.error || "")) { held = { i: i + 1, ...x }; break; } }
ok("without a sign-in, the 11th request still starts the 24-hour hold", held && held.i === 11, held);

// 4. the signed operator clear
store.set("k:start:ip:203.0.113.9", [Date.now() / 1000]); store.set("k:start:all", [Date.now() / 1000]);
r = await call("/api/ops/auth-reset", {}, "198.51.100.99", { "x-pc-ops": "00" });
ok("operator clear with a wrong signature: refused (403)", r.status === 403 && store.has("k:start:ip:203.0.113.9"), r);
const sig = createHmac("sha256", "hb-test-secret").update(`pc-ops|auth-reset|${Math.floor(Date.now() / 60000)}`).digest("hex");
r = await call("/api/ops/auth-reset", {}, "198.51.100.99", { "x-pc-ops": sig });
ok("operator clear with the right signature: every network's counters cleared, the site-wide one kept", r.status === 200 && !store.has("k:start:ip:203.0.113.9") && store.has("k:start:all"), r);

console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
