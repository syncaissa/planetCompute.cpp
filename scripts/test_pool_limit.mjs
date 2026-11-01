// docs/TESTING.md test 72 (+ 73: pictures and videos from the pool): the PlanetCompute pool's free daily limit (website/worker.js handleJobs, poolInfo), the given
// worker.js in-process with an in-memory DynamoDB (sessions, the POOL#<day> counters) and a scripted grid. No keys.
//   node scripts/test_pool_limit.mjs <worker.js>
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { createHash } from "node:crypto";
const tmp = join(mkdtempSync(join(tmpdir(), "pool-")), "w.mjs"); writeFileSync(tmp, readFileSync(process.argv[2], "utf8")); globalThis.WebSocketRequestResponsePair = class {};
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, x === undefined ? "" : JSON.stringify(x)); } };
const SECRET = "test-secret", sha = (s) => createHash("sha256").update(s).digest("hex");
const items = new Map(), key = (t, k) => t + "|" + JSON.stringify(Object.keys(k).sort().map((x) => [x, k[x]]));
const tok = (u) => "testsessiontoken-" + u + "-0123456789";
for (const u of ["alice", "bob", "wolf"]) items.set(key("planetcompute-ai-user", { pk: { S: `SESSION#${sha(`${SECRET}|session|${tok(u)}`)}` }, sk: { S: "SESSION" } }),
  { user_id: { S: u }, expires_at: { N: String(Math.floor(Date.now() / 1000) + 3600) } });
let jobs = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (/dynamodb\./.test(url)) {
    const h = init.headers || {}, op = String(h["x-amz-target"] || h["X-Amz-Target"] || (input.headers && input.headers.get && input.headers.get("x-amz-target")) || "").split(".").pop();
    const b = JSON.parse(init.body || (input.text ? await input.text() : "{}")), k = key(b.TableName, b.Key || {});
    const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
    if (op === "GetItem") return J(items.has(k) ? { Item: items.get(k) } : {});
    if (op === "Scan" && /Workhorses$/.test(b.TableName)) return J({ Items: WH });
    if (op === "PutItem") { items.set(key(b.TableName, { user_id: b.Item.user_id, sk: b.Item.sk }), b.Item); return J({}); }
    if (op === "Query") {
      const u = b.ExpressionAttributeValues[":u"].S, pre = b.ExpressionAttributeValues[":p"].S;
      const rows = [...items.entries()].filter(([kk, v]) => kk.startsWith(b.TableName + "|") && v.user_id && v.user_id.S === u && v.sk && v.sk.S.startsWith(pre)).map(([, v]) => v)
        .sort((a, c) => (a.sk.S < c.sk.S ? 1 : -1));
      return J({ Items: rows.slice(0, b.Limit || 100) });
    }
    if (op === "UpdateItem") {
      const it = items.get(k) || { ...b.Key }, v = b.ExpressionAttributeValues || {}, n = it.n ? Number(it.n.N) : undefined;
      if (b.ConditionExpression && /n < :lim/.test(b.ConditionExpression) && !(n === undefined || n < Number(v[":lim"].N)))
        return J({ __type: "com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException", message: "failed" }, 400);
      const add = Number((v[":one"] || v[":m"]).N);
      it.n = { N: String((n || 0) + add) }; items.set(k, it); return J({});
    }
    return J({});
  }
  if (/b2_authorize_account/.test(url)) return new Response(JSON.stringify({ authorizationToken: "t", accountId: "a",
    apiInfo: { storageApi: { downloadUrl: "https://f.b2test", apiUrl: "https://api.b2test", allowed: { buckets: [{ name: "pc", id: "bid" }] } } } }));
  if (url === "https://f.b2test/file/pc/Models/catalog.json") return new Response(JSON.stringify({ models: [{ id: "qwen2.5-0.5b-q4km", name: "Qwen 0.5B" },
    { id: "zimage-turbo-q4k", name: "Z-Image Turbo", kind: "image" }, { id: "flux1-ae", kind: "image-part" }, { id: "wan21-t2v-1.3b-q8", name: "Wan 2.1", kind: "video" }] }));
  if (url.startsWith("https://f.b2test/file/pc/sherpa_jobs/")) return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
  if (/b2test|backblaze|b2api/.test(url)) return new Response("{}", { status: 401 });
  return realFetch(input, init);
};
const fresh = new Date().toISOString(), stale = new Date(Date.now() - 3600000).toISOString();
const WH = [
  { server_id: { S: "aaaaaaaaaaaa" }, sk: { S: "SERVER" }, role: { S: "" }, agent_seen_at: { S: fresh }, agent_state: { S: JSON.stringify({ instances: [
    { i: 1, state: "running", models: [["qwen2.5-0.5b-q4km", 100], ["zimage-turbo-q4k", 100], ["flux1-ae", 100]] }, { i: 2, state: "running", models: [["zimage-turbo-q4k", 100], ["wan21-t2v-1.3b-q8", 40]] }] }) } },
  { server_id: { S: "bbbbbbbbbbbb" }, sk: { S: "SERVER" }, role: { S: "" }, agent_seen_at: { S: stale }, agent_state: { S: JSON.stringify({ instances: [{ i: 1, state: "running", models: [["wan21-t2v-1.3b-q8", 100]] }] }) } },
  { server_id: { S: "cccccccccccc" }, sk: { S: "SERVER" }, role: { S: "sherpahub" }, agent_seen_at: { S: fresh }, agent_state: { S: JSON.stringify({ instances: [{ i: 1, state: "running", models: [["wan21-t2v-1.3b-q8", 100]] }] }) } }];
const HUB = "sherpa:hub:u1:3eb5be2903aa", roomJobs = {};
let hubsUp = true;
const sherpa = { fetch: async (u, init) => { const x = new URL(u), p = x.pathname;
  if (p === "/dir/list") return new Response(JSON.stringify({ hubs: hubsUp ? [{ name: HUB, queued: 0 }] : [] }));
  if (p === "/jobs/add") { const j = JSON.parse(init.body), id = (Object.keys(roomJobs).length + 1).toString(16).padStart(16, "0");
    roomJobs[id] = { ...j, id, state: "queued", items: j.prompts.map((pr, n) => ({ n, prompt: pr, state: "waiting" })) }; return new Response(JSON.stringify({ ok: true, id, hub_online: true })); }
  if (p === "/jobs") { const j = roomJobs[x.searchParams.get("id")]; return j ? new Response(JSON.stringify({ job: j })) : new Response("{}", { status: 404 }); }
  return new Response("{}", { status: 404 }); } };
const W = (await import(tmp)).default;
const grid = { fetch: async (u, init) => {
  const p = new URL(u).pathname;
  if (p === "/grid/providers") return new Response(JSON.stringify({ providers: [{ models: ["qwen3-4b-instruct-2507", "qwen2.5-0.5b-q4km"] }, { models: ["qwen2.5-0.5b-q4km"] }] }));
  if (p === "/grid/job") { jobs++; const j = JSON.parse(init.body);
    if (j.model === "nobody-has-it") return new Response(JSON.stringify({ error: { message: "No volunteer computer has this model yet." } }), { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Paris" } }], grid: { total_ms: 900, checked: false } })); }
  return new Response("{}", { status: 404 }); } };
const env = (extra = {}) => ({ AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "y", SESSION_SECRET: SECRET, MAIL_FROM: "test@invalid", POLICE: { idFromName: () => "g", get: () => grid },
  SHERPA: { idFromName: (n) => n, get: () => sherpa }, B2_MODELS_KEY_ID: "k", B2_MODELS_APP_KEY: "s", ...extra });
const call = async (e, path, user, body, ua) => { const r = await W.fetch(new Request("https://planetcompute.ai" + path, { method: body ? "POST" : "GET",
  headers: { cookie: user ? "pc_session=" + tok(user) : "", "content-type": "application/json", ...(ua ? { "user-agent": ua } : {}) }, body: body ? JSON.stringify(body) : undefined }), e);
  return { status: r.status, j: await r.json().catch(() => ({})) }; };
const ask = (model = "qwen2.5-0.5b-q4km") => ({ model, messages: [{ role: "user", content: "Capital of France?" }], max_tokens: 16 });
const E3 = env({ POOL_DAILY_LIMIT: "3" });

let r = await call(E3, "/api/pool", null);
ok("1 signed out: /api/pool asks to sign in (401)", r.status === 401, r);
r = await call(E3, "/api/pool", "alice");
ok("2 /api/pool: open, limit 3 from POOL_DAILY_LIMIT, 0 used, models with how many computers have them", r.status === 200 && r.j.open && r.j.limit === 3 && r.j.used === 0 &&
  r.j.models[0].id === "qwen2.5-0.5b-q4km" && r.j.models[0].computers === 2 && r.j.models[1].computers === 1, r.j);
const codes = [];
for (let i = 0; i < 4; i++) codes.push((await call(E3, "/api/pool/chat", "alice", ask())).status);
ok("3 three requests answered, the fourth refused with 429 (today's limit)", codes.join(",") === "200,200,200,429", codes);
r = await call(E3, "/api/pool/chat", "alice", ask());
ok("3 the refusal says the limit and when it resets", r.status === 429 && /used today's 3 free requests/.test(r.j.error.message) && /00:00 UTC/.test(r.j.error.message) && r.j.error.type === "pool_limit", r.j);
ok("3 refused requests never reach the grid", jobs === 3, jobs);
r = await call(E3, "/api/pool", "alice");
ok("4 /api/pool says 3 of 3 used", r.j.used === 3, r.j);
r = await call(E3, "/api/pool/chat", "bob", ask("nobody-has-it"));
const afterFail = (await call(E3, "/api/pool", "bob")).j.used;
ok("5 a request the pool could not answer (503) does not count", r.status === 503 && afterFail === 0, { status: r.status, afterFail });
for (let i = 0; i < 5; i++) await call(E3, "/api/pool/chat", "wolf", ask(), "hungrywolf/1");
ok("6 low-priority test traffic (hungry wolves) is not counted", (await call(E3, "/api/pool", "wolf")).j.used === 0);
r = await call(env({ POOL_DAILY_LIMIT: "0" }), "/api/pool/chat", "bob", ask());
const info0 = (await call(env({ POOL_DAILY_LIMIT: "0" }), "/api/pool", "bob")).j;
ok("7 POOL_DAILY_LIMIT=0 closes the pool (403, open false)", r.status === 403 && r.j.error.type === "pool_closed" && info0.open === false, { r, info0 });
ok("8 POOL_DAILY_LIMIT not set: the default (50)", (await call(env(), "/api/pool", "bob")).j.limit === 50);
ok("8 a bad value (abc, -2) falls back to the default", (await call(env({ POOL_DAILY_LIMIT: "abc" }), "/api/pool", "bob")).j.limit === 50 && (await call(env({ POOL_DAILY_LIMIT: "-2" }), "/api/pool", "bob")).j.limit === 50);
r = await call(E3, "/api/pool/chat", "bob", ask());
ok("9 the answer comes back in the chat-completion shape", r.status === 200 && r.j.choices[0].message.content === "Paris", r.j);
// ---- 73. pictures and videos from the pool ----
const EM = env({ POOL_DAILY_MEDIA_LIMIT: "2" });
r = await call(EM, "/api/pool", "alice");
ok("10 /api/pool lists picture models the in-house computers have READY (2 computers), not parts; videos only from fresh, ready, non-hub rows",
  r.j.media_open === true && r.j.image_models.length === 1 && r.j.image_models[0].id === "zimage-turbo-q4k" && r.j.image_models[0].computers === 2 && r.j.video_models.length === 0 && r.j.media_limit === 2 && r.j.media_used === 0, r.j);
r = await call(EM, "/api/pool/media", "alice", { task: "image", model: "zimage-turbo-q4k", prompt: "a red fox in snow", width: 1080, height: 1350 });
const J1 = r.j.job;
ok("11 a picture request becomes a one-prompt SherpaHub job for this account (no check copy, 1080 x 1350 Instagram size kept: the program renders larger and cuts)", r.status === 200 && r.j.ok && r.j.hub === HUB && /one to three hours at this size/.test(r.j.eta) &&
  roomJobs[J1].for_user === "alice" && roomJobs[J1].task === "image" && roomJobs[J1].prompts[0] === "a red fox in snow" && roomJobs[J1].check_pct === 0 && roomJobs[J1].params.width === 1080 && roomJobs[J1].params.height === 1350 && roomJobs[J1].source === "pool", { r, job: roomJobs[J1] });
r = await call(EM, "/api/pool/media", "alice", { task: "video", model: "wan21-t2v-1.3b-q8", prompt: "a boat" });
ok("12 a model no computer has ready is refused (the video model is 40% downloaded / on a stale server / on a hub)", r.status === 400 && /No volunteer computer has that video model/.test(r.j.error.message), r);
r = await call(EM, "/api/pool/media", "alice");
ok("13 the list: the request, waiting", r.j.items.length === 1 && r.j.items[0].job === J1 && r.j.items[0].state === "waiting" && !r.j.items[0].ready && r.j.items[0].prompt === "a red fox in snow", r.j);
roomJobs[J1].items[0] = { n: 0, prompt: "a red fox in snow", state: "done", result: { file: `sherpa_jobs/${J1}/1-0.png`, ms: 2400000, who: { name: "interserver-1" } } };
r = await call(EM, "/api/pool/media", "alice");
ok("14 done: ready, with who made it and how long", r.j.items[0].state === "done" && r.j.items[0].ready && r.j.items[0].made_by === "interserver-1" && r.j.items[0].ms === 2400000, r.j);
let f = await W.fetch(new Request(`https://planetcompute.ai/api/pool/media/file?hub=${encodeURIComponent(HUB)}&job=${J1}`, { headers: { cookie: "pc_session=" + tok("alice") } }), EM);
ok("15 the file for the account that asked", f.status === 200 && f.headers.get("content-type") === "image/png" && (await f.arrayBuffer()).byteLength === 4);
f = await W.fetch(new Request(`https://planetcompute.ai/api/pool/media/file?hub=${encodeURIComponent(HUB)}&job=${J1}`, { headers: { cookie: "pc_session=" + tok("bob") } }), EM);
ok("15 another account cannot get it (404)", f.status === 404);
await call(EM, "/api/pool/media", "alice", { task: "image", model: "zimage-turbo-q4k", prompt: "two" });
r = await call(EM, "/api/pool/media", "alice", { task: "image", model: "zimage-turbo-q4k", prompt: "three" });
ok("16 the media limit (2 a day) is its own: the third is refused with 429", r.status === 429 && /today's 2 pictures and videos/.test(r.j.error.message), r);
ok("16 the chat limit is not touched by pictures", (await call(EM, "/api/pool", "alice")).j.used === 3);
hubsUp = false;
r = await call(env(), "/api/pool/media", "bob", { task: "image", model: "zimage-turbo-q4k", prompt: "no hub" });
const binfo = await call(env(), "/api/pool", "bob");
ok("17 no SherpaHub running: refused (503) and media_open false; the request does not count", r.status === 503 && binfo.j.media_open === false && binfo.j.media_used === 0, { r, b: binfo.j });
hubsUp = true;
ok("18 POOL_DAILY_MEDIA_LIMIT not set: 10; 0 closes it", binfo.j.media_limit === 10 && (await call(env({ POOL_DAILY_MEDIA_LIMIT: "0" }), "/api/pool/media", "bob", { task: "image", model: "zimage-turbo-q4k", prompt: "x" })).status === 403);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
