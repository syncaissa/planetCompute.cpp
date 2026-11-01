// docs/TESTING.md test 74: my.planetcompute.ai (planetCompute/ways2SaveMoneyOnStorageAndViews.txt sections 8-14): saving to
// the cloud writes the link's folder (index.html, the picture or its WebP versions, meta.json, views.json) into the public
// bucket planetcompute-user-media; old /u/ links move there; trash / restore / download fallback; /api/view (Analytics Engine,
// no database) with its switches; CORS for the page's calls; the hourly totals (myCron). The given worker.js runs
// in-process with a fake B2 (two buckets), a fake DynamoDB, a fake Cloudflare API. No keys.
//   node scripts/test_my_planetcompute.mjs <worker.js>
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { createHash } from "node:crypto";
const dir = mkdtempSync(join(tmpdir(), "my-")), src = readFileSync(process.argv[2], "utf8");
writeFileSync(join(dir, "a.mjs"), src); writeFileSync(join(dir, "b.mjs"), src); writeFileSync(join(dir, "c.mjs"), src);
globalThis.WebSocketRequestResponsePair = class {};
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, x === undefined ? "" : JSON.stringify(x).slice(0, 600)); } };
const SECRET = "test-secret", sha = (s) => createHash("sha256").update(s).digest("hex"), sha1 = (b) => createHash("sha1").update(b).digest("hex");
const tok = (u) => "testsessiontoken-" + u + "-0123456789";
// ---- fake DynamoDB (the few expressions the code uses)
const items = new Map(), K = (t, k) => t + "|" + JSON.stringify(Object.keys(k).sort().map((x) => [x, k[x]]));
for (const u of ["alice", "bob"]) items.set(K("planetcompute-ai-user", { pk: { S: `SESSION#${sha(`${SECRET}|session|${tok(u)}`)}` }, sk: { S: "SESSION" } }),
  { user_id: { S: u }, expires_at: { N: String(Math.floor(Date.now() / 1000) + 3600) } });
function ddb(op, b) {
  const k = b.Key ? K(b.TableName, b.Key) : "", v = b.ExpressionAttributeValues || {}, nm = b.ExpressionAttributeNames || {};
  const N = (x) => (x.startsWith("#") ? nm[x] : x);
  if (op === "GetItem") return items.has(k) ? { Item: items.get(k) } : {};
  if (op === "PutItem") { items.set(K(b.TableName, b.Item.pk ? { pk: b.Item.pk, sk: b.Item.sk } : { user_id: b.Item.user_id, sk: b.Item.sk }), b.Item); return {}; }
  if (op === "DeleteItem") { items.delete(k); return {}; }
  if (op === "BatchGetItem") { const out = {}; for (const [t, r] of Object.entries(b.RequestItems)) out[t] = r.Keys.map((x) => items.get(K(t, x))).filter(Boolean); return { Responses: out }; }
  if (op === "UpdateItem") {
    const it = items.get(k) || { ...b.Key }, ue = b.UpdateExpression, attrs = {};
    let m;
    if ((m = /SET (#?\w+) = if_not_exists\((#?\w+), (:\w+)\)/.exec(ue))) { const a = N(m[1]); if (!it[a]) it[a] = v[m[3]]; attrs[a] = it[a]; }
    else if ((m = /^SET (#?\w+) = (:\w+)$/.exec(ue))) { const a = N(m[1]); it[a] = v[m[2]]; attrs[a] = it[a]; }
    else if ((m = /^REMOVE (#?\w+)$/.exec(ue))) delete it[N(m[1])];
    else if ((m = /^ADD (#?\w+) (:\w+)$/.exec(ue))) { const a = N(m[1]); it[a] = { N: String((it[a] ? +it[a].N : 0) + +v[m[2]].N) }; attrs[a] = it[a]; }
    items.set(k, it); return { Attributes: attrs };
  }
  return {};
}
// ---- fake B2: buckets pc (private, the originals) and planetcompute-user-media (public)
const BUCKETS = { pc: "bid-pc", "planetcompute-user-media": "bid-my" }, BNAME = { "bid-pc": "pc", "bid-my": "planetcompute-user-media" };
let myBucketExists = true, myKeySeesPc = true, fileSeq = 0;
const files = new Map();                                    // bucketId|name -> {fileId, data, type, info, at}
const put = (bid, name, data, type, info = {}) => { const f = { fileId: "f" + ++fileSeq, fileName: name, bid, data: Buffer.from(data), type, info, at: Date.now() }; files.set(bid + "|" + name, f); return f; };
const list = (bid, prefix) => [...files.values()].filter((f) => f.bid === bid && f.fileName.startsWith(prefix)).sort((a, b) => (a.fileName < b.fileName ? -1 : 1))
  .map((f) => ({ action: "upload", fileId: f.fileId, fileName: f.fileName, contentLength: f.data.length, contentSha1: sha1(f.data), uploadTimestamp: f.at, contentType: f.type }));
const myFile = (n) => files.get("bid-my|" + n);
const purged = [], aePoints = [];
let sqlSeen = "";
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url, method = init.method || (input.method) || "GET";
  if (/dynamodb\./.test(url)) {
    const h = init.headers || {}, op = String(h["x-amz-target"] || h["X-Amz-Target"] || "").split(".").pop();
    return J(ddb(op, JSON.parse(init.body || "{}")));
  }
  if (/b2_authorize_account/.test(url)) return J({ authorizationToken: "t", accountId: "a",
    apiInfo: { storageApi: { downloadUrl: "https://f.b2test", apiUrl: "https://api.b2test", ...(/Basic (.*)/.exec((init.headers || {}).authorization || "")[1] === btoa("k:s") ? { allowed: { buckets: [{ name: "pc", id: "bid-pc" }] } } : {}) } } });
  if (url.startsWith("https://api.b2test/b2api/v3/")) {
    const op = url.split("/").pop(), b = JSON.parse(init.body || "{}");
    if (op === "b2_list_buckets") { const id = BUCKETS[b.bucketName]; return J({ buckets: id && (id !== "bid-my" || myBucketExists) && (id !== "bid-pc" || myKeySeesPc) ? [{ bucketId: id, bucketName: b.bucketName }] : [] }); }
    if (op === "b2_get_upload_url") return J({ uploadUrl: "https://up.b2test/" + b.bucketId, authorizationToken: "u" });
    if (op === "b2_list_file_names" || op === "b2_list_file_versions") {
      let l = list(b.bucketId, b.prefix || "");
      if (b.delimiter) l = l.filter((f) => !f.fileName.slice((b.prefix || "").length).includes("/"));
      return J({ files: l.slice(0, b.maxFileCount || 1000), nextFileName: null });
    }
    if (op === "b2_delete_file_version") { for (const [k, f] of files) if (f.fileId === b.fileId) files.delete(k); return J({}); }
    if (op === "b2_copy_file") {
      const s = [...files.values()].find((f) => f.fileId === b.sourceFileId);
      if (!s) return J({ message: "no such file" }, 400);
      const d = put(b.destinationBucketId || s.bid, b.fileName, s.data, b.contentType || s.type, b.fileInfo || {});
      return J({ fileId: d.fileId });
    }
    return J({}, 400);
  }
  if (url.startsWith("https://up.b2test/")) {
    const bid = url.split("/").pop(), h = init.headers, body = Buffer.from(await new Response(init.body).arrayBuffer());
    if (h["X-Bz-Content-Sha1"] !== "do_not_verify" && sha1(body) !== h["X-Bz-Content-Sha1"]) return J({ message: "sha1" }, 400);
    const info = {}; for (const [k, x] of Object.entries(h)) if (/^X-Bz-Info-/i.test(k)) info[k.slice(10)] = decodeURIComponent(x);
    const f = put(bid, decodeURIComponent(h["X-Bz-File-Name"]), body, h["Content-Type"], info);
    return J({ fileId: f.fileId, fileName: f.fileName });
  }
  if (url.startsWith("https://f.b2test/file/")) {
    const [bn, ...rest] = url.slice("https://f.b2test/file/".length).split("/"), f = files.get(BUCKETS[bn] + "|" + decodeURIComponent(rest.join("/")));
    if (!f) return new Response("not found", { status: 404 });
    return new Response(method === "HEAD" ? null : f.data, { headers: { "content-type": f.type, "content-length": String(f.data.length), "x-bz-upload-timestamp": String(f.at) } });
  }
  if (/api\.cloudflare\.com.*purge_cache/.test(url)) { purged.push(...JSON.parse(init.body).files); return J({ success: true }); }
  if (/api\.cloudflare\.com.*analytics_engine\/sql/.test(url)) {
    sqlSeen = init.body; const after = (/index1 > '(\w+)'/.exec(init.body) || [])[1] || "", lim = +/LIMIT (\d+)/.exec(init.body)[1];
    const sums = {}; for (const p of aePoints) sums[p.indexes[0]] = (sums[p.indexes[0]] || 0) + p.doubles[0];
    const rows = Object.keys(sums).sort().filter((t) => t > after).slice(0, lim).map((t) => ({ t, v: sums[t] }));
    return J({ data: rows });
  }
  if (/b2test|backblaze/.test(url)) return new Response("{}", { status: 401 });
  return realFetch(input, init);
};
const env = (extra = {}) => ({ AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "y", SESSION_SECRET: SECRET, MAIL_FROM: "test@invalid",
  B2_MODELS_KEY_ID: "k", B2_MODELS_APP_KEY: "s", B2_MODELS_BUCKET: "pc", B2_MEDIA_KEY_ID: "mk", B2_MEDIA_APP_KEY: "ms", B2_MEDIA_BUCKET_NAME: "planetcompute-user-media", CF_API_TOKEN: "cf",
  MEDIA_VIEWS: { writeDataPoint: (p) => aePoints.push(p) }, ...extra });
const E = env();
const req = (path, o = {}) => new Request((o.host || "https://planetcompute.ai") + path, { method: o.method || "GET", redirect: "manual",
  headers: { ...(o.user ? { cookie: "pc_session=" + tok(o.user) } : {}), ...(o.headers || {}) }, body: o.body });
// a PNG as the program writes one (IHDR, IDAT, IEND): Save to cloud checks the parts and the size (test 84)
const PNG = (n) => { const ch = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); return Buffer.concat([l, Buffer.from(t), d, Buffer.alloc(4)]); };
  const h = Buffer.alloc(13); h.writeUInt32BE(1080, 0); h.writeUInt32BE(1350, 4); h[8] = 8; h[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ch("IHDR", h), ch("IDAT", Buffer.alloc(200 + n, n)), ch("IEND", Buffer.alloc(0))]); };
const WEBP = (n) => { const b = Buffer.alloc(40 + n, n); b.write("RIFF", 0); b.writeUInt32LE(32 + n, 4); b.write("WEBP", 8); b.write("VP8 ", 12); return b; };
// as the program does the moment it makes a picture (test 84): registered first, so Save to cloud keeps it
const register = (W, e, body, user = "alice") => W.fetch(req("/api/media/made", { method: "POST", user, headers: { "content-type": "application/json" },
  body: JSON.stringify({ sha512: createHash("sha512").update(body).digest("hex"), bytes: body.length, kind: "image", name: "x.png" }) }), e);
const upload = async (W, e, name, body, user = "alice", type = "image/png") => {
  if (Buffer.isBuffer(body)) await register(W, e, body, user);
  return W.fetch(req(`/api/uploads?name=${name}`, { method: "POST", user, body, headers: { "content-type": type, "content-length": String(body.length || body.size || 0) } }), e);
};

// ---- before the bucket exists: everything works as before (a separate copy of the module: its own caches)
{
  myBucketExists = false;
  const W0 = (await import(join(dir, "b.mjs"))).default;
  const r = await upload(W0, E, "early.png", PNG(1)), j = await r.json();
  ok("1 no planetcompute-user-media bucket yet: saving works and gives the old /u/ link", r.status === 200 && /^https:\/\/planetcompute\.ai\/u\/[A-Za-z0-9]{10}$/.test(j.url) && ![...files.keys()].some((k) => k.startsWith("bid-my|")), j);
  myBucketExists = true;
}
const W = (await import(join(dir, "a.mjs"))).default;
// ---- an older program: the file alone
let r = await upload(W, E, "fox.png", PNG(2)), j = await r.json();
const T1 = (/my\.planetcompute\.ai\/([A-Za-z0-9]{10})$/.exec(j.url) || [])[1];
ok("2 saving gives a my.planetcompute.ai/<token> link", r.status === 200 && !!T1, j);
ok("3 the folder: index.html, d.png (a server-side copy of the original), meta.json, views.json; the shared script and style",
  !!(myFile(`${T1}/index.html`) && myFile(`${T1}/d.png`) && myFile(`${T1}/meta.json`) && myFile(`${T1}/views.json`) && myFile("s-assets/my-v1.js") && myFile("s-assets/my-v1.css"))
  && myFile(`${T1}/d.png`).data.equals(PNG(2)), [...files.keys()]);
const page1 = myFile(`${T1}/index.html`).data.toString();
ok("4 the page: picture, details (Generated on: the user's own computer using Client), Download via planetcompute.ai, the new sentence, og:image, the script file, no inline script",
  page1.includes(`src="/${T1}/d.png"`) && page1.includes("<dt>Kind</dt><dd>Picture</dd>") && page1.includes(`https://planetcompute.ai/u/${T1}/download`)
  && page1.includes("Now use planetCompute.cpp to generate your own images") && page1.includes(`og:image" content="https://my.planetcompute.ai/${T1}/d.png"`)
  && page1.includes('<script src="/s-assets/my-v1.js" defer></script>') && !/<script>/.test(page1)
  && page1.includes("<dt>Generated on</dt><dd>the user's own computer using Client</dd>") && JSON.parse(myFile(`${T1}/meta.json`).data).generated_on === "the user's own computer using Client" && myFile(`${T1}/index.html`).type.startsWith("text/html"), page1.slice(0, 300));
ok("5 files are kept a year (b2-cache-control immutable), views.json 10 minutes", myFile(`${T1}/d.png`).info["b2-cache-control"] === "public, max-age=31536000, immutable"
  && myFile(`${T1}/views.json`).info["b2-cache-control"] === "public, max-age=600", [myFile(`${T1}/d.png`).info, myFile(`${T1}/views.json`).info]);
ok("6 Cloudflare's copies of the link are purged", purged.includes(`https://my.planetcompute.ai/${T1}`) && purged.includes(`https://my.planetcompute.ai/${T1}/index.html`) === false
  && purged.includes(`https://my.planetcompute.ai/file/planetcompute-user-media/${T1}/index.html`), purged.slice(0, 8));
// ---- the new program: multipart with the WebP versions + meta
const fd = new FormData();
fd.append("file", new Blob([PNG(3)], { type: "image/png" }), "cat.png");
fd.append("f", new Blob([WEBP(4)], { type: "image/webp" }), "f.webp"); fd.append("p", new Blob([WEBP(5)], { type: "image/webp" }), "p.webp");
fd.append("pt", new Blob([Buffer.from("not a webp at all, no")], { type: "image/webp" }), "pt.webp");
fd.append("meta", JSON.stringify({ width: 1080, height: 1350, model_name: "Z-Image <script>alert(1)</script>" }));
await register(W, E, PNG(3));
const fdReq = new Request("https://planetcompute.ai/api/uploads?name=cat.png", { method: "POST", body: fd, headers: { cookie: "pc_session=" + tok("alice") } });
r = await W.fetch(fdReq, E); j = await r.json();
const T2 = (/my\.planetcompute\.ai\/([A-Za-z0-9]{10})$/.exec(j.url) || [])[1];
const page2 = T2 && myFile(`${T2}/index.html`) ? myFile(`${T2}/index.html`).data.toString() : "";
ok("7 the program's WebP versions are published (f, p); a part that is not WebP is refused; no d.png copy",
  !!T2 && myFile(`${T2}/f.webp`) && myFile(`${T2}/p.webp`) && !myFile(`${T2}/pt.webp`) && !myFile(`${T2}/d.png`) && files.has(`bid-pc|public/users_uploads/alice/cat.png`), j);
ok("8 the page shows p.webp, zooms to f.webp, shows the resolution; the model name is escaped",
  page2.includes(`src="/${T2}/p.webp" data-full="/${T2}/f.webp"`) && page2.includes("<dd>1080 × 1350</dd>") && page2.includes("Z-Image &lt;script&gt;") && !page2.includes("<script>alert"), page2.slice(0, 200));
// ---- the same file again, under another name: no second copy
const before = [...files.keys()].filter((k) => k.startsWith("bid-pc|")).length;
r = await upload(W, E, "fox-again.png", PNG(2)); j = await r.json();
ok("9 the same file saved again: the same link, no second copy", r.status === 200 && j.url === `https://my.planetcompute.ai/${T1}` && j.same === "fox.png"
  && [...files.keys()].filter((k) => k.startsWith("bid-pc|")).length === before, j);
// ---- a link from before my.: /u/<token> makes the folder and moves there
put("bid-pc", "public/users_uploads/bob/old.png", PNG(6), "image/png");
items.set(K("planetcompute-ai-user", { pk: { S: "SHARE#OldLink234" }, sk: { S: "SHARE" } }), { pk: { S: "SHARE#OldLink234" }, sk: { S: "SHARE" }, uid: { S: "bob" }, name: { S: "old.png" } });
items.set(K("planetcompute-ai-user", { pk: { S: "UPLOAD#bob/old.png" }, sk: { S: "VIEWS" } }), { pk: { S: "UPLOAD#bob/old.png" }, sk: { S: "VIEWS" }, share: { S: "OldLink234" }, views: { N: "41" } });
r = await W.fetch(req("/u/OldLink234"), E);
ok("10 an old /u/ link: its folder is made (keeping its 41 views) and it moves to my. (301)", r.status === 301 && r.headers.get("location") === "https://my.planetcompute.ai/OldLink234"
  && !!myFile("OldLink234/d.png") && JSON.parse(myFile("OldLink234/views.json").data).views === 41 && myFile("OldLink234/index.html").data.toString().includes("41 views"), [r.status, r.headers.get("location")]);
// ---- views
aePoints.length = 0;
r = await W.fetch(req(`/api/view?t=${T1}&s=1`, { headers: { origin: "https://my.planetcompute.ai", "user-agent": "Mozilla/5.0" } }), E);
ok("11 /api/view: one data point (no database), open to any page (CORS *)", r.status === 204 && aePoints.length === 1 && aePoints[0].indexes[0] === T1 && r.headers.get("access-control-allow-origin") === "*", aePoints);
// security review L2: the sample size is the site's own setting (MEDIA_VIEWS_SAMPLE), never the number in the request
await W.fetch(req(`/api/view?t=${T1}&s=100`, { headers: { "user-agent": "Mozilla/5.0" } }), { ...E, MEDIA_VIEWS_SAMPLE: "100" });
await W.fetch(req(`/api/view?t=${T1}&s=1000000`, { headers: { "user-agent": "Mozilla/5.0" } }), E);
ok("12 a sampled view counts as the site's sample size; a sample size in the request is ignored",
  aePoints[1] && aePoints[1].doubles[0] === 100 && aePoints[2] && aePoints[2].doubles[0] === Number(E.MEDIA_VIEWS_SAMPLE || 1), aePoints);
await W.fetch(req(`/api/view?t=${T1}`, { headers: { "user-agent": "WhatsApp/2.0" } }), E);
await W.fetch(req(`/api/view?t=${T1}`, { headers: { "user-agent": "Mozilla/5.0" } }), env({ MEDIA_VIEWS_COUNT_ACTIVE: "0" }));
r = await W.fetch(req(`/api/view?t=bad`), E);
ok("13 not counted: link-preview bots, MEDIA_VIEWS_COUNT_ACTIVE=0; a bad token is refused", aePoints.length === 3 && r.status === 400, aePoints.length);
// ---- the page's calls with the visitor's sign-in
r = await W.fetch(req("/api/media/report", { method: "OPTIONS", headers: { origin: "https://my.planetcompute.ai", "access-control-request-method": "POST" } }), E);
ok("14 preflight from my.: allowed with credentials", r.status === 204 && r.headers.get("access-control-allow-origin") === "https://my.planetcompute.ai" && r.headers.get("access-control-allow-credentials") === "true");
r = await W.fetch(req("/api/media/report", { method: "POST", body: JSON.stringify({ link: `https://my.planetcompute.ai/${T1}`, reason: "Other", token: "x" }),
  headers: { origin: "https://my.planetcompute.ai", "content-type": "application/json" } }), E);
ok("15 a report from a my. page is not refused as cross-site (it gets to the form checks) and carries CORS", r.status === 400 && /reload/.test((await r.json()).error) && r.headers.get("access-control-allow-origin") === "https://my.planetcompute.ai");
r = await W.fetch(req("/api/media/report", { method: "POST", body: "{}", headers: { origin: "https://evil.example", "content-type": "application/json" } }), E);
ok("16 any other site is still refused", r.status === 403);
r = await W.fetch(req("/api/me", { user: "alice", headers: { origin: "https://my.planetcompute.ai" } }), E);
ok("17 /api/me from my.: answered with CORS for my. only", r.headers.get("access-control-allow-origin") === "https://my.planetcompute.ai");
// ---- trash, restore
purged.length = 0;
const call = async (path, body) => { const x = await W.fetch(req(path, { method: "POST", user: "alice", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), E); return { status: x.status, j: await x.json() }; };
let x = await call("/api/mycontent/trash", { name: "fox.png" });
const stub = myFile(`${T1}/index.html`) ? myFile(`${T1}/index.html`).data.toString() : "";
ok("18 trash: the folder's files go, index.html becomes a page that goes to planetcompute.ai, purged", x.status === 200 && !myFile(`${T1}/d.png`) && !myFile(`${T1}/meta.json`)
  && stub.includes('http-equiv="refresh" content="0;url=https://planetcompute.ai/"') && purged.includes(`https://my.planetcompute.ai/${T1}/d.png`), [x, stub.slice(0, 120)]);
x = await call("/api/mycontent/restore", { name: "fox.png" });
ok("19 restore: the link works again (folder made again)", x.status === 200 && !!myFile(`${T1}/d.png`) && myFile(`${T1}/index.html`).data.toString().includes(`src="/${T1}/d.png"`), x);
r = await W.fetch(req("/api/mycontent", { user: "alice" }), E); j = await r.json();
ok("20 My content lists my.planetcompute.ai links", j.files && j.files.find((f) => f.name === "fox.png").url === `https://my.planetcompute.ai/${T1}`, j.files);
// ---- download falls back when the original is gone
files.delete("bid-pc|public/users_uploads/alice/cat.png");
r = await W.fetch(req(`/u/${T2}/download`), E);
ok("21 Download: the original is gone -> f.webp on my.", r.status === 302 && r.headers.get("location") === `https://my.planetcompute.ai/${T2}/f.webp`, [r.status, r.headers.get("location")]);
// ---- hourly totals
aePoints.length = 0;
for (let i = 0; i < 3; i++) aePoints.push({ indexes: [T1], doubles: [1] });
aePoints.push({ indexes: ["OldLink234"], doubles: [100] });
await W.scheduled({ cron: "47 * * * *" }, E, { waitUntil: (p) => p });
await new Promise((res) => setTimeout(res, 50));
const cfg = myFile("s-assets/config.json");
ok("22 hourly: config.json from the variables", cfg && JSON.parse(cfg.data).active === true && JSON.parse(cfg.data).sample === 1, cfg && cfg.data.toString());
ok("23 hourly: views added in DynamoDB and views.json written (41 + 100 = 141; 3)", JSON.parse(myFile("OldLink234/views.json").data).views === 141
  && JSON.parse(myFile(`${T1}/views.json`).data).views === 3 && /FROM pc_media_views/.test(sqlSeen), [myFile("OldLink234/views.json").data.toString(), sqlSeen]);
await W.scheduled({ cron: "47 * * * *" }, env({ MEDIA_VIEWS_COUNT_ACTIVE: "0", MEDIA_VIEWS_MAX_AGE_DAYS: "365" }), { waitUntil: (p) => p });
await new Promise((res) => setTimeout(res, 50));
ok("24 switching counting off reaches config.json (pages stop calling)", JSON.parse(myFile("s-assets/config.json").data).active === false && JSON.parse(myFile("s-assets/config.json").data).max_age_days === 365);
const js = myFile("s-assets/my-v1.js").data.toString();
ok("25 the page script obeys config.json (active, max age, sample) and counts once per tab", /c\.active===false/.test(js) && /max_age_days/.test(js) && /sessionStorage/.test(js) && /api\/view\?t=/.test(js));
// ---- a key for the media bucket only: the original is streamed over instead of copied inside B2
{
  myKeySeesPc = false;
  const W3 = (await import(join(dir, "c.mjs"))).default;
  const r3 = await upload(W3, E, "bear.png", PNG(7)), j3 = await r3.json(), t3 = (/my\.planetcompute\.ai\/([A-Za-z0-9]{10})$/.exec(j3.url) || [])[1];
  ok("26 a key for the media bucket only: the picture is streamed over (d.png = the original) and the page made",
    !!t3 && myFile(`${t3}/d.png`) && myFile(`${t3}/d.png`).data.equals(PNG(7)) && !!myFile(`${t3}/index.html`), j3);
  myKeySeesPc = true;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
