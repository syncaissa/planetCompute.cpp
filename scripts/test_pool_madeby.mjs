// docs/TESTING.md test 93: who made a pool picture, in the cloud's information panel (user 2026-10-31: "Made by: SherpaHub
// interserver-1-sherpahubs, computer 872ab30c92b3"; "Generated on" said "the user's own computer" for pool pictures).
// When the account's program fetches a finished pool picture (/api/pool/media/file) the site registers it with the
// SherpaHub's server name, the computer, its cores, WholeMode, the BatchMode queue, steps and seconds (poolMadeBy);
// Save to cloud (/api/uploads) then reads those from the registry, never from the program, into the page (ⓘ) and
// meta.json. No seed, no prompt. The given worker.js in Node with a fake DynamoDB, SherpaHub room and B2. No network.
//   node <repo>/scripts/test_pool_madeby.mjs <worker.js>
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { createHash } from "node:crypto";
const tmp = join(mkdtempSync(join(tmpdir(), "pm-")), "w.mjs"); writeFileSync(tmp, readFileSync(process.argv[2], "utf8")); globalThis.WebSocketRequestResponsePair = class {};
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, x === undefined ? "" : JSON.stringify(x).slice(0, 700)); } };
const SECRET = "s", sha = (s) => createHash("sha256").update(s).digest("hex"), TOK = "testsessiontoken-alice-0123456789";
const items = new Map(), K = (t, k) => t + "|" + JSON.stringify(Object.keys(k).sort().map((x) => [x, k[x]]));
const keyOf = (it) => it.pk ? { pk: it.pk, sk: it.sk } : { user_id: it.user_id, sk: it.sk };
items.set(K("planetcompute-ai-user", { pk: { S: `SESSION#${sha(`${SECRET}|session|${TOK}`)}` }, sk: { S: "SESSION" } }), { user_id: { S: "alice" }, expires_at: { N: String(Math.floor(Date.now() / 1000) + 3600) } });
items.set(K("planetcompute-ai-user", { pk: { S: "USER#alice" }, sk: { S: "PROFILE" } }), { pk: { S: "USER#alice" }, sk: { S: "PROFILE" }, user_id: { S: "alice" }, primary_email: { S: "a@example.com" }, created_at: { S: "2026-01-01T00:00:00.000Z" } });
const ROWS = [{ server_id: { S: "cb6de2a66794" }, sk: { S: "SERVER" }, name: { S: "interserver-1" }, instances: { N: "2" },     // no cores set: 16 / (2 x 2) = 4
  agent_state: { S: JSON.stringify({ cores_total: 16, instances: [{ i: 1, device: "3eb5be2903d4", state: "running" }, { i: 2, device: "bd68a6636d91", state: "running" }] }) } }, { server_id: { S: "d0257f91c822" }, sk: { S: "SERVER" }, name: { S: "interserver-1-sherpahubs" }, role: { S: "sherpahub" }, cores: { N: "4" },
  agent_state: { S: JSON.stringify({ cores_total: 16, instances: [{ i: 1, device: "872ab30c92b3", state: "running" }, { i: 2, device: "174d338e018f", state: "running" }] }) } }];
function ddb(op, b) {
  const k = b.Key ? K(b.TableName, b.Key) : "";
  if (op === "GetItem") return items.has(k) ? { Item: items.get(k) } : {};
  if (op === "PutItem") { const kk = K(b.TableName, keyOf(b.Item)); if (/attribute_not_exists/.test(b.ConditionExpression || "") && items.has(kk)) { const e = new Error("c"); e.cond = true; throw e; } items.set(kk, b.Item); return {}; }
  if (op === "Scan" && /Workhorses$/.test(b.TableName)) return { Items: ROWS };
  if (op === "UpdateItem") { const it = items.get(k) || { ...b.Key }; items.set(k, it); return { Attributes: { ...it, share: { S: "tokABCDEF12" }, n: { N: "1" }, b: { N: "1" } } }; }
  return { Items: [] };
}
const png = (w, h, fill) => { const ch = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); return Buffer.concat([l, Buffer.from(type), data, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), ch("IHDR", ihdr), ch("IDAT", Buffer.alloc(300, fill)), ch("IEND", Buffer.alloc(0))]); };
const POOLPNG = png(1920, 1088, 7), OWNPNG = png(1024, 1024, 9);
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const written = {};                                           // my.planetcompute.ai files: name -> text
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (/dynamodb\./.test(url)) { const op = String((init.headers || {})["x-amz-target"] || "").split(".").pop();
    try { return J(ddb(op, JSON.parse(init.body || "{}"))); } catch (e) { return J({ __type: "com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException", message: "c" }, 400); } }
  if (/b2_authorize_account/.test(url)) return J({ authorizationToken: "t", accountId: "a", apiInfo: { storageApi: { downloadUrl: "https://f.b2test", apiUrl: "https://api.b2test", allowed: { buckets: [{ id: "bid", name: "planetcompute-ai" }] } } } });
  if (url === "https://f.b2test/file/planetcompute-ai/sherpa_jobs/00000000000000b2/0.png") return new Response(POOLPNG, { headers: { "content-type": "image/png" } });
  if (/b2_list_file_names|b2_list_buckets/.test(url)) return J({ files: [], buckets: [{ bucketId: "mid", bucketName: "planetcompute-my" }] });
  if (/b2_get_upload_url/.test(url)) return J({ uploadUrl: "https://up.b2test/x", authorizationToken: "u", bucketId: "mid" });
  if (url.startsWith("https://up.b2test/")) { const h = new Headers(init.headers || {}), n = decodeURIComponent(h.get("X-Bz-File-Name") || "");
    if (/(index\.html|meta\.json)$/.test(n)) written[n.split("/").pop()] = new TextDecoder().decode(init.body);
    return J({ fileId: "f1" }); }
  if (/b2_copy_file/.test(url)) return J({ fileId: "c1" });
  if (url.startsWith("https://f.b2test/")) return new Response("", { status: 404 });
  return J({});
};
const sherpa = { fetch: async (u) => { const x = new URL(u);
  if (x.pathname === "/jobs") return J({ job: { id: x.searchParams.get("id"), for_user: "alice", state: "done", model: "zimage-turbo-q4k", prompts: ["A lighthouse in a storm"],
    params: { width: 1920, height: 1088, seed: 123456, steps: 8 },
    items: [{ n: 0, state: "done", result: { file: "sherpa_jobs/00000000000000b2/0.png", ok: true, ms: 1260000, who: { dev: 3, user: "0123456789ab", device: "872ab30c92b3", name: "" } } }] } });
  return J({}, 404); } };
const W = (await import(tmp)).default;
const env = { AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "y", SESSION_SECRET: SECRET, MAIL_FROM: "t@invalid", B2_MODELS_KEY_ID: "k", B2_MODELS_APP_KEY: "s",
  B2_MEDIA_KEY_ID: "mk", B2_MEDIA_APP_KEY: "ms", SHERPA: { idFromName: (n) => n, get: () => sherpa } };
const call = async (path, body, ct) => { const r = await W.fetch(new Request("https://planetcompute.ai" + path, { method: body === undefined ? "GET" : "POST",
  headers: { "user-agent": "planetCompute/0.1.0+e2ca916.1793454763", "cf-connecting-ip": "203.0.113.9", cookie: `pc_session=${TOK}`, ...(ct ? { "content-type": ct } : {}) }, body }), env, { waitUntil() {} });
  return { status: r.status, j: await r.clone().json().catch(() => null) }; };
const HUB = "sherpa:hub:0123456789ab:872ab30c92b3";

// 1: the program fetches the finished pool picture: registered with who made it and how
let r = await call(`/api/pool/media/file?hub=${encodeURIComponent(HUB)}&job=00000000000000b2`);
const row = [...items.entries()].find(([k]) => k.startsWith("planetcompute-ai-media-made|"));
const R = row ? Object.fromEntries(Object.entries(row[1]).map(([k, v]) => [k, v.S ?? (v.N !== undefined ? +v.N : v.BOOL)])) : {};
ok("1 fetched: registered via pool with hub interserver-1-sherpahubs, computer 872ab30c92b3, 4 cores, WholeMode, BatchMode, 8 steps, 1260 s",
  r.status === 200 && R.via === "pool" && R.made_hub === "interserver-1-sherpahubs" && R.made_device === "872ab30c92b3" && R.made_cores === 4
  && R.mode === "WholeMode" && R.queue === "BatchMode" && R.steps === 8 && R.seconds === 1260 && !R.made_volunteer && !R.prompt, R);
// 2: Save to cloud: the page and meta.json say the pool, who and how (from the registry)
r = await call("/api/uploads?name=pool-00000000000000b2.png", POOLPNG, "image/png");
const html = written["index.html"] || "", meta = JSON.parse(written["meta.json"] || "{}");
ok("2 saved to the cloud", r.status === 200 && r.j && r.j.ok, r);
ok("3 ⓘ Generated on: the PlanetCompute pool (not 'the user's own computer')", /<dt>Generated on<\/dt><dd>the PlanetCompute pool<\/dd>/.test(html) && !/own computer using Client<\/dd>/.test(html), html.slice(html.indexOf("<dl>"), html.indexOf("</dl>")));
ok("4 ⓘ Made by: SherpaHub interserver-1-sherpahubs, computer 872ab30c92b3, 4 cores", html.includes("<dt>Made by</dt><dd>SherpaHub interserver-1-sherpahubs, computer 872ab30c92b3, 4 cores</dd>"), html.slice(html.indexOf("<dl>"), html.indexOf("</dl>")));
ok("5 ⓘ How: WholeMode (not split) · BatchMode queue; Steps 8; Time to make 21 minutes", html.includes("<dt>How</dt><dd>WholeMode (not split) · BatchMode queue</dd>")
  && html.includes("<dt>Steps</dt><dd>8</dd>") && html.includes("<dt>Time to make</dt><dd>21 minutes</dd>"), html.slice(html.indexOf("<dl>"), html.indexOf("</dl>")));
ok("6 no seed and no prompt on the page or in meta.json", !/123456|lighthouse/i.test(html) && !/123456|lighthouse/i.test(written["meta.json"] || "") && !("seed" in meta), meta);
ok("7 meta.json has generated_on, made_by, how, steps, time_to_make", meta.generated_on === "the PlanetCompute pool" && /interserver-1-sherpahubs/.test(meta.made_by)
  && /WholeMode/.test(meta.how) && meta.steps === 8 && meta.time_to_make === "21 minutes", meta);
ok("8 the page's note says made on the pool", html.includes("Generated by a user with planetCompute.cpp on the PlanetCompute pool."), null);
// 9: a picture made on the user's own computer keeps its wording and gets no pool rows
const own = createHash("sha512").update(OWNPNG).digest("hex");
items.set(K("planetcompute-ai-media-made", { user_id: { S: "alice" }, sk: { S: "SHA512#" + own } }), { user_id: { S: "alice" }, sk: { S: "SHA512#" + own }, via: { S: "program" }, kind: { S: "image" } });
for (const k of Object.keys(written)) delete written[k];
r = await call("/api/uploads?name=own.png", OWNPNG, "image/png");
const h2 = written["index.html"] || "";
// 10: made by a workhorse copy (its row sets no cores): 4 cores, as its server agent gives it, not 16 / 2 = 8
sherpa.fetch = ((orig) => async (u) => { const x = new URL(u); if (x.pathname === "/jobs" && x.searchParams.get("id") === "00000000000000c3") return J({ job: { id: "00000000000000c3", for_user: "alice", state: "done",
  model: "zimage-turbo-q4k", prompts: ["x"], params: { width: 512, height: 512, steps: 8 }, items: [{ n: 0, state: "done", result: { file: "sherpa_jobs/00000000000000b2/0.png", ok: true, ms: 1200000,
  who: { dev: 4, user: "0123456789ab", device: "3eb5be2903d4", name: "" } } }] } }); return orig(u); })(sherpa.fetch);
items.forEach((v, k) => { if (k.startsWith("planetcompute-ai-media-made|")) items.delete(k); });
await call(`/api/pool/media/file?hub=${encodeURIComponent(HUB)}&job=00000000000000c3`);
const row2 = [...items.entries()].find(([k]) => k.startsWith("planetcompute-ai-media-made|"));
ok("10 a workhorse copy without a cores setting: 4 cores (its agent's share), hub still the SherpaHub's server", row2 && +row2[1].made_cores.N === 4 && row2[1].made_device.S === "3eb5be2903d4"
  && row2[1].made_hub.S === "interserver-1-sherpahubs", row2 && row2[1]);
ok("9 own computer: 'the user's own computer using Client', no Made by / How", r.status === 200 && /<dd>the user's own computer using Client<\/dd>/.test(h2) && !/<dt>Made by<\/dt>/.test(h2), h2.slice(h2.indexOf("<dl>"), h2.indexOf("</dl>")));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
