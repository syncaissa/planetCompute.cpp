// Test of the heartbeat-server agent (TESTING.md test 26): hbserver/agent/hbagent.py runs for real (python3) in a
// temporary folder with a stand-in "hbserver" (a shell script that only waits), and talks to the website Worker's own
// code (run in Node behind a local HTTP bridge, against pctest-ai-* tables). The admin page's Start / Restart / Stop
// and "restart automatically" are sent through the admin API; the agent's reports and the processes are checked.
//   node scripts/test_hb_agent.mjs <path to worker.js>
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, randomBytes } from "node:crypto";

const src = resolve(process.argv[2] || "website/worker.js");
const tmp = join(mkdtempSync(join(tmpdir(), "pcagent-")), "worker.mjs");
copyFileSync(src, tmp);
const worker = (await import(tmp)).default;
const PREFIX = process.env.DDB_PREFIX || "pctest-ai-";
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_REGION: process.env.AWS_REGION || "us-east-1", DDB_PREFIX: PREFIX, SESSION_SECRET: "test-" + randomBytes(8).toString("hex"),
  ADMIN_EMAILS: "admin-test@planetcompute.ai", RESEND_API_KEY: "re_test", RESEND_FROM: "PlanetCompute <test@planetcompute.ai>", HB_SERVER_SECRET: "hb-test-" + randomBytes(8).toString("hex") };
// fake servers: hb-ok.test.planetcompute.ai answers its health check, hb-down.test.planetcompute.ai does not
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
const UT = PREFIX + "user", ST = PREFIX + "HeartbeatEtcEC2TypeServers";
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra === undefined ? "" : JSON.stringify(extra).slice(0, 400)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let agent, bridge;
try {
  const sc0 = await rawDdb("Scan", { TableName: ST });
  for (const it of sc0.Items || []) await rawDdb("DeleteItem", { TableName: ST, Key: { server_id: it.server_id, sk: it.sk } });
  const id = "a1a1a1a1a1a1", email = "admin-test@planetcompute.ai";
  await rawDdb("PutItem", { TableName: UT, Item: { pk: S(`USER#${id}`), sk: S("PROFILE"), user_id: S(id), primary_email: S(email), IsAdmin: { BOOL: true } } });
  await rawDdb("PutItem", { TableName: UT, Item: { pk: S(`USER#${id}`), sk: S(`EMAIL#${email}`), user_id: S(id), email: S(email) } });
  const token = randomBytes(32).toString("base64url");
  await rawDdb("PutItem", { TableName: UT, Item: { pk: S(`SESSION#${createHash("sha256").update(`${env.SESSION_SECRET}|session|${token}`).digest("hex")}`), sk: S("SESSION"), user_id: S(id), expires_at: { N: String(Math.floor(Date.now() / 1000) + 3600) } } });
  const cookie = readFileSync(src, "utf8").match(/const COOKIE = "([^"]+)"/)[1] + "=" + token;
  const api = async (path, body) => {
    const r = await worker.fetch(new Request("https://planetcompute.ai" + path, { method: body ? "POST" : "GET",
      headers: { origin: "https://planetcompute.ai", cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), env);
    return { status: r.status, d: await r.json() };
  };
  // a server row
  let r = await api("/api/admin/servers/save", { name: "agent-test", hostname: "hb-agent.test.planetcompute.ai" });
  const sid = r.d.rows.find((x) => x.name === "agent-test").server_id;
  // the local bridge: the agent's requests -> the Worker code
  bridge = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const rr = await worker.fetch(new Request("https://planetcompute.ai" + req.url, { method: req.method, headers: req.headers, body: req.method === "POST" ? Buffer.concat(chunks) : undefined }), env);
    res.writeHead(rr.status, { "content-type": "application/json" }); res.end(await rr.text());
  });
  await new Promise((r2) => bridge.listen(0, "127.0.0.1", r2));
  const port = bridge.address().port;
  // the folder, as on a server: bin/hbserver (stand-in), bin/hbagent.py, etc/hbserver.env, data, logs, run
  const D = mkdtempSync(join(tmpdir(), "hbdir-"));
  for (const d of ["bin", "etc", "data", "logs", "run"]) mkdirSync(join(D, d));
  writeFileSync(join(D, "bin", "hbserver"), '#!/bin/sh\n[ "$1" = --version ] && { echo "hbserver 9.9-standin"; exit 0; }\nexec sleep 100000\n'); chmodSync(join(D, "bin", "hbserver"), 0o755);
  copyFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "hbserver", "agent", "hbagent.py"), join(D, "bin", "hbagent.py"));
  writeFileSync(join(D, "etc", "hbserver.env"), `HB_SERVER_SECRET=${createHmac("sha256", env.HB_SERVER_SECRET).update("pc-derived|hb").digest("hex")}\nHB_SERVER_ID=${sid}\nHB_SITE=http://127.0.0.1:${port}\n`);
  agent = spawn("python3", [join(D, "bin", "hbagent.py")], { stdio: ["ignore", "pipe", "pipe"] });
  let agentLog = ""; agent.stdout.on("data", (b) => { agentLog += b; }); agent.stderr.on("data", (b) => { agentLog += b; });
  const row = async () => (await api("/api/admin/servers")).d.rows.find((x) => x.server_id === sid);
  const st = async () => { const x = await row(); return { ...x, ag: JSON.parse(x.agent_state || "{}") }; };
  const until = async (fn, ms = 45000) => { const t0 = Date.now(); let x; while (Date.now() - t0 < ms) { x = await st(); if (fn(x)) return x; await sleep(1000); } return x; };
  const standins = () => { try { return execSync(`pgrep -f "sleep 100000" -P ${agent.pid} || true`).toString().trim().split("\n").filter(Boolean); } catch { return []; } };

  let x = await until((v) => v.ag.hbserver === "running");
  ok("1 the agent starts the program and reports: running, pid, since, version, tunnel state", x.ag.hbserver === "running" && x.ag.pid > 0 && x.ag.since && x.ag.version === "9.9-standin" && x.agent_seen_at, x.ag);
  ok("2 one program process, the agent's child", standins().length === 1, standins());
  r = await api("/api/admin/servers/control", { server_id: sid, action: "stop" });
  x = await until((v) => v.ag.hbserver === "stopped");
  ok("3 Stop on the admin page: the program stops", x.ag.hbserver === "stopped" && x.desired_state === "stopped" && standins().length === 0, x.ag);
  await sleep(6000);
  x = await st();
  ok("4 ...and stays stopped although restart-automatically is on (the admin's Stop is respected)", x.ag.hbserver === "stopped" && x.auto_restart !== false && standins().length === 0, x.ag);
  await api("/api/admin/servers/control", { server_id: sid, action: "start" });
  x = await until((v) => v.ag.hbserver === "running");
  ok("5 Start: running again", x.ag.hbserver === "running" && standins().length === 1, x.ag);
  const pid1 = x.ag.pid;
  execSync(`kill -9 ${pid1}`);                                   // a crash
  x = await until((v) => v.ag.hbserver === "running" && v.ag.pid !== pid1);
  ok("6 a crash with restart-automatically on: restarted, the crash recorded", x.ag.pid !== pid1 && x.ag.restarts >= 1 && /code -9/.test(x.ag.last_exit), x.ag);
  await api("/api/admin/servers/autorestart", { server_id: sid, on: false });
  await until((v) => v.auto_restart === false, 5000);
  await sleep(17000);                                            // the agent learns the new setting at its next report
  const pid2 = (await st()).ag.pid;
  execSync(`kill -9 ${pid2}`);
  x = await until((v) => v.ag.hbserver === "crashed");
  await sleep(5000);
  ok("7 a crash with restart-automatically off: stays down, reported crashed", x.ag.hbserver === "crashed" && standins().length === 0, x.ag);
  await api("/api/admin/servers/control", { server_id: sid, action: "restart" });
  x = await until((v) => v.ag.hbserver === "running");
  ok("8 Restart brings it back", x.ag.hbserver === "running" && standins().length === 1, x.ag);
  const pid3 = x.ag.pid;
  await api("/api/admin/servers/control", { server_id: sid, action: "restart" });
  x = await until((v) => v.ag.hbserver === "running" && v.ag.pid !== pid3);
  ok("9 Restart while running: a new process, the old one gone", x.ag.pid !== pid3 && standins().length === 1, x.ag);
  const bad = await worker.fetch(new Request("https://planetcompute.ai/api/hb/agent", { method: "POST", headers: { "x-hb-sig": "1700000000.00", "content-type": "application/json" }, body: "{}" }), env);
  ok("10 an unsigned agent report is refused", bad.status === 401, bad.status);
  const h = (await worker.fetch(new Request("https://planetcompute.ai/admin", { headers: { cookie } }), env));
  const html = await h.text(); let badJs = 0;
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) { try { new Function(m[1]); } catch (e) { badJs++; } }
  ok("11 the admin page has the Start / Restart / Stop controls and every script parses", html.includes("/api/admin/servers/control") && html.includes("Restart automatically if it stops or crashes") && badJs === 0);
  if (fail) console.log("agent log:\n" + agentLog.split("\n").slice(-25).join("\n"));
} finally {
  if (agent) { agent.kill("SIGTERM"); await sleep(1500); }
  if (bridge) bridge.close();
  const sc = await rawDdb("Scan", { TableName: ST }).catch(() => ({}));
  for (const it of sc.Items || []) await rawDdb("DeleteItem", { TableName: ST, Key: { server_id: it.server_id, sk: it.sk } }).catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
