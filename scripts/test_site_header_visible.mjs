// docs/TESTING.md test 75: the day/night and account buttons are on screen, tappable (nothing on top) and the page is not
// wider than the screen, on /, /mycontent, /harness, /balance, /admin, at 320-1440 px, signed in and out (80 cases).
//   cd <folder with playwright-core> && node <repo>/scripts/test_site_header_visible.mjs <worker.js> <screenshot dir>
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/")("playwright-core");
import { copyFileSync, mkdtempSync, mkdirSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const tmp = join(mkdtempSync(join(tmpdir(), "pr-")), "w.mjs"); copyFileSync(process.argv[2], tmp);
globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default, OUT = process.argv[3]; mkdirSync(OUT, { recursive: true });
const PAGES = process.argv.slice(4).length ? process.argv.slice(4) : ["/", "/mycontent", "/harness", "/balance", "/admin"];
const WIDTHS = [320, 360, 390, 430, 600, 768, 1024, 1440];
const exe = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell";
const browser = await chromium.launch({ executablePath: exe });
const results = [];
for (const signed of [false, true]) {
  const ctx = await browser.newContext();
  await ctx.route("**/*", async (r) => {
    const u = new URL(r.request().url()), p = u.pathname;
    if (u.hostname !== "planetcompute.ai") return r.fulfill({ status: 200, body: "" });
    const J = (x, st = 200) => r.fulfill({ status: st, contentType: "application/json", body: JSON.stringify(x) });
    if (p === "/api/me") return signed ? J({ user_id: "u1", primary_email: "maria.long-email@example.com", first_name: "Maria", last_name: "Gonzalez", is_admin: true }) : J({ error: "Not signed in." }, 401);
    if (p.startsWith("/api/")) return J(signed ? {} : { error: "Not signed in." }, signed ? 200 : 401);
    const res = await W.fetch(new Request(u.toString(), { method: r.request().method(), headers: r.request().headers() }), {});
    const h = {}; res.headers.forEach((v, k) => { h[k] = v; });
    return r.fulfill({ status: res.status, headers: h, body: Buffer.from(await res.arrayBuffer()) });
  });
  for (const path of PAGES) for (const w of WIDTHS) {
    const page = await ctx.newPage({ viewport: { width: w, height: 760 } });
    await page.setViewportSize({ width: w, height: 760 });
    await page.goto("https://planetcompute.ai" + path, { waitUntil: "load" }).catch(() => {});
    await page.waitForTimeout(700);
    const r = await page.evaluate(() => {
      const vis = (el) => { if (!el) return null; const b = el.getBoundingClientRect(), s = getComputedStyle(el);
        const on = s.display !== "none" && s.visibility !== "hidden" && b.width > 0 && b.height > 0;
        const inside = b.left >= 0 && b.top >= 0 && b.right <= innerWidth + 0.5 && b.bottom <= innerHeight;
        const top = on && inside ? document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) : null;
        return { on, inside, hit: !!(top && (top === el || el.contains(top))), x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
      const theme = [...document.querySelectorAll(".pc-theme")].find((b) => !b.closest(".modal"));
      const acct = document.querySelector(".pc-end .pc-acct");
      return { theme: vis(theme), acct: vis(acct), acctTag: acct ? acct.id || acct.className : "", overflowX: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    results.push({ signed, path, w, ...r });
    await page.screenshot({ path: `${OUT}/${signed ? "in" : "out"}${path.replace(/\//g, "_") || "_home"}_${w}.png`, clip: { x: 0, y: 0, width: w, height: 140 } });
    await page.close();
  }
  await ctx.close();
}
await browser.close();
let bad = 0;
for (const r of results) {
  const t = r.theme, a = r.acct, bad = (v) => !v || !v.on || !v.inside || !v.hit;
  if (bad_(r)) bad++;
  console.log(`${r.signed ? "IN " : "OUT"} ${r.path.padEnd(11)} ${String(r.w).padStart(4)}  theme:${bad(t) ? "BAD " + JSON.stringify(t) : "ok"}  acct(${r.acctTag}):${bad(a) ? "BAD " + JSON.stringify(a) : "ok"}${r.overflowX ? "  OVERFLOW-X" : ""}`);
}
function bad_(r) { const b = (v) => !v || !v.on || !v.inside || !v.hit; return b(r.theme) || b(r.acct) || r.overflowX; }
console.log(`\n${results.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
