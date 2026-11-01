// Test of the admin Models tab (TESTING.md test 20): runs the website Worker's own code in Node against throwaway
// DynamoDB tables <prefix>user and <prefix>models (default prefix pctest-ai-; created here, deleted at the end). The
// models table gets a copy of the real list (planetcompute-ai-models, read only).
//   node scripts/test_models_tab.mjs <path to worker.js>
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";

const src = resolve(process.argv[2] || "website/worker.js");
const tmp = join(mkdtempSync(join(tmpdir(), "pcmodels-")), "worker.mjs");
copyFileSync(src, tmp);
const worker = (await import(tmp)).default;
const PREFIX = process.env.DDB_PREFIX || "pctest-ai-";
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_REGION: process.env.AWS_REGION || "us-east-1", DDB_PREFIX: PREFIX, SESSION_SECRET: "test-" + randomBytes(8).toString("hex"),
  ADMIN_EMAILS: "", MAIL_FROM: "test@planetcompute.ai" };
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
const UT = PREFIX + "user", MT = PREFIX + "models";
async function create(name, extra) {
  try { await rawDdb("DescribeTable", { TableName: name }); return; } catch {}
  await rawDdb("CreateTable", { TableName: name, BillingMode: "PAY_PER_REQUEST", ...extra });
  for (let i = 0; i < 90; i++) { const d = await rawDdb("DescribeTable", { TableName: name });
    if (d.Table.TableStatus === "ACTIVE" && (d.Table.GlobalSecondaryIndexes || []).every((g) => g.IndexStatus === "ACTIVE")) return; await new Promise((r) => setTimeout(r, 3000)); }
}
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra === undefined ? "" : JSON.stringify(extra).slice(0, 300)); } };
try {
  await create(UT, { KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
    AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }] });
  await create(MT, { KeySchema: [{ AttributeName: "model_id", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
    AttributeDefinitions: ["model_id", "sk", "category", "cat_sk"].map((a) => ({ AttributeName: a, AttributeType: "S" })),
    GlobalSecondaryIndexes: [{ IndexName: "models-by-category", KeySchema: [{ AttributeName: "category", KeyType: "HASH" }, { AttributeName: "cat_sk", KeyType: "RANGE" }], Projection: { ProjectionType: "KEYS_ONLY" } }] });
  // copy the real list
  let items = [], start;
  do { const r = await rawDdb("Scan", { TableName: "planetcompute-ai-models", ...(start ? { ExclusiveStartKey: start } : {}) }); items = items.concat(r.Items); start = r.LastEvaluatedKey; } while (start);
  for (let i = 0; i < items.length; i += 25)
    await rawDdb("BatchWriteItem", { RequestItems: { [MT]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) } });
  const real = items.length, allowed = items.filter((x) => x.allowed && x.allowed.BOOL).length;
  // a new index fills in a little after the writes: wait until it lists every row
  for (let i = 0; i < 60; i++) {
    let n = 0;
    for (const c of ["Image", "Video", "Music", "Audio", "Chat", "Coding"])
      n += (await rawDdb("Query", { TableName: MT, IndexName: "models-by-category", KeyConditionExpression: "category = :c", ExpressionAttributeValues: { ":c": { S: c } }, Select: "COUNT" })).Count;
    if (n === real) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
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
    const headers = { origin: "https://planetcompute.ai", "cf-connecting-ip": "203.0.113.7", ...(o.cookie ? { cookie: cookieName + "=" + o.cookie } : {}), ...(o.body ? { "content-type": "application/json" } : {}) };
    const r = await worker.fetch(new Request("https://planetcompute.ai" + path, { method: o.body ? "POST" : "GET", headers, body: o.body ? JSON.stringify(o.body) : undefined }), env);
    const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: r.status, d };
  };
  let r = await api("/api/admin/models");
  ok("1 signed out: 401", r.status === 401, r.status);
  r = await api("/api/admin/models", { cookie: userTok });
  ok("2 not an admin: 403", r.status === 403, r.status);
  r = await api("/api/admin/models", { cookie: adminTok });
  ok(`3 admin: all ${real} models, through the category index`, r.status === 200 && r.d.rows.length === real && r.d.rows.filter((x) => x.allowed).length === allowed, { n: r.d.rows && r.d.rows.length, real });
  ok("4 six categories with counts", r.d.categories.length === 6 && ["Image", "Video", "Music", "Audio", "Chat", "Coding"].every((c) => r.d.counts[c] && r.d.counts[c].total > 0), r.d.counts);
  const flux = r.d.rows.find((x) => x.model_id === "flux1-schnell-q4");
  ok("5 a row has its files, licence, conditions", flux && flux.files.length === 4 && flux.files.every((f) => f.sha256 && f.revision && f.bytes) && flux.license === "apache-2.0" && flux.conditions && flux.in_app, flux);
  r = await api("/api/admin/models?category=Video", { cookie: adminTok });
  ok("6 one category", r.status === 200 && r.d.rows.length > 0 && r.d.rows.every((x) => x.category === "Video"), r.d.rows && r.d.rows.map((x) => x.category));
  r = await api("/api/admin/models/update", { cookie: adminTok, body: { model_id: "gpt-oss-20b", status: "pending" } });
  ok("7 queue an allowed model for an edition", r.status === 200 && r.d.model.status === "pending" && r.d.model.updated_by === "admin-test@planetcompute.ai", r.d);
  r = await api("/api/admin/models/update", { cookie: adminTok, body: { model_id: "gemma-3-12b", status: "pending" } });
  ok("8 an excluded licence cannot be queued", r.status === 400 && /not allowed/.test(r.d.error), r.d);
  r = await api("/api/admin/models/update", { cookie: adminTok, body: { model_id: "gpt-oss-20b", status: "built" } });
  ok("9 only listed / pending can be set by hand", r.status === 400, r.d);
  r = await api("/api/admin/models/update", { cookie: adminTok, body: { model_id: "gpt-oss-20b", in_app: true, status: "listed" } });
  ok("10 mark for the app; back to listed", r.status === 200 && r.d.model.in_app === true && r.d.model.status === "listed", r.d);
  r = await api("/api/admin/models/update", { cookie: userTok, body: { model_id: "gpt-oss-20b", status: "pending" } });
  ok("11 a non-admin cannot change a model", r.status === 403, r.status);
  r = await api("/api/admin/models/update", { cookie: adminTok, body: { model_id: "no-such-model", status: "pending" } });
  ok("12 unknown model: 404", r.status === 404, r.status);
  const h = (await api("/admin")).d;
  ok("13 /admin has the Models tab and view", h.includes('data-tab="models"') && h.includes('id="v-models"') && h.includes("/api/admin/models/update"));
  let bad = 0;
  for (const m of h.matchAll(/<script>([\s\S]*?)<\/script>/g)) { try { new Function(m[1]); } catch (e) { bad++; console.log("   script error:", e.message); } }
  ok("14 every inline script on /admin parses", bad === 0);
  const lib = await api("/api/models?all=1");
  ok("15 /api/models?all=1 answers (editions catalog, or the originals until it exists)", lib.status === 200 || lib.status === 503, lib.status);
} finally {
  for (const t of [UT, MT]) await rawDdb("DeleteTable", { TableName: t }).catch((e) => console.log("could not delete", t, e.message));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
