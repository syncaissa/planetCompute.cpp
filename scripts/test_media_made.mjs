// docs/TESTING.md test 84 (user 2026-10-30): Save to cloud only for pictures and videos made here, and planetCompute is
// not a free storage. (a) The registry <prefix>media-made (user_id + SHA-512): the program registers each file it makes
// (POST /api/media/made); a pool picture is registered by the site when its owner fetches it; /api/uploads hashes the
// file and refuses one this account did not register ("This picture or video was not made here"). (b) Items 2-6: only
// PNG / WebM at the program's sizes (a PNG made here: known parts, at most 2048 px a side, nothing after its end);
// per-account limits (50 saves / 500 MB a day; 6 registrations a minute, 500 a day); per-IP limits (the ContactGuard);
// new accounts: a permanent address, one account per address (Gmail dots / +tags), Cloudflare Turnstile, 3 a day per IP;
// a global daily safety switch for accounts younger than 30 days, with one email to the admins.
// The given worker.js in Node with a fake DynamoDB, the real ContactGuard (in-memory storage), a fake SherpaHub room,
// a fake B2, a fake Turnstile and a fake mail service. No network.
//   node <repo>/scripts/test_media_made.mjs <worker.js>
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
const tmp = join(mkdtempSync(join(tmpdir(), "mm-")), "w.mjs"); writeFileSync(tmp, readFileSync(process.argv[2], "utf8")); globalThis.WebSocketRequestResponsePair = class {};
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

// ---- (a) the registry
let r = await reg(null, PNG);
ok("1 register: signed out -> 401", r.status === 401, r.status);
r = await call("/api/media/made", "alice", JSON.stringify({ sha512: "abc", kind: "image" }), { ct: "application/json" });
ok("2 register: a bad SHA-512 -> 400", r.status === 400, r);
r = await reg("alice", PNG);
const row = made()[0];
ok("3 register: the program's picture -> a row {user_id alice, sk SHA512#<128 hex>, at, kind, name, via program, device, model, the prompt's SHA-256 (never its words), seed, size, steps}",
  r.status === 200 && made().length === 1 && row.user_id.S === "alice" && row.sk.S === "SHA512#" + sha512(PNG) && row.via.S === "program" && row.device.S === "3eb5be2903d4"
  && row.model.S === "zimage-turbo-q4k" && !row.prompt && row.prompt_sha256.S === sha("prompt|A red fox in fresh snow") && row.seed.S === "42" && row.width.N === "1920" && row.steps.N === "8" && /^\d{4}-/.test(row.at.S), row);
r = await reg("alice", PNG, { name: "other.png" });
ok("4 register again: ok (already), the first row kept", r.status === 200 && r.j.already && made().length === 1 && made()[0].name.S === "abc.png");
r = await up("alice", PNG, "planetCompute-abc.png");
ok("5 Save to cloud of the registered picture: kept (uploaded to B2, a link)", r.status === 200 && uploads === 1 && r.j && r.j.ok, r.j);
r = await up("alice", png(1024, 1024, { fill: 5 }), "planetCompute-holiday.png");
ok("6 Save to cloud of a picture never registered (copied into the folder): 403 'This picture or video was not made here', nothing uploaded",
  r.status === 403 && r.j.not_made_here && /^This picture or video was not made here/.test(r.j.error) && uploads === 1, r.j);
r = await up("bob", PNG, "planetCompute-abc.png");
ok("7 the same picture from ANOTHER account (bob did not make it): 403 not made here", r.status === 403 && r.j.not_made_here && uploads === 1, r.j);
r = await up("alice", PHOTO, "planetCompute-fake.png");
ok("8 a JPEG named .png: 400 'not the picture ... its name says'", r.status === 400 && /not the picture, video or song its name says/.test(r.j.error) && uploads === 1, r.j);
const tampered = Buffer.from(PNG); tampered[60] ^= 1;
r = await up("alice", tampered, "planetCompute-abc2.png");
ok("9 the registered picture changed by one byte: 403 not made here", r.status === 403 && r.j.not_made_here, r.j);
r = await call("/api/pool/media/file?hub=sherpa:hub:u1:3eb5be2903aa&job=00000000000000b2", "alice");
const prow = made().find((x) => x.sk.S === "SHA512#" + sha512(POOLPNG));
ok("10 a pool picture fetched by its owner: the bytes as stored, and registered for alice (via pool, its prompt's SHA-256 and model)",
  r.status === 200 && Buffer.compare(r.buf, POOLPNG) === 0 && prow && prow.user_id.S === "alice" && prow.via.S === "pool" && !prow.prompt && prow.prompt_sha256.S === sha("prompt|A lighthouse in a storm") && prow.name.S === "pool-00000000000000b2.png", prow);
r = await up("alice", POOLPNG, "planetCompute-pool-00000000000000b2.png");
ok("11 Save to cloud of that pool picture: kept", r.status === 200 && uploads === 2, r.j);
r = await call("/api/pool/media/file?hub=sherpa:hub:u1:3eb5be2903aa&job=00000000000000b2", "bob");
ok("12 another account cannot fetch (so cannot register) alice's pool picture: 404", r.status === 404 && !made().some((x) => x.user_id.S === "bob"));
r = await reg("alice", png(800, 800, { fill: 11 }), {}, { ua: "curl/8" });
ok("13 a registration not from the program is kept as via 'api' (visible for review)", r.status === 200 && made().find((x) => x.sk.S === "SHA512#" + sha512(png(800, 800, { fill: 11 }))).via.S === "api");

// ---- (b2) only what the program makes, at its sizes
const seedReg = (u, buf) => items.set(K("planetcompute-ai-media-made", { user_id: { S: u }, sk: { S: "SHA512#" + sha512(buf) } }), { user_id: { S: u }, sk: { S: "SHA512#" + sha512(buf) }, via: { S: "program" } });
const tryPng = async (buf, name = "planetCompute-t.png") => { seedReg("alice", buf); return up("alice", buf, name); };
r = await tryPng(png(2050, 1024, { fill: 21 }));
ok("14 a registered PNG of 2050 px: 400 'at most 2048 px a side'", r.status === 400 && /2050 x 1024 px .*at most 2048/.test(r.j.error), r.j);
r = await tryPng(png(1024, 1024, { fill: 22, after: "PK\u0003\u0004 a zip file hidden after the picture" }));
ok("15 a registered PNG with data after its end (a file hidden in it): 400", r.status === 400 && /data after the end of the picture/.test(r.j.error), r.j);
r = await tryPng(png(1024, 1024, { fill: 23, extra: "zzIP" }));
ok("16 a registered PNG with an unknown part: 400", r.status === 400 && /a part pictures made here do not have \(zzIP\)/.test(r.j.error), r.j);
seedReg("alice", PHOTO); r = await up("alice", PHOTO, "planetCompute-photo.jpg");
ok("17 a JPEG (even registered): 400 'Only pictures (PNG) and videos (WebM) made with planetCompute'", r.status === 400 && /^Only pictures \(PNG\) and videos \(WebM\)/.test(r.j.error), r.j);
r = await tryPng(png(2048, 2048, { fill: 24, big: 16 * 1024 * 1024 }));
ok("18 a registered PNG over 15 MB: 413", r.status === 413 && /at most 15 MB/.test(r.j.error), r.j);

// the prompt is for its creator only: no prompt inside a shared file (the engine's PNG "parameters" / WebM COMMENT)
r = await tryPng(png(1024, 1024, { fill: 25, extra: "tEXt" }));
ok("18b a registered PNG with hidden text (the engine's prompt): 400 'it carries hidden text (its prompt)'", r.status === 400 && /hidden text \(its prompt\)/.test(r.j.error), r.j);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(100, 1), Buffer.from("COMMENT"), Buffer.from([0x44, 0x87, 0x85]), Buffer.from("a fox"), Buffer.alloc(100, 2)]);
seedReg("alice", WEBM); r = await call("/api/uploads?name=planetCompute-v.webm", "alice", WEBM, { ct: "video/webm", ip: freshIp() });
ok("18c a registered WebM with the prompt in its COMMENT tag: 400", r.status === 400 && /video cannot be saved .*hidden text \(its prompt\)/.test(r.j.error), r.j);

// content safety (issue 4): a sexual prompt is refused for the pool and not registered; "leave out" words are not checked
r = await call("/api/media/made", "alice", JSON.stringify({ sha512: sha512(png(333, 333, { fill: 91 })), bytes: 10, kind: "image", meta: { prompt: "A NUDE woman, film photo" } }), { ct: "application/json", ip: freshIp() });
ok("18d a file made from a sexual prompt is not registered (400 'does not make sexual or explicit pictures')", r.status === 400 && /does not make sexual or explicit/.test(r.j.error), r.j);
r = await call("/api/media/made", "alice", JSON.stringify({ sha512: sha512(png(334, 333, { fill: 92 })), bytes: 10, kind: "image", meta: { prompt: "Essex countryside at dawn", negative: "nude, nsfw" } }), { ct: "application/json", ip: freshIp() });
ok("18e an ordinary prompt with 'nude, nsfw' only in what to leave out: registered; whole words only (Essex)", r.status === 200, r.j);
r = await call("/api/pool/media", "alice", JSON.stringify({ task: "image", model: "zimage-turbo-q4k", prompt: "sexy topless model" }), { ct: "application/json", ip: freshIp() });
ok("18f a pool request with a sexual prompt: 400 with the same words", r.status === 400 && /does not make sexual or explicit/.test(JSON.stringify(r.j)), r.j);

// ---- (b3) per-account limits
const c0 = uploads;
items.set(K("planetcompute-ai-media-made", { user_id: { S: "alice" }, sk: { S: "COUNT#save#" + new Date().toISOString().slice(0, 10) } }),
  { user_id: { S: "alice" }, sk: { S: "COUNT#save#" + new Date().toISOString().slice(0, 10) }, n: { N: "50" }, b: { N: "1000" } });
r = await tryPng(png(640, 640, { fill: 31 }));
ok("19 the 51st save today: 429 'Today's limit is reached (50 files or 500 MB ...)', nothing uploaded", r.status === 429 && /Today's limit is reached \(50 files or 500 MB/.test(r.j.error) && uploads === c0, r.j);
items.delete(K("planetcompute-ai-media-made", { user_id: { S: "alice" }, sk: { S: "COUNT#save#" + new Date().toISOString().slice(0, 10) } }));
items.set(K("planetcompute-ai-media-made", { user_id: { S: "alice" }, sk: { S: "COUNT#save#" + new Date().toISOString().slice(0, 10) } }),
  { user_id: { S: "alice" }, sk: { S: "COUNT#save#" + new Date().toISOString().slice(0, 10) }, n: { N: "3" }, b: { N: String(500 * 1024 * 1024 - 100) } });
r = await tryPng(png(640, 640, { fill: 32 }));
ok("20 a save that would pass 500 MB today: 429", r.status === 429 && uploads === c0, r.j);
items.delete(K("planetcompute-ai-media-made", { user_id: { S: "alice" }, sk: { S: "COUNT#save#" + new Date().toISOString().slice(0, 10) } }));
let codes = []; for (let i = 0; i < 7; i++) codes.push((await reg("bob", png(300 + i, 300, { fill: 40 + i }))).status);
ok("21 registrations: 6 a minute per account, the 7th -> 429 (the program keeps it and tries again)", codes.slice(0, 6).every((x) => x === 200) && codes[6] === 429, codes);
const cnt = (u, sk) => { const it = items.get(K("planetcompute-ai-media-made", { user_id: { S: u }, sk: { S: sk } })); return it && it.expires ? +it.expires.N : 0; };
ok("22 the counters expire by themselves (TTL 'expires' set)", cnt("bob", "COUNT#reg#" + new Date().toISOString().slice(0, 10)) > Date.now() / 1000 + 86400);

// ---- (b4) per-IP limits (the ContactGuard)
codes = []; for (let i = 0; i < 31; i++) codes.push((await up("bob", png(500 + i, 500, { fill: 60 }), "planetCompute-x.png", { ip: "192.0.2.77" })).status);
ok("23 saves from one IP: 30 a minute, the 31st -> 429 'Too many saves to the cloud from your network'", codes[30] === 429 && codes.slice(0, 30).every((x) => x !== 429), codes.slice(28));
r = await up("bob", PNG, "planetCompute-x.png", { ip: "192.0.2.77" });
ok("23b its words", /Too many saves to the cloud from your network/.test(r.j.error), r.j);

// ---- (b5) new accounts
const start = (email, opt = {}) => call("/api/auth/start", null, JSON.stringify({ email, ...(opt.ts ? { turnstile: opt.ts } : {}) }), { ct: "application/json", ip: opt.ip || "203.0.113.50", ua: "Mozilla/5.0" });
r = await start("alice@example.com");
ok("24 an existing account signs in without the check (a code is sent)", r.status === 200 && mails.length === 1, r);
r = await start("sam@newmail.example");
ok("25 a NEW address without the check: 428 need_turnstile (with the site key and the sign-up page), no code sent", r.status === 428 && r.j.need_turnstile && r.j.sitekey === "site" && /\?auth=signup$/.test(r.j.signup_url) && mails.length === 1, r.j);
r = await start("sam@newmail.example", { ts: "bad-token" });
ok("26 a failed check: 428 again, no code", r.status === 428 && /did not pass/.test(r.j.error) && mails.length === 1, r.j);
r = await start("sam@mailinator.com", { ts: "good-token" });
ok("27 a throwaway address: 400 'Please use a permanent email address'", r.status === 400 && /permanent email address/.test(r.j.error), r.j);
r = await start("J.A.N.E.Doe+promo@googlemail.com", { ts: "good-token" });
ok("28 the same Gmail with dots and a +tag: 409 'An account already exists for this address (j…@gmail.com)'", r.status === 409 && /already exists for this address \(j…@gmail\.com\)/.test(r.j.error), r.j);
r = await start("sam@newmail.example", { ts: "good-token" });
const code = (JSON.stringify(mails.at(-1)).match(/\b(\d{6})\b/) || [])[1];
ok("29 a new address with the check passed: the code is sent", r.status === 200 && mails.length === 2 && code, r.j);
r = await call("/api/auth/verify", null, JSON.stringify({ email: "sam@newmail.example", code }), { ct: "application/json", ip: "203.0.113.50", ua: "Mozilla/5.0" });
const canon = items.get(K("planetcompute-ai-user", { pk: { S: "CANON#sam@newmail.example" }, sk: { S: "CANON" } }));
ok("30 the code makes the account, with its one-per-address marker (CANON#)", r.status === 200 && canon && canon.email.S === "sam@newmail.example", [r.status, r.j]);
codes = []; for (const e of ["a1@newmail.example", "a2@newmail.example", "a3@newmail.example", "a4@newmail.example"]) codes.push((await start(e, { ts: "good-token", ip: "203.0.113.60" })).status);
ok("31 new accounts from one IP: 3 a day, the 4th -> 429", codes.join() === "200,200,200,429", codes);

// ---- (b6) the global safety switch
const day = new Date().toISOString().slice(0, 10);
items.set(K("planetcompute-ai-media-made", { user_id: { S: "GLOBAL" }, sk: { S: "COUNT#save#" + day } }), { user_id: { S: "GLOBAL" }, sk: { S: "COUNT#save#" + day }, n: { N: "999" }, b: { N: String(20 * 1024 ** 3 - 100) } });
const m0 = mails.length, u0 = uploads, NB = png(700, 700, { fill: 51 });
seedReg("newbie", NB); r = await up("newbie", NB, "planetCompute-nb.png");
ok("32 over 20 GB today: an account younger than 30 days waits: 503 'paused for new accounts today'", r.status === 503 && /paused for new accounts today/.test(r.j.error) && uploads === u0, r.j);
const OB = png(710, 700, { fill: 52 }); seedReg("alice", OB); r = await up("alice", OB, "planetCompute-ob.png");
const alert = mails.slice(m0).find((m) => /passed 20 GB today/.test(m.subject));
ok("33 an older account still saves; crossing 20 GB emails the admins once", r.status === 200 && uploads === u0 + 1 && alert && JSON.stringify(alert.to).includes("admin@example.com"), [r.status, mails.slice(m0).map((m) => m.subject)]);
const OB2 = png(720, 700, { fill: 53 }); seedReg("alice", OB2); await up("alice", OB2, "planetCompute-ob2.png");
ok("34 no second email the same day", mails.slice(m0).filter((m) => /passed 20 GB today/.test(m.subject)).length === 1);
rmSync(dirname(tmp), { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
