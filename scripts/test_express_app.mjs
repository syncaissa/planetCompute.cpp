// docs/TESTING.md test 81: Receive Compute with no PC = the planetCompute program's OWN page in Express mode
// (planetcompute.ai/express/local/, the program page embedded by BrowserCFWorkerCode/embed_express_ui.py). Headless Chromium;
// the given worker.js answers in-process with a fake DynamoDB, a fake SherpaHub room, a fake B2 (two buckets).
// User 2026-10-29: "design the look and feel as the original - except those that are not applicable for browser based - just
// gray them out and put a note ... save to cloud will have to be active - that should return the url ... Same prompt, new
// seeds / Copy prompt / Save picture / Save to cloud / Delete"; "This computer free, private" greyed when not connected.
//   cd <folder with playwright-core> && node <repo>/scripts/test_express_app.mjs <worker.js> [shots dir]
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/")("playwright-core");
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { createHash } from "node:crypto";
const tmp = join(mkdtempSync(join(tmpdir(), "xa-")), "w.mjs"); writeFileSync(tmp, readFileSync(process.argv[2], "utf8")); globalThis.WebSocketRequestResponsePair = class {};
const SHOTS = process.argv[3] || "";
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, x === undefined ? "" : JSON.stringify(x).slice(0, 500)); } };
const SECRET = "s", sha = (s) => createHash("sha256").update(s).digest("hex"), sha1 = (b) => createHash("sha1").update(b).digest("hex");
const TOK = "testsessiontoken-alice-0123456789";
// ---- fake DynamoDB
const items = new Map(), K = (t, k) => t + "|" + JSON.stringify(Object.keys(k).sort().map((x) => [x, k[x]]));
items.set(K("planetcompute-ai-user", { pk: { S: `SESSION#${sha(`${SECRET}|session|${TOK}`)}` }, sk: { S: "SESSION" } }), { user_id: { S: "alice" }, expires_at: { N: String(Math.floor(Date.now() / 1000) + 3600) } });
items.set(K("planetcompute-ai-user", { pk: { S: "USER#alice" }, sk: { S: "PROFILE" } }), { pk: { S: "USER#alice" }, sk: { S: "PROFILE" }, user_id: { S: "alice" }, primary_email: { S: "alice@example.com" }, first_name: { S: "Alice" } });
const JOB = "00000000000000a1", HUB = "sherpa:hub:u1:3eb5be2903aa";
const credits = (sk) => K("planetcompute-ai-user-credits", { user_id: { S: "alice" }, sk: { S: sk } });
items.set(credits(`POOLMEDIA#2026-10-30T18:00:00Z#${JOB}`), { user_id: { S: "alice" }, sk: { S: `POOLMEDIA#2026-10-30T18:00:00Z#${JOB}` }, hub: { S: HUB }, job: { S: JOB }, task: { S: "image" },
  model: { S: "zimage-turbo-q4k" }, prompt: { S: "A red fox in fresh snow" }, width: { N: "1080" }, height: { N: "1350" }, created_at: { S: "2026-10-30T18:00:00Z" } });
const WH = [{ server_id: { S: "aaaaaaaaaaaa" }, sk: { S: "SERVER" }, role: { S: "" }, agent_seen_at: { S: new Date().toISOString() }, agent_state: { S: JSON.stringify({ instances: [{ i: 1, state: "running", models: [["zimage-turbo-q4k", 100]] }] }) } }];
function ddb(op, b) {
  const k = b.Key ? K(b.TableName, b.Key) : "", v = b.ExpressionAttributeValues || {}, nm = b.ExpressionAttributeNames || {};
  if (op === "GetItem") return items.has(k) ? { Item: items.get(k) } : {};
  if (op === "Scan" && /Workhorses$/.test(b.TableName)) return { Items: WH };
  if (op === "Query" && /begins_with\(sk, :p\)/.test(b.KeyConditionExpression || "")) {
    const rows = [...items.entries()].filter(([kk, x]) => kk.startsWith(b.TableName + "|") && x.user_id && x.user_id.S === v[":u"].S && x.sk && x.sk.S.startsWith(v[":p"].S)).map(([, x]) => x)
      .sort((a, c) => (a.sk.S < c.sk.S ? 1 : -1));
    return { Items: rows.slice(0, b.Limit || 100) };
  }
  if (op === "PutItem") { const it = b.Item; items.set(K(b.TableName, it.pk ? { pk: it.pk, sk: it.sk } : { user_id: it.user_id, sk: it.sk }), it); return {}; }
  if (op === "DeleteItem") { items.delete(k); return {}; }
  if (op === "BatchGetItem") { const out = {}; for (const [t, r] of Object.entries(b.RequestItems)) out[t] = r.Keys.map((x) => items.get(K(t, x))).filter(Boolean); return { Responses: out }; }
  if (op === "UpdateItem") {
    const it = items.get(k) || { ...b.Key }, ue = b.UpdateExpression || "", attrs = {};
    for (const part of ue.split(/(?=\b(?:SET|ADD|REMOVE)\b)/)) {
      const t = part.trim();
      if (t.startsWith("SET ")) for (const a of t.slice(4).split(/,(?![^(]*\))/)) { const m = /(#?\w+)\s*=\s*(?:if_not_exists\((#?\w+),\s*(:\w+)\)|(:\w+))/.exec(a.trim()); if (!m) continue;
        const name = m[1].startsWith("#") ? nm[m[1]] : m[1], val = m[3] ? (it[name] || v[m[3]]) : v[m[4]]; it[name] = val; attrs[name] = val; }
      if (t.startsWith("ADD ")) for (const a of t.slice(4).split(",")) { const [n0, vv] = a.trim().split(/\s+/); const name = n0.startsWith("#") ? nm[n0] : n0; it[name] = { N: String((it[name] ? +it[name].N : 0) + +v[vv].N) }; attrs[name] = it[name]; }
      if (t.startsWith("REMOVE ")) for (const a of t.slice(7).split(",")) { const n0 = a.trim(); delete it[n0.startsWith("#") ? nm[n0] : n0]; }
    }
    items.set(k, it); return { Attributes: attrs };
  }
  return {};
}
// ---- fake B2: planetcompute-ai (originals + the pool's results) and planetcompute-user-media
const BUCKETS = { "planetcompute-ai": "bid-pc", "planetcompute-user-media": "bid-my" };
const files = new Map(); let seq = 0;
const put = (bid, name, data, type) => { const f = { fileId: "f" + ++seq, fileName: name, bid, data: Buffer.from(data), type, at: Date.now() }; files.set(bid + "|" + name, f); return f; };
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(300, 7)]);
put("bid-pc", `sherpa_jobs/${JOB}/0.png`, PNG, "image/png");
const listF = (bid, prefix) => [...files.values()].filter((f) => f.bid === bid && f.fileName.startsWith(prefix)).map((f) => ({ action: "upload", fileId: f.fileId, fileName: f.fileName, contentLength: f.data.length, contentSha1: sha1(f.data), uploadTimestamp: f.at }));
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url, method = init.method || (input.method) || "GET";
  if (/dynamodb\./.test(url)) { const op = String((init.headers || {})["x-amz-target"] || "").split(".").pop(); return J(ddb(op, JSON.parse(init.body || "{}"))); }
  if (/b2_authorize_account/.test(url)) return J({ authorizationToken: "t", accountId: "a", apiInfo: { storageApi: { downloadUrl: "https://f.b2test", apiUrl: "https://api.b2test" } } });
  if (url.startsWith("https://api.b2test/b2api/v3/")) {
    const op = url.split("/").pop(), b = JSON.parse(init.body || "{}");
    if (op === "b2_list_buckets") { const id = BUCKETS[b.bucketName]; return J({ buckets: id ? [{ bucketId: id, bucketName: b.bucketName }] : [] }); }
    if (op === "b2_get_upload_url") return J({ uploadUrl: "https://up.b2test/" + b.bucketId, authorizationToken: "u" });
    if (op === "b2_list_file_names" || op === "b2_list_file_versions") { let l = listF(b.bucketId, b.prefix || ""); if (b.delimiter) l = l.filter((f) => !f.fileName.slice((b.prefix || "").length).includes("/")); return J({ files: l.slice(0, b.maxFileCount || 1000) }); }
    if (op === "b2_copy_file") { const s = [...files.values()].find((f) => f.fileId === b.sourceFileId); const d = put(b.destinationBucketId || s.bid, b.fileName, s.data, b.contentType || s.type); return J({ fileId: d.fileId }); }
    if (op === "b2_delete_file_version") { for (const [k2, f] of files) if (f.fileId === b.fileId) files.delete(k2); return J({}); }
    return J({}, 400);
  }
  if (url.startsWith("https://up.b2test/")) { const h = init.headers; put(url.split("/").pop(), decodeURIComponent(h["X-Bz-File-Name"]), Buffer.from(await new Response(init.body).arrayBuffer()), h["Content-Type"]); return J({ fileId: "x" }); }
  if (url.startsWith("https://f.b2test/file/")) {
    const [bn, ...rest] = url.slice("https://f.b2test/file/".length).split("/"), name = decodeURIComponent(rest.join("/"));
    if (name === "Models/catalog.json") return J({ models: [{ id: "zimage-turbo-q4k", name: "Z-Image Turbo", kind: "image" }] });
    const f = files.get(BUCKETS[bn] + "|" + name);
    return f ? new Response(method === "HEAD" ? null : f.data, { headers: { "content-type": f.type, "content-length": String(f.data.length) } }) : new Response("nf", { status: 404 });
  }
  if (/api\.cloudflare\.com/.test(url)) return J({ success: true });
  return realFetch(input, init);
};
// ---- fake SherpaHub room + directory, and the grid
const posted = [];
const sherpa = { fetch: async (u, init) => { const x = new URL(u), p = x.pathname;
  if (p === "/dir/list") return J({ hubs: [{ name: HUB, queued: 0 }] });
  if (p === "/jobs/add") { posted.push(JSON.parse(init.body)); return J({ ok: true, id: "00000000000000b2" }); }
  if (p === "/jobs" && x.searchParams.get("id") === "00000000000000b2")   // the one asked in this test: being made
    return J({ job: { id: "00000000000000b2", for_user: "alice", state: "running", items: [{ n: 0, state: "running", sent: { at: "2026-10-29T20:05:00.000Z", who: "generouscows-1" } }] } });
  if (p === "/jobs") return J({ job: { id: x.searchParams.get("id"), for_user: "alice", state: "done", items: [{ n: 0, state: "done", result: { file: `sherpa_jobs/${JOB}/0.png`, ok: true, ms: 1234000, at: "2026-10-29T19:14:00Z", who: { name: "generouscows-1" } } }] } });
  return J({}, 404); } };
const grid = { fetch: async (u) => new URL(u).pathname === "/grid/providers" ? J({ providers: [{ models: ["qwen3-4b-instruct-2507"] }] }) : J({}, 404) };
const W = (await import(tmp)).default;
const env = { AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "y", SESSION_SECRET: SECRET, MAIL_FROM: "t@invalid", B2_MODELS_KEY_ID: "k", B2_MODELS_APP_KEY: "s",
  B2_MEDIA_KEY_ID: "mk", B2_MEDIA_APP_KEY: "ms", B2_MEDIA_BUCKET_NAME: "planetcompute-user-media", CF_API_TOKEN: "cf",
  SHERPA: { idFromName: (n) => n, get: () => sherpa }, POLICE: { idFromName: () => "g", get: () => grid } };
const b = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell" });
const ctx = await b.newContext({ viewport: { width: 1366, height: 1000 }, acceptDownloads: true });
await ctx.addCookies([{ name: "pc_session", value: TOK, domain: "planetcompute.ai", path: "/", secure: true }]);
await ctx.addInitScript(() => { localStorage.setItem("pc-cookies-ok", "1"); });
const sent = [];
await ctx.route("**/*", async (r) => {
  const u = new URL(r.request().url());
  if (u.hostname !== "planetcompute.ai") return r.fulfill({ body: "" });
  if (u.pathname === "/api/tunnel/devices") return r.fulfill({ status: 200, contentType: "application/json", body: '{"devices":[]}' });
  if (r.request().method() === "POST") sent.push([u.pathname, r.request().postData()]);
  const res = await W.fetch(new Request(u.toString(), { method: r.request().method(), headers: r.request().headers(), body: ["GET", "HEAD"].includes(r.request().method()) ? undefined : r.request().postDataBuffer() }), env);
  const h = {}; res.headers.forEach((v, k2) => { h[k2] = v; });
  return r.fulfill({ status: res.status, headers: h, body: Buffer.from(await res.arrayBuffer()) });
});
const page = await ctx.newPage();
await page.goto("https://planetcompute.ai/harness#inference"); await page.waitForTimeout(2500);
const src = await page.getAttribute("#devFrame", "src");
ok("1 Receive Compute, no PC: the SAME frame as with a PC (devFrame) shows the program's own page in Express (/express/local/), under the same row ('Express mode', Download, Connect)",
  src && src.startsWith("/express/local/") && await page.isVisible("#devRow") && await page.isVisible("#xConn2") && !(await page.isVisible("#getApp")), src);
const fr = page.frames().find((x) => x.url().includes("/express/local/"));
await fr.waitForSelector("#segWhere", { timeout: 10000 }); await fr.waitForTimeout(1500);
const st = await fr.evaluate(() => { const loc = document.querySelector('#segWhere [data-v="local"]'), pool = document.querySelector('#segWhere [data-v="pool"]');
  return { locDisabled: loc.disabled, locTitle: loc.title, poolPressed: pool.getAttribute("aria-pressed"), bar: (document.querySelector(".xbar") || {}).textContent || "",
    imgRow: !document.getElementById("imgRow").hidden && document.getElementById("imgRow").classList.contains("xlock"), note: (document.querySelector("#imgRow .xnote") || {}).textContent || "",
    sizeActive: getComputedStyle(document.getElementById("iSize")).pointerEvents !== "none", sub: document.getElementById("pSub").textContent }; });
ok("2 'This computer · free, private' greyed (disabled) with 'Connect to your PC ...'; the PlanetCompute pool chosen", st.locDisabled && /Connect to your PC/.test(st.locTitle) && st.poolPressed === "true", st);
ok("3 the Express note at the top of the page", /Express mode/.test(st.bar) && /Connect to your PC to activate more features/.test(st.bar), st.bar);
ok("4 the picture settings stay visible, greyed, with the lock note; Size stays active", st.imgRow && /Connect to your PC to activate more features/.test(st.note) && st.sizeActive, st);
ok("5 the subtitle says the pool, not this computer", /PlanetCompute pool \(Express mode\)/.test(st.sub), st.sub);
const sz = await fr.evaluate(() => ({ v: document.getElementById("iSize").value, t: document.getElementById("iSize").selectedOptions[0].textContent, code: (() => { const c = document.querySelector('#snav [data-page="code"]'); return c.disabled && /coming soon/i.test(c.textContent); })() }));
ok("5c the default size is '1920 × 1080 (Full, HD, Wide)'; Code is disabled, 'coming soon'", sz.v === "1920x1080" && sz.t === "1920 × 1080 (Full, HD, Wide)" && sz.code, sz);
if (SHOTS) await page.screenshot({ path: SHOTS + "/express_app_1366.png", fullPage: false });
// 🎲 Random: one of the 100 built-in picture prompts (client/ui/image_prompts.txt), as in the program (user: "I lost all my 100 random prompts")
const PROMPTS = readFileSync(new URL("../client/ui/image_prompts.txt", import.meta.url), "utf8").split("\n").map((x) => x.trim()).filter(Boolean);
const picks = new Set();
for (let i = 0; i < 6; i++) { await fr.click("#exBtn, button:has-text('Random')"); await fr.waitForTimeout(150); picks.add(await fr.inputValue("#cIn")); }
ok("5b Random fills the prompt with the built-in prompts (100 of them; different picks)", PROMPTS.length === 100 && [...picks].every((x) => PROMPTS.includes(x)) && picks.size > 1, [PROMPTS.length, [...picks].map((x) => x.slice(0, 40))]);
await fr.fill("#cIn", "");
// Generate Images at 1080 x 1350 goes to the pool with that size
await fr.selectOption("#iSize", "1080x1350").catch(() => {});
await fr.fill("#cIn", "A lighthouse in a storm"); await fr.waitForTimeout(300);
await fr.click("#cSend"); await fr.waitForTimeout(1200);
const job = posted.at(-1) || {};
ok("6 Generate Images: a pool job at 1080 x 1350 for the prompt", job.prompts && job.prompts[0] === "A lighthouse in a storm" && job.params && job.params.width === 1080 && job.params.height === 1350, job);
// the Queue lists the one being made on the pool (user 2026-10-29: "the QUEUE is empty")
await fr.evaluate(() => document.querySelector('#snav [data-page="queue"]').click()); await fr.waitForTimeout(1500);
const qtext = await fr.$eval("#qList", (e) => e.textContent).catch(() => "");
ok("6b the Queue shows the pool picture being made: 'On the PlanetCompute pool: being made on generouscows-1 since 20:05 UTC'", /On the PlanetCompute pool: being made on generouscows-1 since 20:05 UTC/.test(qtext) && /A lighthouse in a storm/.test(qtext), qtext.slice(0, 200));
const qn = [...items.keys()].filter((k2) => k2.includes("POOLMEDIA#")).length;
await fr.click("#qList .qrow button"); await fr.waitForTimeout(1200);
ok("6c Remove from list (Delete) takes it off the queue", [...items.keys()].filter((k2) => k2.includes("POOLMEDIA#")).length === qn - 1 && !/A lighthouse in a storm/.test(await fr.$eval("#qList", (e) => e.textContent).catch(() => "")));
// Video page: 🎲 Random uses the 100 built-in video prompts (client/ui/video_prompts.txt); its prompt history is its own
// (user 2026-10-29: "write the 100 video prompts ... keep the history of image video etc prompts separate so no mix")
const VPROMPTS = readFileSync(new URL("../client/ui/video_prompts.txt", import.meta.url), "utf8").split("\n").map((x) => x.trim()).filter(Boolean);
await fr.evaluate(() => document.querySelector('#snav [data-page="video"]').click()); await fr.waitForTimeout(600);
const vpicks = new Set();
for (let i = 0; i < 6; i++) { await fr.click("#pRandom"); await fr.waitForTimeout(100); vpicks.add(await fr.inputValue("#cIn")); }
ok("5d Video page: Random fills the prompt from the 100 built-in video prompts (none from the picture list)", VPROMPTS.length === 100 && [...vpicks].every((x) => VPROMPTS.includes(x) && !PROMPTS.includes(x)) && vpicks.size > 1, [VPROMPTS.length, [...vpicks].map((x) => x.slice(0, 40))]);
await fr.click("#pHist"); await fr.waitForTimeout(400);
const vh = await fr.evaluate(() => ({ t: document.getElementById("histTitle").textContent, l: document.getElementById("histList").textContent }));
await fr.click("#histClose");
await fr.evaluate(() => document.querySelector('#snav [data-page="image"]').click()); await fr.waitForTimeout(600);
await fr.click("#pHist"); await fr.waitForTimeout(400);
const ih = await fr.evaluate(() => ({ t: document.getElementById("histTitle").textContent, l: document.getElementById("histList").textContent }));
await fr.click("#histClose"); await fr.fill("#cIn", "");
ok("5e prompt history is separate: Video history has no picture prompt; Picture history has 'A lighthouse in a storm'", /^Video prompt history/.test(vh.t) && !/A lighthouse in a storm/.test(vh.l) && /^Picture prompt history/.test(ih.t) && /A lighthouse in a storm/.test(ih.l), { vh: vh.t + " | " + vh.l.slice(0, 80), ih: ih.t + " | " + ih.l.slice(0, 80) });
// the finished picture: in the gallery; the viewer's actions
await fr.evaluate(() => { const b2 = document.querySelector('#snav [data-page="image"]'); b2 && b2.click(); }); await fr.waitForTimeout(1500);
const tiles = await fr.$$("#gGrid .gtile");
ok("7 the finished pool picture is in the gallery", tiles.length >= 1, tiles.length);
if (tiles.length) { await tiles[0].click(); await fr.waitForTimeout(800); }
const btns = await fr.$$eval(".va button", (l) => l.map((x) => x.textContent));
ok("8 the viewer has Same prompt, new seeds / Copy prompt / Save picture / Save to cloud / Delete", ["Same prompt, new seeds", "Copy prompt", "Save picture", "Save to cloud", "Delete"].every((t) => btns.includes(t)), btns);
const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 8000 }).catch(() => null), fr.click('.va button:has-text("Save picture")')]);
ok("9 Save picture: a download of the picture", !!dl && /pool-[0-9a-f]{16}\.png$/.test(dl.suggestedFilename()), dl && dl.suggestedFilename());
await fr.click('.va button:has-text("Save to cloud")'); await fr.waitForTimeout(400);
// the first share asks for the sharing rules once (issue 4): OK it
const askTxt = await fr.$eval(".pc-toast.ask .pc-t-msg", (e) => e.textContent).catch(() => "");
ok("9b the first Save to cloud asks once: public link, legal, not sexual, no real person without consent, 18 or older", /Share publicly\?/.test(askTxt) && /not sexual/.test(askTxt) && /real person without their consent/.test(askTxt) && /18 or older/.test(askTxt), askTxt);
await fr.click(".pc-toast.ask .pc-ok").catch(() => {}); await fr.waitForTimeout(1500);
const said = await fr.$eval(".va .say", (e) => e.textContent).catch(() => "");
const cloudFile = [...files.keys()].find((k2) => k2.startsWith("bid-pc|public/users_uploads/alice/planetCompute-pool-"));
const myIndex = [...files.keys()].find((k2) => k2.startsWith("bid-my|") && k2.endsWith("/index.html"));
ok("10 Save to cloud: into Cloud Content, published on my.planetcompute.ai, the link shown", !!cloudFile && !!myIndex && /my\.planetcompute\.ai\/[A-Za-z0-9]{10}/.test(said), { said, cloudFile, myIndex });
const pg = myIndex ? files.get(myIndex).data.toString() : "";
ok("11 its page says 'Generated on: the PlanetCompute pool using Browser (Express mode)'", pg.includes("the PlanetCompute pool using Browser (Express mode)"));
ok("12 the button is now Copy Cloud URL", (await fr.$$eval(".va button", (l) => l.map((x) => x.textContent))).includes("Copy Cloud URL"));
await fr.click('.va button:has-text("Same prompt, new seeds")'); await fr.waitForTimeout(500);
ok("13 Same prompt, new seeds: the picture's prompt is back in the box", ["A red fox in fresh snow", "A lighthouse in a storm"].includes(await fr.inputValue("#cIn")), await fr.inputValue("#cIn"));
if (tiles.length) { const t2 = await fr.$$("#gGrid .gtile"); if (t2.length) { await t2[0].click(); await fr.waitForTimeout(600); } }
const before14 = [...items.keys()].filter((k2) => k2.includes("POOLMEDIA#")).length;
await fr.click('.va button:has-text("Delete")'); await fr.waitForTimeout(300);
await fr.click('.va button:has-text("Delete")').catch(() => {}); await fr.waitForTimeout(1000);   // "Sure?" second press
const after14 = [...items.keys()].filter((k2) => k2.includes("POOLMEDIA#")).length;
ok("14 Delete: one picture off the list", after14 === before14 - 1, { before14, after14 });
// a PC-only call is refused politely
const r403 = await page.evaluate(() => fetch("/express/local/models/download", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.status));
ok("15 a PC-only call (model download) answers 403 'Connect to your PC'", r403 === 403);
await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
