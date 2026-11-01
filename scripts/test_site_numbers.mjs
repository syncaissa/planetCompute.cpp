// docs/TESTING.md test 76: big numbers with commas (pcNum, exact at any size) on My Balance (cards fit, no overflow at
// 360-1280 px), the activity table, the formatter itself. cd <folder with playwright-core> && node <repo>/scripts/test_site_numbers.mjs <worker.js>
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/")("playwright-core");
import { copyFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const tmp = join(mkdtempSync(join(tmpdir(), "nm-")), "w.mjs"); copyFileSync(process.argv[2], tmp); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default;
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, x === undefined ? "" : JSON.stringify(x)); } };
const b = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell" });
const BAL = { unit: "WU", shared_wu: "1000000000000.000000", received_wu: "1.296925", difference_wu: "999999999998.703075", lifetime_contributed_wu: "1000000000000.000000", lifetime_transferred_wu: "0.000000", available_wu: "163.545081", receiving_open: true };
const ACT = { days: [{ day: "2026-10-29", rx_jobs: 13525, rx_failed: 0, tx_jobs: 8359, rx_uwu: 6850500, tx_uwu: 1000000000000000000, rx_tokens: 616387, tx_tokens: 379196, rx_ok: 13525, rx_total_ms: 27000000 }], recent: [] };
for (const w of [360, 390, 768, 1280]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 } });
  await ctx.route("**/*", async (r) => { const u = new URL(r.request().url()); if (u.hostname !== "planetcompute.ai") return r.fulfill({ body: "" });
    const J = (x, s = 200) => r.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(x) });
    if (u.pathname === "/api/me") return J({ user_id: "u1", primary_email: "user@example.com", first_name: "Milind" });
    if (u.pathname === "/api/me/balance") return J(BAL);
    if (u.pathname.startsWith("/api/me/activity")) return J(ACT);
    if (u.pathname.startsWith("/api/")) return J({});
    const res = await W.fetch(new Request(u.toString()), {}); const h = {}; res.headers.forEach((v, k) => h[k] = v); return r.fulfill({ status: res.status, headers: h, body: Buffer.from(await res.arrayBuffer()) }); });
  const p = await ctx.newPage(); await p.goto("https://planetcompute.ai/balance"); await p.waitForTimeout(900);
  const m = await p.evaluate(() => {
    const cards = [...document.querySelectorAll(".bal .c")].map((c) => { const r = c.getBoundingClientRect(), v = c.querySelector(".v"); return { text: v.textContent, over: v.scrollWidth > v.clientWidth + 1 || v.getBoundingClientRect().right > r.right + 1 }; });
    const act = [...document.querySelectorAll("#actDays tr")].map((tr) => [...tr.children].map((c) => c.textContent));
    return { cards, act, pageWide: document.documentElement.scrollWidth > innerWidth + 1, f: [pcNum("1234567.891234"), pcNum("0.005"), pcNum(5, 0), pcNum("-0.001"), pcNum("999999999999999999.999")] };
  });
  ok(`${w}px: every balance card fits (no overflow) and the page is not wider than the screen`, m.cards.every((c) => !c.over) && !m.pageWide, m.cards);
  ok(`${w}px: lifetime shows 1,000,000,000,000.00 WU`, m.cards.some((c) => c.text === "1,000,000,000,000.00WU"), m.cards.map((c) => c.text));
  if (w === 390) {
    ok("formatter: 1,234,567.89 / 0.01 / 5 / 0.00 / 1,000,000,000,000,000,000.00", JSON.stringify(m.f) === JSON.stringify(["1,234,567.89", "0.01", "5", "0.00", "1,000,000,000,000,000,000.00"]), m.f);
    ok("activity: commas in jobs, tokens and WU", JSON.stringify(m.act[1]).includes("13,525") && JSON.stringify(m.act[1]).includes("8,359") && JSON.stringify(m.act[1]).includes("995,583") && JSON.stringify(m.act[1]).includes("1,000,000,000,000.00"), m.act);
  }
  await ctx.close();
}
await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
