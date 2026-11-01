// Test of paid services (TESTING.md test 15): runs the website Worker's own code in Node against a throwaway DynamoDB
// table <prefix>user (default prefix pctest-ai-; this script creates it and deletes it at the end). The AI providers
// and Stripe are FAKED (no request leaves for them, no money moves); everything else is the real code.
//   node scripts/test_paid.mjs <path to worker.js>
// AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION come from the environment.
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";

const src = resolve(process.argv[2] || "website/worker.js");
const tmp = join(mkdtempSync(join(tmpdir(), "pcpaid-")), "worker.mjs");
copyFileSync(src, tmp);
const worker = (await import(tmp)).default;
const PREFIX = process.env.DDB_PREFIX || "pctest-ai-";
const WHSEC = "whsec_test_" + randomBytes(8).toString("hex");
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_REGION: process.env.AWS_REGION || "us-east-1", DDB_PREFIX: PREFIX, SESSION_SECRET: "test-" + randomBytes(8).toString("hex"),
  ADMIN_EMAILS: "", MAIL_FROM: "test@planetcompute.ai", DEEPSEEK_PLATFORM_API_KEY: "fake-ds", DEEPINFRA_API_KEY: "fake-di" };

// --- fake providers and Stripe; DynamoDB goes through ---
const realFetch = globalThis.fetch;
const fake = { deepseek: 200, deepinfra: 200, calls: [], stripeForm: null };
globalThis.fetch = async (input, init = {}) => {
  const u = typeof input === "string" ? input : input.url;
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (u.startsWith("https://api.deepseek.com/")) {
    fake.calls.push("deepseek");
    const b = JSON.parse(init.body);
    if (fake.deepseek !== 200) return reply(fake.deepseek, { error: "down" });
    return reply(200, { choices: [{ message: { content: "Paris is the capital of France." } }], usage: { prompt_tokens: 1000, completion_tokens: 500 }, max: b.max_tokens });
  }
  if (u.startsWith("https://api.deepinfra.com/v1/openai/chat")) {
    fake.calls.push("deepinfra-chat");
    if (fake.deepinfra !== 200) return reply(fake.deepinfra, { error: "down" });
    return reply(200, { choices: [{ message: { content: "Paris." } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } });
  }
  if (u.startsWith("https://api.deepinfra.com/v1/openai/images")) {
    fake.calls.push("deepinfra-image");
    return reply(200, { data: [{ b64_json: "iVBORw0KGgo=" }] });
  }
  if (u.startsWith("https://api.stripe.com/")) {
    fake.stripeForm = new URLSearchParams(init.body.toString());
    return reply(200, { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
  }
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
const TABLE = PREFIX + "user";
try { await rawDdb("DescribeTable", { TableName: TABLE }); }
catch {
  await rawDdb("CreateTable", { TableName: TABLE, BillingMode: "PAY_PER_REQUEST", KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
    AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }] });
  for (let i = 0; i < 60; i++) { const d = await rawDdb("DescribeTable", { TableName: TABLE }); if (d.Table.TableStatus === "ACTIVE") break; await new Promise((r) => setTimeout(r, 2000)); }
}
const ADMIN = "a1a1a1a1a1a1", USER = "b2b2b2b2b2b2";
async function seedUser(id, email, admin) {
  await rawDdb("PutItem", { TableName: TABLE, Item: { pk: S(`USER#${id}`), sk: S("PROFILE"), user_id: S(id), primary_email: S(email), created_at: S(new Date().toISOString()), ...(admin ? { IsAdmin: { BOOL: true } } : {}) } });
  await rawDdb("PutItem", { TableName: TABLE, Item: { pk: S(`USER#${id}`), sk: S(`EMAIL#${email}`), user_id: S(id), email: S(email) } });
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(`${env.SESSION_SECRET}|session|${token}`).digest("hex");
  await rawDdb("PutItem", { TableName: TABLE, Item: { pk: S(`SESSION#${hash}`), sk: S("SESSION"), user_id: S(id), expires_at: { N: String(Math.floor(Date.now() / 1000) + 3600) } } });
  return token;
}
const adminTok = await seedUser(ADMIN, "admin-test@planetcompute.ai", true);
const userTok = await seedUser(USER, "bob-test@planetcompute.ai", false);
const cookieName = readFileSync(src, "utf8").match(/const COOKIE = "([^"]+)"/)[1];
async function api(path, o = {}) {
  const headers = { "cf-connecting-ip": "203.0.113.9", origin: "https://planetcompute.ai", ...(o.headers || {}) };
  if (o.body || o.raw) headers["content-type"] = "application/json";
  if (o.cookie) headers.cookie = cookieName + "=" + o.cookie;
  const raw = o.raw != null ? o.raw : o.body ? JSON.stringify(o.body) : undefined;
  const r = await worker.fetch(new Request("https://planetcompute.ai" + path, { method: o.body || o.raw ? "POST" : "GET", headers, body: raw }), env);
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, d, text: t };
}
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra === undefined ? "" : JSON.stringify(extra).slice(0, 300)); } };
const near = (a, b) => Math.abs(a - b) < 1e-6;
const hidden = (r) => !/deepseek|deepinfra|llama|flux/i.test(r.text);
const msgs = [{ role: "user", content: "What is the capital of France?" }];
const quote = async (body) => (await api("/api/paid/quote", { body, cookie: userTok })).d;
const run = (q, body) => api("/api/paid/run", { body: { quote: q.quote, ...body }, cookie: userTok });
const bal = async () => (await api("/api/paid/account", { cookie: userTok })).d.balance;
// our price = provider cost x 1.3, at least 0.001 (the Worker's PAID settings)
const price = (cost) => Math.max(0.001, cost * 1.3);

try {
  let r = await api("/api/paid/account", { cookie: userTok });
  ok("0a without card payments: closed", r.status === 200 && r.d.open === false, r.d);
  r = await api("/api/paid/quote", { body: { task: "chat", messages: msgs }, cookie: userTok });
  ok("0b without card payments: no quote (503)", r.status === 503 && /open soon/.test(r.d.error), r.d);
  env.PAID_TEST = "1";
  r = await api("/api/paid/account");
  ok("1 signed out: 401", r.status === 401, r);
  r = await api("/api/paid/account", { cookie: userTok });
  ok("2 account: balance 0, chat + image on, video off, top-up off without Stripe", r.status === 200 && r.d.balance === 0 && r.d.available.chat && r.d.available.image && !r.d.available.video && r.d.topup === false && /best model/.test(r.d.note), r.d);
  let q = await quote({ task: "chat", messages: msgs });
  ok("3 chat quote: price and a higher most-it-can-cost", q.price > 0 && q.max >= q.price && q.quote, q);
  r = await run(q, { task: "chat", messages: msgs });
  ok("4 no balance: refused (402), nothing run", r.status === 402 && /Not enough balance/.test(r.d.error) && fake.calls.length === 0, r.d);
  r = await api("/api/admin/paid/grant", { body: { user_id: USER, amount: 1 }, cookie: userTok });
  ok("5 grant: not an admin -> 403", r.status === 403, r.status);
  r = await api("/api/admin/paid/grant", { body: { user_id: USER, amount: 1, note: "test" }, cookie: adminTok });
  ok("6 grant: admin adds 1.00", r.status === 200 && near(r.d.balance, 1), r.d);
  q = await quote({ task: "chat", messages: msgs });
  r = await run(q, { task: "chat", messages: msgs });
  const c1 = price((1000 * 0.60 + 500 * 1.70) / 1e6);
  ok("7 chat runs on the first provider; charged = its cost x 1.3", r.status === 200 && /Paris/.test(r.d.text) && near(r.d.charged, Math.ceil(c1 * 1e6 - 1e-6) / 1e6) && fake.calls.join() === "deepseek", { d: r.d, c1, calls: fake.calls });
  ok("8 the answer does not name the provider or model", hidden(r));
  ok("9 balance = 1 - charge (the hold was returned)", near(r.d.balance, 1 - r.d.charged) && near(await bal(), r.d.balance), r.d);
  let b0 = await bal();
  r = await run(q, { task: "chat", messages: msgs });
  ok("10 the same quote twice: refused, nothing charged", r.status === 402 && /already used/.test(r.d.error) && near(await bal(), b0), r.d);
  q = await quote({ task: "chat", messages: msgs });
  r = await run(q, { task: "chat", messages: [{ role: "user", content: "Something much longer and different" }] });
  ok("11 a quote for other messages: refused", r.status === 400 && /not valid/.test(r.d.error), r.d);
  r = await run({ quote: q.quote.replace(/\.(\d+)\.(\d+)\./, ".1.1.") }, { task: "chat", messages: msgs });
  ok("12 a quote with a changed price: refused", r.status === 400, r.d);
  fake.deepseek = 500; fake.calls = [];
  q = await quote({ task: "chat", messages: msgs }); b0 = await bal();
  r = await run(q, { task: "chat", messages: msgs });
  const c2 = price((1000 * 0.25 + 500 * 0.50) / 1e6);
  ok("13 first provider down: the next one answers, charged its price", r.status === 200 && fake.calls.join() === "deepseek,deepinfra-chat" && near(r.d.charged, Math.ceil(c2 * 1e6 - 1e-6) / 1e6) && hidden(r), { d: r.d, calls: fake.calls });
  fake.deepinfra = 503; b0 = await bal();
  q = await quote({ task: "chat", messages: msgs });
  r = await run(q, { task: "chat", messages: msgs });
  ok("14 every provider down: 502, nothing charged", r.status === 502 && near(r.d.balance, b0) && near(await bal(), b0), r.d);
  fake.deepseek = 200; fake.deepinfra = 200;
  q = await quote({ task: "image", prompt: "a lighthouse at dawn" }); b0 = await bal();
  r = await run(q, { task: "image", prompt: "a lighthouse at dawn" });
  ok("15 image: one picture, charged 0.005 x 1.3", r.status === 200 && r.d.images.length === 1 && r.d.images[0].startsWith("data:image/png;base64,") && near(r.d.charged, 0.0065) && near(r.d.balance, b0 - 0.0065) && hidden(r), r.d);
  r = await api("/api/paid/quote", { body: { task: "video", prompt: "waves" }, cookie: userTok });
  ok("16 video: coming soon (503)", r.status === 503 && /coming soon/.test(r.d.error), r.d);
  r = await api("/api/paid/quote", { body: { task: "chat", messages: [] }, cookie: userTok });
  ok("17 nothing to run: 400", r.status === 400, r.d);
  // a job that costs more than the balance
  await api("/api/admin/paid/grant", { body: { user_id: USER, amount: -(await bal()) + 0.0001 }, cookie: adminTok });
  q = await quote({ task: "chat", messages: msgs });
  r = await run(q, { task: "chat", messages: msgs });
  ok("18 balance below the most it can cost: refused", r.status === 402 && near(await bal(), 0.0001), r.d);
  // Stripe top-up
  r = await api("/api/paid/topup", { body: { amount: 10 }, cookie: userTok });
  ok("19 top-up without Stripe keys: 503", r.status === 503, r.d);
  env.STRIPE_SECRET_KEY = "sk_test_fake"; env.STRIPE_WEBHOOK_SECRET = WHSEC;
  r = await api("/api/paid/topup", { body: { amount: 2 }, cookie: userTok });
  ok("20 top-up below the minimum: 400", r.status === 400, r.d);
  r = await api("/api/paid/topup", { body: { amount: 10 }, cookie: userTok });
  ok("21 top-up: Stripe Checkout for 1000 cents, for this user", r.status === 200 && r.d.url.startsWith("https://checkout.stripe.com/") &&
    fake.stripeForm.get("line_items[0][price_data][unit_amount]") === "1000" && fake.stripeForm.get("metadata[user_id]") === USER, r.d);
  const event = (id) => JSON.stringify({ type: "checkout.session.completed", data: { object: { id, payment_status: "paid", amount_total: 1000, metadata: { user_id: USER }, client_reference_id: USER } } });
  const sign = (body, t = Math.floor(Date.now() / 1000), key = WHSEC) => `t=${t},v1=${createHmac("sha256", key).update(`${t}.${body}`).digest("hex")}`;
  const hook = (body, sig) => api("/api/stripe/webhook", { raw: body, headers: { "stripe-signature": sig, origin: "" } });
  b0 = await bal();
  let ev = event("cs_test_A");
  r = await hook(ev, sign(ev, undefined, "whsec_wrong"));
  ok("22 webhook with a wrong signature: refused, no money", r.status === 400 && near(await bal(), b0), r.d);
  r = await hook(ev, sign(ev, Math.floor(Date.now() / 1000) - 3600));
  ok("23 webhook signed an hour ago: refused", r.status === 400 && near(await bal(), b0), r.d);
  r = await hook(ev, sign(ev));
  ok("24 paid session: balance + 10.00", r.status === 200 && near(await bal(), b0 + 10), r.d);
  r = await hook(ev, sign(ev));
  ok("25 the same session again (Stripe retries): credited once", r.status === 200 && near(await bal(), b0 + 10), r.d);
  ev = JSON.stringify({ type: "checkout.session.completed", data: { object: { id: "cs_test_B", payment_status: "unpaid", amount_total: 1000, metadata: { user_id: USER } } } });
  r = await hook(ev, sign(ev));
  ok("26 an unpaid session: nothing credited", r.status === 200 && near(await bal(), b0 + 10), r.d);
  // the ledger keeps every move, with the provider for the admins
  const led = await rawDdb("Query", { TableName: TABLE, KeyConditionExpression: "pk = :p AND begins_with(sk, :s)", ExpressionAttributeValues: { ":p": S(`USER#${USER}`), ":s": S("PAID#") } });
  const kinds = led.Items.map((i) => i.kind.S).sort().join(",");
  ok("27 ledger: grants, charges with provider, a failed try, a top-up", kinds === "charge,charge,charge,failed,grant,grant,topup" && led.Items.filter((i) => i.kind.S === "charge").every((i) => i.provider && i.provider_cost_u), kinds);
} finally {
  await rawDdb("DeleteTable", { TableName: TABLE }).catch((e) => console.log("could not delete", TABLE, e.message));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
