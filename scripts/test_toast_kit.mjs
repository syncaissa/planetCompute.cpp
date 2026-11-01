// Messages in the page, never the browser's own windows (TESTING.md test 55; user, 2026-10-28: "change all the window
// messages to toast type of messages 100%"). (1) Every page of the given worker.js and the program's page: no alert(,
// confirm( or prompt( call left, the kit once, every inline script parses. (2) The kit in headless Chromium: a toast
// shows and goes; pcConfirm answers OK / Cancel / Esc / Enter; pcPrompt returns what was typed; pcCopy shows the text.
//   cd <folder with playwright-core and chromium> && node <repo>/scripts/test_toast_kit.mjs <worker.js> <client/ui/index.html>
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/")("playwright-core");
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"; import { execFileSync } from "node:child_process";
const dir = mkdtempSync(join(tmpdir(), "kit-")), tmp = join(dir, "w.mjs"); writeFileSync(tmp, readFileSync(process.argv[2], "utf8")); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default, program = readFileSync(process.argv[3], "utf8");
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
const NATIVE = /(^|[^\w$.'"])(alert|confirm|prompt)\(/g;
function check(name, html) {
  const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]); let bad = [];
  scripts.forEach((sc, i) => { const f = join(dir, `s${i}.js`); writeFileSync(f, sc); try { execFileSync("node", ["--check", f], { stdio: "pipe" }); } catch (e) { bad.push(i); } });
  return { name, scripts: scripts.length, bad, kit: (html.match(/window\.pcConfirm =/g) || []).length, native: scripts.map((s) => (s.match(NATIVE) || []).length).reduce((a, b) => a + b, 0) };
}
const res = [];
for (const p of ["/", "/?console=1", "/admin", "/balance", "/harness", "/contribute", "/mycontent"]) res.push(check(p, await (await W.fetch(new Request("https://planetcompute.ai" + p), {})).text()));
res.push(check("program", program));
ok("1 every site page and the program: the kit once, no alert / confirm / prompt left, every inline script parses", res.every((r) => r.kit === 1 && r.native === 0 && !r.bad.length), res);
const br = await chromium.launch(), pg = await br.newPage({ viewport: { width: 1100, height: 800 } }), errs = []; pg.on("pageerror", (e) => errs.push(e.message));
let native = 0; pg.on("dialog", (d) => { native++; d.dismiss(); });
const page = (await (await W.fetch(new Request("https://planetcompute.ai/balance"), {})).text());
await pg.route("**/*", (rt) => { const u = new URL(rt.request().url()); if (u.pathname === "/balance") return rt.fulfill({ contentType: "text/html", body: page });
  if (u.pathname.startsWith("/api/")) return rt.fulfill({ status: 401, contentType: "application/json", body: "{}" }); return rt.abort(); });
await pg.goto("https://planetcompute.ai/balance"); await pg.waitForTimeout(800);
await pg.evaluate(() => pcToast("Saved.", "good", 1500));
const t1 = await pg.evaluate(() => [...document.querySelectorAll(".pc-toast")].map((t) => t.textContent));
await pg.waitForTimeout(1800);
ok("2 a toast shows the message (with a close button) and goes by itself", t1.length === 1 && /^Saved\.×$/.test(t1[0]) && (await pg.evaluate(() => document.querySelectorAll(".pc-toast").length)) === 0, t1);
const ans = async (fn, act) => { const p = pg.evaluate(fn); await pg.waitForSelector(".pc-toast.ask"); await act(); return p; };
const r1 = await ans(() => pcConfirm("Delete it?"), () => pg.click(".pc-toast.ask .pc-ok"));
const r2 = await ans(() => pcConfirm("Delete it?"), () => pg.click(".pc-toast.ask button:not(.pc-ok)"));
const r3 = await ans(() => pcConfirm("Delete it?"), () => pg.keyboard.press("Escape"));
const r4 = await ans(() => pcConfirm("Delete it?"), () => pg.keyboard.press("Enter"));
ok("3 pcConfirm: OK true, Cancel false, Esc false, Enter true; the question goes away", r1 === true && r2 === false && r3 === false && r4 === true && (await pg.evaluate(() => document.querySelectorAll(".pc-toast.ask, .pc-dim").length)) === 0, { r1, r2, r3, r4 });
const r5 = await ans(() => pcPrompt("Add how much (USD)?", "10"), async () => { await pg.fill(".pc-toast.ask input", "25"); await pg.click(".pc-toast.ask .pc-ok"); });
const r6 = await ans(() => pcPrompt("Add how much (USD)?", "10"), () => pg.keyboard.press("Escape"));
ok("4 pcPrompt: returns what was typed (25), Esc returns null", r5 === "25" && r6 === null, { r5, r6 });
const r7 = await ans(() => pcCopy("Copy the link:", "https://x.test/a"), async () => { const ro = await pg.$eval(".pc-toast.ask input", (i) => [i.value, i.readOnly]); await pg.click(".pc-toast.ask button:not(.pc-ok)"); globalThis.__ro = ro; });
ok("5 pcCopy shows the link read-only with Copy / Close", globalThis.__ro[0] === "https://x.test/a" && globalThis.__ro[1] === true && r7 === null, globalThis.__ro);
ok("6 no browser pop-up was opened, no page errors", native === 0 && errs.length === 0, { native, errs });
console.log(`\n${pass} passed, ${fail} failed`); await br.close(); process.exit(fail ? 1 : 0);
