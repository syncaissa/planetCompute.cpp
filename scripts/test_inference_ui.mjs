// Test of the program's Inference pages (TESTING.md test 28): client/ui/index.html in jsdom against a fake planetCompute
// program (no engine, no keys): the menu, Images / Video forms, live cards, gallery, viewer with how it was made,
// Use these settings, How many + seeds, Prompt history, Chat and Code conversations, Queue.
//   cd <a folder with jsdom installed (npm i jsdom)> && node <repo>/scripts/test_inference_ui.mjs <repo>/client/ui/index.html
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const { JSDOM, VirtualConsole } = createRequire(process.cwd() + "/")("jsdom");
const html = readFileSync(process.argv[2], "utf8");
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, x === undefined ? "" : JSON.stringify(x).slice(0, 300)); } };
const posted = [], errors = [];
let poolUsed = 1;
const poolMedia = [];
const files = [
  { name: "aa11.png", bytes: 500000, at: Date.now() - 60000, type: "image/png", meta: { kind: "image", prompt: "A red fox in fresh snow", negative: "blurry", model: "flux1-schnell-q4", model_name: "FLUX.1 schnell", width: 1024, height: 768, steps: 4, seed: 12345, seconds: 36.8, ran_on: "Vulkan", made_at: Date.now() - 60000 } },
  { name: "bb22.png", bytes: 400000, at: Date.now() - 120000, type: "image/png", meta: { kind: "image", prompt: "A lighthouse in a storm", model: "flux1-schnell-q4", width: 512, height: 512, steps: 4, seed: 7, seconds: 20, ran_on: "CPU", made_at: Date.now() - 120000 } },
  { name: "old.png", bytes: 100000, at: Date.now() - 999999, type: "image/png", meta: null },
  { name: "cc33.webm", bytes: 900000, at: Date.now() - 30000, type: "video/webm", meta: { kind: "video", prompt: "Waves at sunset", model: "wan21-t2v-1.3b-q8", width: 832, height: 480, steps: 20, seed: 99, frames: 33, seconds: 492, made_at: Date.now() - 30000 } },
];
let queue = [{ id: "q1", state: "sampling", step: 2, steps: 4, seconds: 12, video: false, prompt: "A busy market", model: "flux1-schnell-q4", width: 1024, height: 1024, seed: 555, at: Date.now() },
             { id: "q2", state: "queued", ahead: 1, video: false, prompt: "A quiet lake", model: "flux1-schnell-q4", width: 512, height: 512, seed: 556, at: Date.now() }];
const models = { used: 1e10, free: 5e10, dir: "/m", library: [], downloaded: [
  { id: "flux1-schnell-q4", name: "FLUX.1 schnell", kind: "image", state: "ready", size: 1024, steps: 4, verified: true, bytes: 9e9 },
  { id: "wan21-t2v-1.3b-q8", name: "Wan 2.1 1.3B", kind: "video", state: "ready", steps: 20, verified: true, bytes: 5e9 },
  { id: "qwen3-4b-instruct-2507", name: "Qwen3 4B", kind: "chat", state: "ready", verified: true, bytes: 2e9 },
  { id: "qwen2.5-coder-7b", name: "Qwen2.5 Coder 7B", kind: "chat", state: "ready", verified: true, bytes: 4e9 }] };
function answer(path, o) {
  const u = new URL(path, "http://127.0.0.1:7526/"), p = u.pathname, body = o && o.body ? JSON.parse(o.body) : null;
  if (body) posted.push([p, body]);
  const J = (x, st = 200) => new Response(JSON.stringify(x), { status: st, headers: { "content-type": "application/json" } });
  if (p.endsWith("/local/info")) return J({ port: 7526, device: "0123456789ab", version: "0.1.0", mode: "regular" });
  if (p.endsWith("/local/image/examples")) return J({ image: ["EXAMPLE ONE: a grandmother teaching knitting on a porch", "EXAMPLE TWO: a father and son at sunset"] });
  if (p.endsWith("/api/pool")) return J({ open: true, limit: 2, used: poolUsed, models: [{ id: "qwen3-4b-instruct-2507", name: "Qwen3 4B Instruct", computers: 3 }],
    media_open: true, media_limit: 10, media_used: 0, image_models: [{ id: "zimage-turbo-q4k", name: "Z-Image Turbo", computers: 4 }], video_models: [], hubs: 1 });
  if (p.endsWith("/api/pool/media") && o && o.method === "POST") { poolMedia.push({ hub: "sherpa:hub:u1:3eb5be2903aa", job: "00000000000000a1", task: body.task, model: body.model, prompt: body.prompt,
      width: 512, height: 512, created_at: new Date().toISOString(), state: "waiting", ready: false }); return J({ ok: true, job: "00000000000000a1", eta: "usually 30 to 60 minutes (the pool's computers have no graphics cards yet)" }); }
  if (p.endsWith("/api/pool/media")) return J({ items: poolMedia });
  if (p.endsWith("/local/pool/save")) { files.unshift({ name: "pool-" + body.job + ".png", bytes: 400000, at: Date.now(), type: "image/png", meta: { kind: "image", prompt: body.prompt, model: body.model, ran_on: "PlanetCompute pool", width: 512, height: 512 } }); return J({ ok: true }); }
  if (p.endsWith("/api/pool/chat")) { poolUsed++; return J({ choices: [{ message: { role: "assistant", content: "Paris" } }], grid: { total_ms: 1200, checked: true, agree: true } }); }
  if (p.endsWith("/local/models")) return J(models);
  if (p.endsWith("/local/image/info")) return J({ engine: true, busy: false });
  if (p.endsWith("/local/image/queue")) return J({ jobs: queue });
  if (p.endsWith("/local/image/check")) return J({ ok: true, way: "GPU", checks: [{ name: "Engine", state: "pass", text: "ok" }] });
  if (p.endsWith("/local/image")) { const id = "n" + posted.length; queue = queue.concat([{ id, state: "queued", video: false, prompt: body.prompt, model: body.model, width: body.width, height: body.height, seed: body.seed, at: Date.now() }]); return J({ id }); }
  if (p.endsWith("/local/content")) return J({ folder: "/pics", files });
  if (p.includes("/local/content/file/")) return new Response("x", { headers: { "content-type": "image/png" } });
  if (p.endsWith("/local/contribute")) return J({ running: false });
  if (p.endsWith("/v1/chat/completions")) return new Response('data: {"choices":[{"delta":{"content":"print(1)"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  if (p.startsWith("/api/")) return J({ error: "Not signed in." }, 401);
  return J({});
}
const vc = new VirtualConsole(); vc.on("jsdomError", (e) => { const m = String(e.detail && e.detail.stack || e.message || e); if (!/Not implemented|navigation|Could not parse CSS/.test(m)) errors.push(m.split("\n")[0]); });
const dom = new JSDOM(html, { url: "http://127.0.0.1:7526/local/", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc, beforeParse(w) {
  w.fetch = async (path, o = {}) => answer(String(path), o);
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; }; w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  w.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); }; w.HTMLMediaElement.prototype.pause = function () {};
  w.TextDecoder = TextDecoder; w.scrollTo = () => {}; w.navigator.clipboard = { writeText: async () => {} };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
} });
const w = dom.window, d = w.document, $ = (id) => d.getElementById(id), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (e) => e.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
await sleep(1500);
click(d.querySelector('header nav [data-tab="harness"]') || d.querySelector('[data-tab="harness"]')); await sleep(600);
const nav = $("snav"), page = (p) => nav.querySelector(`[data-page="${p}"]`);
ok("1 the menu: Images, Video, Music, Chat, Code, then Queue and My Content", ["image","video","music","chat","code","queue","content"].every((p) => page(p)) &&
  [...nav.querySelectorAll("button")].map((b) => b.dataset.page).join() === "image,video,music,chat,code,queue,content");
click(page("image")); await sleep(800);
ok("2 Images: title, form with prompt, how many, seed, leave out, Generate Images button", $("pTitle").textContent === "Images" && !$("pCreate").hidden && !$("genRow").hidden && !$("negBox").hidden && $("cSend").textContent === "Generate Images" && !$("imgRow").hidden);
const tiles = [...$("gGrid").querySelectorAll(".gtile")];
ok("3 the gallery: the 3 pictures (not the video), newest first, prompt on the tile", tiles.length === 3 && tiles[0].querySelector(".gcap").textContent === "A red fox in fresh snow" && $("gCount").textContent.includes("3"), tiles.length);
ok("4 live cards: the picture being made (step 2 of 4, seed) and the one waiting, with Stop", $("pLive").querySelectorAll(".lcard").length === 2 && /step 2 of 4/.test($("pLive").textContent) && /seed 555/.test($("pLive").textContent));
ok("5 the queue count in the menu", $("qBadge").textContent === "2" && !$("qBadge").hidden, $("qBadge").textContent);
$("gQ").value = "lighthouse"; $("gQ").dispatchEvent(new w.Event("input")); ok("6 search the gallery by prompt", $("gGrid").querySelectorAll(".gtile").length === 1); $("gQ").value = ""; $("gQ").dispatchEvent(new w.Event("input"));
click($("gGrid").querySelector(".gtile")); await sleep(200);
const info = d.querySelector("#viewer .vinfo");
ok("7 a thumbnail opens large with how it was made", !$("viewer").hidden && !info.hidden && /A red fox/.test(info.textContent) && /12345/.test(info.textContent) && /FLUX.1 schnell/.test(info.textContent) && /1024 × 768/.test(info.textContent) && /blurry/.test(info.textContent) && /36.8 s/.test(info.textContent));
d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowRight" })); await sleep(100);
ok("8 the arrow key goes to the next picture", /lighthouse/i.test(info.textContent));
d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowLeft" })); await sleep(100);
click([...info.querySelectorAll("button")].find((b) => b.textContent === "Use these settings")); await sleep(300);
ok("9 Use these settings: prompt, leave out, size, steps, seed, one picture; the viewer closes", $("viewer").hidden && $("cIn").value === "A red fox in fresh snow" && $("pNeg").value === "blurry" && $("iSize").value === "1024x768" && $("iSteps").value === "4" && $("pSeed").value === "12345" && $("pCount").value === "1",
  [$("cIn").value, $("iSize").value, $("pSeed").value]);
$("pCount").value = "3"; $("pCount").dispatchEvent(new w.Event("change")); $("pSeed").value = "42";
ok("10 the button follows How many", $("cSend").textContent === "Generate 3 Images", $("cSend").textContent);
posted.length = 0; $("chatForm").dispatchEvent(new w.Event("submit", { cancelable: true })); await sleep(800);
const made = posted.filter((x) => x[0].endsWith("/local/image"));
ok("11 Generate 3 Images: 3 requests, seeds 42, 43, 44, the leave-out text, the prompt stays in the box", made.length === 3 && made.map((x) => x[1].seed).join() === "42,43,44" && made.every((x) => x[1].negative === "blurry" && x[1].width === 1024 && x[1].height === 768) && $("cIn").value === "A red fox in fresh snow", made.map((x) => x[1]));
$("pSeed").value = ""; $("pCount").value = "1"; posted.length = 0; $("chatForm").dispatchEvent(new w.Event("submit", { cancelable: true })); await sleep(500);
ok("12 no seed: the program picks one (-1 sent)", posted.filter((x) => x[0].endsWith("/local/image"))[0][1].seed === -1);
click($("pRandom")); ok("13 Random fills an example prompt from the program's built-in list (client/ui/image_prompts.txt)", /^EXAMPLE (ONE|TWO):/.test($("cIn").value), $("cIn").value);
click($("pRandom")); const r2 = $("cIn").value; click($("pRandom")); ok("13 Random never repeats the prompt already in the box", $("cIn").value !== r2 && /^EXAMPLE/.test($("cIn").value));
click($("pHist")); await sleep(300);
ok("14 Prompt history: typed and made prompts, once each, with Use", $("histDlg").open && /A red fox in fresh snow/.test($("histList").textContent) && /A lighthouse in a storm/.test($("histList").textContent) && ($("histList").textContent.match(/A red fox in fresh snow/g) || []).length === 1);
click([...$("histList").querySelectorAll("button")].find((b) => b.textContent === "Use")); ok("15 Use fills the prompt and closes", !$("histDlg").open && $("cIn").value.length > 0);
click(page("video")); await sleep(600);
ok("16 Video: its own form and only the video in the gallery", $("pTitle").textContent === "Video" && !$("vidRow").hidden && $("imgRow").hidden && $("gGrid").querySelectorAll(".gtile video").length === 1 && $("cSend").textContent === "Generate Videos");
click(page("music")); await sleep(200);
ok("17 Music: coming soon, no form", !$("pMusic").hidden && $("pCreate").hidden);
click(page("chat")); await sleep(300);
ok("18 Chat: the conversation layout, a model list, Send", $("pCreate").classList.contains("chat") && !$("chatLog").hidden && $("gGrid").hidden && !$("modelRow").hidden && $("cSend").textContent === "Send");
$("cIn").value = "hello"; posted.length = 0; $("chatForm").dispatchEvent(new w.Event("submit", { cancelable: true })); await sleep(500);
const c1 = posted.find((x) => x[0].endsWith("/v1/chat/completions"));
ok("19 Chat sends the conversation without a coding instruction", c1 && c1[1].messages[0].role === "user" && $("chatLog").querySelectorAll(".msg").length === 2);
// Code: coming soon (user 2026-10-29: "disable the 'Code' inference and say coming soon")
const codeBtn = page("code");
ok("20 Code in the menu: disabled, 'coming soon'", codeBtn.disabled && /coming soon/i.test(codeBtn.textContent));
click(codeBtn); await sleep(200);
ok("21 a click on Code does nothing: Chat stays open with its conversation", $("pTitle").textContent === "Chat" && $("chatLog").querySelectorAll(".msg").length === 2 && /hello/.test($("chatLog").textContent));
ok("22 a page saved as Code opens Chat instead", /if \(p === 'code'\) p = 'chat';/.test(html));
// the PlanetCompute pool (chat and code go whole to a volunteer's computer; free, daily limit)
click(d.querySelector('#segWhere [data-v="pool"]')); await sleep(400);
ok("26 Pool on Chat: its own model list (with how many computers have it), the note with today's use, Send on",
  !$("poolRow").hidden && $("modelRow").hidden && /Qwen3 4B Instruct · 3 computers/.test($("poolModel").textContent) && /1 of 2 free requests used today/.test($("whereNote").textContent) && !$("cSend").disabled,
  { note: $("whereNote").textContent, models: $("poolModel").textContent, dis: $("cSend").disabled });
$("cIn").value = "Capital of France?"; posted.length = 0; $("chatForm").dispatchEvent(new w.Event("submit", { cancelable: true })); await sleep(500);
const pc = posted.find((x) => x[0].endsWith("/api/pool/chat"));
ok("27 Send goes to the pool with the pool model; the answer and who answered show", pc && pc[1].model === "qwen3-4b-instruct-2507" && pc[1].messages.slice(-1)[0].content === "Capital of France?" &&
  /Paris/.test($("chatLog").textContent) && /Answered by a volunteer computer in 1.2 s · double-checked by a second computer: same answer/.test($("chatLog").textContent), { pc, log: $("chatLog").textContent.slice(-200) });
ok("28 today's limit reached (2 of 2): Send off", $("cSend").disabled && /2 of 2 free requests used today/.test($("whereNote").textContent), $("whereNote").textContent);
click(page("image")); await sleep(400);
ok("29 Pool on Images: picture models of the pool, the note (time, today's count), Make on",
  !$("poolRow").hidden && /Z-Image Turbo · 4 computers/.test($("poolModel").textContent) && /usually 30 to 60 minutes/.test($("whereNote").textContent) && /0 of 10 pictures and videos asked today/.test($("whereNote").textContent) && !$("cSend").disabled && $("cNew2").hidden,
  { note: $("whereNote").textContent, dis: $("cSend").disabled });
$("cIn").value = "a red fox in snow"; posted.length = 0; $("chatForm").dispatchEvent(new w.Event("submit", { cancelable: true })); await sleep(800);
const pm = posted.find((x) => x[0].endsWith("/api/pool/media"));
ok("31 Make asks the pool (task image, the pool model, the prompt); the answer is shown; a card says it waits in the pool",
  pm && pm[1].task === "image" && pm[1].model === "zimage-turbo-q4k" && pm[1].prompt === "a red fox in snow" && /Asked the PlanetCompute pool: usually 30 to 60 minutes/.test($("whereNote").textContent) &&
  /In the PlanetCompute pool: waiting for a volunteer computer/.test($("pLive").textContent), { pm, note: $("whereNote").textContent, live: $("pLive").textContent.slice(0, 200) });
poolMedia[0].state = "done"; poolMedia[0].ready = true; poolMedia[0].made_by = "interserver-1"; poolMedia[0].ms = 2400000;
posted.length = 0; await w.eval("loadPoolMedia()"); await sleep(800);
const sv = posted.find((x) => x[0].endsWith("/local/pool/save"));
ok("32 when it is done the program saves it into the pictures folder (once), with who made it", sv && sv[1].job === "00000000000000a1" && sv[1].made_by === "interserver-1" && sv[1].seconds === 2400, sv);
ok("32 it is in the gallery now (made by the pool), its card gone", [...$("gGrid").querySelectorAll(".gtile")].some((t) => /a red fox in snow/.test(t.textContent)) && !/a red fox in snow/.test($("pLive").textContent),
  { live: $("pLive").textContent.slice(0, 200) });
posted.length = 0; await w.eval("loadPoolMedia()"); await sleep(500);
ok("32 not saved twice", !posted.some((x) => x[0].endsWith("/local/pool/save")));
click(d.querySelector('#segWhere [data-v="local"]')); await sleep(200);
click(page("queue")); await sleep(800);
ok("23 Queue: the list of every request, in the page", !$("pQueue").hidden && $("pCreate").hidden && $("qList").querySelectorAll(".qrow").length >= 2, $("qList").querySelectorAll(".qrow").length);
queue = queue.concat([{ id: "d1", state: "done", seconds: 30, video: false, prompt: "A finished one", model: "flux1-schnell-q4", width: 512, height: 512, at: Date.now() },
  { id: "e1", state: "error", error: "out of memory", video: false, prompt: "A failed one", model: "flux1-schnell-q4", width: 512, height: 512, at: Date.now() }]);
await sleep(2000);
const qids = [...$("qList").querySelectorAll(".qrow")].map((r) => r.dataset.id);
ok("25 a done request leaves the Queue by itself (it is in My Content); a failed one stays, with 'Remove failed from list'",
  !qids.includes("d1") && qids.includes("e1") && qids.includes("q1") && !$("qClear").hidden && /Remove failed/.test($("qClear").textContent), qids);
const ab = $("about") ? $("about").textContent : "";
ok("30 About says the mode: Regular", /ModeRegular: shares and receives compute/.test(ab), ab.slice(0, 200));
ok("24 no script errors", errors.length === 0, errors);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
