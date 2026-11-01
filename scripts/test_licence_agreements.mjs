// Test of the licence agreement step (TESTING.md test 24): runs the website Worker's own code in Node against throwaway
// DynamoDB tables <prefix>user and <prefix>model-agreements (default prefix pctest-ai-; created here, deleted at the
// end). B2 (the model library) and Resend (email) are faked inside this script: no real file or email is sent.
//   node scripts/test_licence_agreements.mjs <path to worker.js>
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";

const src = resolve(process.argv[2] || "website/worker.js");
const tmp = join(mkdtempSync(join(tmpdir(), "pclic-")), "worker.mjs");
copyFileSync(src, tmp);
const worker = (await import(tmp)).default;
const PREFIX = process.env.DDB_PREFIX || "pctest-ai-";
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_REGION: process.env.AWS_REGION || "us-east-1", DDB_PREFIX: PREFIX, SESSION_SECRET: "test-" + randomBytes(8).toString("hex"),
  ADMIN_EMAILS: "", RESEND_API_KEY: "re_test", RESEND_FROM: "PlanetCompute <test@planetcompute.ai>",
  B2_MODELS_KEY_ID: "k", B2_MODELS_APP_KEY: "a" };
// fake B2 + Resend; everything else (DynamoDB) is real
const CATALOG = { models: [
  { id: "free-model", name: "Free model", file: "free.gguf", license: "Apache-2.0" },
  { id: "llama-model", name: "Llama model", file: "llama.gguf", license: "Llama 3.3", agreement: "llama3.3" },
  { id: "ltx-model", name: "LTX model", file: "ltx.gguf", license: "LTX-2.x", agreement: "ltx-2.x-community", needs: ["ltx-vae", "free-model"] },
  { id: "ltx-vae", name: "LTX VAE", file: "vae.safetensors", license: "LTX-2.x", agreement: "ltx-2.x-community", partOf: "ltx-model" } ] };
const mails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const u = typeof input === "string" ? input : input.url;
  if (u.startsWith("https://api.backblazeb2.com/")) return new Response(JSON.stringify({ authorizationToken: "t", accountId: "x",
    apiInfo: { storageApi: { downloadUrl: "https://b2.test", apiUrl: "https://b2.test" } } }));
  if (u === "https://b2.test/file/planetcompute-ai/Models/catalog.json") return new Response(JSON.stringify(CATALOG));
  if (u.startsWith("https://b2.test/file/planetcompute-ai/Models/catalog-editions.json")) return new Response("no", { status: 404 });
  if (u.startsWith("https://b2.test/file/planetcompute-ai/Models/")) return new Response("GGUF-bytes", { headers: { "content-length": "10" } });
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
const UT = PREFIX + "user", AT = PREFIX + "model-agreements";
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
  await create(AT, { KeySchema: [{ AttributeName: "user_id", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
    AttributeDefinitions: ["user_id", "sk", "model_id", "accepted_at"].map((a) => ({ AttributeName: a, AttributeType: "S" })),
    GlobalSecondaryIndexes: [{ IndexName: "by-model", KeySchema: [{ AttributeName: "model_id", KeyType: "HASH" }, { AttributeName: "accepted_at", KeyType: "RANGE" }], Projection: { ProjectionType: "KEYS_ONLY" } }] });
  async function seedUser(id, email) {
    await rawDdb("PutItem", { TableName: UT, Item: { pk: S(`USER#${id}`), sk: S("PROFILE"), user_id: S(id), primary_email: S(email) } });
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(`${env.SESSION_SECRET}|session|${token}`).digest("hex");
    await rawDdb("PutItem", { TableName: UT, Item: { pk: S(`SESSION#${hash}`), sk: S("SESSION"), user_id: S(id), expires_at: { N: String(Math.floor(Date.now() / 1000) + 3600) } } });
    return token;
  }
  const tok = await seedUser("c3c3c3c3c3c3", "carol-test@planetcompute.ai");
  const cookieName = readFileSync(src, "utf8").match(/const COOKIE = "([^"]+)"/)[1];
  const api = async (path, o = {}) => {
    const headers = { "cf-connecting-ip": "203.0.113.9", "user-agent": "planetCompute/test", ...(o.cookie ? { cookie: cookieName + "=" + o.cookie } : {}), ...(o.body ? { "content-type": "application/json" } : {}), ...(o.headers || {}) };
    const r = await worker.fetch(new Request("https://planetcompute.ai" + path, { method: o.body ? "POST" : "GET", headers, body: o.body ? JSON.stringify(o.body) : undefined }), env);
    const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: r.status, d };
  };
  let r = await api("/api/models");
  const byId = Object.fromEntries((r.d.models || []).map((m) => [m.id, m]));
  ok("1 the list marks the models that need an agreement (with title, version, points)", r.status === 200 && !byId["free-model"].agreement &&
    byId["llama-model"].agreement.title === "Llama 3.3 Community License" && byId["ltx-model"].agreement.version === "2026-08-11" && byId["ltx-model"].agreement.points.length >= 3, r.d);
  r = await api("/api/models/file/free-model", { cookie: tok });
  ok("2 a model without an agreement downloads as before", r.status === 200 && r.d === "GGUF-bytes", r);
  r = await api("/api/models/file/ltx-model", { cookie: tok });
  ok("3 an LTX file before agreeing: 403 needs_agreement with the licence", r.status === 403 && r.d.needs_agreement && r.d.agreement.key === "ltx-2.x-community", r);
  r = await api("/api/models/file/ltx-vae", { cookie: tok });
  ok("4 its part too: 403", r.status === 403, r.status);
  r = await api("/api/models/agreement?id=ltx-model", { cookie: tok });
  ok("5 agreement status: required, not accepted", r.status === 200 && r.d.required === true && r.d.accepted === false, r.d);
  r = await api("/api/models/agreement?id=ltx-model");
  ok("6 agreement status signed out: 401", r.status === 401, r.status);
  r = await api("/api/models/accept", { body: { model_id: "ltx-model" } });
  ok("7 accept signed out: 401", r.status === 401, r.status);
  r = await api("/api/models/accept", { cookie: tok, body: { model_id: "ltx-model" }, headers: { origin: "https://evil.example" } });
  ok("8 accept from another site: 403", r.status === 403, r.status);
  r = await api("/api/models/accept", { cookie: tok, body: { model_id: "ltx-model", via: "planetCompute test" } });
  ok("9 accept: saved for the model and its LTX part (not the Apache part), emailed", r.status === 200 && r.d.accepted && r.d.emailed === true &&
    JSON.stringify(r.d.models) === JSON.stringify(["ltx-model", "ltx-vae"]), r.d);
  const q = await rawDdb("Query", { TableName: AT, KeyConditionExpression: "user_id = :u", ExpressionAttributeValues: { ":u": S("c3c3c3c3c3c3") } });
  const it = q.Items.find((x) => x.model_id.S === "ltx-model");
  ok("10 the table item: user, model, licence + version, accepted, time, IP, email, user agent, email_sent_at", q.Items.length === 2 && it &&
    it.sk.S === "ltx-model#ltx-2.x-community#2026-08-11" && it.accepted.BOOL === true && /^\d{4}-\d\d-\d\dT/.test(it.accepted_at.S) &&
    it.ip.S === "203.0.113.9" && it.email.S === "carol-test@planetcompute.ai" && it.user_agent.S === "planetCompute/test" && it.via.S === "planetCompute test" && !!it.email_sent_at, q.Items);
  const mail = mails[mails.length - 1] || {};
  ok("11 the email went to the user at once, naming licence, model, time and IP", mails.length === 1 && mail.to[0] === "carol-test@planetcompute.ai" &&
    mail.subject.includes("LTX-2.x Community License") && mail.text.includes("ltx-model") && mail.text.includes("203.0.113.9") && mail.text.includes(it.accepted_at.S), mail);
  r = await api("/api/models/file/ltx-model", { cookie: tok });
  ok("12 after agreeing the LTX file downloads", r.status === 200, r.status);
  r = await api("/api/models/file/ltx-vae", { cookie: tok });
  ok("13 and its part", r.status === 200, r.status);
  r = await api("/api/models/file/llama-model", { cookie: tok });
  ok("14 another licence (Llama) still needs its own agreement", r.status === 403 && r.d.agreement.key === "llama3.3", r.status);
  r = await api("/api/models/accept", { cookie: tok, body: { model_id: "free-model" } });
  ok("15 accepting a model without an agreement: nothing saved, nothing emailed", r.status === 200 && r.d.required === false && mails.length === 1, r.d);
  r = await api("/api/models/accept", { cookie: tok, body: { model_id: "no-such" } });
  ok("16 unknown model: 404", r.status === 404, r.status);
} finally {
  for (const t of [UT, AT]) await rawDdb("DeleteTable", { TableName: t }).catch((e) => console.log("could not delete", t, e.message));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
