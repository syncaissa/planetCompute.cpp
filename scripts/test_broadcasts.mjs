// docs/TESTING.md test 104: notifications to every signed-in user (table <prefix>user-broadcast; admin tab Notifications;
// /api/me/broadcasts; the pop-up on the website and in the program). Runs the given worker.js's own functions against the
// TEST table pctest-ai-user-broadcast (real DynamoDB; the rows it adds are removed again), then checks the pages:
//   AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. node scripts/test_broadcasts.mjs website/worker.js client/ui/index.html
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

let src = readFileSync(process.argv[2], "utf8");
src += "\nglobalThis.__B = { adminBroadcasts, activeBroadcasts, listBroadcasts, ddb, M, broadcastTable };\n";
const tmp = join(mkdtempSync(join(tmpdir(), "bc-")), "w.mjs"); writeFileSync(tmp, src);
const W = (await import(tmp)).default, B = globalThis.__B;
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n, x === undefined ? "" : JSON.stringify(x).slice(0, 300)); } };
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, AWS_REGION: process.env.AWS_REGION || "us-east-1", DDB_PREFIX: "pctest-ai-" };
const body = async (r) => r.json();
const mark = "test-" + Date.now();

ok("the table name is <prefix>user-broadcast", B.broadcastTable(env) === "pctest-ai-user-broadcast");
let r = await B.adminBroadcasts(env, "admin@example.com", "/api/admin/broadcasts/add", { title: mark + " A", message: "Maintenance tonight 22:00-23:00 UTC.\nSign-in may pause briefly.", active: true });
ok("an admin adds an active notification", r.status === 200 && (await body(r)).rows.some((x) => x.title === mark + " A" && x.active));
r = await B.adminBroadcasts(env, "admin@example.com", "/api/admin/broadcasts/add", { title: mark + " B", message: "Draft, not shown yet.", active: false });
ok("an admin adds an inactive notification", r.status === 200 && (await body(r)).rows.some((x) => x.title === mark + " B" && !x.active));
r = await B.adminBroadcasts(env, "admin@example.com", "/api/admin/broadcasts/add", { title: "x", message: "   " });
ok("an empty notification is refused", r.status === 400);
const all = await B.listBroadcasts(env), a = all.find((x) => x.title === mark + " A"), b = all.find((x) => x.title === mark + " B");
ok("the list keeps the timestamp, the flag, the text and who added it", a && /^\d{4}-\d\d-\d\dT/.test(a.created_at) && a.by === "admin@example.com" && a.message.includes("\n"), a);
let act = await B.activeBroadcasts(env);
ok("users get the active one, not the inactive one", act.some((x) => x.id === a.id) && !act.some((x) => x.id === b.id), act.map((x) => x.title));
ok("users get only id, time, title and text (not who added it)", act.every((x) => Object.keys(x).sort().join() === "created_at,id,message,title"), act[0]);
r = await B.adminBroadcasts(env, "admin@example.com", "/api/admin/broadcasts/set", { sk: b.sk, active: true });
act = await B.activeBroadcasts(env);
ok("making the draft active shows it at once (the cache is cleared)", r.status === 200 && act.some((x) => x.id === b.id), act.map((x) => x.title));
r = await B.adminBroadcasts(env, "admin@example.com", "/api/admin/broadcasts/set", { sk: a.sk, active: false });
act = await B.activeBroadcasts(env);
ok("making a notification inactive hides it at once", r.status === 200 && !act.some((x) => x.id === a.id), act.map((x) => x.title));
r = await B.adminBroadcasts(env, "admin@example.com", "/api/admin/broadcasts/set", { sk: "bad", active: true });
ok("a bad key is refused", r.status === 400);
// clean up the test rows
for (const x of [a, b]) await B.ddb(env, "DeleteItem", { TableName: B.broadcastTable(env), Key: B.M({ pk: "B", sk: x.sk }) });
ok("the test rows are removed again", !(await B.listBroadcasts(env)).some((x) => x.title.startsWith(mark)));

// the pages: the admin tab and the pop-up are in the website, the pop-up in the program, and their scripts parse
const req = (p) => W.fetch(new Request("https://planetcompute.ai" + p), { ...env }, { waitUntil() {}, passThroughOnException() {} });
const home = await (await req("/")).text(), admin = await (await req("/admin")).text(), prog = readFileSync(process.argv[3], "utf8");
ok("admin page: a Notifications tab with add, filters and search", /data-tab="broadcast">Notifications</.test(admin) && admin.includes('id="bcAdd"') && admin.includes('data-bcf="inactive"') && admin.includes('id="q-bc"'));
ok("website: the pop-up is shown for a signed-in user (after /api/me)", home.includes("function pcShowBroadcasts") && home.includes('api("/api/me/broadcasts")'));
ok("program: the pop-up is shown after it signs in", prog.includes("function pcShowBroadcasts") && prog.includes("api/me/broadcasts"));
let bad = 0;
for (const page of [home, admin]) for (const m of page.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)) { try { new vm.Script(m[1]); } catch (e) { bad++; } }
for (const m of prog.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)) { if (/\btype="module"/.test(m[0])) continue; try { new vm.Script(m[1]); } catch (e) { bad++; } }
ok("every inline script of the home page, the admin page and the program page parses", bad === 0, bad);

// the pop-up itself: a minimal page, then the x closes it and it stays closed for this session
const fn = home.match(/function pcShowBroadcasts\(rows\) \{[\s\S]*?\n  \}\n/)[0];
const els = [], store = {};
const mk = (tag) => { const e = { tag, children: [], style: {}, attrs: {}, listeners: {}, set textContent(v) { this._t = v; }, get textContent() { return this._t; },
  appendChild(c) { this.children.push(c); c.parent = this; return c; }, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, f) { this.listeners[k] = f; },
  remove() { const i = doc.body.children.indexOf(this); if (i >= 0) doc.body.children.splice(i, 1); }, focus() {} }; els.push(e); return e; };
const doc = { body: mk("body"), createElement: mk, getElementById: (id) => doc.body.children.find((c) => c.id === id) || null, addEventListener() {}, removeEventListener() {} };
const ctx = vm.createContext({ document: doc, sessionStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } }, Date });
vm.runInContext(fn + "\nthis.show = pcShowBroadcasts;", ctx);
const rows = [{ id: "a1", created_at: new Date().toISOString(), title: "Hello", message: "First" }, { id: "b2", created_at: new Date().toISOString(), title: "", message: "Second" }];
ctx.show(rows);
const pop = doc.getElementById("pcBroadcast");
ok("the pop-up opens with both notifications and an x", pop && els.some((e) => e.tag === "button" && e.textContent === "×") && els.some((e) => e.textContent === "First") && els.some((e) => e.textContent === "Second"));
els.find((e) => e.tag === "button" && e.textContent === "×").onclick();
ok("the x closes it", !doc.getElementById("pcBroadcast"));
ctx.show(rows);
ok("closed: not shown again in the same session", !doc.getElementById("pcBroadcast"));
ctx.show(rows.concat([{ id: "c3", created_at: new Date().toISOString(), title: "New", message: "Third" }]));
ok("a new notification shows the pop-up again", !!doc.getElementById("pcBroadcast"));

console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
