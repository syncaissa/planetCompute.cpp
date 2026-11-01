// Test of "Report Bugs" (TESTING.md test 13): runs the website Worker's own code in Node against two throwaway
// DynamoDB tables, <prefix>user and <prefix>bugs-reported (default prefix pctest-ai-, created beforehand, deleted after).
// The Durable Object that counts the limits runs in memory; no email is sent (CONTACT_DRY_RUN); Turnstile is off.
//   node scripts/test_bug_reports.mjs <path to worker.js>
// AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION come from the environment.
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";

const src = resolve(process.argv[2] || "website/worker.js");
const tmp = join(mkdtempSync(join(tmpdir(), "pcbug-")), "worker.mjs");
copyFileSync(src, tmp);
const mod = await import(tmp);
const worker = mod.default;

class MemStorage {                                        // enough of the Durable Object storage API for ContactGuard
  constructor() { this.m = new Map(); this.alarm = null; }
  async get(k) { return this.m.get(k); }
  async put(k, v) { this.m.set(k, v); }
  async delete(k) { this.m.delete(k); }
  async list() { return new Map(this.m); }
  async getAlarm() { return this.alarm; }
  async setAlarm(t) { this.alarm = t; }
}
const guards = new Map();
const CONTACT = {
  idFromName: (n) => n,
  get: (n) => { if (!guards.has(n)) guards.set(n, new mod.ContactGuard({ storage: new MemStorage() }));
    const g = guards.get(n); return { fetch: (u, init) => g.fetch(new Request(u, init)) }; },
};
const PREFIX = process.env.DDB_PREFIX || "pctest-ai-";
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_REGION: process.env.AWS_REGION || "us-east-1", DDB_PREFIX: PREFIX, SESSION_SECRET: "test-" + randomBytes(8).toString("hex"),
  ADMIN_EMAILS: "", CONTACT_DRY_RUN: "1", MAIL_FROM: "test@planetcompute.ai", CONTACT };

async function rawDdb(op, payload) {                      // SigV4 by hand, as the Worker does
  const region = env.AWS_REGION, host = `dynamodb.${region}.amazonaws.com`, body = JSON.stringify(payload);
  const t = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""), d = t.slice(0, 8);
  const h = (x) => createHash("sha256").update(x).digest("hex");
  const hmac = (k, x) => createHmac("sha256", k).update(x).digest();
  const headers = { "content-type": "application/x-amz-json-1.0", host, "x-amz-date": t, "x-amz-target": "DynamoDB_20120810." + op };
  const names = Object.keys(headers).sort();
  const creq = ["POST", "/", "", names.map((n) => `${n}:${headers[n]}`).join("\n") + "\n", names.join(";"), h(body)].join("\n");
  const scope = `${d}/${region}/dynamodb/aws4_request`;
  const sts = ["AWS4-HMAC-SHA256", t, scope, h(creq)].join("\n");
  let k = hmac("AWS4" + env.AWS_SECRET_ACCESS_KEY, d); k = hmac(k, region); k = hmac(k, "dynamodb"); k = hmac(k, "aws4_request");
  const sig = hmac(k, sts).toString("hex");
  const r = await fetch(`https://${host}/`, { method: "POST", body, headers: { ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}` } });
  const j = await r.json();
  if (!r.ok) throw new Error(op + ": " + JSON.stringify(j));
  return j;
}

const S = (v) => ({ S: String(v) });
const ADMIN = "a1a1a1a1a1a1", USER = "b2b2b2b2b2b2";
async function seedUser(id, email, admin) {
  await rawDdb("PutItem", { TableName: PREFIX + "user", Item: { pk: S(`USER#${id}`), sk: S("PROFILE"), user_id: S(id), primary_email: S(email),
    first_name: S(admin ? "Ada" : "Bob"), last_name: S("Tester"), created_at: S(new Date().toISOString()), ...(admin ? { IsAdmin: { BOOL: true } } : {}) } });
  await rawDdb("PutItem", { TableName: PREFIX + "user", Item: { pk: S(`USER#${id}`), sk: S(`EMAIL#${email}`), user_id: S(id), email: S(email) } });
  await rawDdb("PutItem", { TableName: PREFIX + "user", Item: { pk: S(`EMAIL#${email}`), sk: S("EMAIL"), user_id: S(id) } });
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(`${env.SESSION_SECRET}|session|${token}`).digest("hex");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  await rawDdb("PutItem", { TableName: PREFIX + "user", Item: { pk: S(`SESSION#${hash}`), sk: S("SESSION"), user_id: S(id), expires_at: { N: String(exp) } } });
  return token;
}

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra === undefined ? "" : JSON.stringify(extra).slice(0, 300)); } };
let ipN = 10;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = (over = {}) => ({ area: "Website", severity: "Annoying", subject: "The console stops after a while",
  description: "I pressed Start, and after about five minutes the console stopped by itself.", email: "someone@gmail.com", name: "Some One",
  page: "/", screen: "1440x900 @2", ...over });

const adminTok = await seedUser(ADMIN, "admin-test@planetcompute.ai", true);
const userTok = await seedUser(USER, "bob-test@planetcompute.ai", false);
// the cookie name the Worker reads
const cookieName = (await import("node:fs")).readFileSync(src, "utf8").match(/const COOKIE = "([^"]+)"/)[1];
async function api(path, o = {}) {
  const headers = { "cf-connecting-ip": o.ip || "203.0.113." + ipN, origin: "https://planetcompute.ai" };
  if (o.body || o.raw) headers["content-type"] = "application/json";
  if (o.cookie) headers.cookie = cookieName + "=" + o.cookie;
  const raw = o.raw != null ? o.raw : o.body ? JSON.stringify(o.body) : undefined;
  const r = await worker.fetch(new Request("https://planetcompute.ai" + path, { method: o.body || o.raw ? "POST" : "GET", headers, body: raw }), env);
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, d };
}
const tok = async () => (await api("/api/contact/token")).d.token;

// 1. a report from someone signed out
let t1 = await tok(); await wait(3100);
let r = await api("/api/bugs", { body: report({ token: t1 }) });
ok("1 signed-out report saved", r.status === 200 && /^[0-9a-f]{10}$/.test(r.d.bug_id), r);
const anonId = r.d.bug_id;
// 2. the same form token again
r = await api("/api/bugs", { body: report({ token: t1 }) });
ok("2 a form token works once", r.status === 400 && /already sent/.test(r.d.error), r);
// 3. too quick
ipN++; r = await api("/api/bugs", { body: report({ token: await tok() }) });
ok("3 sent under 3 s refused", r.status === 400 && /quick/.test(r.d.error), r);
// 4. checks on the fields
let t = await tok(); await wait(3100);
r = await api("/api/bugs", { body: report({ token: t, email: "" }) });
ok("4a signed out without email refused", r.status === 400 && /email/.test(r.d.error), r);
r = await api("/api/bugs", { body: report({ token: t, description: "too short" }) });
ok("4b short description refused", r.status === 400 && /describe/.test(r.d.error), r);
r = await api("/api/bugs", { body: report({ token: t, subject: "bug" }) });
ok("4c short title refused", r.status === 400 && /title/.test(r.d.error), r);
r = await api("/api/bugs", { body: report({ token: t, email: "x@mailinator.com" }) });
ok("4d disposable email refused", r.status === 400 && /permanent/.test(r.d.error), r);
r = await api("/api/bugs", { body: report({ token: t, email: "x@no-such-domain-pc-test-1234.com" }) });
ok("4e email domain without mail refused", r.status === 400 && /cannot receive/.test(r.d.error), r);
r = await api("/api/bugs", { body: report({ token: "1.2.3" }) });
ok("4f bad token refused", r.status === 400 && /reload/.test(r.d.error), r);
// 5. the honeypot: looks fine, nothing saved
r = await api("/api/bugs", { body: report({ token: t, website: "http://spam.example" }) });
ok("5 honeypot answers ok, saves nothing", r.status === 200 && r.d.bug_id === "0000000000", r);
// 6. signed in: the account is recorded, no email needed
ipN++; t = await tok(); await wait(3100);
r = await api("/api/bugs", { body: report({ token: t, email: "", name: "", description: "x".repeat(4000) }), cookie: userTok });
ok("6 signed-in report saved (4,000 characters)", r.status === 200 && r.d.bug_id, r);
const userBug = r.d.bug_id;
// 7. limits per IP address: 2 a minute
ipN++; const ipX = "198.51.100.7"; let codes = [];
for (let i = 0; i < 3; i++) { t = await tok(); await wait(3100); codes.push((await api("/api/bugs", { body: report({ token: t, email: `p${i}@gmail.com` }), ip: ipX })).status); }
ok("7 third report in a minute from one IP refused (429)", codes.join() === "200,200,429", codes);
// 8. limits per network (/24): another address in the same /24
t = await tok(); await wait(3100);
r = await api("/api/bugs", { body: report({ token: t, email: "q@gmail.com" }), ip: "198.51.100.99" });
ok("8 same /24 network is counted too", r.status === 429, r);
// 9. limits per account: two from the user on new addresses, then the third refused
codes = [];
for (let i = 0; i < 2; i++) { t = await tok(); await wait(3100); codes.push((await api("/api/bugs", { body: report({ token: t, email: "" }), cookie: userTok, ip: `192.0.2.${60 + i}` })).status); }
ok("9 per-account limit (1 earlier + 1 ok, then 429)", codes.join() === "200,429", codes);
// 10. too large a body
r = await api("/api/bugs", { raw: JSON.stringify(report({ description: "y".repeat(25000) })) });
ok("10 body over 20,000 characters refused (413)", r.status === 413, r.status);
// 11. admin pages: only for admins
r = await api("/api/admin/bugs");
ok("11a signed out: 401", r.status === 401, r.status);
r = await api("/api/admin/bugs", { cookie: userTok });
ok("11b not an admin: 403", r.status === 403, r.status);
r = await api("/api/admin/bugs?filter=all", { cookie: adminTok });
ok("11c admin lists all, newest first", r.status === 200 && r.d.rows.length >= 4 && r.d.rows[0].created_at >= r.d.rows[r.d.rows.length - 1].created_at && !("pk" in r.d.rows[0]), r.d.rows && r.d.rows.length);
r = await api("/api/admin/bugs?q=" + anonId, { cookie: adminTok });
ok("11d search by report ID", r.d.rows.length === 1 && r.d.rows[0].email === "someone@gmail.com" && !r.d.rows[0].user_id, r.d);
r = await api("/api/admin/bugs?q=bob-test@planetcompute.ai", { cookie: adminTok });
ok("11e search by reporter email (account)", r.d.rows.length >= 1 && r.d.rows.every((x) => x.user_id === USER), r.d.rows && r.d.rows.length);
r = await api("/api/admin/bugs?q=" + USER, { cookie: adminTok });
ok("11f search by user ID", r.d.rows.length >= 1 && r.d.rows[0].email === "bob-test@planetcompute.ai" && r.d.rows[0].name === "Bob Tester", r.d.rows && r.d.rows[0]);
// 12. status and comments, each with time and admin
r = await api("/api/admin/bugs/update", { body: { bug_id: anonId, status: "on_hold", comment: "On hold until the next client release." }, cookie: adminTok });
let log = JSON.parse(r.d.bug.comments);
ok("12a status + comment saved as two log entries", r.status === 200 && r.d.bug.status === "on_hold" && log.length === 2 && log[0].kind === "status" && log[0].from === "new" && log[1].kind === "comment" && log[1].by_email === "admin-test@planetcompute.ai" && log[1].at, log);
r = await api("/api/admin/bugs/update", { body: { bug_id: anonId, status: "on_hold", comment: "Still on hold." }, cookie: adminTok });
ok("12b comment only (status unchanged)", JSON.parse(r.d.bug.comments).length === 3, r.d);
r = await api("/api/admin/bugs/update", { body: { bug_id: anonId, status: "on_hold", comment: "" }, cookie: adminTok });
ok("12c nothing to save refused", r.status === 400, r);
r = await api("/api/admin/bugs/update", { body: { bug_id: anonId, status: "bogus" }, cookie: adminTok });
ok("12d unknown status refused", r.status === 400, r);
r = await api("/api/admin/bugs/update", { body: { bug_id: anonId, status: "fixed" }, cookie: userTok });
ok("12e not an admin cannot update", r.status === 403, r.status);
r = await api("/api/admin/bugs?filter=on_hold", { cookie: adminTok });
ok("12f filter On hold finds it", r.d.rows.some((x) => x.bug_id === anonId), r.d.rows.length);
r = await api("/api/admin/bugs?filter=new", { cookie: adminTok });
ok("12g filter New no longer has it", !r.d.rows.some((x) => x.bug_id === anonId) && r.d.rows.some((x) => x.bug_id === userBug), r.d.rows.length);
// 13. email the reporter (dry run: not sent, but logged)
r = await api("/api/admin/bugs/email", { body: { bug_id: anonId, subject: "About your report", message: "Hello,\n\nIt is fixed now." }, cookie: adminTok });
log = JSON.parse(r.d.bug.comments);
ok("13a email to the reporter is logged", r.status === 200 && r.d.sent_to === "someone@gmail.com" && log[log.length - 1].kind === "email" && log[log.length - 1].to === "someone@gmail.com", r.d);
r = await api("/api/admin/bugs/email", { body: { bug_id: anonId, message: "" }, cookie: adminTok });
ok("13b empty email refused", r.status === 400, r);
r = await api("/api/admin/bugs/email", { body: { bug_id: anonId, message: "hi there" }, cookie: userTok });
ok("13c not an admin cannot email", r.status === 403, r.status);
// 14. pages: entry points, and every inline script parses
for (const [path, must] of [["/", ["Report Bugs", 'id="bugModal"', "data-bug"]], ["/admin", ['data-tab="bugs"', 'id="v-bugs"', "/api/admin/bugs/email"]]]) {
  const h = (await api(path)).d;
  ok(`14 ${path} has ${must.join(", ")}`, must.every((m) => h.includes(m)));
  let bad = 0;
  for (const m of h.matchAll(/<script>([\s\S]*?)<\/script>/g)) { try { new Function(m[1]); } catch (e) { bad++; console.log("   script error:", e.message); } }
  ok(`14 ${path} inline scripts parse`, bad === 0);
  // a script that looks up the pop-up must run after the pop-up's HTML, or wait for the page (bug found 2026-10-22:
  // the Report Bugs script ran first, found nothing and quietly stopped)
  if (path === "/") {
    const at = h.indexOf('id="bugModal"'), m = h.match(/<script>([^<]*?getElementById\("bugModal"\)[\s\S]*?)<\/script>/);
    ok("14 / the Report Bugs script waits for the page or comes after the pop-up", m && (h.indexOf(m[0]) > at || /DOMContentLoaded/.test(m[1])));
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
