// docs/TESTING.md test 69: the admin tab's jobs in the site's broker (website/worker.js SherpaBroker rooms), run for
// real in the local Cloudflare runtime (start it as in test 65), with a scripted hub and devices:
//   node scripts/test_sherpa_jobs.mjs [http://127.0.0.1:8799]
// A job given to a room reaches its hub; the hub's lines (jstate, tsent, tresult, tcheck, credit with job) build the
// job's log; a file in parts is collected; cancel reaches the hub; after a reconnect the jobs still to do come again
// with "jobs_end"; devices with models are routed to a hub that has prompts waiting.
const BASE = process.argv[2] || "http://127.0.0.1:8799", WS = BASE.replace(/^http/, "ws");
let pass = 0, fail = 0;
const ok = (c, what, x) => { if (c) { pass++; console.log("PASS", what); } else { fail++; console.log("FAIL", what, x === undefined ? "" : JSON.stringify(x)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, ms = 3000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await sleep(30); } return false; }
function open(path, q) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS}${path}?${new URLSearchParams(q)}`); ws.binaryType = "arraybuffer";
    const s = { ws, texts: [], bins: [], closed: null, opened: false };
    ws.onopen = () => { s.opened = true; resolve(s); };
    ws.onmessage = (e) => { if (typeof e.data === "string") s.texts.push(JSON.parse(e.data)); else s.bins.push(new Uint8Array(e.data)); };
    ws.onclose = (e) => { s.closed = e.code; resolve(s); };
    ws.onerror = () => {};
  });
}
const post = async (p, body) => (await fetch(BASE + p, { method: "POST", body: JSON.stringify(body) })).json();
const get = async (p) => (await fetch(BASE + p)).json();
const HUB = "sherpa:hub:u-h00000000009:h00000000009", Q = "hub=" + encodeURIComponent(HUB);
const send = (s, o) => s.ws.send(JSON.stringify(o));

// 1. a job given while the hub is offline waits; the hub gets it when it connects, then "jobs_end"
let r = await post("/jobs/add?" + Q, { kind: "matmul", by: "admin@test", m: 256, k: 512, n: 256, tile: 64, total: 16, done: 0 });
ok(r.ok && /^[0-9a-f]{16}$/.test(r.id) && r.hub_online === false, "1. job stored while the hub is offline", r);
const J1 = r.id;
let H = await open("/api/sherpa/hub", { device: "h00000000009" });
ok(await until(() => H.texts.some((m) => m.t === "job" && m.id === J1 && m.kind === "matmul" && m.m === 256)), "1. the hub gets the job when it connects");
ok(await until(() => H.texts.some((m) => m.t === "jobs_end")), "1. then jobs_end");

// 2. the matrix job's log: running, credits per device, progress from status, done
const D1 = await open("/api/sherpa/device", { device: "d00000000001" });
send(D1, { t: "hello", cache: 1 << 20, cores: 2, name: "box-1" });
ok(await until(() => H.texts.some((m) => m.t === "hello")), "2. a device for it");
const dev1 = H.texts.find((m) => m.t === "hello").dev;
ok(H.texts.find((m) => m.t === "hello").name === "box-1", "2. hello carries the device's name");
send(H, { t: "jstate", job: J1, state: "running", note: "started: 16 units" });
send(H, { t: "status", job: J1, done: 4, total: 16, open: true, wants: ["packs"], queued: 0 });
send(H, { t: "credit", dev: dev1, units: 4, job: J1 }); send(H, { t: "strike", dev: dev1, job: J1 });
await sleep(300);
let d = await get(`/jobs?${Q}&id=${J1}`);
ok(d.job.state === "running" && d.job.done === 4 && d.job.started_at, "2. running, 4 of 16 done", d.job);
ok(d.devices.length === 1 && d.devices[0].units === 4 && d.devices[0].strikes === 1 && d.devices[0].name === "box-1", "2. where the pieces went: box-1 4 pieces, 1 strike", d.devices);
send(H, { t: "jstate", job: J1, state: "done", note: "DONE" });
await sleep(200);
d = await get(`/jobs?${Q}&id=${J1}`);
ok(d.job.state === "done" && d.job.finished_at && d.job.events.length >= 3, "2. done, with its log", d.job.events);

// 3. a prompts job: to the hub at once; tsent / tresult / tcheck make each prompt's line
r = await post("/jobs/add?" + Q, { kind: "prompts", by: "admin@test", task: "chat", model: "qwen", prompts: ["one", "two", "three"], check_pct: 34, params: { seed: 1, max_tokens: 8 } });
const J2 = r.id;
ok(r.ok && r.hub_online === true, "3. prompts job given while the hub is online");
ok(await until(() => H.texts.some((m) => m.t === "job" && m.id === J2 && m.prompts.length === 3 && m.done.length === 0)), "3. the hub gets the 3 prompts");
send(H, { t: "jstate", job: J2, state: "running" });
send(H, { t: "tsent", job: J2, n: 0, dev: dev1, copy: 0 });
send(H, { t: "tresult", job: J2, n: 0, dev: dev1, copy: 0, ok: true, ms: 1500, text: "answer one" });
send(H, { t: "tsent", job: J2, n: 1, dev: dev1, copy: 0 });
send(H, { t: "tresult", job: J2, n: 1, dev: dev1, copy: 0, ok: false, ms: 10, error: "out of memory", final: false });
send(H, { t: "tresult", job: J2, n: 1, dev: dev1, copy: 0, ok: false, ms: 10, error: "out of memory", final: true });
send(H, { t: "tresult", job: J2, n: 0, dev: dev1, copy: 1, ok: true, ms: 1400, text: "answer one" });
send(H, { t: "tcheck", job: J2, n: 0, agree: true, diff: 0, note: "same text" });
await sleep(400);
d = await get(`/jobs?${Q}&id=${J2}`);
const it = d.job.items;
ok(it[0].state === "done" && it[0].result.text === "answer one" && it[0].result.who.name === "box-1" && it[0].result.who.user === "u-d00000000001", "3. prompt 1 done by box-1 (account and device kept)", it[0]);
ok(it[0].check && it[0].check.agree === true && it[0].check.note === "same text", "3. its check: AGREE", it[0].check);
ok(it[1].state === "failed" && it[1].result.error === "out of memory", "3. prompt 2 failed after its last try", it[1]);
ok(it[2].state === "waiting" && d.job.done === 2, "3. prompt 3 waiting; 2 of 3 counted", { s: it[2].state, done: d.job.done });
ok(d.job.events.some((e) => /#1 sent to box-1/.test(e[1])) && d.job.events.some((e) => /#1 check: AGREE/.test(e[1])), "3. the log says where each piece went");

// 4. a picture in 3 parts (frames to device 0): collected; B2 is not reachable here, so the log says it was not saved
const part = (n, copy, i, parts, len) => {
  const meta = new TextEncoder().encode(JSON.stringify({ job: J2, n, copy, part: i, parts, ext: "png" }));
  const b = new Uint8Array(4 + 12 + meta.length + len), v = new DataView(b.buffer);
  v.setUint32(0, 0, true); v.setUint32(4, 0x50574350, true); b[8] = 7; b[9] = 1; v.setUint32(12, meta.length, true); b.set(meta, 16);
  return b;
};
for (let i = 0; i < 3; i++) H.ws.send(part(2, 0, i, 3, 1000));
await sleep(800);
d = await get(`/jobs?${Q}&id=${J2}`);
ok(d.job.items[2].result && d.job.items[2].result.bytes === 3000, "4. 3 parts collected into one 3,000-byte file", d.job.items[2].result);

// 5. cancel reaches the hub; the job is not sent again after a reconnect
r = await post("/jobs/cancel?" + Q, { id: J2, by: "admin@test" });
ok(r.ok && await until(() => H.texts.some((m) => m.t === "cancel" && m.job === J2)), "5. cancel reaches the hub");
r = await post("/jobs/add?" + Q, { kind: "matmul", by: "admin@test", m: 128, k: 128, n: 128, tile: 64, total: 4, done: 0 });
const J3 = r.id;
H.ws.close(); await sleep(400);
H = await open("/api/sherpa/hub", { device: "h00000000009" });
ok(await until(() => H.texts.some((m) => m.t === "jobs_end")), "5. reconnected");
const ids = H.texts.filter((m) => m.t === "job").map((m) => m.id);
ok(ids.includes(J3) && !ids.includes(J2) && !ids.includes(J1), "5. only the job still to do comes again", ids);

// 6. list: newest first, with progress
const L = await get("/jobs?" + Q);
ok(L.jobs.length === 3 && L.jobs[0].id === J3 && L.jobs.find((j) => j.id === J2).state === "cancelled", "6. jobs list newest first, states kept", L.jobs.map((j) => [j.id.slice(0, 4), j.state]));

// 7. routing by kind: a second hub wants prompts; a device with models goes there, a browser to a packs hub
send(H, { t: "status", job: J3, done: 0, total: 4, open: true, wants: ["packs"], queued: 0 });
const H2 = await open("/api/sherpa/hub", { device: "h00000000010" });
send(H2, { t: "status", job: "x", done: 0, total: 3, open: true, wants: ["prompts"], queued: 0 });
await sleep(500);
const P = await open("/api/sherpa/device", { device: "e00000000001", kinds: "packs,prompts" });
send(P, { t: "hello", cache: 1 << 20, cores: 2, name: "gpu-box", models: [{ id: "qwen", kind: "text" }] });
const B = await open("/api/sherpa/device", { device: "e00000000002", kinds: "packs" });
send(B, { t: "hello", cache: 1 << 20, cores: 1 });
await sleep(500);
const h2 = H2.texts.filter((m) => m.t === "hello");
ok(h2.length === 1 && h2[0].models[0].id === "qwen" && h2[0].name === "gpu-box", "7. the device with models went to the hub with prompts waiting", h2);
ok(H.texts.filter((m) => m.t === "hello").length >= 1 && !h2.some((m) => !m.models.length), "7. the browser-like device went to the hub with packs");
// 8. the prompts hub has nothing left: its devices are sent on (4010)
send(H2, { t: "status", job: "", done: 0, total: 0, open: false, wants: [], queued: 0 });
ok(await until(() => P.closed === 4010), "8. a hub with no work sends its devices on (4010)", P.closed);
// 9. the hub's own log lines are kept (the last 300); drain reaches the hub, is sent again after a reconnect, shows in its status
for (let i = 0; i < 305; i++) send(H, { t: "log", line: "line " + i });
await sleep(1500);
let lg = await get("/hublog?" + Q);
ok(lg.lines.length === 300 && lg.lines[299][1] === "line 304" && lg.lines[0][1] === "line 5" && lg.online === true, "9. hub log: the last 300 lines kept, newest last", [lg.lines.length, lg.lines[0], lg.lines[299]]);
let dr = await post("/drain?" + Q, { on: true });
ok(dr.ok && dr.drain && await until(() => H.texts.some((m) => m.t === "drain" && m.on === true)), "9. drain reaches the hub");
H.ws.close(); await sleep(400);
H = await open("/api/sherpa/hub", { device: "h00000000009" });
ok(await until(() => H.texts.some((m) => m.t === "drain" && m.on === true)), "9. drain is sent again when the hub reconnects");
send(H, { t: "status", job: "", done: 0, total: 0, open: false, wants: [], queued: 1, draining: true, idle: true });
await sleep(300);
lg = await get("/hublog?" + Q);
ok(lg.drain === true && lg.status.draining === true && lg.status.idle === true, "9. its status says drained (safe to stop)", lg.status);
await post("/drain?" + Q, { on: false });
ok(await until(() => H.texts.some((m) => m.t === "drain" && m.on === false)), "9. drain off reaches the hub");
for (const s of [H, H2, D1, P, B]) try { s.ws.close(); } catch (e) {}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
