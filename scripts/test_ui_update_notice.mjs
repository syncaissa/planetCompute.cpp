// docs/TESTING.md test 90 (program part): the update notice and the build in the program's window (plan_old_programs #1, #3).
// The program's page (client/ui/index.html) in headless Chromium; /local/info and the site answers are faked.
//   cd <folder with playwright-core> && node <repo>/scripts/test_ui_update_notice.mjs <repo>/client/ui/index.html [screenshot dir]
import { createRequire } from "node:module"; const req = createRequire(process.cwd() + "/"), { chromium } = req("playwright-core");
import { readFileSync } from "node:fs";
const [html, outDir] = process.argv.slice(2), page = readFileSync(html, "utf8");
const br = await chromium.launch(), pg = await br.newPage({ viewport: { width: 1280, height: 900 } }), errs = [], opened = [];
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
pg.on("pageerror", (e) => errs.push(e.message));
let update = {}, devices = [];
const info = () => ({ version: "0.1.0", build: "abc1234", build_time: 1793401357, built: "2026-10-30 23:02 UTC", update, port: 7526, device: "abc123abc123", engine: {}, link: "", tunnel: "on" });
const J = (o, s = 200) => ({ status: s, contentType: "application/json", body: JSON.stringify(o) });
await pg.route("**/*", (rt) => { const u = new URL(rt.request().url());
  if (u.pathname === "/" || u.pathname === "/local/") return rt.fulfill({ contentType: "text/html", body: page });
  if (u.pathname === "/local/info") return rt.fulfill(J(info()));
  if (u.pathname === "/local/open") { opened.push(JSON.parse(rt.request().postData() || "{}").url); return rt.fulfill(J({ ok: true })); }
  if (u.pathname === "/api/me/devices") return rt.fulfill(J({ devices, sharing_now: 0, beat_s: 300, idle_beat_s: 900 }));
  if (u.hostname === "127.0.0.1") return rt.fulfill(J({}));
  return rt.abort(); });
const bar = () => pg.evaluate(() => ({ shown: !document.getElementById("updBar").hidden && getComputedStyle(document.getElementById("updBar")).display !== "none",
  text: document.getElementById("updText").textContent }));
const tick = async () => { await pg.evaluate(() => localStorage.removeItem("pc-upd-later")); await pg.reload(); await pg.waitForTimeout(1200); };

await pg.goto("http://127.0.0.1:7526/local/"); await pg.waitForTimeout(1200);
let c = await bar();
ok("1 no newer build (the program has not looked yet, or offline): no notice", !c.shown, c);
const about = await pg.evaluate(() => [...document.querySelectorAll("#about tr")].map((r) => r.textContent));
ok("2 About shows the build and its date", about.some((r) => r === "Buildabc1234, made 2026-10-30 23:02 UTC"), about);
update = { available: true, build_time: 1793500000, built: "2026-11-01 02:26 UTC", commit: "def5678", url: "https://planetcompute.ai/download", too_old_to_earn: false, earn_mode: "" };
await tick(); c = await bar();
ok("3 a newer build: 'A new PlanetCompute is ready (made <date>).'", c.shown && c.text === "A new PlanetCompute is ready (made 2026-11-01 02:26 UTC).", c);
if (outDir) await pg.screenshot({ path: outDir + "/update_ready.png" });
await pg.click("#updGet"); await pg.waitForTimeout(300);
ok("4 Download opens planetcompute.ai/download in the browser", opened[0] === "https://planetcompute.ai/download", opened);
await pg.click("#updLater"); await pg.waitForTimeout(200); c = await bar();
ok("5 Later hides it", !c.shown, c);
await pg.reload(); await pg.waitForTimeout(1200); c = await bar();
ok("6 ... and it stays hidden after a restart (24 h)", !c.shown, c);
update = { ...update, too_old_to_earn: true, earn_mode: "warn" };
await tick(); c = await bar();
ok("7 below the minimum (warn): 'old and will soon stop earning'", c.shown && /will soon stop earning\. Update to keep earning\./.test(c.text), c);
update = { ...update, earn_mode: "enforce" };
await tick(); c = await bar();
ok("8 below the minimum (enforce): 'too old to earn', and local use still works", c.shown && /too old to earn/.test(c.text) && /making pictures and chat here still work/.test(c.text), c);
if (outDir) await pg.screenshot({ path: outDir + "/update_too_old.png" });
ok("9 no script errors", errs.length === 0, errs);
await br.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
