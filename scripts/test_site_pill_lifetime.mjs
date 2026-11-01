// docs/TESTING.md test 75: signed in, the status pill shows the lifetime contribution (/api/me/balance), never lower than
// before; signed out, what this tab did. cd <folder with playwright-core> && node <repo>/scripts/test_site_pill_lifetime.mjs <worker.js>
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/")("playwright-core");
import { copyFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const tmp = join(mkdtempSync(join(tmpdir(), "lf-")), "w.mjs"); copyFileSync(process.argv[2], tmp); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default;
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, x === undefined ? "" : JSON.stringify(x)); } };
const b = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell" });
async function run(signed, life, w) {
  const st = { life };
  const ctx = await b.newContext({ viewport: { width: w, height: 760 } });
  await ctx.route("**/*", async (r) => { const u = new URL(r.request().url()); if (u.hostname !== "planetcompute.ai") return r.fulfill({ body: "" });
    const J = (x, s = 200) => r.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(x) });
    if (u.pathname === "/api/me") return signed ? J({ user_id: "u1", primary_email: "user@example.com", first_name: "Milind" }) : J({}, 401);
    if (u.pathname === "/api/me/balance") return signed ? J({ unit: "WU", lifetime_contributed_wu: st.life, available_wu: "1" }) : J({}, 401);
    if (u.pathname.startsWith("/api/")) return J({}, 401);
    const res = await W.fetch(new Request(u.toString()), {}); const h = {}; res.headers.forEach((v, k) => h[k] = v); return r.fulfill({ status: res.status, headers: h, body: Buffer.from(await res.arrayBuffer()) }); });
  const p = await ctx.newPage(); await p.goto("https://planetcompute.ai/"); await p.waitForTimeout(900);
  return { p, ctx, st };
}
let x = await run(true, "162.865900", 390);
ok("1 signed in (phone): the pill shows the lifetime contribution 162.9", await x.p.textContent("#dPcc") === "162.9", await x.p.textContent("#dPcc"));
x.st.life = "100.0"; await x.p.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); await x.p.waitForTimeout(400);
ok("2 a lower answer later never lowers the pill", await x.p.textContent("#dPcc") === "162.9", await x.p.textContent("#dPcc"));
x.st.life = "170.25"; await x.p.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); await x.p.waitForTimeout(400);
ok("3 a higher answer raises it (170.3)", await x.p.textContent("#dPcc") === "170.3", await x.p.textContent("#dPcc"));
await x.ctx.close();
x = await run(true, "162.865900", 1280);
ok("4 desktop card: 162.9 labelled Lifetime Compute Credit", await x.p.textContent("#dPcc") === "162.9" && (await x.p.textContent(".dock .dlbl")) === "Lifetime Compute Credit", [await x.p.textContent("#dPcc"), await x.p.textContent(".dock .dlbl")]);
await x.ctx.close();
x = await run(false, "0", 390);
ok("5 signed out: what this tab did (0.00), labelled for this tab", await x.p.textContent("#dPcc") === "0.00" && (await x.p.textContent(".dock .dlbl")) === "Compute Credit (this tab)");
await x.ctx.close(); await b.close();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
