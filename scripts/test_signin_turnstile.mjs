// docs/TESTING.md test 101: Cloudflare Turnstile on sign-in code requests (POST /api/auth/start, website/worker.js).
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
  db.forEach((v, k) => { if (k.startsWith("OTP#")) db.delete(k); });    // a fresh code window for every case
  const body = JSON.stringify(turnstile ? { email, turnstile } : { email });
  const req = new Request("https://planetcompute.ai/api/auth/start", { method: "POST", body,
    headers: { "content-type": "application/json", "user-agent": ua, origin: "https://planetcompute.ai", "cf-connecting-ip": "203.0.113." + (++n) } });
  const r = await W.fetch(req, env, { waitUntil() {}, passThroughOnException() {} });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

let r = await start("owner@example.com", BROWSER);
ok("existing account, browser, no check: asked for the check (428 need_turnstile)", r.status === 428 && r.body.need_turnstile === true && r.body.sitekey === "ts-sitekey", r);
ok("... and no code was sent", mails.length === 0, mails.length);
r = await start("owner@example.com", BROWSER, "bad-token");
ok("existing account, browser, failing check: refused", r.status === 428 && /did not pass/.test(r.body.error || ""), r);
r = await start("owner@example.com", BROWSER, "good-token");
ok("existing account, browser, passing check: code sent", r.status === 200 && r.body.ok === true && mails.length === 1, r);
ok("the code email says who asked (IP address, browser)", mails.length === 1 && /Requested from IP address 203\.0\.113\.\d+, using Chrome on Windows/.test(mails[0].text), mails[0] && mails[0].text);
r = await start("owner@example.com", PROGRAM);
ok("existing account, the planetCompute program, no check: code sent (its window cannot show the check)", r.status === 200 && mails.length === 2, r);
ok("the program's code email names the program", /using the planetCompute program/.test(mails[1] && mails[1].text || ""), mails[1] && mails[1].text);
r = await start("newperson@example.com", BROWSER);
ok("new account, browser, no check: asked for the check", r.status === 428 && r.body.need_turnstile === true && /New account/.test(r.body.error), r);
r = await start("newperson@example.com", PROGRAM);
ok("new account, the program: still sent to the website for the check (as before)", r.status === 428 && r.body.need_turnstile === true, r);
r = await start("newperson@example.com", BROWSER, "good-token");
ok("new account, browser, passing check: code sent", r.status === 200 && mails.length === 3, r);

console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
