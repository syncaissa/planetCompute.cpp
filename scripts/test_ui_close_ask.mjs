// docs/TESTING.md test 92: the window's close button (user, 2026-10-31: "when we x out the exe - I want the users to see this
// toast type message for 5 seconds (now 10) with ok and cancel button"). The program calls window.pcCloseAsk() in its page
// (client/src/tray.rs close_pressed); the page shows the message with OK (5 s countdown) and Cancel and answers
// POST /local/close {hide}. The program's page in headless Chromium; /local/* answers are faked.
//   cd <folder with playwright-core> && node <repo>/scripts/test_ui_close_ask.mjs <repo>/client/ui/index.html [screenshot dir]
import { createRequire } from "node:module"; const req = createRequire(process.cwd() + "/"), { chromium } = req("playwright-core");
import { readFileSync } from "node:fs";
const [html, outDir] = process.argv.slice(2), page = readFileSync(html, "utf8");
const br = await chromium.launch(), pg = await br.newPage({ viewport: { width: 1100, height: 760 } }), errs = [], answers = [];
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
pg.on("pageerror", (e) => errs.push(e.message));
const J = (o) => ({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
await pg.route("**/*", (rt) => { const u = new URL(rt.request().url());
  if (u.pathname === "/" || u.pathname === "/local/") return rt.fulfill({ contentType: "text/html", body: page });
  if (u.pathname === "/local/close") { answers.push(JSON.parse(rt.request().postData() || "{}")); return rt.fulfill({ status: 200, body: "ok" }); }
  if (u.pathname === "/local/info") return rt.fulfill(J({ version: "0.1.0", port: 7526, device: "abc123abc123", engine: {}, update: {} }));
  if (u.hostname === "127.0.0.1") return rt.fulfill(J({}));
  return rt.abort(); });
await pg.goto("http://127.0.0.1:7526/local/"); await pg.waitForTimeout(1000);
const TEXT = "PlanetCompute keeps running in the background. To open or quit it, use its icon in the system tray (Windows and Linux) or the menu bar (Mac).";
const state = () => pg.evaluate(() => { const t = document.querySelector(".pc-toast.closeask"); return t ? { text: t.querySelector(".pc-t-msg").textContent,
  buttons: [...t.querySelectorAll("button")].map((b) => b.textContent) } : null; });

await pg.evaluate(() => window.pcCloseAsk()); await pg.waitForTimeout(300);
let s = await state();
ok("1 close pressed: the message, Cancel and OK (10)", s && s.text === TEXT && s.buttons.join("|") === "Cancel|OK (10)", s);
if (outDir) await pg.screenshot({ path: outDir + "/close_ask.png" });
await pg.waitForTimeout(2100); s = await state();
ok("2 OK counts down", s && /^OK \([78]\)$/.test(s.buttons[1]), s);
await pg.click(".pc-toast.closeask button:not(.pc-ok)"); await pg.waitForTimeout(300);
ok("3 Cancel: the message goes and the program is told to keep the window", !(await state()) && answers.length === 1 && answers[0].hide === false, answers);
await pg.evaluate(() => window.pcCloseAsk()); await pg.waitForTimeout(300); await pg.click(".pc-toast.closeask .pc-ok"); await pg.waitForTimeout(300);
ok("4 OK: the program is told to hide the window", !(await state()) && answers.length === 2 && answers[1].hide === true, answers);
await pg.evaluate(() => window.pcCloseAsk()); await pg.waitForTimeout(10600);
ok("5 no answer for 10 seconds: hide (once)", !(await state()) && answers.length === 3 && answers[2].hide === true, answers);
await pg.evaluate(() => window.pcCloseAsk()); await pg.waitForTimeout(300); await pg.keyboard.press("Escape"); await pg.waitForTimeout(300);
ok("6 Escape = Cancel", !(await state()) && answers.length === 4 && answers[3].hide === false, answers);
await pg.evaluate(() => { window.pcCloseAsk(); window.pcCloseAsk(); }); await pg.waitForTimeout(300);
ok("7 asked twice: one message only", (await pg.$$(".pc-toast.closeask")).length === 1, null);
await pg.waitForTimeout(10600);
ok("8 ... and one answer", answers.length === 5 && answers[4].hide === true, answers);
ok("9 no script errors", errs.length === 0, errs);
await br.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
