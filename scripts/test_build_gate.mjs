// docs/TESTING.md test 90: which build of the program, and "too old to earn" (plan_old_programs #1, #2, #4; 2026-10-31).
// The given worker.js answers in-process with a fake DynamoDB, B2 and Resend (no browser). Each check sends one status
// report for a verified device (1 WU/s verified, 5 minutes since the last report, 100 WU reported, then paused, so the
// credit is written at once) and reads what reached the balance.
//   node scripts/test_build_gate.mjs <worker.js>
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { createHash } from "node:crypto";
const tmp = join(mkdtempSync(join(tmpdir(), "bg-")), "w.mjs"); writeFileSync(tmp, readFileSync(process.argv[2], "utf8")); globalThis.WebSocketRequestResponsePair = class {};
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, x === undefined ? "" : JSON.stringify(x).slice(0, 600)); } };
const SECRET = "s", sha = (s) => createHash("sha256").update(s).digest("hex"), TOK = "testsessiontoken-alice-0123456789";
const DEV = "a1b2c3d4e5f6", SID = "0123456789abcdef", NEW = 1800000000, OLDUA = "planetCompute/0.1.0", NEWUA = `planetCompute/0.1.0+abc1234.${NEW}`;
const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141 Safari/537.36";
// ---- fake DynamoDB
const items = new Map(), K = (t, k) => t + "|" + JSON.stringify(Object.keys(k).sort().map((x) => [x, k[x]]));
const un = (v) => v.S !== undefined ? v.S : v.N !== undefined ? Number(v.N) : v.BOOL !== undefined ? v.BOOL : v.NULL ? null : v;
const put = (t, it) => items.set(K(t, t === "planetcompute-ai-user-credits" ? { user_id: it.user_id, sk: it.sk } : { pk: it.pk, sk: it.sk }), it);
put("planetcompute-ai-user", { pk: { S: `SESSION#${sha(`${SECRET}|session|${TOK}`)}` }, sk: { S: "SESSION" }, user_id: { S: "alice" }, expires_at: { N: String(Math.floor(Date.now() / 1000) + 3600) } });
put("planetcompute-ai-user", { pk: { S: "USER#alice" }, sk: { S: "PROFILE" }, user_id: { S: "alice" }, primary_email: { S: "alice@example.com" } });
let credits = [], oldPuts = 0;
function resetDevice() {
  const t = Math.floor(Date.now() / 1000) - 300;
  put("planetcompute-ai-user", { pk: { S: "USER#alice" }, sk: { S: `DEVICE#${DEV}` }, user_id: { S: "alice" }, device_id: { S: DEV }, session_id: { S: SID },
    state: { S: "running" }, last_seen: { N: String(t) }, wu: { N: "0" }, seq: { N: "1" }, police_verified: { BOOL: true }, verified_cpu_wu_s: { N: "1" },
    verified_cores: { N: "1" }, cs_id: { S: "x" }, cs_sk: { S: "CS#x" }, first_seen: { N: String(t - 999) }, live_pk: { S: "x" } });
  credits = [];
}
function ddb(op, b) {
  const k = b.Key ? K(b.TableName, b.Key) : "", v = b.ExpressionAttributeValues || {}, n = b.ExpressionAttributeNames || {};
  if (op === "GetItem") return items.has(k) ? { Item: items.get(k) } : {};
  if (op === "PutItem") {
    if (/^OLDBUILD#/.test((b.Item.sk || {}).S || "")) { oldPuts++; const kk = K(b.TableName, { pk: b.Item.pk, sk: b.Item.sk });
      if (items.has(kk)) { const e = new Error("cond"); e.cond = true; throw e; } }
    put(b.TableName, b.Item); return {};
  }
  if (op === "UpdateItem") {
    if (b.TableName === "planetcompute-ai-user-credits" && b.Key.sk.S === "BALANCE") { credits.push({ c: Number(v[":c"].N), e: BigInt(v[":e"].N) }); return {}; }
    const it = items.get(k) || { ...b.Key };                          // apply "#aN = :aN" sets (enough for the device row)
    for (const m of String(b.UpdateExpression).matchAll(/(#a\d+) = (:a\d+)/g)) it[n[m[1]]] = v[m[2]];
    items.set(k, it); return {};
  }
  if (op === "Query" && /howCreditAwarded$/.test(b.TableName)) return { Items: [
    { pk: { S: "RULE" }, sk: { S: "2026-10-27T05:27:34.000Z#r2" }, rule_id: { S: "r2" }, effective_from: { S: "2026-10-27T05:27:34.000Z" }, status: { S: "active" },
      credit_per_wu: { N: "0.00000126" }, standby_per_hour: { N: "0.0001" }, work_min_per_hour: { N: "0.0002" } }] };
  if (op === "Query" && b.TableName === "planetcompute-ai-user" && v[":p"] && v[":p"].S === "USER#alice")
    return { Items: [...items.values()].filter((x) => x.pk && x.pk.S === "USER#alice" && /^DEVICE#/.test(x.sk.S)) };
  return { Items: [] };
}
let mails = [], latest = null;
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (/dynamodb\./.test(url)) { const op = String((init.headers || {})["x-amz-target"] || "").split(".").pop();
    try { return J(ddb(op, JSON.parse(init.body || "{}"))); }
    catch (e) { return e.cond ? J({ __type: "com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException", message: "The conditional request failed" }, 400) : J({ __type: "InternalServerError", message: e.message }, 500); } }
  if (/api\.resend\.com/.test(url)) { mails.push(JSON.parse(init.body)); return J({ id: "m" }); }
  if (/b2_authorize_account/.test(url)) return J({ authorizationToken: "t", apiInfo: { storageApi: { downloadUrl: "https://f.b2", allowed: { buckets: [{ name: "pc" }] } } } });
  if (/^https:\/\/f\.b2\/file\/pc\/client\/LATEST\.json/.test(url)) return latest ? J(latest) : J({}, 404);
  return J({}, 503);
};
const W = (await import(tmp)).default;
const base = { AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "y", SESSION_SECRET: SECRET, RESEND_API_KEY: "r", RESEND_FROM: "t@invalid", B2_MODELS_KEY_ID: "k", B2_MODELS_APP_KEY: "a" };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const call = (env, path, { ua = CHROME, body } = {}) => W.fetch(new Request("https://planetcompute.ai" + path, { method: body ? "POST" : "GET",
  headers: { cookie: `pc_session=${TOK}`, "user-agent": ua, "content-type": "application/json", origin: "https://planetcompute.ai" }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, ctx);
async function beat(env, ua, extra = {}) {
  resetDevice();
  const r = await call(env, "/api/volunteer/heartbeat", { ua, body: { device_id: DEV, session_id: SID, state: "paused", cores: 1, cpu_cap: 100, wu: 100, host: "app", ...extra } });
  const j = await r.json(), d = items.get(K("planetcompute-ai-user", { pk: { S: "USER#alice" }, sk: { S: `DEVICE#${DEV}` } }));
  const sum = credits.reduce((a, x) => ({ c: a.c + x.c, e: a.e + x.e }), { c: 0, e: 0n });
  return { j, wu: sum.c / 1e6, bonus: Number(sum.e) / 1e21, dev: Object.fromEntries(Object.entries(d).map(([k, x]) => [k, un(x)])) };
}

// 1: rule off (no MIN_EARN_BUILD): an old program (no build id) is credited as before
let x = await beat(base, OLDUA);
ok("1 rule off: old program credited 100 WU, bonus > 0, no flag", x.wu === 100 && x.bonus > 0 && !x.j.old_build && x.dev.build_time === 0 && x.dev.build === "", x);
// 2: a build with an id is audited (#4: the website decides): no report credit even without "leases" in its hello
x = await beat(base, NEWUA);
ok("2 build id stored (abc1234, " + NEW + ") and audited: 0 WU from the report", x.dev.build === "abc1234" && x.dev.build_time === NEW && x.wu === 0 && /audits/.test(x.j.note), x);
// 3: WARN: old program still credited, flagged, owner emailed once
const warn = { ...base, MIN_EARN_BUILD: String(NEW - 1000) };
x = await beat(warn, OLDUA);
ok("3 warn: old program credited 100 WU, answer old_build + earn true + update link", x.wu === 100 && x.j.old_build === true && x.j.earn === true && /download/.test(x.j.update) && x.dev.old_build === true, x);
ok("3b warn: one email to the owner, naming the device and the download page", mails.length === 1 && mails[0].to[0] === "alice@example.com" && mails[0].text.includes(DEV) && mails[0].text.includes("planetcompute.ai/download") && /will soon stop/.test(mails[0].text), mails);
x = await beat(warn, OLDUA);
ok("3c warn: a second report sends no second email", mails.length === 1 && oldPuts === 2, { mails: mails.length, oldPuts });
// 4: ENFORCE: no credit of any kind for the old program
const enf = { ...warn, MIN_EARN_MODE: "enforce" };
x = await beat(enf, OLDUA);
ok("4 enforce: old program gets 0 WU and 0 bonus (no working minimum, no standby)", x.wu === 0 && x.bonus === 0 && x.j.earn === false && /too old/.test(x.j.note), x);
x = await beat(enf, NEWUA);
ok("4b enforce: a new build is not flagged", !x.j.old_build && x.dev.old_build === false, x);
// 5: the browser console is never checked (always current)
x = await beat(enf, CHROME, { host: "browser" });
ok("5 enforce: a browser tab is credited as before", x.wu === 100 && !x.j.old_build, x);
// 6: the window's console: its User-Agent is the program's relay; a report with the build in its body counts too
x = await beat(enf, CHROME, { build: "abc1234", build_time: NEW });
ok("6 build from the report body (heartbeat-server path) is used when the User-Agent is not the program's", x.dev.build_time === NEW && !x.j.old_build, x);
x = await beat(enf, CHROME, {});
ok("6b host app with no build anywhere = old: not credited under enforce", x.dev.build_time === 0 && x.wu === 0 && x.j.earn === false, x);
// 7: date form of MIN_EARN_BUILD
x = await beat({ ...base, MIN_EARN_BUILD: "2030-01-01T00:00Z", MIN_EARN_MODE: "enforce" }, NEWUA);
ok("7 MIN_EARN_BUILD as a date (2030) makes a 2027 build old", x.j.old_build === true && x.j.earn === false, x);
// 8: /api/app-build reads the program's User-Agent back (for the console inside the window)
let j = await (await call(base, "/api/app-build", { ua: NEWUA })).json();
ok("8 /api/app-build for the program", j.app === true && j.build === "abc1234" && j.build_time === NEW, j);
j = await (await call(base, "/api/app-build", { ua: OLDUA })).json();
ok("8b /api/app-build for an old program: app, no build", j.app === true && j.build === "" && j.build_time === 0, j);
j = await (await call(base, "/api/app-build", { ua: CHROME })).json();
ok("8c /api/app-build for a browser: not the app", j.app === false, j);
// 9: "Your computers" shows the flag (from the build stored on the device)
await beat(warn, OLDUA);
j = await (await call(warn, "/api/me/devices")).json();
ok("9 /api/me/devices: old_build true, earn_mode warn", j.devices && j.devices[0] && j.devices[0].old_build === true && j.devices[0].earn_mode === "warn" && j.devices[0].build_time === 0, j);
// 10: latest.json: commit + build_time per platform, and the minimum
latest = { version: "0.1.0", commit: "abc1234", builds: { "linux-x86_64": { file: "f", sha256: "s", bytes: 1, sig: "g", commit: "abc1234", build_time: NEW },
  "macos-aarch64": { file: "m", sha256: "t", bytes: 2, sig: "h" } } };
j = await (await call(enf, "/download/latest.json")).json();
ok("10 latest.json: linux has commit + build_time, mac (older entry) has none, min_earn_build + mode", j.builds.linux.build_time === NEW && j.builds.linux.commit === "abc1234"
  && j.builds.mac && j.builds.mac.build_time === undefined && j.min_earn_build === NEW - 1000 && j.min_earn_mode === "enforce", j);
j = await (await call(base, "/download/latest.json")).json();
ok("10b latest.json without the rule: no min_earn_build", j.min_earn_build === undefined && j.builds.linux.sig === "g", j);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
