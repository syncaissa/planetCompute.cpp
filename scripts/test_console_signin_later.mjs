// docs/TESTING.md test 91: the console asks the website again before asking to sign in (user, 2026-10-31: "I was already
// logged on - but when I tried to contribute compute (added cores etc) - it kept asking me to signin again").
// In the program window the console page loads once; signing in on the program's Account tab (or in another tab)
// came later, so the page still thought "signed out" and Start opened the sign-in box. The given worker.js answers
// the pages in-process; /api/me is faked: signed out when the page loads, signed in from a chosen moment.
//   cd <folder with playwright-core> && node <repo>/scripts/test_console_signin_later.mjs <worker.js> [screenshot dir]
import { createRequire } from "node:module";
const req = createRequire(process.cwd() + "/"), { chromium } = req("playwright-core");
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const tmp = join(mkdtempSync(join(tmpdir(), "cs-")), "w.mjs"); writeFileSync(tmp, readFileSync(process.argv[2], "utf8")); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default, SHOTS = process.argv[3] || "";
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
const br = await chromium.launch();
async function run(signedInLater, name) {
  const pg = await br.newPage({ viewport: { width: 1100, height: 900 } }), errs = [];
  let signedIn = false, meCalls = 0;
  pg.on("pageerror", (e) => errs.push(e.message));
  await pg.route(/^https:\/\/planetcompute\.ai\//, async (rt) => { const u = new URL(rt.request().url());
    if (u.pathname === "/api/me") { meCalls++; return signedIn ? rt.fulfill({ contentType: "application/json", body: JSON.stringify({ user_id: "u1", first_name: "Milind", primary_email: "t@invalid", emails: [] }) })
      : rt.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Not signed in." }) }); }
    if (u.pathname.startsWith("/api/")) return rt.fulfill({ contentType: "application/json", body: "{}" });
    const res = await W.fetch(new Request(u.toString()), {}); const hd = {}; res.headers.forEach((v, k) => hd[k] = v);
    rt.fulfill({ status: res.status, headers: hd, body: Buffer.from(await res.arrayBuffer()) }); });
  await pg.route(/^https?:\/\/(?!planetcompute\.ai\/)/, (rt) => rt.abort());
  await pg.routeWebSocket(/.*/, (ws) => ws.close());
  await pg.goto("https://planetcompute.ai/?console=1"); await pg.waitForTimeout(2500);
  const atLoad = await pg.$eval("#acctLbl", (e) => e.textContent);
  signedIn = signedInLater;                                         // the program signs in on its Account tab now
  await pg.evaluate(() => { const a = document.getElementById("agree"); if (!a.checked) a.click(); });
  await pg.evaluate(() => { const c = document.getElementById("cores"); if (c) { c.value = c.max || 2; c.dispatchEvent(new Event("input")); c.dispatchEvent(new Event("change")); } });
  await pg.waitForTimeout(300); const before = meCalls;
  await pg.click("#startBtn"); await pg.waitForTimeout(2500);
  const st = await pg.$eval("#statusText", (e) => e.textContent), modal = await pg.$eval("#authModal", (e) => e.classList.contains("open"));
  const lbl = await pg.$eval("#acctLbl", (e) => e.textContent);
  if (SHOTS) await pg.screenshot({ path: `${SHOTS}/console_signin_${name}.png` });
  await pg.click("#pauseBtn").catch(() => {}); await pg.close();
  return { atLoad, st, modal, lbl, asked: meCalls - before, errs };
}
let r = await run(true, "later");
ok("1 page loaded signed out (as in the window before the program signed in)", r.atLoad === "Sign in", r);
ok("2 signed in since: Start asks the website again and starts computing, no sign-in box", r.asked >= 1 && !r.modal && /^Running: /.test(r.st), r);
ok("3 the account button now shows the name", r.lbl === "Milind", r);
r = await run(false, "out");
ok("4 really signed out: Start opens the sign-in box (with the reason) and does not start", r.modal && !/^Running: /.test(r.st), r);
ok("5 no script errors", r.errs.length === 0, r.errs);
await br.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
