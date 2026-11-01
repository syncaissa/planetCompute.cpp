// docs/TESTING.md test 87 (website part): the in-house SherpaHub switches on planetcompute.ai. The admin saves
// SupplySimulation / DemandSimulation on a SherpaHub row (checked fields); the row's agent gets them in its orders
// (POST /api/wh/agent, signed with the row's own key) and its numbers are kept for the tab; a regular row never gets them;
// a server's own sign-in may send only test requests to the pool ("priority low": not counted in the daily limit, marked
// "demand" and low for the SherpaHub, not listed for the account), a user's request is as before.
// The given worker.js in Node with a fake DynamoDB and a fake SherpaHub directory and room. No network.
//   node <repo>/scripts/test_sim_site.mjs <worker.js>
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join, dirname } from "node:path";
import { createHash, createHmac } from "node:crypto";
const tmp = join(mkdtempSync(join(tmpdir(), "ss-")), "w.mjs"); writeFileSync(tmp, readFileSync(process.argv[2], "utf8")); globalThis.WebSocketRequestResponsePair = class {};
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, x === undefined ? "" : JSON.stringify(x).slice(0, 400)); } };
const SECRET = "s", MASTER = "hb-master", sha = (s) => createHash("sha256").update(s).digest("hex"), now = new Date().toISOString();
const TOK = { admin: "testsessiontoken-admin-0123456789", user: "testsessiontoken-user-01234567890", srv: "testsessiontoken-server-012345678" };
const items = new Map(), K = (t, k) => t + "|" + JSON.stringify(Object.keys(k).sort().map((x) => [x, k[x]]));
const keyOf = (it) => it.pk ? { pk: it.pk, sk: it.sk } : it.server_id ? { server_id: it.server_id, sk: it.sk } : { user_id: it.user_id, sk: it.sk };
const sess = (t, uid, scope) => items.set(K("planetcompute-ai-user", { pk: { S: `SESSION#${sha(`${SECRET}|session|${t}`)}` }, sk: { S: "SESSION" } }),
  { user_id: { S: uid }, expires_at: { N: String(Math.floor(Date.now() / 1000) + 3600) }, ...(scope ? { scope: { S: scope } } : {}) });
sess(TOK.admin, "adm", ""); sess(TOK.user, "usr", ""); sess(TOK.srv, "adm", "worker");
for (const [u, e] of [["adm", "admin@example.com"], ["usr", "user@example.com"]]) {
  items.set(K("planetcompute-ai-user", { pk: { S: `USER#${u}` }, sk: { S: "PROFILE" } }), { pk: { S: `USER#${u}` }, sk: { S: "PROFILE" }, user_id: { S: u }, primary_email: { S: e }, created_at: { S: "2026-01-01T00:00:00Z" } });
  items.set(K("planetcompute-ai-user", { pk: { S: `EMAIL#${e}` }, sk: { S: "EMAIL" } }), { pk: { S: `EMAIL#${e}` }, sk: { S: "EMAIL" }, user_id: { S: u } });
  items.set(K("planetcompute-ai-user", { pk: { S: `USER#${u}` }, sk: { S: `EMAIL#${e}` } }), { pk: { S: `USER#${u}` }, sk: { S: `EMAIL#${e}` }, user_id: { S: u }, email: { S: e } });
}
const WT = "planetcompute-ai-Workhorses", HUBID = "dddddddddddd", REG = "aaaaaaaaaaaa";
const AG = JSON.stringify({ instances: [{ i: 1, state: "running", device: "3eb5be2903d4", models: [["zimage-turbo-q4k", 100], ["qwen2.5-0.5b-q4km", 100]] }] });
items.set(K(WT, { server_id: { S: HUBID }, sk: { S: "SERVER" } }), { server_id: { S: HUBID }, sk: { S: "SERVER" }, role: { S: "sherpahub" }, name: { S: "interserver-1-sherpahubs" },
  account_email: { S: "admin@example.com" }, account_user_id: { S: "adm" }, instances: { S: "1" }, agent_seen_at: { S: now }, agent_state: { S: AG } });
items.set(K(WT, { server_id: { S: REG }, sk: { S: "SERVER" } }), { server_id: { S: REG }, sk: { S: "SERVER" }, role: { S: "" }, name: { S: "interserver-1" }, supply: { S: "on" }, demand: { S: "on" },
  account_email: { S: "admin@example.com" }, account_user_id: { S: "adm" }, instances: { S: "2" }, agent_seen_at: { S: now }, agent_state: { S: AG } });
const cond = () => { const e = new Error("cond"); e.cond = true; return e; };
function update(b, it) {
  const v = b.ExpressionAttributeValues || {}, nm = b.ExpressionAttributeNames || {}, nameOf = (x) => x.startsWith("#") ? nm[x] : x;
  if (/attribute_exists\(server_id\)/.test(b.ConditionExpression || "") && !it.server_id) throw cond();
  const lim = /n < (:\w+)/.exec(b.ConditionExpression || ""); if (lim && it.n && +it.n.N >= +v[lim[1]].N) throw cond();
  for (const part of String(b.UpdateExpression || "").split(/(?=\b(?:SET|ADD|REMOVE)\b)/)) {
    const t = part.trim();
    if (t.startsWith("SET ")) for (const a of t.slice(4).split(/,(?![^(]*\))/)) { const m = /(#?\w+)\s*=\s*(?:if_not_exists\((#?\w+),\s*(:\w+)\)|(:\w+))/.exec(a.trim()); if (m) it[nameOf(m[1])] = m[3] ? (it[nameOf(m[1])] || v[m[3]]) : v[m[4]]; }
    if (t.startsWith("ADD ")) for (const a of t.slice(4).split(",")) { const [n0, vv] = a.trim().split(/\s+/); const n = nameOf(n0); it[n] = { N: String((it[n] ? +it[n].N : 0) + +v[vv].N) }; }
  }
  return it;
}
function ddb(op, b) {
  const k = b.Key ? K(b.TableName, b.Key) : "";
  if (op === "GetItem") return items.has(k) ? { Item: items.get(k) } : {};
  if (op === "PutItem") { const kk = K(b.TableName, keyOf(b.Item)); if (/attribute_not_exists/.test(b.ConditionExpression || "") && items.has(kk)) throw cond(); items.set(kk, b.Item); return {}; }
  if (op === "UpdateItem") { const it = update(b, structuredClone(items.get(k) || { ...b.Key })); items.set(k, it); return { Attributes: it }; }
  const bw = /(\w+) = (:\w+) AND begins_with\(sk, (:\w+)\)/.exec(b.KeyConditionExpression || "");
  if (op === "Query" && bw) { const v = b.ExpressionAttributeValues;
    return { Items: [...items.entries()].filter(([kk, x]) => kk.startsWith(b.TableName + "|") && x[bw[1]] && x[bw[1]].S === v[bw[2]].S && x.sk.S.startsWith(v[bw[3]].S)).map(([, x]) => x) }; }
  if (op === "Scan") return { Items: [...items.entries()].filter(([kk]) => kk.startsWith(b.TableName + "|")).map(([, x]) => x) };
  return { Items: [] };
}
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (/dynamodb\./.test(url)) { const op = String((init.headers || {})["x-amz-target"] || "").split(".").pop();
    try { return J(ddb(op, JSON.parse(init.body || "{}"))); } catch (e) { return J({ __type: "com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException", message: "cond" }, 400); } }
  if (/b2_authorize_account/.test(url)) return J({ authorizationToken: "t", accountId: "a", apiInfo: { storageApi: { downloadUrl: "https://f.b2test", apiUrl: "https://api.b2test", allowed: { buckets: [{ id: "bid", name: "planetcompute-ai" }] } } } });
  if (/Models\/catalog\.json$/.test(url)) return J({ models: [{ id: "zimage-turbo-q4k", name: "Z-Image Turbo", kind: "image" }, { id: "qwen2.5-0.5b-q4km", name: "Qwen 0.5B" }] });
  return J({}, 404);
};
const added = [];
const sherpa = { fetch: async (u, init) => { const x = new URL(u);
  if (x.pathname === "/dir/list") return J({ hubs: [{ name: "sherpa:hub:adm:3eb5be2903d4", queued: 0 }] });
  if (x.pathname === "/jobs/add") { added.push(JSON.parse(init.body)); return J({ ok: true, id: "00000000000000c" + added.length }); }
  return J({}, 404); } };
const W = (await import(tmp)).default;
const env = { AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "y", SESSION_SECRET: SECRET, MAIL_FROM: "t@invalid", ADMIN_EMAILS: "admin@example.com", HB_SERVER_SECRET: MASTER, B2_MODELS_KEY_ID: "k", B2_MODELS_APP_KEY: "s",
  SHERPA: { idFromName: (n) => n, get: () => sherpa } };
const call = async (path, who, body, headers = {}) => { const r = await W.fetch(new Request("https://planetcompute.ai" + path, { method: body === undefined ? "GET" : "POST",
  headers: { "content-type": "application/json", ...(who ? { cookie: `pc_session=${TOK[who]}` } : {}), ...headers }, body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)) }), env);
  return { status: r.status, j: await r.json().catch(() => null) }; };
const row = (id) => Object.fromEntries(Object.entries(items.get(K(WT, { server_id: { S: id }, sk: { S: "SERVER" } }))).map(([k, v]) => [k, Object.values(v)[0]]));
const base = { server_id: HUBID, role: "sherpahub", name: "interserver-1-sherpahubs", public_ipv4: "203.0.113.10", ssh_user: "root", ssh_port: "22", ssh_key_name: "id_rsa_fiverr",
  instances: "1", account_email: "admin@example.com", root_dir: "/root/REMOTESERVERSACCESS/sherpahubs", port_base: "", provider: "InterServer", notes: "" };

let r = await call("/api/admin/workhorses/save", "admin", { ...base, supply: "on", cores: "4", cap: "50", demand: "on", demand_chat_per_hour: "600", demand_images_per_day: "4", demand_model: "qwen2.5-0.5b-q4km", demand_image_model: "zimage-turbo-q4k" });
const rw = row(HUBID);
ok("1 the admin saves SupplySimulation (cores 4, cap 50) and DemandSimulation (600 chat jobs an hour, 4 pictures a day, models) on the SherpaHub row",
  r.status === 200 && rw.supply === "on" && rw.cores === "4" && rw.cap === "50" && rw.demand === "on" && rw.demand_chat_per_hour === "600" && rw.demand_images_per_day === "4" && rw.demand_image_model === "zimage-turbo-q4k", [r.status, r.j, rw]);
r = await call("/api/admin/workhorses/save", "admin", { ...base, demand: "on", demand_chat_per_hour: "5000" });
const r2 = await call("/api/admin/workhorses/save", "admin", { ...base, supply: "yes" });
ok("2 out-of-range or wrong values are refused (5,000 chat jobs an hour; supply 'yes')", r.status === 400 && r2.status === 400 && /demand_chat_per_hour/.test(r.j.error), [r.j, r2.j]);
r = await call("/api/admin/workhorses/save", "user", { ...base, supply: "on" });
ok("3 a non-admin cannot save", r.status === 403 || r.status === 401, r.status);
const agentCall = async (id, extra = {}) => {
  const raw = JSON.stringify({ server_id: id, at: Math.floor(Date.now() / 1000), done_seq: 0, instances: [{ i: 1, state: "running", device: "3eb5be2903d4", models: [["zimage-turbo-q4k", 100], ["qwen2.5-0.5b-q4km", 100]] }], version: "0.1.0", ...extra });
  const ts = String(Math.floor(Date.now() / 1000)), key = createHmac("sha256", MASTER).update("pc-derived|wh:" + id).digest("hex");
  const sig = createHmac("sha256", key).update(`workhorse|${ts}|${raw}`).digest("hex");
  return call("/api/wh/agent", null, raw, { "x-wh-sig": `${ts}.${sig}` });
};
r = await agentCall(HUBID, { supply: true, demand: { day: "2026-10-30", chat_sent: 12, chat_ok: 11, chat_failed: 1, images_sent: 1, last_error: "chat 503: busy" } });
ok("4 the SherpaHub row's agent gets them in its orders: supply true, demand {600 an hour, 4 a day, the models}",
  r.status === 200 && r.j.supply === true && JSON.stringify(r.j.demand) === JSON.stringify({ chat_per_hour: 600, images_per_day: 4, model: "qwen2.5-0.5b-q4km", image_model: "zimage-turbo-q4k" }) && r.j.cores === 4 && r.j.cap === 50, r.j);
const ags = JSON.parse(row(HUBID).agent_state);
ok("5 the agent's numbers are kept for the tab (supply on; today 12 sent, 11 answered, 1 failed, 1 picture, last error)", ags.supply === true && ags.demand.chat_sent === 12 && ags.demand.chat_ok === 11 && ags.demand.images_sent === 1 && ags.demand.last_error === "chat 503: busy", ags);
r = await agentCall(REG);
ok("6 a regular row (the cows / workhorses) never gets the switches, even if set", r.status === 200 && r.j.supply === false && r.j.demand === null, r.j);
const media = (who, extra = {}) => call("/api/pool/media", who, { task: "image", model: "zimage-turbo-q4k", prompt: "A red fox in fresh snow", width: 512, height: 512, ...extra });
r = await media("srv");
ok("7 a server's own sign-in asking the pool WITHOUT 'priority low': refused (403)", r.status === 403 && /test requests only/.test(JSON.stringify(r.j)), r.j);
r = await media("srv", { priority: "low" });
const day = new Date().toISOString().slice(0, 10), cnt = items.get(K("planetcompute-ai-user-credits", { user_id: { S: "adm" }, sk: { S: "POOLM#" + day } }));
const listed = [...items.keys()].some((k) => k.includes("POOLMEDIA#") && k.includes('"adm"'));
ok("8 with 'priority low' (DemandSimulation): taken; the SherpaHub job is low and marked demand; not counted in the daily limit; not listed for the account",
  r.status === 200 && added.at(-1).low === true && added.at(-1).source === "demand" && /^DemandSimulation/.test(added.at(-1).by) && !cnt && !listed, [r.j, added.at(-1), cnt, listed]);
r = await media("user", { priority: "low" });
const ucnt = items.get(K("planetcompute-ai-user-credits", { user_id: { S: "usr" }, sk: { S: "POOLM#" + day } }));
ok("9 a user's request (even saying low) is as before: counted, listed, a normal pool job", r.status === 200 && added.at(-1).source === "pool" && !added.at(-1).low && ucnt && ucnt.n.N === "1"
  && [...items.keys()].some((k) => k.includes("POOLMEDIA#") && k.includes('"usr"')), [r.j, added.at(-1), ucnt]);
// with the cows retired: only the SherpaHub row reports models. Its copies count for the pool only with SupplySimulation on
const REGK = K(WT, { server_id: { S: REG }, sk: { S: "SERVER" } }); items.get(REGK).agent_seen_at = { S: "2026-01-01T00:00:00Z" };
const HK = K(WT, { server_id: { S: HUBID }, sk: { S: "SERVER" } }); items.get(HK).agent_seen_at = { S: new Date().toISOString() }; items.get(HK).agent_state = { S: AG };
r = await media("user");
ok("10 no cows left: the SherpaHub with SupplySimulation offers its picture model to the pool (the request is taken)", r.status === 200, r.j);
items.get(HK).supply = { S: "" };
r = await media("user");
ok("11 SupplySimulation off: its copies do not count (no computer has the model)", r.status === 400 && /No volunteer computer has that image model/.test(JSON.stringify(r.j)), r.j);
rmSync(dirname(tmp), { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
