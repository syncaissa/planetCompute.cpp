// Test of Save to cloud, the shared page and My content (TESTING.md test 21): runs the website Worker's own code in Node, with a throwaway DynamoDB
// table <prefix>user (default prefix pctest-ai-; created here, deleted at the end) and the REAL B2 bucket: the test
// file goes to public/users_uploads/c3c3c3c3c3c3/ and is deleted at the end.
//   node scripts/test_uploads.mjs <path to worker.js>      (AWS + B2 keys in the environment, e.g. from ../.env)
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";

const src = resolve(process.argv[2] || "website/worker.js");
const tmp = join(mkdtempSync(join(tmpdir(), "pcuploads-")), "worker.mjs");
copyFileSync(src, tmp);
const worker = (await import(tmp)).default;
const PREFIX = process.env.DDB_PREFIX || "pctest-ai-";
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_REGION: process.env.AWS_REGION || "us-east-1", DDB_PREFIX: PREFIX, SESSION_SECRET: "test-" + randomBytes(8).toString("hex"),
  ADMIN_EMAILS: "", MAIL_FROM: "test@planetcompute.ai",
  CONTACT_DRY_RUN: "1",                                   // the Report pop-up: no email to the admins
  // the rate limits (ContactGuard) always say yes here; they are the same code as for Report Bugs (TESTING test 13)
  CONTACT: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response(JSON.stringify({ ok: true })) }) },
  B2_MODELS_KEY_ID: process.env.B2_KEY_ID, B2_MODELS_APP_KEY: process.env.B2_APPLICATION_KEY, B2_MODELS_BUCKET: process.env.B2_BUCKET_NAME };
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
async function b2(name, body) {                           // the B2 API with the test's own login, for the clean-up
  if (!b2.a) b2.a = await (await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account",
    { headers: { authorization: "Basic " + btoa(env.B2_MODELS_KEY_ID + ":" + env.B2_MODELS_APP_KEY) } })).json();
  const r = await fetch(`${b2.a.apiInfo.storageApi.apiUrl}/b2api/v3/${name}`, { method: "POST", headers: { authorization: b2.a.authorizationToken }, body: JSON.stringify(body) });
  return r.json();
}

const S = (v) => ({ S: String(v) });
const MT = PREFIX + "reported-media", MM = PREFIX + "media-made";
const UT = PREFIX + "user", UID = "c3c3c3c3c3c3", NAME = "pctest-" + Date.now() + ".png";
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra === undefined ? "" : JSON.stringify(extra).slice(0, 300)); } };
try {
  try { await rawDdb("DescribeTable", { TableName: UT }); } catch {
    await rawDdb("CreateTable", { TableName: UT, BillingMode: "PAY_PER_REQUEST", KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }] });
    for (let i = 0; i < 60; i++) { if ((await rawDdb("DescribeTable", { TableName: UT })).Table.TableStatus === "ACTIVE") break; await new Promise((r) => setTimeout(r, 2000)); }
  }
  // the reported-media table as CreateTables.py makes it (keys and the four indexes)
  try { await rawDdb("DescribeTable", { TableName: MT }); } catch {
    const g = (n, pk, sk) => ({ IndexName: n, KeySchema: [{ AttributeName: pk, KeyType: "HASH" }, { AttributeName: sk, KeyType: "RANGE" }], Projection: { ProjectionType: "KEYS_ONLY" } });
    await rawDdb("CreateTable", { TableName: MT, BillingMode: "PAY_PER_REQUEST", KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
      AttributeDefinitions: ["pk", "sk", "list_pk", "list_sk", "status_pk", "token", "owner_user_id", "created_at"].map((a) => ({ AttributeName: a, AttributeType: "S" })),
      GlobalSecondaryIndexes: [g("reports-by-month", "list_pk", "list_sk"), g("reports-by-status", "status_pk", "list_sk"), g("by-token", "token", "created_at"), g("by-owner", "owner_user_id", "created_at")] });
    for (let i = 0; i < 90; i++) { if ((await rawDdb("DescribeTable", { TableName: MT })).Table.TableStatus === "ACTIVE") break; await new Promise((r) => setTimeout(r, 2000)); }
  }
  // the registry of what was made here (test 84): only a registered file may be saved
  try { await rawDdb("DescribeTable", { TableName: MM }); } catch {
    await rawDdb("CreateTable", { TableName: MM, BillingMode: "PAY_PER_REQUEST", KeySchema: [{ AttributeName: "user_id", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
      AttributeDefinitions: [{ AttributeName: "user_id", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }] });
    for (let i = 0; i < 60; i++) { if ((await rawDdb("DescribeTable", { TableName: MM })).Table.TableStatus === "ACTIVE") break; await new Promise((r) => setTimeout(r, 2000)); }
  }
  // the test user is an admin (for the Reported media tab)
  await rawDdb("PutItem", { TableName: UT, Item: { pk: S(`USER#${UID}`), sk: S("PROFILE"), user_id: S(UID), IsAdmin: { BOOL: true }, primary_email: S("pctest-owner@planetcompute.ai") } });
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(`${env.SESSION_SECRET}|session|${token}`).digest("hex");
  await rawDdb("PutItem", { TableName: UT, Item: { pk: S(`SESSION#${hash}`), sk: S("SESSION"), user_id: S(UID), expires_at: { N: String(Math.floor(Date.now() / 1000) + 3600) } } });
  const cookie = readFileSync(src, "utf8").match(/const COOKIE = "([^"]+)"/)[1] + "=" + token;
  const png = readFileSync(new URL("../client/icons/32x32.png", import.meta.url));
  const call = (path, o = {}) => worker.fetch(new Request("https://planetcompute.ai" + path, { method: o.method || "POST", body: o.body,
    headers: { ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.origin ? { origin: o.origin } : {}), ...(o.ua ? { "user-agent": o.ua } : {}),
      "content-type": o.type || "application/octet-stream" } }), env);
  const post = (path, body) => call(path, { body: JSON.stringify(body), cookie, type: "application/json" });
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) test_uploads";
  // as the program does the moment it makes a picture (test 84): register it, so Save to cloud keeps it
  await post("/api/media/made", { sha512: createHash("sha512").update(png).digest("hex"), bytes: png.length, kind: "image", name: NAME });

  let r = await call("/api/uploads?name=" + NAME, { body: png });
  ok("1 not signed in: 401", r.status === 401, r.status);
  r = await call("/api/uploads?name=" + NAME, { body: png, cookie, origin: "https://evil.example" });
  ok("2 another web site: 403", r.status === 403, r.status);
  r = await call("/api/uploads?name=../x.png", { body: png, cookie });
  ok("3 a path in the name: 400", r.status === 400, r.status);
  r = await call("/api/uploads?name=run.exe", { body: png, cookie });
  ok("4 not a picture or video: 400", r.status === 400, r.status);
  r = await call("/api/uploads?name=" + NAME, { body: new Uint8Array(0), cookie });
  ok("5 empty file: 400", r.status === 400, r.status);
  r = await call("/api/uploads?name=" + NAME, { body: png, cookie });
  const j = await r.json().catch(() => ({}));
  const L = (j.url || "").replace("https://planetcompute.ai", ""), TOK = L.slice(3);
  ok("6 saved: 200 with a link that shows neither the user ID nor the file name (/u/<10 letters and digits>)",
    r.status === 200 && /^\/u\/[A-Za-z0-9]{10}$/.test(L) && !j.url.includes(UID) && !j.url.includes(NAME), j);
  r = await call(`${L}/file`, { method: "GET" });
  const got = Buffer.from(await r.arrayBuffer());
  ok("7 <link>/file gives the same bytes as image/png", r.status === 200 && r.headers.get("content-type") === "image/png" && got.equals(png), [r.status, r.headers.get("content-type"), got.length, png.length]);
  r = await call(`/u/d4d4d4d4d4d4/${NAME}`, { method: "GET" });
  let r2 = await call(`/u/Zz9Zz9Zz9Z`, { method: "GET" });
  ok("8 someone else's folder, or a made-up link: 404", r.status === 404 && r2.status === 404, [r.status, r2.status]);
  r = await call(`/u/${UID}/index.json`, { method: "GET" });
  ok("9 only picture and video names are served", r.status === 404, r.status);
  r = await call(`/u/${UID}/${NAME}`, { method: "GET", ua: UA });
  r2 = await call(`/u/${UID}/${NAME}/file`, { method: "GET" });
  ok("9b a first-style link (user ID and name) redirects to the new link", r.status === 301 && (r.headers.get("location") || "").endsWith(L)
    && (r2.headers.get("location") || "").endsWith(L + "/file"), [r.status, r.headers.get("location"), r2.headers.get("location")]);
  r = await call("/api/uploads?name=" + NAME, { body: png, cookie });
  ok("9c the same file saved again keeps its link", ((await r.json().catch(() => ({}))).url || "").endsWith(L));
  r = await call(L, { method: "GET", ua: UA });
  let page = await r.text();
  ok("9d the page shows neither the user ID nor the file name", !page.includes(UID) && !page.includes(NAME), page.match(new RegExp(".{40}(" + UID + "|" + NAME + ").{40}")));
  ok("10 the link is the shared page: Made with planetCompute, AI-generated, Picture, size, Download, Report abuse, 1 view",
    r.status === 200 && (r.headers.get("content-type") || "").startsWith("text/html") && r.headers.get("x-robots-tag") === "noindex"
    && ["Made with planetCompute", "AI-generated", "<dd>Picture</dd>", "<dd>planetCompute.cpp</dd>", `${L}/download`, 'id="rb"', "Made with planetCompute.ai", "1 view<", 'id="zimg"', 'id="fb"']
      .every((t) => page.includes(t)), [r.status, page.slice(0, 200)]);
  r = await call(L, { method: "GET", ua: UA });
  page = await r.text();
  ok("11 the same visitor again within 24 hours: still 1 view", page.includes("1 view<") && !page.includes("2 views"));
  r = await call(L, { method: "GET", ua: "Slackbot-LinkExpanding 1.0" });
  r = await call(L, { method: "GET", ua: "Mozilla/5.0 (Macintosh) another visitor" });
  page = await r.text();
  ok("12 a link preview bot is not counted, another visitor is: 2 views", page.includes("2 views<"), page.match(/👁 [^<]*/));
  r = await call(`${L}/views`, { method: "GET" });
  const vj = await r.json().catch(() => ({}));
  ok("13 <link>/views: {views: 2}", r.status === 200 && vj.views === 2, vj);
  r = await call(`${L}/download`, { method: "GET" });
  const dl = Buffer.from(await r.arrayBuffer());
  ok("14 <link>/download: an attachment with the same bytes, named planetCompute-<token>.png", r.status === 200 && (r.headers.get("content-disposition") || "") === `attachment; filename="planetCompute-${TOK}.png"` && dl.equals(png),
    [r.status, r.headers.get("content-disposition")]);
  r = await call(`/reportabuse?url=${encodeURIComponent("https://planetcompute.ai" + L)}`, { method: "GET" });
  ok("15 Report abuse opens the contact form with the link", r.status === 302 && (r.headers.get("location") || "").endsWith(`/?report=${encodeURIComponent("https://planetcompute.ai" + L)}#ask`),
    [r.status, r.headers.get("location")]);
  // The Report pop-up on the shared page, and the admin page's Reported media tab
  const wait = (ms) => new Promise((x) => setTimeout(x, ms));
  let ft = (await (await call("/api/contact/token", { method: "GET" })).json()).token;
  r = await call("/api/media/report", { body: JSON.stringify({ link: L, reason: "Spam or scam", token: ft }), type: "application/json" });
  ok("R1 Report pop-up: sent at once is refused (the form must be open 3 s)", r.status === 400, r.status);
  await wait(3200);
  r = await call("/api/media/report", { body: JSON.stringify({ link: L, token: ft }), type: "application/json" });
  const r3 = await call("/api/media/report", { body: JSON.stringify({ link: L, reason: "Other", details: "bad", token: ft }), type: "application/json" });
  ok("R2 no reason, or Other without details: 400", r.status === 400 && r3.status === 400, [r.status, r3.status]);
  r = await call("/api/media/report", { body: JSON.stringify({ link: "/u/Zz9Zz9Zz9Z", reason: "Spam or scam", token: ft }), type: "application/json" });
  ok("R3 a made-up link: 404", r.status === 404, r.status);
  r = await call("/api/media/report", { body: JSON.stringify({ link: L, reason: "Spam or scam", details: "test report from test_uploads", token: ft }), type: "application/json", ua: UA });
  const rep1 = await r.json().catch(() => ({}));
  ok("R4 a report from a signed-out visitor (no email needed): saved with a report number", r.status === 200 && /^[0-9a-f]{10}$/.test(rep1.report_id || ""), rep1);
  r = await call("/api/media/report", { body: JSON.stringify({ link: L, reason: "Spam or scam", token: ft }), type: "application/json", origin: "https://evil.example" });
  ok("R5 a report from another web site: 403", r.status === 403, r.status);
  r = await call(`/api/admin/media/lookup?q=${encodeURIComponent("https://planetcompute.ai" + L)}`, { method: "GET" });
  ok("R6 admin lookup signed out: 401", r.status === 401, r.status);
  r = await call(`/api/admin/media/lookup?q=${encodeURIComponent("https://planetcompute.ai" + L)}`, { method: "GET", cookie });
  const lk = await r.json().catch(() => ({}));
  ok("R7 admin lookup of the link: owner user ID and email, real file name, live, size, its report", r.status === 200 && lk.user_id === UID
    && lk.owner_email === "pctest-owner@planetcompute.ai" && lk.file_name === NAME && lk.file_state === "live" && lk.bytes === png.length
    && (lk.reports || []).some((x) => x.report_id === rep1.report_id && x.reason === "Spam or scam"), lk);
  r = await call(`/api/admin/media/lookup?q=${TOK}`, { method: "GET", cookie });
  const lk2 = await r.json().catch(() => ({}));
  ok("R8 admin lookup by the bare code, and by a first-style link", lk2.file_name === NAME
    && (await (await call(`/api/admin/media/lookup?q=${encodeURIComponent("https://planetcompute.ai/u/" + UID + "/" + NAME)}`, { method: "GET", cookie })).json()).token === TOK, lk2);
  let rows = [];
  for (let i = 0; i < 10 && !rows.some((x) => x.report_id === rep1.report_id); i++) {   // the index fills within a second or two
    rows = ((await (await call("/api/admin/media?limit=50", { method: "GET", cookie })).json()).rows || []); if (i) await wait(1000);
  }
  const row = rows.find((x) => x.report_id === rep1.report_id) || {};
  ok("R9 Reported media list: the report, new, with owner, file name, reason and the reporter's details", row.status === "new" && row.owner_user_id === UID
    && row.file_name === NAME && row.reason === "Spam or scam" && row.message === "test report from test_uploads" && row.source === "Report button", row);
  r = await call("/api/admin/media/update", { body: JSON.stringify({ report_id: rep1.report_id, status: "reviewing", comment: "looking at it" }), cookie, type: "application/json" });
  const up = await r.json().catch(() => ({}));
  let log = []; try { log = JSON.parse((up.report || {}).comments || "[]"); } catch (e) {}
  ok("R10 status and comment saved, each kept with its time and the admin", r.status === 200 && up.report.status === "reviewing" && log.length === 2
    && log[0].kind === "status" && log[1].text === "looking at it" && log.every((x) => x.by === UID && x.at), up);
  rows = [];
  for (let i = 0; i < 10 && !rows.some((x) => x.report_id === rep1.report_id); i++) {
    rows = ((await (await call("/api/admin/media?filter=reviewing", { method: "GET", cookie })).json()).rows || []); if (i) await wait(1000);
  }
  const byLink = ((await (await call(`/api/admin/media?q=${encodeURIComponent("https://planetcompute.ai" + L)}`, { method: "GET", cookie })).json()).rows || []);
  ok("R11 the list filtered by status, and searched by the link", rows.some((x) => x.report_id === rep1.report_id) && byLink.some((x) => x.report_id === rep1.report_id), [rows.length, byLink.length]);
  r = await call("/admin", { method: "GET" });
  page = await r.text();
  ok("R12 the admin page has the Reported media tab with the lookup", page.includes('data-tab="media">Reported media') && page.includes('id="q-lookup"'), r.status);
  // Take down (admin): the file goes to the evidence folder, the link shows Removed, the reports say Taken down; Undo
  r = await call("/api/admin/media/takedown", { body: JSON.stringify({ q: L }), cookie, type: "application/json" });
  ok("T1 Take down needs a reason", r.status === 400, r.status);
  r = await call("/api/admin/media/takedown", { body: JSON.stringify({ q: L, note: "test take-down" }), cookie, type: "application/json" });
  const td = await r.json().catch(() => ({}));
  ok("T2 Take down: the file is in the evidence folder, with who and why", r.status === 200 && td.file_state === "removed" && td.removed_by && td.removed_note === "test take-down" && td.bytes === png.length, td);
  r = await call(L, { method: "GET", ua: UA });
  r2 = await call(`${L}/file`, { method: "GET" });
  page = await r.text();
  ok("T3 the link shows Removed (410), the file is not served", r.status === 410 && page.includes("This was removed.") && r2.status === 410, [r.status, r2.status]);
  const rpt = (((await (await call(`/api/admin/media/lookup?q=${TOK}`, { method: "GET", cookie })).json()).reports) || []).find((x) => x.report_id === rep1.report_id) || {};
  ok("T4 the report is Taken down, with the reason in its log", rpt.status === "taken_down" && (rpt.comments || "").includes("Taken down: test take-down"), rpt.status);
  const mcT = await (await call("/api/mycontent", { method: "GET", cookie })).json();
  r = await post("/api/mycontent/restore", { name: NAME });
  ok("T5 the owner no longer has it (not in My content, not in the trash, cannot restore)", !mcT.files.some((f) => f.name === NAME) && !mcT.trash.some((f) => f.name === NAME) && r.status === 404, r.status);
  r = await call("/api/admin/media/takedown", { body: JSON.stringify({ q: L, note: "again" }), cookie, type: "application/json" });
  ok("T6 taking it down twice: 404", r.status === 404, r.status);
  r = await call("/api/admin/media/untakedown", { body: JSON.stringify({ q: L }), cookie, type: "application/json" });
  const ud = await r.json().catch(() => ({}));
  r2 = await call(`${L}/file`, { method: "GET" });
  const back2 = Buffer.from(await r2.arrayBuffer());
  const rpt2 = (((await (await call(`/api/admin/media/lookup?q=${TOK}`, { method: "GET", cookie })).json()).reports) || []).find((x) => x.report_id === rep1.report_id) || {};
  ok("T7 Undo take down: the same link works again with the same bytes, the report is back to Reviewing", r.status === 200 && ud.file_state === "live" && !ud.removed_at
    && r2.status === 200 && back2.equals(png) && rpt2.status === "reviewing", [r.status, ud.file_state, r2.status, rpt2.status]);
  // My content (planetcompute.ai/mycontent)
  r = await call("/api/mycontent", { method: "GET" });
  ok("16 My content list, not signed in: 401", r.status === 401, r.status);
  r = await call("/api/mycontent", { method: "GET", cookie });
  let mc = await r.json().catch(() => ({}));
  let mine = (mc.files || []).find((f) => f.name === NAME);
  ok("17 My content lists the file with its views (2), size, link, and 2 GB", r.status === 200 && mine && mine.views === 2 && mine.bytes === png.length
    && mine.url === `https://planetcompute.ai${L}` && mc.quota === 2 * 1024 ** 3 && mc.used >= png.length, mc);
  r = await post("/api/mycontent/trash", { name: NAME });
  const t1 = r.status;
  r = await call(L, { method: "GET", ua: UA });
  mc = await (await call("/api/mycontent", { method: "GET", cookie })).json();
  ok("18 Delete moves it to the trash: the link stops working", t1 === 200 && r.status === 404 && !mc.files.some((f) => f.name === NAME) && mc.trash.some((f) => f.name === NAME), [t1, r.status, mc]);
  r = await post("/api/mycontent/restore", { name: NAME });
  const t2 = r.status;
  r = await call(`${L}/file`, { method: "GET" });
  const back = Buffer.from(await r.arrayBuffer());
  ok("19 Restore: the link works again, same bytes", t2 === 200 && r.status === 200 && back.equals(png), [t2, r.status]);
  await post("/api/mycontent/trash", { name: NAME });
  r = await post("/api/mycontent/delete", { name: NAME });
  mc = await (await call("/api/mycontent", { method: "GET", cookie })).json();
  ok("20 Delete forever: gone from files and trash", r.status === 200 && !mc.files.some((f) => f.name === NAME) && !mc.trash.some((f) => f.name === NAME), mc);
  r = await call("/api/uploads?name=" + NAME, { body: png, cookie });
  const again = ((await r.json().catch(() => ({}))).url || "");
  r2 = await call(L, { method: "GET", ua: UA });
  ok("20b after Delete forever the old link is dead; the same name saved again gets a new link", r2.status === 404 && /\/u\/[A-Za-z0-9]{10}$/.test(again) && !again.endsWith(L), [r2.status, again, L]);
  await post("/api/mycontent/trash", { name: NAME });
  await post("/api/mycontent/delete", { name: NAME });
  r = await call("/api/mycontent/trash", { body: JSON.stringify({ name: NAME }), cookie, type: "application/json", origin: "https://evil.example" });
  ok("21 My content from another web site: 403", r.status === 403, r.status);
  const SONG = NAME.replace(/\.png$/, ".mp3");
  r = await call("/api/uploads?name=" + SONG, { body: Buffer.concat([Buffer.from("ID3"), Buffer.alloc(200, 1)]), cookie });
  const sj = await r.json().catch(() => ({}));
  ok("22 a song (.mp3) is refused: only PNG pictures and WebM videos made with planetCompute (since 2026-10-30, test 84)", r.status === 400 && sj.not_made_here && /^Only pictures \(PNG\) and videos \(WebM\)/.test(sj.error), [r.status, sj]);
  await post("/api/mycontent/trash", { name: SONG });
  r = await post("/api/mycontent/empty", {});
  mc = await (await call("/api/mycontent", { method: "GET", cookie })).json();
  ok("23 Empty trash", r.status === 200 && !mc.trash.length, mc.trash);
  r = await call("/mycontent", { method: "GET" });
  page = await r.text();
  ok("24 the page /mycontent", r.status === 200 && page.includes("<h1>My content</h1>") && page.includes("/api/mycontent"), r.status);
} finally {
  const v = await b2("b2_list_file_versions", { bucketId: (await b2("b2_list_buckets", { accountId: b2.a ? b2.a.accountId : (await b2("x", {}), b2.a.accountId), bucketName: env.B2_MODELS_BUCKET })).buckets[0].bucketId,
    prefix: `public/users_uploads/${UID}/`, maxFileCount: 100 }).catch(() => ({ files: [] }));
  const tv = await b2("b2_list_file_versions", { bucketId: (await b2("b2_list_buckets", { accountId: b2.a.accountId, bucketName: env.B2_MODELS_BUCKET })).buckets[0].bucketId,
    prefix: `public/users_trash/${UID}/`, maxFileCount: 100 }).catch(() => ({ files: [] }));
  const rv = await b2("b2_list_file_versions", { bucketId: (await b2("b2_list_buckets", { accountId: b2.a.accountId, bucketName: env.B2_MODELS_BUCKET })).buckets[0].bucketId,
    prefix: `public/users_removed/${UID}/`, maxFileCount: 100 }).catch(() => ({ files: [] }));
  const all = [...(v.files || []), ...(tv.files || []), ...(rv.files || [])];
  for (const f of all) await b2("b2_delete_file_version", { fileName: f.fileName, fileId: f.fileId });
  console.log("removed", all.length, "test file(s) from B2");
  await rawDdb("DeleteTable", { TableName: UT }).catch((e) => console.log("could not delete", UT, e.message));
  await rawDdb("DeleteTable", { TableName: MT }).catch((e) => console.log("could not delete", MT, e.message));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
