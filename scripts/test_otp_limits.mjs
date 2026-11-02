// TESTING.md test 108 (user 2026-11-02, noGuessingOTPcode.txt): a code stops working after 15 wrong tries; 15 wrong codes
// in a UTC day lock the address until the next day; 50 wrong codes in 30 days lock it; a right code is not counted as
// wrong; guesses sent at the same moment cannot pass the limits together. The given worker.js in-process against the
// TEST tables (pctest-ai-*); e-mails are captured, not sent; the rate limiter (ContactGuard) runs in-process.
//   AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. node scripts/test_otp_limits.mjs website/worker.js
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"; import { randomBytes } from "node:crypto";
let src = readFileSync(process.argv[2], "utf8");
const swap = (o, n) => { if (!src.includes(o)) throw new Error("not found: " + o); src = src.replace(o, n); };
swap("async function sendCodeEmail(env, to, code, purpose, request) {", "async function sendCodeEmail(env, to, code, purpose, request) { (globalThis.__mails = globalThis.__mails || []).push({ to: [to], text: String(code) }); return;");
swap("async function sendEmail(env, { to, subject, text, html, replyTo }) {", "async function sendEmail(env, { to, subject, text, html, replyTo }) { (globalThis.__mails = globalThis.__mails || []).push({ to, subject, text }); return;");
src += "\nglobalThis.__G = { ddb, M, getItem, ContactGuard, OTP_FAIL_PERIOD: typeof OTP_FAIL_PERIOD === 'undefined' ? 2592000 : OTP_FAIL_PERIOD };\n";
const tmp = join(mkdtempSync(join(tmpdir(), "ol-")), "w.mjs"); writeFileSync(tmp, src); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default, G = globalThis.__G, PREFIX = "pctest-ai-", T = PREFIX + "user";
const store = new Map(), guard = new G.ContactGuard({ storage: { get: async (k) => structuredClone(store.get(k)), put: async (k, v) => { store.set(k, structuredClone(v)); },
  delete: async (k) => store.delete(k), list: async () => store, getAlarm: async () => 1, setAlarm: async () => {} } });
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, AWS_REGION: "us-east-1", DDB_PREFIX: PREFIX,
  SESSION_SECRET: "s".repeat(40), MAIL_FROM: "test@planetcompute.ai", CONTACT: { idFromName: (n) => n, get: () => ({ fetch: (u, i) => guard.fetch(new Request(u, i)) }) } };
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
let ipN = 0;   // a new IP for every request, so only the per-address limits are tested here
const call = (path, body) => W.fetch(new Request("https://planetcompute.ai" + path, { method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", origin: "https://planetcompute.ai", "cf-connecting-ip": `${11 + (++ipN % 180)}.${(ipN * 37) % 250}.${(ipN * 11) % 250}.${(ipN % 250) + 1}` } }), env)
  .then(async (r) => ({ s: r.status, j: await r.json().catch(() => ({})) }));
const codeFor = (email) => { const m = [...(globalThis.__mails || [])].reverse().find((x) => x.to[0] === email); return m && (m.text.match(/\b(\d{6})\b/) || [])[1]; };
const fresh = (tag) => `otplim-${tag}-${randomBytes(4).toString("hex")}@example.com`;
const wrongOf = (c) => String((Number(c) + 1) % 1000000).padStart(6, "0");
const now = () => Math.floor(Date.now() / 1000), day = () => Math.floor(now() / 86400), bucket = () => Math.floor(now() / G.OTP_FAIL_PERIOD);
const dayN = async (e) => Number(((await G.getItem(env, `OTPFAIL#${e}#${day()}`, "OTPFAIL")) || {}).n || 0);
const used = [];
async function newCode(tag) { const e = fresh(tag); used.push(e); const r = await call("/api/auth/start", { email: e }); return { e, r, c: codeFor(e) }; }

// 1 a code takes 15 wrong tries, the 16th is refused; then even the right code is refused; no new code today
let { e, r, c } = await newCode("seq");
ok("1a a code is sent", r.s === 200 && /^\d{6}$/.test(c || ""), r);
const seq = []; for (let i = 0; i < 16; i++) seq.push(await call("/api/auth/verify", { email: e, code: wrongOf(c) }));
ok("1b 15 wrong tries are answered 'not right'", seq.slice(0, 15).every((x) => x.s === 401 && /not right/.test(x.j.error)), seq.slice(0, 15).map((x) => x.j.error));
ok("1c the 16th is refused as too many", seq[15].s === 401 && /Too many wrong codes/.test(seq[15].j.error), seq[15]);
r = await call("/api/auth/verify", { email: e, code: c });
ok("1d after that the right code is refused too", r.s === 401 && /Too many wrong codes/.test(r.j.error), r);
r = await call("/api/auth/start", { email: e });
ok("1e no new code for that address today (429, until tomorrow)", r.s === 429 && /today/.test(r.j.error), r);
ok("1f the day counter stopped at 15", (await dayN(e)) === 15, await dayN(e));

// 2 30 wrong guesses at the same moment: exactly 15 are counted
({ e, c } = await newCode("burst"));
const burst = await Promise.all(Array.from({ length: 30 }, () => call("/api/auth/verify", { email: e, code: wrongOf(c) })));
const nr = burst.filter((x) => /not right/.test(x.j.error || "")).length, tm = burst.filter((x) => /Too many wrong codes/.test(x.j.error || "")).length;
ok(`2 30 at the same moment: exactly 15 counted (${nr}), 15 refused (${tm})`, nr === 15 && tm === 15, { nr, tm });
ok("2b the day counter is exactly 15", (await dayN(e)) === 15, await dayN(e));

// 3 the 30-day limit: 40 wrong codes in the previous 30-day bucket, so 10 more are allowed now
e = fresh("d30"); used.push(e);
await G.ddb(env, "PutItem", { TableName: T, Item: G.M({ pk: `OTPFAIL30#${e}#${bucket() - 1}`, sk: "OTPFAIL30", n: 40, ttl: now() + 86400 }) });
r = await call("/api/auth/start", { email: e }); c = codeFor(e);
ok("3a with 40 of 50 used a code is still sent", r.s === 200, r);
const d30 = []; for (let i = 0; i < 11; i++) d30.push(await call("/api/auth/verify", { email: e, code: wrongOf(c) }));
ok("3b 10 more wrong tries are answered", d30.slice(0, 10).every((x) => /not right/.test(x.j.error || "")), d30.map((x) => x.j.error));
ok("3c the 11th is refused: 30 days", /30 days/.test(d30[10].j.error || ""), d30[10]);
r = await call("/api/auth/start", { email: e });
ok("3d no new code (429, 30 days)", r.s === 429 && /30 days/.test(r.j.error), r);

// 4 a right code is not counted as wrong; the sign-in works
({ e, c } = await newCode("right"));
for (let i = 0; i < 3; i++) await call("/api/auth/verify", { email: e, code: wrongOf(c) });
r = await call("/api/auth/verify", { email: e, code: c });
ok("4a 3 wrong then the right code signs in", r.s === 200, r);
const n30 = Number(((await G.getItem(env, `OTPFAIL30#${e}#${bucket()}`, "OTPFAIL30")) || {}).n || 0);
ok("4b counters show 3 wrong (day and 30 days), not 4", (await dayN(e)) === 3 && n30 === 3, { day: await dayN(e), n30 });

// clean up what was made here
for (const x of used) {
  for (const k of [[`OTP#signin#${x}`, "OTP"], [`OTPFAIL#${x}#${day()}`, "OTPFAIL"], [`OTPFAIL30#${x}#${bucket()}`, "OTPFAIL30"], [`OTPFAIL30#${x}#${bucket() - 1}`, "OTPFAIL30"],
    [`OTPREQ#${x}`, "OTPREQ"], [`NEWOK#${x}`, "NEWOK"]])
    await G.ddb(env, "DeleteItem", { TableName: T, Key: G.M({ pk: k[0], sk: k[1] }) }).catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
