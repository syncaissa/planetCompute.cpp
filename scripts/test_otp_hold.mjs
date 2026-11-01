// docs/TESTING.md test 102: more than 10 code requests for one address in 24 hours put it on hold for 24 hours, with one
// email (website/worker.js otpDayCheck). Based on test_signin_turnstile.mjs (same fakes).
// In-process with a fake DynamoDB, a fake rate limiter (ContactGuard), a fake Turnstile siteverify and a fake email
// service: nothing real is touched.   node scripts/test_signin_turnstile.mjs website/worker.js
// Checks: an existing account asked from a browser needs the check (428 need_turnstile) and gets a code only with a
// passing token; a failing token is refused; the planetCompute program (its user agent) still gets a code without the
// check (its window cannot show it); a new account needs the check from a browser and from the program, as before; the
// code email says who asked (IP address, place, browser or program).
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const W = (await import(pathToFileURL(resolve(process.argv[2] || "website/worker.js")).href)).default;
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n, x === undefined ? "" : JSON.stringify(x).slice(0, 300)); } };

const db = new Map(), mails = [];
db.set("EMAIL#owner@example.com|EMAIL", { pk: { S: "EMAIL#owner@example.com" }, sk: { S: "EMAIL" }, user_id: { S: "0123456789ab" } });
globalThis.fetch = async (req, init = {}) => {
  const url = typeof req === "string" ? req : req.url, h = new Headers(init.headers || {}), t = h.get("x-amz-target") || "";
  if (t.startsWith("DynamoDB_")) {
    const op = t.split(".")[1], b = JSON.parse(init.body);
    if (op === "GetItem") { const it = db.get(b.Key.pk.S + "|" + b.Key.sk.S); return new Response(JSON.stringify(it ? { Item: it } : {})); }
    if (op === "PutItem") { db.set(b.Item.pk.S + "|" + b.Item.sk.S, b.Item); return new Response("{}"); }
    return new Response("{}");
  }
  if (url.includes("turnstile/v0/siteverify")) { const token = init.body.get("response"); return new Response(JSON.stringify({ success: token === "good-token" })); }
  if (url.includes("api.resend.com")) { mails.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: "m" })); }
  return new Response("{}");
};
const guard = { idFromName: (n) => n, get: () => ({ fetch: async () => Response.json({ ok: true }) }) };
const env = { AWS_ACCESS_KEY_ID: "test-key-id", AWS_SECRET_ACCESS_KEY: "x", AWS_REGION: "us-east-1", DDB_PREFIX: "pctest-ai-",
  SESSION_SECRET: "test-secret", RESEND_API_KEY: "re_test", RESEND_FROM: "PlanetCompute <codes@example.com>",
  TURNSTILE_SECRET: "ts-secret", TURNSTILE_SITEKEY: "ts-sitekey", CONTACT: guard };
const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const PROGRAM = "planetCompute/0.1.0+5047691.1793541417";
let n = 0;
async function start(email, ua, turnstile) {
  const body = JSON.stringify(turnstile ? { email, turnstile } : { email });
  const req = new Request("https://planetcompute.ai/api/auth/start", { method: "POST", body,
    headers: { "content-type": "application/json", "user-agent": ua, origin: "https://planetcompute.ai", "cf-connecting-ip": "203.0.113." + (++n) } });
  const r = await W.fetch(req, env, { waitUntil() {}, passThroughOnException() {} });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const realNow = Date.now; let shift = 0; Date.now = () => realNow() + shift;
const T0 = Date.now();
const codesSent = () => mails.filter((m) => /is your PlanetCompute code/.test(m.subject)).length;
const holdMails = () => mails.filter((m) => /on hold/.test(m.subject));
const results = [];
for (let i = 1; i <= 15; i++) { shift += 61000; results.push(await start("owner@example.com", PROGRAM)); }   // a minute apart
ok("requests 1-10 are not held (codes sent while the hourly limit allows)", results.slice(0, 10).every((r) => !/on hold/.test(r.body.error || "")) && codesSent() >= 1, results.slice(0, 25).map((r) => r.status));
ok("the 11th request puts the address on hold (429, 'on hold until ...')", results[10].status === 429 && /on hold until \d{8}:\d{6} Greenwich time/.test(results[10].body.error || ""), results[10]);
ok("requests 12-15 are refused as on hold", results.slice(11).every((r) => r.status === 429 && /on hold/.test(r.body.error || "")), results.slice(26).map((r) => r.body.error));
ok("exactly ONE hold email was sent", holdMails().length === 1, holdMails().length);
const hm = holdMails()[0] || {}, started = new Date(T0 + 11 * 61000).toISOString();
const stamp = started.slice(0, 10).replace(/-/g, "") + ":" + started.slice(11, 19).replace(/:/g, "");
ok("the hold email says: Your account is on hold for 24 hours starting YYYYMMDD:HHMMSS Greenwich time; please try later",
  (hm.text || "").startsWith("Your account is on hold for 24 hours starting ") && / Greenwich time; please try later\./.test(hm.text || "") && (hm.text || "").includes(stamp.slice(0, 13)), [hm.text && hm.text.slice(0, 120), stamp]);
ok("no code was sent during the hold", codesSent() === results.slice(0, 10).filter((r) => r.status === 200).length, [codesSent(), results.filter((r) => r.status === 200).length]);
shift += 23 * 3600 * 1000;
let r = await start("owner@example.com", PROGRAM);
ok("23 hours later: still on hold", r.status === 429 && /on hold/.test(r.body.error || ""), r);
shift += 3600 * 1000 + 60000;
r = await start("owner@example.com", PROGRAM);
ok("after 24 hours: a code is sent again", r.status === 200 && r.body.ok === true, r);
ok("still only ONE hold email in total", holdMails().length === 1, holdMails().length);
r = await start("other@example.com", PROGRAM);
ok("another address is not affected", r.status === 428 || r.status === 200, r);

console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
