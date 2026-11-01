// docs/TESTING.md test 75: the phone status pill with very large credit (0.00 ... 5000T) never covers the site name or the
// day/night + account buttons, 320-600 px. cd <folder with playwright-core> && node <repo>/scripts/test_site_pill_room.mjs <worker.js>
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/")("playwright-core");
import { copyFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const tmp = join(mkdtempSync(join(tmpdir(), "pl-")), "w.mjs"); copyFileSync(process.argv[2], tmp); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default;
let pass = 0, fail = 0;
const b = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell" });
for (const w of [320, 340, 360, 375, 390, 414, 430, 600]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 700 } });
  await ctx.route("**/*", async (r) => { const u = new URL(r.request().url()); if (u.hostname !== "planetcompute.ai") return r.fulfill({ body: "" });
    if (u.pathname === "/api/me") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user_id: "u1", primary_email: "m@x.com", first_name: "Maria", last_name: "Gonzalez" }) });
    if (u.pathname.startsWith("/api/")) return r.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    const res = await W.fetch(new Request(u.toString()), {}); const h = {}; res.headers.forEach((v, k) => h[k] = v); return r.fulfill({ status: res.status, headers: h, body: Buffer.from(await res.arrayBuffer()) }); });
  const p = await ctx.newPage(); await p.goto("https://planetcompute.ai/"); await p.waitForTimeout(700);
  for (const val of ["0.00", "999.9", "12.3M", "100M", "1.23B", "5000T"]) {
    const m = await p.evaluate((v) => { document.getElementById("dPcc").textContent = v;
      const R = (s) => document.querySelector(s).getBoundingClientRect();
      const br = R("nav.top .brand"), pill = R("#dock"), end = R("nav.top .pc-end");
      return { brandRight: Math.round(br.right), pillL: Math.round(pill.left), pillR: Math.round(pill.right), endL: Math.round(end.left),
        clashBrand: pill.left < br.right - 1 && pill.width > 0, clashEnd: pill.right > end.left + 1, inside: pill.left >= 0 }; }, val);
    const good = !m.clashBrand && !m.clashEnd && m.inside; good ? pass++ : fail++; console.log(good ? "PASS" : "FAIL", String(w).padStart(5), val.padEnd(9), JSON.stringify(m));
  }
  await ctx.close();
}
await b.close();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
