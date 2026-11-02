// Sign-in codes (TESTING.md test 56; security review W4): guesses sent at the same moment cannot get past the 15-attempt (5 before 2026-11-02)
// limit, a code works once, and sign-in requests are limited per IP / network. The given worker.js in-process against
// the TEST tables (pctest-ai-*); e-mails are captured, not sent; the rate limiter runs in-process.
//   AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. node scripts/test_auth_codes.mjs website/worker.js
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"; import { randomBytes } from "node:crypto";
let src = readFileSync(process.argv[2], "utf8");
const swap = (o, n) => { if (!src.includes(o)) throw new Error("not found: " + o); src = src.replace(o, n); };   // never send real e-mail from a test
swap("async function sendCodeEmail(env, to, code, purpose, request) {", "async function sendCodeEmail(env, to, code, purpose, request) { (globalThis.__mails = globalThis.__mails || []).push({ to: [to], text: String(code) }); return;");
swap("async function sendEmail(env, { to, subject, text, html, replyTo }) {", "async function sendEmail(env, { to, subject, text, html, replyTo }) { (globalThis.__mails = globalThis.__mails || []).push({ to, subject, text }); return;");
src += "\nglobalThis.__G = { ddb, M, ContactGuard };\n";
const tmp = join(mkdtempSync(join(tmpdir(), "au-")), "w.mjs"); writeFileSync(tmp, src); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default, G = globalThis.__G, PREFIX = "pctest-ai-";
const store = new Map(), guard = new G.ContactGuard({ storage: { get: async (k) => structuredClone(store.get(k)), put: async (k, v) => { store.set(k, structuredClone(v)); },
  delete: async (k) => store.delete(k), list: async () => store, getAlarm: async () => 1, setAlarm: async () => {} } });
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, AWS_REGION: "us-east-1", DDB_PREFIX: PREFIX,
  SESSION_SECRET: "s".repeat(40), MAIL_FROM: "test@planetcompute.ai", CONTACT: { idFromName: (n) => n, get: () => ({ fetch: (u, i) => guard.fetch(new Request(u, i)) }) } };
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
let ipN = 0;
const call = (path, body, ip) => W.fetch(new Request("https://planetcompute.ai" + path, { method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", origin: "https://planetcompute.ai", "cf-connecting-ip": ip || `198.51.${100 + (ipN++ % 50)}.${(ipN % 250) + 1}` } }), env)
  .then(async (r) => ({ s: r.status, j: await r.json().catch(() => ({})) }));
const codeFor = (email) => { const m = [...(globalThis.__mails || [])].reverse().find((x) => x.to[0] === email); return m && (m.text.match(/\b(\d{6})\b/) || [])[1]; };
const email = "auth-test-" + randomBytes(4).toString("hex") + "@example.com";
let r = await call("/api/auth/start", { email });
const code = codeFor(email);
ok("1 a code is sent", r.s === 200 && /^\d{6}$/.test(code || ""), { r, code });
const wrong = String((Number(code) + 1) % 1000000).padStart(6, "0");
const rs = await Promise.all(Array.from({ length: 20 }, () => call("/api/auth/verify", { email, code: wrong })));
const notRight = rs.filter((x) => /not right/.test(x.j.error || "")).length, tooMany = rs.filter((x) => /Too many wrong codes/.test(x.j.error || "")).length;
ok(`2 20 wrong guesses at the same moment: exactly 15 were counted as guesses (${notRight}), the other 5 refused as too many (${tooMany})`, notRight === 15 && tooMany === 5, { notRight, tooMany });
r = await call("/api/auth/verify", { email, code });
ok("3 after that even the right code is refused (the code is void)", r.s === 401 && /Too many wrong codes/.test(r.j.error), r);
const email2 = "auth-test-" + randomBytes(4).toString("hex") + "@example.com";
await call("/api/auth/start", { email: email2 }); const code2 = codeFor(email2);
const both = await Promise.all([call("/api/auth/verify", { email: email2, code: code2 }), call("/api/auth/verify", { email: email2, code: code2 })]);
ok("4 the right code sent twice at the same moment signs in once; the other is refused", both.filter((x) => x.s === 200).length === 1 && both.filter((x) => x.s === 401).length === 1, both.map((x) => [x.s, x.j.error]));
r = await call("/api/auth/verify", { email: email2, code: code2 });
ok("5 the same code again later: refused", r.s === 401, r);
const fromOne = []; for (let i = 0; i < 22; i++) fromOne.push(await call("/api/auth/verify", { email: "nobody-" + i + "@example.com", code: "123456" }, "203.0.113.7"));
ok("6 more than 20 sign-in guesses from one IP in 10 minutes: refused with 429 (the first 20 are answered)", fromOne.slice(0, 20).every((x) => x.s === 401) && fromOne.slice(20).every((x) => x.s === 429), fromOne.map((x) => x.s).join(","));
const starts = []; for (let i = 0; i < 12; i++) starts.push(await call("/api/auth/start", { email: `many-${i}-${randomBytes(3).toString("hex")}@example.com` }, "203.0.113.9"));
ok("7 asking for codes for many NEW addresses from one IP: more than 3 a day refused (429; AUTH_LIMITS newacct, was 10 per 10 minutes before)", starts.slice(0, 3).every((x) => x.s === 200) && starts.slice(3).every((x) => x.s === 429), starts.map((x) => x.s).join(","));
// clean up the OTP items made here
for (const m of globalThis.__mails || []) await G.ddb(env, "DeleteItem", { TableName: PREFIX + "user", Key: G.M({ pk: `OTP#signin#${m.to[0]}`, sk: "OTP" }) }).catch(() => {});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
