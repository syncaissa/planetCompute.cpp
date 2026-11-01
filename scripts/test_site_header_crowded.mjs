// docs/TESTING.md test 79: home page top bar with the status pill + Admin in it (Receive Compute / Admin open), admin and user, 900-1920 px:
// nothing drawn over anything, nothing off screen, page not wider than the screen. cd <folder with playwright-core> && node <repo>/scripts/test_site_header_crowded.mjs <worker.js>
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/")("playwright-core");
import { copyFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const tmp = join(mkdtempSync(join(tmpdir(), "h2-")), "w.mjs"); copyFileSync(process.argv[2], tmp); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default;
let pass = 0, fail = 0;
const b = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell" });
for (const admin of [true, false]) for (const view of ["harness", "admin", "contribute"]) for (const w of [900, 1024, 1180, 1280, 1366, 1440, 1920]) {
  if (view === "admin" && !admin) continue;
  const ctx = await b.newContext({ viewport: { width: w, height: 700 } });
  await ctx.addInitScript(() => localStorage.setItem("pc-cookies-ok", "1"));
  await ctx.route("**/*", async (r) => { const u = new URL(r.request().url()); if (u.hostname !== "planetcompute.ai") return r.fulfill({ body: "" });
    const J = (x, s = 200) => r.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(x) });
    if (u.pathname === "/api/me") return J({ user_id: "u1", primary_email: "user@example.com", first_name: "Milind", last_name: "Patil", is_admin: admin });
    if (u.pathname === "/api/me/balance") return J({ lifetime_contributed_wu: "167.9" });
    if (u.pathname === "/api/tunnel/devices") return J({ devices: [] });
    if (u.pathname.startsWith("/api/")) return J({});
    if (u.pathname.startsWith("/admin")) return r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><body>ADMIN</body>" });
    const res = await W.fetch(new Request(u.toString()), {}); const h = {}; res.headers.forEach((v, k) => h[k] = v); return r.fulfill({ status: res.status, headers: h, body: Buffer.from(await res.arrayBuffer()) }); });
  const p = await ctx.newPage(); await p.goto("https://planetcompute.ai/"); await p.waitForTimeout(1200);
  if (view === "harness") await p.click('nav.top .modes [data-mode="harness"]');
  if (view === "admin") await p.evaluate(() => { const a = document.getElementById("adminLink2") || document.getElementById("adminLink"); a.click(); });
  await p.waitForTimeout(1000);
  const m = await p.evaluate(() => {
    const els = [...document.querySelectorAll("nav.top .brand, nav.top .modes, #statusBox.slim #dock, #statusBox.slim #adminLink, nav.top .pc-end .pc-theme, nav.top .pc-end .pc-acct")].filter((e) => e.offsetWidth && getComputedStyle(e).display !== "none");
    const R = els.map((e) => ({ n: e.id || e.className.split(" ")[0], r: e.getBoundingClientRect() }));
    const clash = []; for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) { const a = R[i].r, c = R[j].r; if (a.left < c.right - 1 && c.left < a.right - 1 && a.top < c.bottom - 1 && c.top < a.bottom - 1) clash.push(R[i].n + "×" + R[j].n); }
    const off = R.filter((x) => x.r.right > innerWidth + 1 || x.r.left < -1).map((x) => x.n);
    return { clash, off, wide: document.documentElement.scrollWidth > innerWidth + 1, n: R.map((x) => x.n).join(",") };
  });
  const good = !m.clash.length && !m.off.length && !m.wide; good ? pass++ : fail++;
  if (!good || w === 1366) console.log(good ? "PASS" : "FAIL", admin ? "admin" : "user ", view.padEnd(10), w, JSON.stringify(m));
  if (admin && view === "harness" && w === 1366) await p.screenshot({ path: "hdr_fixed_1366.png", clip: { x: 0, y: 0, width: w, height: 80 } });
  await ctx.close();
}
await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
