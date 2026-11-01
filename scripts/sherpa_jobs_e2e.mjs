// Driver of docs/TESTING.md test 71 (scripts/test_sherpa_jobs_e2e.sh): gives jobs to the REAL SherpaHub through its
// room in the broker (as the admin tab does) and checks each job's log.
//   node scripts/sherpa_jobs_e2e.mjs <base> main                 steps 1-5
//   node scripts/sherpa_jobs_e2e.mjs <base> liar                 step 6 (a lying prompt device is running)
//   node scripts/sherpa_jobs_e2e.mjs <base> restart-begin        step 7a: a long batch; returns when 5 prompts are done (prints the job id)
//   node scripts/sherpa_jobs_e2e.mjs <base> restart-end <job>    step 7b: after the hub was killed and started again
const [BASE, STEP, ARG] = process.argv.slice(2);
let pass = 0, fail = 0;
const ok = (c, what, x) => { if (c) { pass++; console.log("PASS", what); } else { fail++; console.log("FAIL", what, x === undefined ? "" : JSON.stringify(x).slice(0, 600)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => (await fetch(BASE + p)).json();
const post = async (p, b) => (await fetch(BASE + p, { method: "POST", body: JSON.stringify(b) })).json();
let HUB = "";
for (let i = 0; i < 60 && !HUB; i++) { const d = await get("/dir"); const h = (d.hubs || [])[0]; if (h) HUB = h.name; else await sleep(1000); }
if (!HUB) { console.log("FAIL no hub on the directory"); process.exit(1); }
const Q = "hub=" + encodeURIComponent(HUB);
const add = (j) => post("/jobs/add?" + Q, { by: "e2e@test", ...j });
const job = async (id) => get(`/jobs?${Q}&id=${id}`);
async function wait(id, states = ["done", "failed", "cancelled"], ms = 240000) {
  const t = Date.now(); let d;
  while (Date.now() - t < ms) { d = await job(id); if (states.includes(d.job.state)) return d; await sleep(1000); }
  return d;
}
const chat = (n, pct, tag) => ({ kind: "prompts", task: "chat", model: "fake-chat", prompts: Array.from({ length: n }, (_, i) => `${tag} ${i}`), check_pct: pct, params: { seed: 100, max_tokens: 32 } });

if (STEP === "main") {
  // 1. a chat batch: every prompt done once, by the prompt devices; the checked ones AGREE on another device
  let r = await add(chat(20, 25, "hello"));
  ok(r.ok && r.hub_online, "1. chat batch of 20 given to the running hub");
  let d = await wait(r.id);
  const it = d.job.items, checked = it.filter((x) => x.check);
  ok(d.job.state === "done" && it.every((x) => x.state === "done" && /^echo hello \d+ seed \d+$/.test(x.result.text)), "1. all 20 done with the right answers", d.job.state);
  ok(it.every((x) => /^js-0c/.test(x.result.who.name)), "1. each answered by a prompt device (name kept)", it.map((x) => x.result.who.name));
  ok(it.every((x, i) => x.result.text.endsWith(" seed " + (100 + i))), "1. each prompt its own seed (seed + position)");
  ok(checked.length >= 3 && checked.every((x) => x.check.agree === true && x.check.who.device !== x.result.who.device), `1. ${checked.length} checked on ANOTHER device, all AGREE`, checked.map((x) => x.check));
  ok(d.job.events.some((e) => /sent to js-0c/.test(e[1])) && d.job.events.some((e) => /DONE: 20 prompts/.test(e[1])), "1. the log has where each went and the end");
  // 2. pictures: ~3 MB each, in parts device -> hub -> room; compared (the same seed on two devices: AGREE)
  r = await add({ kind: "prompts", task: "image", model: "fake-image", prompts: ["a fox", "a boat", "a tree"], check_pct: 100, params: { seed: 9, width: 1024, height: 1024 } });
  d = await wait(r.id);
  ok(d.job.state === "done" && d.job.items.every((x) => x.state === "done" && x.result.bytes > 2000000 && x.check && x.check.bytes > 2000000), "2. 3 pictures of ~3 MB arrived whole at the room (main and check copy)", d.job.items.map((x) => [x.result && x.result.bytes, x.check && x.check.bytes]));
  ok(d.job.items.every((x) => x.check.agree === true && /mean difference 0/.test(x.check.note)), "2. picture checks: AGREE (difference 0)", d.job.items.map((x) => x.check.note));
  // 3. a matrix job given on the tab: packs to the pack devices; where the pieces went
  r = await add({ kind: "matmul", m: 1024, k: 2048, n: 1024, tile: 64, total: 256, done: 0 });
  d = await wait(r.id);
  const units = (d.devices || []).reduce((a, x) => a + x.units, 0);
  ok(d.job.state === "done" && /DONE in/.test(d.job.events.slice(-1)[0][1]), "3. matrix job DONE (every piece checked, final check)", d.job.events.slice(-2));
  ok(units >= 256 && d.devices.length >= 2, `3. where the pieces went: ${d.devices.length} devices, ${units} checked pieces`, d.devices);
  // 4. a batch and a matrix job at the same time: both end
  const a = await add(chat(10, 0, "both")), b = await add({ kind: "matmul", m: 512, k: 1024, n: 512, tile: 64, total: 64, done: 0 });
  const [da, db] = [await wait(a.id), await wait(b.id)];
  ok(da.job.state === "done" && db.job.state === "done", "4. a prompts batch and a matrix job side by side: both done");
  // 5. cancel a big matrix job while it runs
  r = await add({ kind: "matmul", m: 16384, k: 4096, n: 16384, tile: 64, total: 65536, done: 0 });
  await wait(r.id, ["running"], 30000); await sleep(3000);
  await post("/jobs/cancel?" + Q, { id: r.id, by: "e2e@test" });
  await sleep(1500);
  d = await job(r.id);
  ok(d.job.state === "cancelled" && d.job.done < 65536, `5. a running matrix job cancelled at ${d.job.done} of 65536`, d.job.state);
  const after = await add(chat(2, 0, "after"));
  ok((await wait(after.id)).job.state === "done", "5. the hub goes on with the next job after a cancel");
}
if (STEP === "liar") {
  // 6. a lying prompt device among honest ones: the checks it took part in say DIFFERENT, the others AGREE
  const r = await add(chat(16, 100, "lie"));
  const d = await wait(r.id);
  const diff = d.job.items.filter((x) => x.check && x.check.agree === false), agree = d.job.items.filter((x) => x.check && x.check.agree === true);
  const liarIn = (x) => /^js-0d/.test(x.result.who.name) || /^js-0d/.test(x.check.who.name);
  ok(d.job.state === "done" && diff.length >= 1, `6. ${diff.length} checks DIFFERENT, ${agree.length} AGREE`, d.job.items.map((x) => x.check && [x.result.who.name, x.check.who.name, x.check.agree]));
  ok(diff.every(liarIn) && agree.every((x) => !liarIn(x)), "6. every DIFFERENT involves the lying device, no AGREE does");
}
if (STEP === "drop-begin") {
  // 8. the site drops every connection (a deploy) while prompts are being made: they finish and are delivered once
  const r = await add(chat(6, 0, "veryslow"));
  for (let i = 0; i < 40; i++) { const d = await job(r.id); if (d.job.events.filter((e) => /sent to/.test(e[1])).length >= 3) break; await sleep(250); }
  console.log("JOB " + r.id);
}
if (STEP === "drop-end") {
  const d = await wait(ARG);
  const sent = {};
  for (const e of d.job.events) { const m = e[1].match(/^#(\d+) sent to/); if (m) sent[m[1]] = (sent[m[1]] || 0) + 1; }
  ok(d.job.state === "done" && d.job.items.every((x) => x.state === "done"), "8. after the site dropped every connection mid-batch, all 6 prompts done", d.job.state);
  const before = Object.values(sent).filter((n) => n > 1).length;
  ok(before === 0, "8. no prompt was given out twice (the devices said what they were still making)", sent);
}
if (STEP === "restart-begin") {
  const r = await add(chat(40, 0, "slow"));
  for (let i = 0; i < 240; i++) { const d = await job(r.id); if ((d.job.done || 0) >= 5) break; await sleep(250); }
  console.log("JOB " + r.id);
}
if (STEP === "restart-end") {
  const d = await wait(ARG);
  const done = d.job.items.filter((x) => x.state === "done").length;
  ok(d.job.state === "done" && done === 40, `7. after the hub was killed (kill -9) and started again, the batch finished: ${done} of 40`, d.job.state);
  ok(d.job.events.filter((e) => /started:/.test(e[1])).length >= 2 && d.job.events.some((e) => /started: \d+ of 40 prompts to do/.test(e[1])), "7. the restarted hub went on with what was left", d.job.events.filter((e) => /started/.test(e[1])));
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
