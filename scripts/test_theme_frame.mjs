// The site's day/night button and a frame on the same address (the program's page through its link): they follow each other.
import { createRequire } from "node:module"; const req = createRequire(process.cwd() + "/"), { chromium } = req("playwright-core");
import { readFileSync } from "node:fs";
const [worker, client] = process.argv.slice(2), w = readFileSync(worker, "utf8");
const a = w.indexOf('<script>(function () {\n  // Day / night: one button'), script = w.slice(a, w.indexOf("</script>", a) + 9).replace(/\\\\/g, "\\");
const parent = `<!doctype html><html data-theme="dark"><body><nav class="top"><div class="wrap"></div></nav><iframe id="f" src="/device/abc123abc123/"></iframe>${script}</body></html>`;
const page = readFileSync(client, "utf8");
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
const br = await chromium.launch(), pg = await br.newPage(), errs = []; pg.on("pageerror", (e) => errs.push(e.message));
await pg.addInitScript(() => { try { if (!localStorage.getItem("pc-theme")) localStorage.setItem("pc-theme", "dark"); } catch (e) {} });
await pg.route("**/*", (rt) => { const u = new URL(rt.request().url());
  if (u.pathname === "/harness") return rt.fulfill({ contentType: "text/html", body: parent });
  if (u.pathname === "/device/abc123abc123/") return rt.fulfill({ contentType: "text/html", body: page });
  if (u.hostname === "planetcompute.ai") return rt.fulfill({ contentType: "application/json", body: "{}" });
  return rt.abort(); });
await pg.goto("https://planetcompute.ai/harness"); await pg.waitForTimeout(1500);
const fr = () => pg.frame({ url: /device/ });
const st = async () => ({ top: await pg.evaluate(() => document.documentElement.dataset.theme), frame: await fr().evaluate(() => document.documentElement.dataset.theme),
  btn: await fr().evaluate(() => document.getElementById("theme").textContent) });
let s0 = await st(); const e0 = errs.length;   // the mock answers ({}) can trip the page on load: only errors after it count
await pg.click("nav.top .pc-theme"); await pg.waitForTimeout(300);
let s1 = await st();
ok("1 the site's button switches the page and the frame (and the frame's own button icon)", s1.top !== s0.top && s1.frame === s1.top && s1.btn !== s0.btn, [s0, s1]);
await fr().click("#theme"); await pg.waitForTimeout(300);
let s2 = await st();
ok("2 the frame's own button switches the page around it too", s2.frame !== s1.frame && s2.top === s2.frame, [s1, s2]);
ok("3 no page errors from switching", errs.length === e0, errs.slice(e0));
console.log(`\n${pass} passed, ${fail} failed`); await br.close(); process.exit(fail ? 1 : 0);
