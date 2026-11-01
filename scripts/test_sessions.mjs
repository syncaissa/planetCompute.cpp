// docs/TESTING.md test 85 (user 2026-10-30, issue 3): an email when an account signs in from a browser / country it has
// not used before (not for a new account, not for the first sign-in recorded, not twice); "Where you are signed in" lists
// the account's sign-ins (this one first, the in-house servers' own marked), Sign out one, Sign out everywhere else (the
// servers' sign-ins stay); a signed-out session no longer works. The given worker.js in Node with a fake DynamoDB (with the
// user table's by-user index) and a fake mail service. No network.
//   node <repo>/scripts/test_sessions.mjs <worker.js>
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
const tmp = join(mkdtempSync(join(tmpdir(), "ss-")), "w.mjs"); writeFileSync(tmp, readFileSync(process.argv[2], "utf8")); globalThis.WebSocketRequestResponsePair = class {};
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, x === undefined ? "" : JSON.stringify(x).slice(0, 400)); } };
const SECRET = "s", sha = (s) => createHash("sha256").update(s).digest("hex"), sha512 = (b) => createHash("sha512").update(b).digest("hex");
const TOK = { alice: "testsessiontoken-alice-0123456789", bob: "testsessiontoken-bob-00123456789", newbie: "testsessiontoken-newbie-0123456789" };
const OLD = "2026-01-01T00:00:00.000Z", items = new Map(), K = (t, k) => t + "|" + JSON.stringify(Object.keys(k).sort().map((x) => [x, k[x]]));
const keyOf = (it) => it.pk ? { pk: it.pk, sk: it.sk } : { user_id: it.user_id, sk: it.sk };
for (const [u, t] of Object.entries(TOK)) {
  items.set(K("planetcompute-ai-user", { pk: { S: `SESSION#${sha(`${SECRET}|session|${t}`)}` }, sk: { S: "SESSION" } }), { user_id: { S: u }, expires_at: { N: String(Math.floor(Date.now() / 1000) + 3600) } });
  items.set(K("planetcompute-ai-user", { pk: { S: `USER#${u}` }, sk: { S: "PROFILE" } }), { pk: { S: `USER#${u}` }, sk: { S: "PROFILE" }, user_id: { S: u },
    primary_email: { S: u + "@example.com" }, created_at: { S: u === "newbie" ? new Date().toISOString() : OLD } });
  items.set(K("planetcompute-ai-user", { pk: { S: `EMAIL#${u}@example.com` }, sk: { S: "EMAIL" } }), { pk: { S: `EMAIL#${u}@example.com` }, sk: { S: "EMAIL" }, user_id: { S: u } });
}
// an existing Gmail account (for the one-account-per-address check)
items.set(K("planetcompute-ai-user", { pk: { S: "EMAIL#jane.doe@gmail.com" }, sk: { S: "EMAIL" } }), { pk: { S: "EMAIL#jane.doe@gmail.com" }, sk: { S: "EMAIL" }, user_id: { S: "jane" } });
items.set(K("planetcompute-ai-user", { pk: { S: "CANON#janedoe@gmail.com" }, sk: { S: "CANON" } }), { pk: { S: "CANON#janedoe@gmail.com" }, sk: { S: "CANON" }, user_id: { S: "jane" }, email: { S: "jane.doe@gmail.com" } });
const made = () => [...items.entries()].filter(([k, v]) => k.startsWith("planetcompute-ai-media-made|") && v.sk.S.startsWith("SHA512#")).map(([, v]) => v);
const cond = () => { const e = new Error("cond"); e.cond = true; return e; };
function update(b, it) {                                   // SET / ADD / REMOVE, and the counters' "x <= :mx" conditions
  const v = b.ExpressionAttributeValues || {}, nm = b.ExpressionAttributeNames || {}, nameOf = (x) => x.startsWith("#") ? nm[x] : x;
  for (const c of String(b.ConditionExpression || "").matchAll(/attribute_not_exists\((\w+)\) OR (\w+) <= (:\w+)/g)) if (it[c[2]] && +it[c[2]].N > +v[c[3]].N) throw cond();
  if (/^attribute_exists\(pk\)$/.test(b.ConditionExpression || "") && !it.pk) throw cond();
  for (const part of String(b.UpdateExpression || "").split(/(?=\b(?:SET|ADD|REMOVE)\b)/)) {
    const t = part.trim();
    if (t.startsWith("SET ")) for (const a of t.slice(4).split(/,(?![^(]*\))/)) { const m = /(#?\w+)\s*=\s*(?:if_not_exists\((#?\w+),\s*(:\w+)\)|(:\w+))/.exec(a.trim()); if (m) it[nameOf(m[1])] = m[3] ? (it[nameOf(m[1])] || v[m[3]]) : v[m[4]]; }
    if (t.startsWith("ADD ")) for (const a of t.slice(4).split(",")) { const [n0, vv] = a.trim().split(/\s+/); const n = nameOf(n0); it[n] = { N: String((it[n] ? +it[n].N : 0) + +v[vv].N) }; }
    if (t.startsWith("REMOVE ")) for (const a of t.slice(7).split(",")) delete it[nameOf(a.trim())];
  }
  return it;
}
function ddb(op, b) {
  const k = b.Key ? K(b.TableName, b.Key) : "";
  if (op === "GetItem") return items.has(k) ? { Item: items.get(k) } : {};
  if (op === "PutItem") { const kk = K(b.TableName, keyOf(b.Item)); if (/attribute_not_exists/.test(b.ConditionExpression || "") && items.has(kk)) throw cond(); items.set(kk, b.Item); return {}; }
  if (op === "UpdateItem") { const it = update(b, structuredClone(items.get(k) || { ...b.Key })); items.set(k, it);
    return { Attributes: it.share ? it : { ...it, share: { S: "tok" + Math.random().toString(16).slice(2, 10) } } }; }
  if (op === "DeleteItem") { items.delete(k); return {}; }
  if (op === "TransactWriteItems") {
    for (const x of b.TransactItems) if (x.Put && /attribute_not_exists/.test(x.Put.ConditionExpression || "") && items.has(K(x.Put.TableName, keyOf(x.Put.Item)))) { const e = new Error("tx"); e.tx = true; throw e; }
    for (const x of b.TransactItems) { if (x.Put) items.set(K(x.Put.TableName, keyOf(x.Put.Item)), x.Put.Item); if (x.Update) ddb("UpdateItem", x.Update); }
    return {};
  }
  if (op === "Query" && b.IndexName === "by-user") { const v = b.ExpressionAttributeValues;
    return { Items: [...items.entries()].filter(([kk, x]) => kk.startsWith(b.TableName + "|") && x.user_id && x.user_id.S === v[":u"].S && x.sk && x.sk.S === v[":s"].S).map(([, x]) => ({ pk: x.pk, sk: x.sk, user_id: x.user_id })) }; }
  if (op === "Query" && /begins_with\(sk, :s\)/.test(b.KeyConditionExpression || "")) { const v = b.ExpressionAttributeValues;
    return { Items: [...items.entries()].filter(([kk, x]) => kk.startsWith(b.TableName + "|") && x.pk && x.pk.S === v[":p"].S && x.sk.S.startsWith(v[":s"].S)).map(([, x]) => x).slice(0, b.Limit || 100) }; }
  if (op === "BatchGetItem") { const out = {}; for (const [tn, rq] of Object.entries(b.RequestItems)) out[tn] = rq.Keys.map((x) => items.get(K(tn, x))).filter(Boolean); return { Responses: out }; }
  return { Items: [] };
}
const png = (w, h, opt = {}) => {                         // a PNG as the program writes one (IHDR, IDAT, IEND; CRCs not checked)
  const ch = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); return Buffer.concat([l, Buffer.from(type), data, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), ch("IHDR", ihdr), ...(opt.extra ? [ch(opt.extra, Buffer.alloc(20, 1))] : []),
    ch("IDAT", Buffer.alloc(opt.big || 300, opt.fill || 3)), ch("IEND", Buffer.alloc(0)), ...(opt.after ? [Buffer.from(opt.after)] : [])]);
};
const PNG = png(1920, 1080), POOLPNG = png(1080, 1350, { fill: 7 });
const PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 9)]);
const mails = [];
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (/dynamodb\./.test(url)) { const op = String((init.headers || {})["x-amz-target"] || "").split(".").pop();
    try { return J(ddb(op, JSON.parse(init.body || "{}"))); }
    catch (e) { return J({ __type: e.tx ? "com.amazonaws.dynamodb.v20120810#TransactionCanceledException" : "com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException", message: "cond" }, 400); } }
  if (url === "https://challenges.cloudflare.com/turnstile/v0/siteverify") { const fd = init.body; return J({ success: fd.get("response") === "good-token" }); }
  if (url === "https://api.resend.com/emails") { mails.push(JSON.parse(init.body)); return J({ id: "m" + mails.length }); }
  if (/cloudflare-dns\.com|dns\.google/.test(url)) return J({ Status: 0, Answer: [{ type: 15, data: "10 mx.example.com." }] });
  if (/b2_authorize_account/.test(url)) return J({ authorizationToken: "t", accountId: "a", apiInfo: { storageApi: { downloadUrl: "https://f.b2test", apiUrl: "https://api.b2test", allowed: { buckets: [{ id: "bid", name: "planetcompute-ai" }] } } } });
  if (url === "https://f.b2test/file/planetcompute-ai/sherpa_jobs/00000000000000b2/0.png") return new Response(POOLPNG, { headers: { "content-type": "image/png" } });
  if (url.startsWith("https://api.b2test/b2api/v3/b2_list_file_names")) return J({ files: [] });
  if (url.startsWith("https://api.b2test/b2api/v3/b2_get_upload_url")) return J({ uploadUrl: "https://up.b2test/x", authorizationToken: "u" });
  if (url.startsWith("https://up.b2test/")) { uploads++; return J({ fileId: "f" + uploads }); }
  return J({}, 404);
};
let uploads = 0;
const sherpa = { fetch: async (u) => { const x = new URL(u);
  if (x.pathname === "/jobs") return J({ job: { id: x.searchParams.get("id"), for_user: "alice", state: "done", model: "zimage-turbo-q4k", prompts: ["A lighthouse in a storm"], params: { width: 1080, height: 1350 },
    items: [{ n: 0, state: "done", result: { file: "sherpa_jobs/00000000000000b2/0.png", ok: true } }] } });
  return J({}, 404); } };
const mod = await import(tmp), W = mod.default;
const guardStore = new Map(), guard = new mod.ContactGuard({ storage: { get: async (k) => guardStore.get(k), put: async (k, v) => { guardStore.set(k, v); }, delete: async (k) => guardStore.delete(k),
  list: async () => new Map(guardStore), getAlarm: async () => 1, setAlarm: async () => {} } });
const env = { AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "y", SESSION_SECRET: SECRET, MAIL_FROM: "t@invalid", RESEND_API_KEY: "r", ADMIN_EMAILS: "admin@example.com",
  TURNSTILE_SECRET: "ts", TURNSTILE_SITEKEY: "site", B2_MODELS_KEY_ID: "k", B2_MODELS_APP_KEY: "s",
  SHERPA: { idFromName: (n) => n, get: () => sherpa }, CONTACT: { idFromName: (n) => n, get: () => ({ fetch: (u, init) => guard.fetch(new Request(u, init)) }) } };
let ipN = 0; const freshIp = () => "198.51." + Math.floor(++ipN / 250) + "." + (ipN % 250 + 1);
const call = async (path, who, body, opt = {}) => { const h = { "user-agent": opt.ua || "planetCompute/0.1.0", "cf-connecting-ip": opt.ip || "203.0.113.9",
    ...(who ? { cookie: `pc_session=${TOK[who]}` } : {}), ...(opt.ct ? { "content-type": opt.ct } : {}) };
  const r = await W.fetch(new Request("https://planetcompute.ai" + path, { method: body === undefined ? "GET" : "POST", headers: h, body: body === undefined ? undefined : body }), env);
  return { status: r.status, j: await r.clone().json().catch(() => null), buf: Buffer.from(await r.arrayBuffer()) }; };
const reg = (who, buf, extra = {}, opt = {}) => call("/api/media/made", who, JSON.stringify({ sha512: sha512(buf), bytes: buf.length, name: "abc.png", kind: "image", device: "3eb5be2903d4",
  meta: { kind: "image", prompt: "A red fox in fresh snow", model: "zimage-turbo-q4k", seed: 42, width: 1920, height: 1080, steps: 8, seconds: 61.2, ran_on: "GPU", app: "0.1.0" }, ...extra }), { ct: "application/json", ip: opt.ip || freshIp(), ua: opt.ua });
const up = (who, buf, name, opt = {}) => call(`/api/uploads?name=${name}`, who, buf, { ct: "image/png", ip: opt.ip || freshIp() });


const CH = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const FF = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0";
async function signIn(email, ua, country) {           // the real code flow: the code from the email, then verify
  for (const [kk, v] of [...items]) if (v.sk && v.sk.S === "OTP") items.delete(kk);   // no 30 s wait between codes in the test
  const s1 = await W.fetch(new Request("https://planetcompute.ai/api/auth/start", { method: "POST", headers: { "content-type": "application/json", "user-agent": ua, "cf-connecting-ip": freshIp() },
    body: JSON.stringify({ email, turnstile: "good-token" }) }), env);
  const code = (JSON.stringify(mails.at(-1)).match(/\b(\d{6})\b/) || [])[1];
  const rq = new Request("https://planetcompute.ai/api/auth/verify", { method: "POST", headers: { "content-type": "application/json", "user-agent": ua, "cf-connecting-ip": freshIp() }, body: JSON.stringify({ email, code }) });
  Object.defineProperty(rq, "cf", { value: { country } });
  const r = await W.fetch(rq, env);
  return { status: r.status, cookie: ((r.headers.get("set-cookie") || "").match(/^([^;]+)/) || [])[1] || "", s1: s1.status };
}
const asCookie = async (cookie, path, body) => { const r = await W.fetch(new Request("https://planetcompute.ai" + path, { method: body ? "POST" : "GET",
  headers: { cookie, "content-type": "application/json", origin: "https://planetcompute.ai" }, body: body ? JSON.stringify(body) : undefined }), env); return { status: r.status, j: await r.json().catch(() => null) }; };
const alerts = () => mails.filter((m) => /^New sign-in to your PlanetCompute account$/.test(m.subject));
let a = await signIn("pat@newmail.example", CH, "US");
ok("1 a NEW account signs in (Chrome, US): signed in, no 'new sign-in' email", a.status === 200 && a.cookie && alerts().length === 0, a);
let b2 = await signIn("pat@newmail.example", CH, "US");
ok("2 again from the same browser and country: no email", b2.status === 200 && alerts().length === 0);
let c = await signIn("pat@newmail.example", FF, "DE");
const al = alerts()[0];
ok("3 from Firefox on Mac in DE: one email 'New sign-in ...' to the account's address, naming the browser and country, with the link to sign out",
  c.status === 200 && alerts().length === 1 && JSON.stringify(al.to).includes("pat@newmail.example") && /Firefox on Mac, DE/.test(al.text) && /\?auth=settings#sessions/.test(al.text), al && al.text);
await signIn("pat@newmail.example", FF, "DE");
ok("4 the same new place again: no second email", alerts().length === 1);
const uid = items.get(K("planetcompute-ai-user", { pk: { S: "EMAIL#pat@newmail.example" }, sk: { S: "EMAIL" } })).user_id.S;
const SV = "S".repeat(64);                                // an in-house server's own sign-in for this account (scope worker)
items.set(K("planetcompute-ai-user", { pk: { S: "SESSION#" + SV }, sk: { S: "SESSION" } }), { pk: { S: "SESSION#" + SV }, sk: { S: "SESSION" }, user_id: { S: uid }, scope: { S: "worker" }, expires_at: { N: String(Math.floor(Date.now() / 1000) + 86400) }, created_at: { S: new Date().toISOString() } });
let L = await asCookie(c.cookie, "/api/me/sessions");
const ss = L.j.sessions || [];
ok("5 'Where you are signed in': 5 (4 sign-ins + the server's), this one first and marked, browsers and countries named, the server marked",
  ss.length === 5 && ss[0].current && ss[0].browser === "Firefox on Mac" && ss[0].country === "DE" && ss.filter((x) => x.browser === "Chrome on Windows" && x.country === "US").length === 2 && ss.some((x) => x.kind === "server"), ss);
const one = ss.find((x) => x.browser === "Chrome on Windows");
let r = await asCookie(c.cookie, "/api/me/sessions/signout", { id: one.id });
L = await asCookie(c.cookie, "/api/me/sessions");
ok("6 Sign out one: it is gone from the list", r.status === 200 && L.j.sessions.length === 4 && !L.j.sessions.some((x) => x.id === one.id), r.j);
r = await asCookie(c.cookie, "/api/me/sessions/signout", { all_others: true });
L = await asCookie(c.cookie, "/api/me/sessions");
ok("7 Sign out everywhere else: only this one and the in-house server's are left", r.status === 200 && r.j.signed_out === 2 && L.j.sessions.length === 2 && L.j.sessions[0].current && L.j.sessions[1].kind === "server", [r.j, L.j.sessions]);
r = await asCookie(a.cookie, "/api/me");
ok("8 a signed-out browser's session no longer works (401)", r.status === 401, r.status);
r = await asCookie(c.cookie, "/api/me/sessions/signout", { id: ss[0].id });
ok("9 'Sign out' of this one by ID is refused (use Sign out)", r.status === 404);
r = await asCookie("pc_session=" + TOK.bob, "/api/me/sessions");
ok("10 another account sees only its own sign-ins (none of pat's)", r.status === 200 && !(r.j.sessions || []).some((x) => x.id === ss[0].id));
rmSync(dirname(tmp), { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
