// Workhorse keys and sign-ins (TESTING.md test 59; security review W5): each row signs with its own derived key, a
// signed request is accepted once, and the sign-in it gets is a "worker" one (no admin, wallet, transfers). The given
// worker.js in-process against the TEST tables (pctest-ai-*).
//   AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. node scripts/test_wh_keys.mjs website/worker.js
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"; import { randomBytes, createHmac } from "node:crypto";
let src = readFileSync(process.argv[2], "utf8"); src += "\nglobalThis.__G = { ddb, M, U };\n";
const tmp = join(mkdtempSync(join(tmpdir(), "wk-")), "w.mjs"); writeFileSync(tmp, src); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default, G = globalThis.__G, PREFIX = "pctest-ai-";
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, AWS_REGION: "us-east-1", DDB_PREFIX: PREFIX,
  SESSION_SECRET: "s".repeat(40), MAIL_FROM: "test@planetcompute.ai", HB_SERVER_SECRET: "m".repeat(48), ADMIN_EMAILS: "boss@example.com" };
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
const A = randomBytes(6).toString("hex"), B = randomBytes(6).toString("hex"), user = "wk" + randomBytes(5).toString("hex");
for (const id of [A, B]) await G.ddb(env, "PutItem", { TableName: PREFIX + "Workhorses", Item: G.M({ server_id: id, sk: "SERVER", name: "test " + id, account_user_id: user, account_email: "boss@example.com" }) });
await G.ddb(env, "PutItem", { TableName: PREFIX + "user", Item: G.M({ pk: "USER#" + user, sk: "PROFILE", user_id: user, primary_email: "boss@example.com" }) });
await G.ddb(env, "PutItem", { TableName: PREFIX + "user", Item: G.M({ pk: "EMAIL#boss@example.com", sk: "EMAIL", user_id: user }) }).catch(() => {});
const key = (label) => createHmac("sha256", env.HB_SERVER_SECRET).update("pc-derived|" + label).digest("hex");
const signed = async (path, what, body, k, sigOverride) => { const raw = JSON.stringify(body), ts = String(Math.floor(Date.now() / 1000)), sig = sigOverride || ts + "." + createHmac("sha256", k).update(`${what}|${ts}|${raw}`).digest("hex");
  const r = await W.fetch(new Request("https://planetcompute.ai" + path, { method: "POST", headers: { "content-type": "application/json", "x-wh-sig": sig }, body: raw }), env); return { s: r.status, j: await r.json(), sig, raw }; };
let r = await signed("/api/wh/session", "whsession", { server_id: A }, key("wh:" + A));
ok("1 a row's agent signs with its own key (derived for that row) and gets a sign-in", r.s === 200 && !!r.j.token, r.s);
const tok = r.j.token;
const again = await W.fetch(new Request("https://planetcompute.ai/api/wh/session", { method: "POST", headers: { "content-type": "application/json", "x-wh-sig": r.sig }, body: r.raw }), env);
ok("2 the same signed request again (a replay) gets no second sign-in", again.status === 409, again.status);
await new Promise((x) => setTimeout(x, 1100));
r = await signed("/api/wh/session", "whsession", { server_id: B }, key("wh:" + A));
ok("3 row A's key cannot act for row B", r.s === 401, r.s);
const as = (path, method = "GET", body) => W.fetch(new Request("https://planetcompute.ai" + path, { method, headers: { cookie: "pc_session=" + tok, "content-type": "application/json", origin: "https://planetcompute.ai" }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
const me = await as("/api/me");
ok("4 the workhorse sign-in reads its account (GET /api/me)", me.status === 200, me.status);
const blocked = {};
for (const [p, m, b] of [["/api/me/solana-address", "POST", { address: "8XwKcJJGZ1ZwGyn99vBGfuNBwjAHq2F99nbTEyRWCCuB" }], ["/api/wallet/withdraw", "POST", {}], ["/api/wallet/claim/prepare", "POST", {}],
  ["/api/admin/ledger-options", "GET"], ["/api/admin/ledger-options/move", "POST", {}], ["/api/me/balance", "GET"], ["/api/tunnel/devices/delete-all", "POST", {}]]) blocked[p] = (await as(p, m, b)).status;
ok("5 it cannot change the wallet address, move coins, claim, open admin (although the account is an admin), or delete links: 403", Object.values(blocked).every((x) => x === 403), blocked);
const dv = await W.fetch(new Request("https://planetcompute.ai/device/aaaaaaaaaaaa/local/", { headers: { cookie: "pc_session=" + tok }, redirect: "manual" }), { ...env, TUNNEL: {} });
ok("6 it cannot open device pages", dv.status === 401, dv.status);
const sess = await G.ddb(env, "Scan", { TableName: PREFIX + "user", FilterExpression: "user_id = :u AND sk = :s", ExpressionAttributeValues: G.M({ ":u": user, ":s": "SESSION" }) });
const it = (sess.Items || []).map(G.U)[0] || {};
ok("7 the sign-in is a 'worker' one and lasts 8 days (renewed weekly by the agent), not 30", it.scope === "worker" && Math.abs(it.expires_at - Math.floor(Date.now() / 1000) - 8 * 86400) < 60, it);
// clean up
for (const id of [A, B]) await G.ddb(env, "DeleteItem", { TableName: PREFIX + "Workhorses", Key: G.M({ server_id: id, sk: "SERVER" }) });
for (const x of sess.Items || []) await G.ddb(env, "DeleteItem", { TableName: PREFIX + "user", Key: { pk: x.pk, sk: x.sk } });
await G.ddb(env, "DeleteItem", { TableName: PREFIX + "user", Key: G.M({ pk: "USER#" + user, sk: "PROFILE" }) });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
