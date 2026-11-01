// The program page: My Balance has "My activity" (daily totals and recent jobs from /api/me/activity), as on the website.
import { createRequire } from "node:module"; const req = createRequire(process.cwd() + "/"), { chromium } = req("playwright-core");
import { readFileSync } from "node:fs";
const [html, outDir] = process.argv.slice(2), page = readFileSync(html, "utf8");
const br = await chromium.launch(), pg = await br.newPage({ viewport: { width: 1280, height: 900 } }), errs = [];
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
pg.on("pageerror", (e) => errs.push(e.message));
let signedIn = true, actQuery = "", act = { flush_minutes: 10, detail_days: 90,
  days: [{ day: "2026-10-27", rx_jobs: 12, rx_failed: 2, rx_ok: 10, rx_total_ms: 22800, rx_uwu: 3460, tx_jobs: 8, tx_uwu: 2768, rx_tokens: 40, tx_tokens: 30 },
         { day: "2026-10-26", tx_jobs: 3, tx_uwu: 1000, tx_tokens: 9 }],
  recent: [{ at: "2026-10-27T18:37:42Z", role: "answered", device: "7905a7a4cc5e", model: "qwen2.5-0.5b-q4km", ok: true, tokens: 3, wait_ms: 26, run_ms: 305, checked: true, agree: "yes", wu: 0.000346 },
           { at: "2026-10-27T18:37:16Z", role: "received", low: true, model: "qwen2.5-0.5b-q4km", ok: false, error: "no answer in time", tokens: 0, wait_ms: 60714, run_ms: 0, checked: false, wu: 0 }] };
const J = (o, s = 200) => ({ status: s, contentType: "application/json", body: JSON.stringify(o) });
await pg.route("**/*", (rt) => { const u = new URL(rt.request().url());
  if (u.pathname === "/" || u.pathname === "/local/") return rt.fulfill({ contentType: "text/html", body: page });
  if (u.pathname === "/local/info") return rt.fulfill(J({ version: "0.1.0", port: 7526, device: "abc123abc123", engine: {}, signed_in: signedIn }));
  if (u.pathname.startsWith("/api/me") && !signedIn) return rt.fulfill(J({ error: "Not signed in." }, 401));
  if (u.pathname === "/api/me") return rt.fulfill(J({ user_id: "u1", first_name: "Test", last_name: "User", primary_email: "t@x", solana_address: "", solana_address_at: "" }));
  if (u.pathname === "/api/me/balance") return rt.fulfill(J({ shared_wu: 1.5, received_wu: 0.2, difference_wu: 1.3, lifetime_contributed_wu: 3, lifetime_transferred_wu: 0, receiving_open: true }));
  if (u.pathname === "/api/me/activity") { actQuery = u.search; return rt.fulfill(J(act)); }
  if (u.hostname === "127.0.0.1") return rt.fulfill(J({}));
  return rt.abort(); });
await pg.goto("http://127.0.0.1:7526/local/"); await pg.waitForTimeout(1500);
await pg.click('header nav button[data-tab="balance"]'); await pg.waitForTimeout(800);
const rows = (id) => pg.evaluate((id) => [...document.querySelectorAll("#" + id + " tr")].map((r) => [...r.children].map((c) => c.textContent)), id);
let c = { shown: await pg.evaluate(() => !document.getElementById("act").hidden), h: await pg.textContent("#act h2"), q: actQuery, r: await rows("actDays") };
ok("1 My Balance shows 'My activity' and asks /api/me/activity?days=14", c.shown && c.h === "My activity" && c.q === "?days=14", c);
ok("2 the day table: header + 2 days; received with failures, answered, WU, tokens, typical wait + run", c.r.length === 3 &&
  c.r[0].join("|") === "Day|Received|Answered|Received WU|Earned WU|Input/output words|Typical wait + run" &&
  c.r[1].join("|") === "2026-10-27|12 (2 failed)|8|0.00346|0.002768|70|2.3 s" && c.r[2].join("|") === "2026-10-26|0|3|0|0.001|9|–", c.r);
await pg.screenshot({ path: outDir + "/bal_activity.png", fullPage: true });
await pg.click("#actMore"); await pg.waitForTimeout(200); c = await rows("actJobs");
ok("3 Recent jobs lists each job: role (device / test), model, result, wait, run, checked, WU", c.length === 3 &&
  c[1].join("|") === "2026-10-27 18:37:42|answered (7905a7a4cc5e)|qwen2.5-0.5b-q4km|answered|3|26 ms|305 ms|agreed|0.000346" &&
  c[2].join("|") === "2026-10-27 18:37:16|received (test)|qwen2.5-0.5b-q4km|failed: no answer in time|0|60.7 s|–|–|0", c);
await pg.screenshot({ path: outDir + "/bal_activity_jobs.png", fullPage: true });
await pg.click("#actMore"); ok("4 a second click hides the jobs", await pg.evaluate(() => document.getElementById("actJobs").hidden), null);
act = { days: [], recent: [] }; await pg.click("#balRefresh"); await pg.waitForTimeout(500);
ok("5 no jobs yet: a plain line, no table", /No AI jobs yet/.test(await pg.textContent("#actMsg")) && (await rows("actDays")).length === 0, await pg.textContent("#actMsg"));
signedIn = false; await pg.click("#balRefresh"); await pg.waitForTimeout(500);
ok("6 signed out: the activity section is hidden with the balance", await pg.evaluate(() => document.getElementById("act").hidden && document.getElementById("balGrid").hidden), null);
ok("7 no page errors", errs.length === 0, errs);
console.log(`\n${pass} passed, ${fail} failed`); await br.close(); process.exit(fail ? 1 : 0);
