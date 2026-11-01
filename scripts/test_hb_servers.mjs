// Test of the heartbeat servers (TESTING.md test 25): the admin tab Servers and GET /api/hb/config, running the
// website Worker's own code in Node against throwaway DynamoDB tables <prefix>user and <prefix>HeartbeatEtcEC2TypeServers
// (default prefix pctest-ai-; created here if missing; the servers table is emptied at the start and the end). The servers' /health answers are faked.
//   node scripts/test_hb_servers.mjs <path to worker.js>
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";

const src = resolve(process.argv[2] || "website/worker.js");
const tmp = join(mkdtempSync(join(tmpdir(), "pchb-")), "worker.mjs");
copyFileSync(src, tmp);
const worker = (await import(tmp)).default;
const PREFIX = process.env.DDB_PREFIX || "pctest-ai-";
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_REGION: process.env.AWS_REGION || "us-east-1", DDB_PREFIX: PREFIX, SESSION_SECRET: "test-" + randomBytes(8).toString("hex"),
  ADMIN_EMAILS: "admin-test@planetcompute.ai", RESEND_API_KEY: "re_test", RESEND_FROM: "PlanetCompute <test@planetcompute.ai>", HB_SERVER_SECRET: "hb-test-" + randomBytes(8).toString("hex") };
const mails = [];
// fake servers: hb-ok.test.planetcompute.ai answers its health check, hb-down.test.planetcompute.ai does not
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const u = typeof input === "string" ? input : input.url;
  if (u === "https://hb-ok.test.planetcompute.ai/health") return new Response(JSON.stringify({ ok: true, version: "0.1-test" }));
  if (u === "https://hb-down.test.planetcompute.ai/health") throw new Error("connection refused");
  if (u === "https://api.resend.com/emails") { mails.push(JSON.parse(init.body)); return new Response("{}"); }
  return realFetch(input, init);
};
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
const UT = PREFIX + "user", ST = PREFIX + "HeartbeatEtcEC2TypeServers";
async function create(name, extra) {
  try { const d = await rawDdb("DescribeTable", { TableName: name }); if (d.Table.TableStatus === "ACTIVE") return; } catch {}
  try { await rawDdb("CreateTable", { TableName: name, BillingMode: "PAY_PER_REQUEST", ...extra }); } catch {}
  for (let i = 0; i < 90; i++) { try { const d = await rawDdb("DescribeTable", { TableName: name }); if (d.Table.TableStatus === "ACTIVE") return; } catch {} await new Promise((r) => setTimeout(r, 3000)); }
}
const HBKEY = () => createHmac("sha256", env.HB_SERVER_SECRET).update("pc-derived|hb").digest("hex");   // what a heartbeat server holds (security review W5)
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra === undefined ? "" : JSON.stringify(extra).slice(0, 300)); } };
try {
  await create(UT, { KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
    AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }] });
  await create(ST, { KeySchema: [{ AttributeName: "server_id", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
    AttributeDefinitions: [{ AttributeName: "server_id", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }] });
  // the test table is delete-protected (CreateTables.py): empty it instead of dropping it
  const clearServers = async () => { const sc = await rawDdb("Scan", { TableName: ST });
    for (const it of sc.Items || []) await rawDdb("DeleteItem", { TableName: ST, Key: { server_id: it.server_id, sk: it.sk } }); };
  await clearServers();
  async function seedUser(id, email, admin) {
    await rawDdb("PutItem", { TableName: UT, Item: { pk: S(`USER#${id}`), sk: S("PROFILE"), user_id: S(id), primary_email: S(email), ...(admin ? { IsAdmin: { BOOL: true } } : {}) } });
    await rawDdb("PutItem", { TableName: UT, Item: { pk: S(`USER#${id}`), sk: S(`EMAIL#${email}`), user_id: S(id), email: S(email) } });
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(`${env.SESSION_SECRET}|session|${token}`).digest("hex");
    await rawDdb("PutItem", { TableName: UT, Item: { pk: S(`SESSION#${hash}`), sk: S("SESSION"), user_id: S(id), expires_at: { N: String(Math.floor(Date.now() / 1000) + 3600) } } });
    return token;
  }
  const adminTok = await seedUser("a1a1a1a1a1a1", "admin-test@planetcompute.ai", true), userTok = await seedUser("b2b2b2b2b2b2", "bob-test@planetcompute.ai", false);
  const cookieName = readFileSync(src, "utf8").match(/const COOKIE = "([^"]+)"/)[1];
  const api = async (path, o = {}) => {
    // cf-connecting-ip: Cloudflare adds it to every real request (the session rows are indexed by it)
    const headers = { origin: "https://planetcompute.ai", "cf-connecting-ip": "203.0.113.60", ...(o.cookie ? { cookie: cookieName + "=" + o.cookie } : {}), ...(o.body ? { "content-type": "application/json" } : {}) };
    const r = await worker.fetch(new Request("https://planetcompute.ai" + path, { method: o.body ? "POST" : "GET", headers, body: o.body ? JSON.stringify(o.body) : undefined }), env);
    const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: r.status, d };
  };
  let r = await api("/api/admin/servers", { cookie: userTok });
  ok("1 a non-admin cannot see the servers", r.status === 403, r.status);
  r = await api("/api/admin/servers", { cookie: adminTok });
  ok("2 an admin sees an empty list, secret set", r.status === 200 && r.d.rows.length === 0 && r.d.secret_set === true, r.d);
  r = await api("/api/admin/servers/save", { cookie: adminTok, body: { name: "x", hostname: "hb.example.org", notes: "-----BEGIN OPENSSH PRIVATE KEY----- abc" } });
  ok("3 a private key is refused", r.status === 400 && /key/i.test(r.d.error), r.d);
  r = await api("/api/admin/servers/save", { cookie: adminTok, body: { name: "x", hostname: "not a host" } });
  ok("4 a bad hostname is refused", r.status === 400, r.d);
  r = await api("/api/admin/servers/save", { cookie: adminTok, body: { name: "x", hostname: "hb.example.org" } });
  ok("4b a hostname outside planetcompute.ai is refused (the pages may only connect there)", r.status === 400, r.d);
  r = await api("/api/admin/servers/save", { cookie: adminTok, body: { name: "no address" } });
  ok("5 a server without hostname or IP is refused", r.status === 400, r.d);
  r = await api("/api/admin/servers/save", { cookie: adminTok, body: { name: "hetzner-1", hostname: "HB-OK.test.planetcompute.ai", public_ipv4: "203.0.113.10",
    provider: "Hetzner", region: "fsn1", instance_type: "CPX21", ssh_user: "root", ssh_port: "22", ssh_key_name: "planetcompute_hb", weight: "50" } });
  const s1 = (r.d.rows || []).find((x) => x.name === "hetzner-1");
  ok("6 add: saved inactive, health unknown, hostname lower-cased, who and when", r.status === 200 && s1 && s1.status === "inactive" && s1.health === "unknown" &&
    s1.hostname === "hb-ok.test.planetcompute.ai" && s1.created_by === "admin-test@planetcompute.ai" && /^[0-9a-f]{12}$/.test(s1.server_id), r.d);
  r = await api("/api/admin/servers/save", { cookie: adminTok, body: { name: "aws-1", hostname: "hb-down.test.planetcompute.ai", public_ipv4: "198.51.100.7", weight: "90" } });
  const s2 = (r.d.rows || []).find((x) => x.name === "aws-1");
  ok("7 a second server; the list is sorted by weight", s2 && r.d.rows[0].name === "aws-1", r.d.rows && r.d.rows.map((x) => x.name));
  r = await api("/api/hb/config?device=0123456789ab", { cookie: userTok });
  ok("8 no active server: volunteers get an empty list (they report to the website)", r.status === 200 && r.d.servers.length === 0 && !r.d.token, r.d);
  await api("/api/admin/servers/status", { cookie: adminTok, body: { server_id: s1.server_id, status: "active" } });
  r = await api("/api/admin/servers/status", { cookie: adminTok, body: { server_id: s2.server_id, status: "active" } });
  ok("9 activate both", r.status === 200 && r.d.rows.every((x) => x.status === "active"), r.d);
  r = await api("/api/hb/config?device=0123456789ab", { cookie: userTok });
  ok("10 config: only the healthy one (the down one is checked and left out)", r.status === 200 && JSON.stringify(r.d.servers) === JSON.stringify(["https://hb-ok.test.planetcompute.ai"]), r.d);
  const [u, d, until, sig] = String(r.d.token || "").split(".");
  const want = createHmac("sha256", HBKEY()).update(`hb|${u}.${d}.${until}`).digest("hex");   // the heartbeat servers' own key (W5)
  ok("11 the pass names the user and device, lasts a day, and its HMAC checks with the shared secret", u === "b2b2b2b2b2b2" && d === "0123456789ab" &&
    +until - Date.now() / 1000 > 86000 && sig === want, r.d.token);
  r = await api("/api/admin/servers", { cookie: adminTok });
  const d2 = r.d.rows.find((x) => x.name === "aws-1"), d1 = r.d.rows.find((x) => x.name === "hetzner-1");
  ok("12 health recorded: ok with version and latency; down with the error", d1.health === "ok" && d1.version === "0.1-test" && d1.last_ok_at &&
    d2.health === "down" && /refused/.test(d2.last_error), r.d.rows);
  r = await api("/api/admin/servers/save", { cookie: adminTok, body: { server_id: s1.server_id, name: "hetzner-1b", hostname: "hb-ok.test.planetcompute.ai", notes: "renamed" } });
  ok("13 edit keeps the server's status and ID", r.d.rows.find((x) => x.server_id === s1.server_id).name === "hetzner-1b" && r.d.rows.find((x) => x.server_id === s1.server_id).status === "active", r.d);
  await api("/api/admin/servers/status", { cookie: adminTok, body: { server_id: s1.server_id, status: "inactive" } });
  r = await api("/api/hb/config?device=0123456789ab", { cookie: userTok });
  ok("14 inactivated: no server offered any more", r.d.servers.length === 0, r.d);
  r = await api("/api/hb/config?device=0123456789ab");
  ok("15 config needs sign-in", r.status === 401, r.status);
  r = await api("/api/admin/servers/delete", { cookie: adminTok, body: { server_id: s2.server_id } });
  ok("16 delete", r.status === 200 && !r.d.rows.find((x) => x.server_id === s2.server_id), r.d);
  r = await api("/api/hb/config?device=0123456789ab", { cookie: userTok }, null);
  const noSecret = { ...env }; delete noSecret.HB_SERVER_SECRET;
  const r2 = await worker.fetch(new Request("https://planetcompute.ai/api/hb/config?device=0123456789ab", { headers: { cookie: cookieName + "=" + userTok } }), noSecret);
  ok("17 without HB_SERVER_SECRET volunteers always report to the website", (await r2.json()).servers.length === 0);
  // --- the reminder email when no server runs, its setting, the hourly timer
  r = await api("/api/admin/servers", { cookie: adminTok });
  ok("19 the reminder is daily unless changed", r.d.settings.alert_every === "day", r.d.settings);
  r = await api("/api/admin/servers/alert-test", { cookie: adminTok, body: {} });
  ok("20 no server running: the admins are emailed", r.status === 200 && r.d.usable === 0 && r.d.emailed === true && mails.length === 1 &&
    mails[0].to[0] === "admin-test@planetcompute.ai" && /No heartbeat server/.test(mails[0].subject), r.d);
  let waits = []; await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) }); await Promise.all(waits);
  ok("21 the hourly timer does not email again within the day", mails.length === 1, mails.length);
  r = await api("/api/admin/servers/settings", { cookie: adminTok, body: { alert_every: "off" } });
  ok("22 switch the email off", r.status === 200 && r.d.settings.alert_every === "off", r.d);
  r = await api("/api/admin/servers/alert-test", { cookie: adminTok, body: {} });
  ok("23 ...then no email even when none runs", r.d.emailed === false && mails.length === 1, r.d);
  r = await api("/api/admin/servers/settings", { cookie: adminTok, body: { alert_every: "hourly" } });
  ok("24 only day / week / month / off", r.status === 400, r.d);
  await api("/api/admin/servers/settings", { cookie: adminTok, body: { alert_every: "week" } });
  // --- a batch of beats handed in by a server
  const tok = (await api("/api/hb/config?device=0123456789ab", { cookie: userTok }));
  await api("/api/admin/servers/status", { cookie: adminTok, body: { server_id: s1.server_id, status: "active" } });
  const cfg = (await api("/api/hb/config?device=0123456789ab", { cookie: userTok })).d;
  const sidHex = randomBytes(8).toString("hex"), at = Math.floor(Date.now() / 1000) - 30;
  const beat = { device_id: "0123456789ab", session_id: sidHex, state: "running", cores: 4, cpu_cap: 50, wu: 0.5, packs: 3, host: "browser" };
  const ingest = async (bodyObj, sigOverride) => {
    const raw = JSON.stringify(bodyObj), ts = String(Math.floor(Date.now() / 1000));
    const sig = sigOverride || ts + "." + createHmac("sha256", HBKEY()).update(`ingest|${ts}|${raw}`).digest("hex");
    const rr = await worker.fetch(new Request("https://planetcompute.ai/api/hb/ingest", { method: "POST", headers: { "x-hb-sig": sig, "content-type": "application/json" }, body: raw }), env);
    return { status: rr.status, d: await rr.json(), sig, raw };
  };
  const replay = async (prev) => { const rr = await worker.fetch(new Request("https://planetcompute.ai/api/hb/ingest", { method: "POST", headers: { "x-hb-sig": prev.sig, "content-type": "application/json" }, body: prev.raw }), env); return { status: rr.status, d: await rr.json() }; };
  r = await ingest({ server_id: s1.server_id, beats: [{ token: cfg.token, at, ip: "203.0.113.50", country: "DE", beat }] }, "123.abc");
  ok("25 a batch with a bad signature is refused", r.status === 401, r);
  r = await ingest({ server_id: s1.server_id, beats: [{ token: cfg.token, at, ip: "203.0.113.50", country: "DE", beat }] });
  ok("26 a signed batch: the beat goes through the normal heartbeat", r.status === 200 && r.d.results[0].ok === true, r.d);
  const dev = await rawDdb("GetItem", { TableName: UT, Key: { pk: S("USER#b2b2b2b2b2b2"), sk: S("DEVICE#0123456789ab") }, ConsistentRead: true });
  ok("27 the device row has the server's time and the volunteer's address and country", dev.Item && +dev.Item.last_seen.N === at &&
    dev.Item.ip.S === "203.0.113.50" && dev.Item.country.S === "DE" && dev.Item.state.S === "running", dev.Item);
  const first = r, again = await replay(first);
  ok("28a the very same signed request again (a replay) is refused (security review W5)", again.status === 409, again);
  await new Promise((x) => setTimeout(x, 1100));          // a new signature (new time) for the same beats
  r = await ingest({ server_id: s1.server_id, beats: [{ token: cfg.token, at, ip: "203.0.113.50", country: "DE", beat }] });
  ok("28 the same beats in a new batch count once (skipped: not newer)", r.d.results[0].skipped, r.d);
  { const k = HBKEY(), raw2 = JSON.stringify({ server_id: s1.server_id, beats: [] }), ts2 = String(Math.floor(Date.now() / 1000));
    const rr = await worker.fetch(new Request("https://planetcompute.ai/api/hb/ingest", { method: "POST", headers: { "x-hb-sig": ts2 + "." + createHmac("sha256", k).update(`ingest|${ts2}|${raw2}`).digest("hex"), "content-type": "application/json" }, body: raw2 }), env);
    ok("28b a batch signed with the heartbeat servers' own derived key is accepted (W5)", rr.status === 200, rr.status);
    const raw3 = JSON.stringify({ server_id: s1.server_id, beats: [] }), ts3 = String(Math.floor(Date.now() / 1000)) ;
    const r3 = await worker.fetch(new Request("https://planetcompute.ai/api/hb/ingest", { method: "POST", headers: { "x-hb-sig": ts3 + "." + createHmac("sha256", env.HB_SERVER_SECRET).update(`ingest|${ts3}|${raw3}`).digest("hex"), "content-type": "application/json" }, body: raw3 }), env);
    ok("28c a batch signed with the master secret itself is refused: no server holds it any more (W5)", r3.status === 401, r3.status); }
  r = await ingest({ server_id: s1.server_id, beats: [{ token: cfg.token, at: at + 5, ip: "x", country: "DE", beat: { ...beat, device_id: "ffffffffffff" } }] });
  ok("29 a beat for another device than its pass is refused", /does not match/.test(r.d.results[0].error), r.d);
  r = await ingest({ server_id: s1.server_id, beats: [{ token: cfg.token.replace(/.$/, (c) => c === "0" ? "1" : "0"), at: at + 5, beat }] });
  ok("30 a forged pass is refused", r.d.results[0].error === "bad pass", r.d);
  r = await api("/api/admin/servers", { cookie: adminTok });
  ok("31 the server's last hand-in is recorded", !!r.d.rows.find((x) => x.server_id === s1.server_id).last_ingest_at, r.d.rows);
  void tok;
  // --- a server fails: the next direct report may cover the time its beats were held (credit never lost)
  const dev2 = randomBytes(6).toString("hex"), sid2 = randomBytes(8).toString("hex"), t25 = Math.floor(Date.now() / 1000) - 1500;
  const cfg2 = (await api("/api/hb/config?device=" + dev2, { cookie: userTok })).d;
  const b2 = { device_id: dev2, session_id: sid2, state: "running", cores: 4, cpu_cap: 100, wu: 0, packs: 0, host: "browser" };
  r = await ingest({ server_id: s1.server_id, beats: [{ token: cfg2.token, at: t25, ip: "203.0.113.60", country: "DE", beat: b2 }] });
  ok("32 a beat through a server 25 minutes ago (recorded, not skipped)", r.d.results[0].ok === true && !r.d.results[0].skipped, r.d);
  await rawDdb("UpdateItem", { TableName: UT, Key: { pk: S("USER#b2b2b2b2b2b2"), sk: S("DEVICE#" + dev2) },
    UpdateExpression: "SET police_verified = :v, verified_cpu_wu_s = :c", ExpressionAttributeValues: { ":v": { BOOL: true }, ":c": { N: "1" } } });
  r = await api("/api/volunteer/heartbeat", { cookie: userTok, body: { ...b2, wu: 3000, packs: 10 } });
  ok("33 the server is gone: the next direct report is credited for the whole 25 minutes (not cut to 10)",
    r.status === 200 && r.d.credited_wu >= 1495 && r.d.credited_wu <= 1505, r.d);
  r = await api("/api/volunteer/heartbeat", { cookie: userTok, body: { ...b2, wu: 6000, packs: 20 } });
  ok("34 ...and the one after it is limited normally again (verified capacity x the seconds since)", r.status === 200 && r.d.credited_wu <= 5, r.d);
  const h = (await api("/admin")).d;
  let bad = 0;
  for (const m of h.matchAll(/<script>([\s\S]*?)<\/script>/g)) { try { new Function(m[1]); } catch (e) { bad++; console.log("   script error:", e.message); } }
  ok("18 /admin has the Servers tab and every inline script parses", h.includes('data-tab="servers"') && h.includes('id="v-servers"') && bad === 0);
} finally {
  const sc = await rawDdb("Scan", { TableName: ST }).catch(() => ({}));
  for (const it of sc.Items || []) await rawDdb("DeleteItem", { TableName: ST, Key: { server_id: it.server_id, sk: it.sk } }).catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
