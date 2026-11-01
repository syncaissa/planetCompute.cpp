// Test (TESTING.md test 48): the volunteer console as the program's window shows it (/?console=1, embedded):
// no script error while it opens, and Start computing starts (the user, 2026-10-27: "'Start Computing' button is not
// working on exe. [works fine on browser]"). The given worker.js runs in-process; the signed-in user is faked
// (/api/me); other API calls answer {} and the police socket is not opened (no network).
//   cd <folder with playwright-core and chromium> && node <repo>/scripts/test_console_embed.mjs <worker.js> <screenshot>
import { createRequire } from "node:module";
const req = createRequire(process.cwd() + "/"), { chromium } = req("playwright-core");
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const tmp = join(mkdtempSync(join(tmpdir(), "ce-")), "w.mjs"); writeFileSync(tmp, readFileSync(process.argv[2], "utf8")); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default;
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
const br = await chromium.launch();
for (const q of ["/?console=1", "/"]) {
  const pg = await br.newPage({ viewport: { width: 1100, height: 900 } }), errs = [];
  pg.on("pageerror", (e) => errs.push(e.message));
  await pg.route(/^https:\/\/planetcompute\.ai\//, async (rt) => { const u = new URL(rt.request().url());
    if (u.pathname === "/api/me") return rt.fulfill({ contentType: "application/json", body: JSON.stringify({ user_id: "u1", primary_email: "t@invalid", emails: [] }) });
    if (u.pathname.startsWith("/api/")) return rt.fulfill({ contentType: "application/json", body: "{}" });
    const res = await W.fetch(new Request(u.toString()), {}); const hd = {}; res.headers.forEach((v, k) => hd[k] = v);
    rt.fulfill({ status: res.status, headers: hd, body: Buffer.from(await res.arrayBuffer()) }); });
  await pg.route(/^https?:\/\/(?!planetcompute\.ai\/)/, (rt) => rt.abort());
  await pg.routeWebSocket(/.*/, (ws) => ws.close());
  await pg.goto("https://planetcompute.ai" + q); await pg.waitForTimeout(2500);
  if (q === "/") { await pg.evaluate(() => document.getElementById("dock") && document.getElementById("dock").click()); await pg.waitForTimeout(800); }
  await pg.evaluate(() => { const a = document.getElementById("agree"); if (!a.checked) a.click(); }); await pg.waitForTimeout(300);
  const label = await pg.$eval("#startBtn", (b) => b.textContent);
  await pg.click("#startBtn"); await pg.waitForTimeout(2500);
  const st = await pg.$eval("#statusText", (e) => e.textContent), run = await pg.$eval("#startBtn", (b) => b.textContent + "|" + b.disabled);
  ok(`${q}: no script error while the console opens`, errs.length === 0, errs);
  ok(`${q}: signed in, "${label}" starts computing (status: ${st})`, label === "Start computing" && /^Running: /.test(st) && run === "Running|true", { label, st, run });
  const app = await pg.$eval(".con-app", (e) => getComputedStyle(e).display !== "none" && e.getBoundingClientRect().height > 0);
  ok(`${q}: the "Download our client app" box is ${q === "/" ? "shown (the website)" : "hidden (the program is the app)"}`, app === (q === "/"), app);
  if (q !== "/") await pg.screenshot({ path: process.argv[3] });
  await pg.click("#pauseBtn").catch(() => {}); await pg.close();
}
await br.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
