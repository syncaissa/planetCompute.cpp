// docs/TESTING.md test 105: program versions (table <prefix>versions; admin tab Versions; GET /api/program/version; the
// program's new-version bar and its obsolete stop). The given worker.js's own functions against the TEST table
// pctest-ai-versions (real DynamoDB; its rows are removed afterwards), the decision rule on its own, and the pages.
//   AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. node scripts/test_versions.mjs website/worker.js client/ui/index.html
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

let src = readFileSync(process.argv[2], "utf8");
src += "\nglobalThis.__V = { adminVersions, listVersions, versionVerdict, versionsTable, ddb, M, VERSION_OSES };\n";
const tmp = join(mkdtempSync(join(tmpdir(), "ver-")), "w.mjs"); writeFileSync(tmp, src);
const W = (await import(tmp)).default, V = globalThis.__V;
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n, x === undefined ? "" : JSON.stringify(x).slice(0, 300)); } };
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, AWS_REGION: process.env.AWS_REGION || "us-east-1", DDB_PREFIX: "pctest-ai-", SESSION_SECRET: "test-secret", RESEND_API_KEY: "re_test_unused" };

// 1. the rule on its own
const rows = [
  { os: "Windows", version: "aaa1111", created_at: "2026-10-01T00:00:00Z", active: "no" },
  { os: "Windows", version: "bbb2222", created_at: "2026-10-15T00:00:00Z", active: "yes" },
  { os: "Windows", version: "ccc3333", created_at: "2026-11-01T00:00:00Z", active: "yes" },
  { os: "Mac", version: "ddd4444", created_at: "2026-11-01T00:00:00Z", active: "yes" },
];
let v = V.versionVerdict(rows, "Windows", "ccc3333");
ok("the latest version: no message", !v.newer && !v.obsolete && v.latest === "ccc3333", v);
v = V.versionVerdict(rows, "Windows", "bbb2222");
ok("an older active version: 'there is a new version ccc3333'", v.newer && !v.obsolete && v.latest === "ccc3333" && v.url === "https://planetcompute.ai/download", v);
v = V.versionVerdict(rows, "Windows", "aaa1111");
ok("an inactive version: obsolete (does not start)", v.obsolete === true, v);
v = V.versionVerdict(rows, "Windows", "zzz9999");
ok("a version not in the list (it may be newer than the list): no message, not blocked", !v.newer && !v.obsolete, v);
v = V.versionVerdict(rows, "Linux", "anything");
ok("an OS with no versions listed: no message", !v.newer && !v.obsolete && v.latest === "", v);
ok("the five OS names", V.VERSION_OSES.join() === "Windows,Mac,Linux,LinuxWithGPU,LinuxNoUI");

// 2. the admin routes against the test table, and the program's route
const mark = "t" + (Date.now() % 1e7);
let r = await V.adminVersions(env, "admin@example.com", "/api/admin/versions/add", { os: "LinuxNoUI", version: mark + "a", active: "yes", notes: "test" });
ok("an admin adds a version (active)", r.status === 200);
await new Promise((res) => setTimeout(res, 20));
r = await V.adminVersions(env, "admin@example.com", "/api/admin/versions/add", { os: "LinuxNoUI", version: mark + "b", active: "yes" });
r = await V.adminVersions(env, "admin@example.com", "/api/admin/versions/add", { os: "LinuxNoUI", version: mark + "b" });
ok("the same OS and version twice is refused", r.status === 409);
r = await V.adminVersions(env, "admin@example.com", "/api/admin/versions/add", { os: "Amiga", version: "1" });
ok("an unknown OS is refused", r.status === 400);
r = await V.adminVersions(env, "admin@example.com", "/api/admin/versions/add", { os: "Mac", version: "bad version!" });
ok("a bad version text is refused", r.status === 400);
const ask = async (os, ver) => (await W.fetch(new Request(`https://planetcompute.ai/api/program/version?os=${os}&v=${ver}`), env, { waitUntil() {}, passThroughOnException() {} })).json();
let a = await ask("LinuxNoUI", mark + "a");
ok("GET /api/program/version (no sign-in): the older one is told about the newer", a.newer === true && a.latest === mark + "b" && !a.obsolete, a);
const ra = (await V.listVersions(env)).find((x) => x.version === mark + "a");
r = await V.adminVersions(env, "admin@example.com", "/api/admin/versions/set", { sk: ra.sk, active: "no" });
globalThis.__V; // (the route caches a minute per instance: ask the rule directly after a change)
v = V.versionVerdict(await V.listVersions(env), "LinuxNoUI", mark + "a");
ok("making it inactive makes that version obsolete", r.status === 200 && v.obsolete === true, v);
v = V.versionVerdict(await V.listVersions(env), "LinuxNoUI", mark + "b");
ok("the newest active one is still fine", !v.newer && !v.obsolete, v);
r = await (await W.fetch(new Request("https://planetcompute.ai/api/program/version?os=Nope&v=1"), env, { waitUntil() {}, passThroughOnException() {} }));
ok("the program's route refuses an unknown OS", r.status === 400);
for (const x of (await V.listVersions(env)).filter((x) => x.version.startsWith(mark))) await V.ddb(env, "DeleteItem", { TableName: V.versionsTable(env), Key: V.M({ pk: "V", sk: x.sk }) });
ok("the test rows are removed again", !(await V.listVersions(env)).some((x) => x.version.startsWith(mark)));

// 3. the pages
const admin = await (await W.fetch(new Request("https://planetcompute.ai/admin"), env, { waitUntil() {}, passThroughOnException() {} })).text();
const prog = readFileSync(process.argv[3], "utf8");
ok("admin page: a Versions tab with add, the published builds, OS and status filters and search",
  /data-tab="versions">Versions</.test(admin) && admin.includes('id="vAdd"') && admin.includes('id="vPub"') && admin.includes('id="vfOs"') && admin.includes('data-vf="no"') && admin.includes('id="q-ver"'));
ok("program: the bar says 'There is a new version … available, please download it at …'", prog.includes("There is a new version ${u.latest_version} available, please download it at"));
ok("program: an obsolete version gets the full-window message and nothing else", prog.includes("function obsoleteScreen") && prog.includes("This version of PlanetCompute is obsolete") && prog.includes("if (u && u.obsolete) { obsoleteScreen(u); return; }"));
let bad = 0;
for (const page of [admin, prog]) for (const m of page.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)) { if (/\btype="module"/.test(m[0])) continue; try { new vm.Script(m[1]); } catch (e) { bad++; } }
ok("every inline script of the admin page and the program page parses", bad === 0, bad);

console.log(fail ? `${fail} FAILED, ${pass} passed` : `ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
