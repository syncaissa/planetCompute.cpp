// docs/TESTING.md test 70: the admin tab SherpaHubs in headless Chromium (the given worker.js in-process; the admin
// answers faked): a server row with its copies (running, connected hub, job now), Start / Stop / Restart and the copies
// select send the right calls, Give work sends a prompts batch and a matrix job, the jobs list, and a job's detail:
// each prompt with the account and device that did it, the check, the result (text, picture link) and the log.
//   cd <folder with playwright-core and chromium> && node <repo>/scripts/test_admin_sherpahubs.mjs <worker.js> <screenshot dir>
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/")("playwright-core");
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const tmp = join(mkdtempSync(join(tmpdir(), "sh-")), "w.mjs"); writeFileSync(tmp, readFileSync(process.argv[2], "utf8")); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default, OUT = process.argv[3];
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
const now = new Date().toISOString(), HUB = "sherpa:hub:u1:3eb5be2903aa";
const ADMIN = {
  rows: [{ server_id: "aaaaaaaaaaaa", role: "sherpahub", name: "interserver-1-sherpahubs", public_ipv4: "203.0.113.10", root_dir: "/root/REMOTESERVERSACCESS/sherpahubs",
    account_email: "admin@test", instances: 2, desired_state: "running", agent_seen_at: now, supply: "on", cores: "4", cap: "50", demand: "", demand_chat_per_hour: "600",
    account_user_id: "u1", agent_state: JSON.stringify({ version: "0.1.0", update_last: { at: now, result: "updated", commit: "9535a7b" }, supply: true,
      demand: { day: "2026-10-30", chat_sent: 12, chat_ok: 11, chat_failed: 1, images_sent: 1, images_failed: 0, last_error: "" },
      instances: [{ i: 1, state: "running", port: 7551, device: "3eb5be2903aa", models: [] }, { i: 2, state: "running", port: 7552, device: "3eb5be2903bb", models: [] }] }) }],
  servers: [{ server_id: "bbbbbbbbbbbb", name: "interserver-1", role: "", agent_seen_at: now,
    agent_state: JSON.stringify({ model_last: { seq: 2, at: now, action: "download", model: "zimage-turbo-q4k", results: { "1": "started", "2": "started" } },
      instances: [{ i: 1, state: "running", device: "3eb5be2903d4", models: [["qwen2.5-0.5b-q4km", 100], ["zimage-turbo-q4k", 45]] }, { i: 2, state: "running", device: "bd68a6636d91", models: [["qwen2.5-0.5b-q4km", 100]] }] }) }],
  hubs: [{ name: HUB, user: "u1", device: "3eb5be2903aa", email: "admin@test", devices: 7, job: "1111111111111111", done: 12, total: 50, wants: ["prompts"], queued: 1, credits: [] }],
  jobs: [{ hub: HUB, id: "1111111111111111", kind: "prompts", state: "running", by: "admin@test", created_at: now, task: "image", model: "flux1-schnell-q4", done: 2, total: 3, failed: 1, last: [now, "#2 failed"] },
         { hub: HUB, id: "2222222222222222", kind: "matmul", state: "done", by: "admin@test", created_at: now, m: 2048, k: 4096, n: 2048, done: 1024, total: 1024 }],
  secret_set: true, max: 5,
};
const JOB = { hub: HUB, job: { id: "1111111111111111", kind: "prompts", task: "image", model: "flux1-schnell-q4", state: "running", by: "admin@test", created_at: now, check_pct: 34, params: { width: 512, height: 512, seed: 7 },
  items: [
    { n: 0, prompt: "a red fox in snow", state: "done", result: { who: { dev: 3, user: "u7", device: "7905a7a4cc5e", name: "gpu-box", email: "volunteer@test" }, ms: 41000, ok: true, file: "sherpa_jobs/1111111111111111/1-0.png" },
      check: { who: { dev: 4, user: "u8", device: "f9680a5e9606", name: "laptop", email: "other@test" }, ok: true, agree: true, diff: 2.1, note: "mean difference 2.1 of 255 (same up to 8)", file: "sherpa_jobs/1111111111111111/1-1.png" } },
    { n: 1, prompt: "a castle", state: "failed", result: { who: { dev: 3, user: "u7", device: "7905a7a4cc5e", name: "gpu-box", email: "volunteer@test" }, ms: 10, ok: false, error: "out of memory" } },
    { n: 2, prompt: "a boat", state: "running" }],
  events: [[now, "submitted by admin@test"], [now, "#1 sent to gpu-box (account u7)"], [now, "#1 check: AGREE (mean difference 2.1 of 255)"]] }, devices: [] };
const calls = [];
const br = await chromium.launch(), errs = [];
const pg = await br.newPage({ viewport: { width: 1400, height: 1100 } }); pg.on("pageerror", (e) => errs.push(e.message));
await pg.route(/^https:\/\/planetcompute\.ai\//, async (rt) => { const u = new URL(rt.request().url()), J = (x, s = 200) => rt.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(x) });
  if (rt.request().method() === "POST") calls.push([u.pathname, JSON.parse(rt.request().postData() || "{}")]);
  if (u.pathname === "/api/me") return J({ user_id: "u1", primary_email: "admin@test", is_admin: true });
  if (u.pathname === "/api/admin/sherpa") return J(ADMIN);
  if (u.pathname === "/api/admin/sherpa/job") return J(JOB);
  if (u.pathname === "/api/admin/sherpa/log") return J({ online: true, drain: false, lines: [[now, "SherpaHub: connected to https://planetcompute.ai"], [now, "SherpaHub: prompts job 1111: 2 of 3 done, 7 devices"]] });
  if (u.pathname === "/api/admin/sherpa/drain") return J({ ok: true, drain: true, online: true });
  if (u.pathname === "/api/admin/sherpa/jobs") return J({ ok: true, hub: HUB, id: "3333333333333333", hub_online: true });
  if (u.pathname.startsWith("/api/admin/workhorses/")) return J({ ok: true, rows: ADMIN.rows });
  if (u.pathname === "/api/admin/sherpa/file") return rt.fulfill({ contentType: "image/png", body: Buffer.from("89504e470d0a1a0a", "hex") });
  if (u.pathname === "/api/models") return J({ models: [{ id: "qwen3-4b-instruct-2507", name: "Qwen3 4B" }, { id: "flux1-schnell-q4", name: "FLUX.1 schnell", kind: "image" }, { id: "flux1-ae", kind: "image-part" }] });
  if (u.pathname.startsWith("/api/")) return J({});
  const res = await W.fetch(new Request(u.toString()), {}); const hd = {}; res.headers.forEach((v, kk) => hd[kk] = v); rt.fulfill({ status: res.status, headers: hd, body: Buffer.from(await res.arrayBuffer()) }); });
await pg.route(/^https?:\/\/(?!planetcompute\.ai\/)/, (rt) => rt.abort());
pg.on("dialog", (d) => d.accept());
await pg.goto("https://planetcompute.ai/admin"); await pg.waitForTimeout(1500);
await pg.evaluate(() => { document.getElementById("gate").style.display = "none"; document.getElementById("app").style.display = ""; });
errs.splice(0);
// the page asks in its own message box (pcConfirm): answer OK
await pg.evaluate(() => { new MutationObserver(() => { const t = document.querySelector(".pc-toast.ask:not([data-seen])"); if (!t) return; t.dataset.seen = "1"; setTimeout(() => t.querySelector(".pc-ok").click(), 0); }).observe(document, { childList: true, subtree: true }); });
await pg.click('.tab[data-tab="sherpahubs"]'); await pg.waitForTimeout(1200);
const txt = (sel) => pg.$eval(sel, (e) => e.textContent);
const srv = await txt("#sh-servers");
ok("1 the server row: name, folder, agent reporting, copy #1 connected with its job and devices, copy #2 not connected yet",
  /interserver-1-sherpahubs/.test(srv) && /sherpahubs/.test(srv) && /agent reporting/.test(srv) && /#1 :7551running/.test(srv) && /connected · hub 3eb5be2903aa/.test(srv) && /12 of 50 · 1 waiting/.test(srv) && /7 devices · needs prompts/.test(srv) && /not connected yet/.test(srv), srv);
ok("2 the Workhorses tab does not list it", !(await txt("#t-workhorses")).includes("interserver-1-sherpahubs"));
// Start / Stop / copies
const head = await pg.$("#sh-servers .panel .bar");
await (await head.$("button:has-text('Start')")).click(); await pg.waitForTimeout(200);
await (await head.$("button:has-text('Stop')")).click(); await pg.waitForTimeout(500);
await pg.selectOption("#sh-servers .panel .bar select", "4"); await pg.waitForTimeout(300);
const ctl = calls.filter((c) => c[0] === "/api/admin/workhorses/control").map((c) => c[1].action), save = calls.find((c) => c[0] === "/api/admin/workhorses/save");
ok("3 Start and Stop (after the question) sent to the row; the copies select saves 4 copies with role sherpahub", ctl.join(",") === "start,stop" && save && save[1].instances === "4" && save[1].role === "sherpahub" && save[1].server_id === "aaaaaaaaaaaa", { ctl, save });
// give work: image prompts
await pg.selectOption("#sh-kind", "image"); await pg.waitForTimeout(100);
const models = await pg.$$eval("#sh-model option", (o) => o.map((x) => x.value));
ok("4 image prompts: only picture models offered (not parts)", models.join(",") === "flux1-schnell-q4", models);
await pg.fill("#sh-prompts", "a fox\na castle\n\na boat"); await pg.fill("#sh-check", "34"); await pg.fill("#sh-w", "768");
await pg.click("#sh-submit"); await pg.waitForTimeout(500);
const g = calls.filter((c) => c[0] === "/api/admin/sherpa/jobs").pop();
ok("5 Give this work: a prompts batch (image, model, 3 lines, check 34%, width 768, any hub)", g && g[1].kind === "prompts" && g[1].task === "image" && g[1].model === "flux1-schnell-q4" &&
  g[1].prompts.split("\n").filter(Boolean).length === 3 && g[1].check_pct === "34" && g[1].width === "768" && g[1].hub === "", g && g[1]);
ok("5 the answer is shown", /Given to hub 3eb5be2903aa/.test(await txt("#sh-jmsg")));
await pg.selectOption("#sh-kind", "matmul"); await pg.fill("#sh-m", "4096"); await pg.waitForTimeout(100);
ok("6 matrix job: pieces and GOP shown", /2048 pieces, 68.7 GOP/.test(await txt("#sh-mminfo")), await txt("#sh-mminfo"));
await pg.click("#sh-submit"); await pg.waitForTimeout(400);
const g2 = calls.filter((c) => c[0] === "/api/admin/sherpa/jobs").pop();
ok("6 a matrix job sent with its sizes", g2[1].kind === "matmul" && g2[1].m === "4096" && g2[1].k === "4096" && g2[1].tile === "64", g2[1]);
// jobs + detail
await pg.waitForTimeout(800);
const jt = await txt("#t-sherpajobs");
ok("7 jobs list: both jobs with work, state and progress", /image · flux1-schnell-q4/.test(jt) && /running/.test(jt) && /2 of 3 · 1 failed/.test(jt) && /matrix 2048x4096x2048/.test(jt) && /1024 of 1024/.test(jt), jt);
const det = await txt("#sh-detail");
ok("8 job detail: each prompt with who did it (email · device name id), its check and its log", /a red fox in snow/.test(det) && /volunteer@test · gpu-box 7905a7a4cc5e/.test(det) &&
  /AGREE with other@test · laptop f9680a5e9606 \(mean difference 2.1/.test(det) && /failed: out of memory/.test(det) && /#1 sent to gpu-box/.test(det), det);
const imgs = await pg.$$eval("#sh-detail img", (x) => x.map((i) => i.getAttribute("src")));
ok("8 the picture result links to the private file route", imgs.length === 1 && imgs[0] === "/api/admin/sherpa/file?key=" + encodeURIComponent("sherpa_jobs/1111111111111111/1-0.png"), imgs);
// 10. Update, Log, Console, Drain
const head2 = await pg.$("#sh-servers .panel .bar");
await (await head2.$("button:has-text('Update to newest build')")).click(); await pg.waitForTimeout(500);
ok("10 Update to newest build (after the question) sends action update", calls.some((c) => c[0] === "/api/admin/workhorses/control" && c[1].action === "update" && c[1].server_id === "aaaaaaaaaaaa"));
ok("10 the row shows the program version and the last update", /Program v0.1.0 · last update .*: updated \(9535a7b\)/.test(await txt("#sh-servers")), await txt("#sh-servers"));
const row1 = (await pg.$$("#sh-servers table tr"))[1];
const consoleHref = await row1.$eval("a.chip", (a) => a.getAttribute("href"));
ok("11 Console links to the copy's own page", consoleHref === "/device/3eb5be2903aa/", consoleHref);
await (await row1.$("button:has-text('Log')")).click(); await pg.waitForTimeout(600);
ok("11 Log shows the hub's own lines", /connected to https:\/\/planetcompute.ai/.test(await txt("#sh-log")) && /Log of interserver-1-sherpahubs #1/.test(await txt("#sh-logtitle")), await txt("#sh-log"));
await (await row1.$("button:has-text('Drain')")).click(); await pg.waitForTimeout(400);
ok("12 Drain sends on: true for that hub", calls.some((c) => c[0] === "/api/admin/sherpa/drain" && c[1].on === true && c[1].hub === HUB));
// 13. models on in-house computers
const mt = await txt("#t-shmodels");
ok("13 models table: each copy's models, downloading %, and the last order", /qwen2.5-0.5b-q4km ✓/.test(mt) && /zimage-turbo-q4k 45%/.test(mt) && /download zimage-turbo-q4k .*#1 started, #2 started/.test(mt), mt);
await pg.selectOption("#sh-mserver", "bbbbbbbbbbbb"); await pg.selectOption("#sh-mmodel", "flux1-schnell-q4"); await pg.selectOption("#sh-mcopies", "2");
await pg.click("#sh-mdl"); await pg.waitForTimeout(400);
const mo = calls.filter((c) => c[0] === "/api/admin/workhorses/models").pop();
ok("13 Download sends the model order (server, model, copy 2)", mo && mo[1].server_id === "bbbbbbbbbbbb" && mo[1].model === "flux1-schnell-q4" && mo[1].action === "download" && mo[1].copies[0] === 2, mo && mo[1]);
const opts = await pg.$$eval("#sh-mmodel option", (o) => o.map((x) => x.value));
ok("13 the model list leaves out parts (they come with their model)", !opts.includes("flux1-ae") && opts.includes("qwen3-4b-instruct-2507"), opts);
// in-house SherpaHub switches (test 87): SupplySimulation / DemandSimulation on the row, and the fleet buttons
const sim = await pg.evaluate(() => { const b = document.querySelector("#sh-servers .sim"); const ins = [...b.querySelectorAll("input")];
  return { sup: b.querySelector(".simSupply").checked, dem: b.querySelector(".simDemand").checked, vals: ins.map((i) => i.value), text: b.textContent }; });
ok("14 the row's simulation box: SupplySimulation on (cores 4, cap 50), DemandSimulation off (600 an hour kept), today's numbers",
  sim.sup && !sim.dem && sim.vals[1] === "4" && sim.vals[2] === "50" && sim.vals[4] === "600" && /Today \(2026-10-30\): 12 chat jobs sent, 11 answered, 1 failed; 1 picture asked/.test(sim.text), sim);
await pg.evaluate(() => { const b = document.querySelector("#sh-servers .sim"); b.querySelector(".simDemand").checked = true; const ins = [...b.querySelectorAll("input")]; ins[4].value = "300"; ins[5].value = "2"; });
await pg.click('#sh-servers .sim button:has-text("Save simulation")'); await pg.waitForTimeout(500);
const sv = calls.filter((c) => c[0] === "/api/admin/workhorses/save").at(-1);
ok("15 Save simulation sends the row with supply on, cores 4, cap 50, demand on, 300 chat jobs an hour, 2 pictures a day; name, account, folder kept",
  sv && sv[1].server_id === "aaaaaaaaaaaa" && sv[1].role === "sherpahub" && sv[1].supply === "on" && sv[1].cores === "4" && sv[1].cap === "50" && sv[1].demand === "on"
  && sv[1].demand_chat_per_hour === "300" && sv[1].demand_images_per_day === "2" && sv[1].name === "interserver-1-sherpahubs" && sv[1].account_email === "admin@test" && sv[1].root_dir === "/root/REMOTESERVERSACCESS/sherpahubs", sv && sv[1]);
await pg.click("#sh-dem-off"); await pg.waitForTimeout(500);
const fl = calls.filter((c) => c[0] === "/api/admin/workhorses/save").at(-1);
ok("16 the fleet button 'DemandSimulation off' saves every SherpaHub row with demand off (supply unchanged)", fl && fl[1].demand === "" && fl[1].supply === "on" && fl[1].server_id === "aaaaaaaaaaaa", fl && fl[1]);
if (OUT) await pg.screenshot({ path: OUT + "/sherpahubs_sim.png", fullPage: false });
ok("9 no script error", errs.length === 0, errs);
await pg.screenshot({ path: OUT + "/admin_sherpahubs.png", fullPage: true });
await br.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
