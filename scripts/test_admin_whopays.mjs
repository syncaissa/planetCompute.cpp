// The admin tab Who Pays for Transfer (TESTING.md test 54; user, 2026-10-28: "PUT this info in the admin tab new one - Who
// Pays for Transfer - so it will be reminder for me to change the flags later"). (1) GET /api/admin/ledger-options/who-pays
// from the given worker.js in-process: the two settings as YES/NO, unset, other spellings (DynamoDB count and the Solana
// read faked); (2) the tab in headless Chromium (answers faked): settings now, accounts, the reminder (due at 1,000).
//   cd <folder with playwright-core and chromium> && node <repo>/scripts/test_admin_whopays.mjs <worker.js> <screenshot dir>
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/")("playwright-core");
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
let src = readFileSync(process.argv[2], "utf8");
src += "\nglobalThis.__modes = transferModes;\n";
const tmp = join(mkdtempSync(join(tmpdir(), "wp-")), "w.mjs"); writeFileSync(tmp, src); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default, OUT = process.argv[3];
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
const m = (a, b, extra = {}) => globalThis.__modes({ TRANSFER_PLANETCOMPUTE_PAYS: a, TRANSFER_CLAIM_USER_PAY: b, ...extra });
const k = (x) => (x.site_pays ? "S" : "-") + (x.user_pays ? "U" : "-");
ok("1 YES/YES, NO/YES, YES/NO, NO/NO", k(m("YES", "YES")) === "SU" && k(m("NO", "YES")) === "-U" && k(m("YES", "NO")) === "S-" && k(m("NO", "NO")) === "--", null);
ok("2 other spellings: yes, true, 1, on = YES; no, false, 0, off = NO", k(m("yes", "true")) === "SU" && k(m("1", "on")) === "SU" && k(m("no", "false")) === "--" && k(m("0", "off")) === "--", null);
ok("3 unset: PlanetCompute pays only with the old SITE_PAYS_FEES=1; claims on", k(m(undefined, undefined)) === "-U" && k(m("", "", { SITE_PAYS_FEES: "1" })) === "SU", null);
const br = await chromium.launch(), errs = [];
let WP = { cluster: "mainnet-beta", users: 3, reminder_at_users: 1000, planetcompute_pays: true, user_pays: true, planetcompute_pays_raw: "YES", user_pays_raw: "YES",
  payer: { address: "HU3ZmeHsgkaDzv1DwzGY1fgnUpSBmPS3cDKv2tbFNpTq", sol: 0 } };
const pg = await br.newPage({ viewport: { width: 1300, height: 1000 } }); pg.on("pageerror", (e) => errs.push(e.message));
await pg.route(/^https:\/\/planetcompute\.ai\//, async (rt) => { const u = new URL(rt.request().url());
  if (u.pathname === "/api/me") return rt.fulfill({ contentType: "application/json", body: JSON.stringify({ user_id: "u1", primary_email: "a@b.c", first_name: "A", is_admin: true }) });
  if (u.pathname === "/api/admin/ledger-options/who-pays") return rt.fulfill({ contentType: "application/json", body: JSON.stringify(WP) });
  if (u.pathname.startsWith("/api/")) return rt.fulfill({ contentType: "application/json", body: "{}" });
  const res = await W.fetch(new Request(u.toString()), {}); const hd = {}; res.headers.forEach((v, kk) => hd[kk] = v); rt.fulfill({ status: res.status, headers: hd, body: Buffer.from(await res.arrayBuffer()) }); });
await pg.route(/^https?:\/\/(?!planetcompute\.ai\/)/, (rt) => rt.abort());
await pg.goto("https://planetcompute.ai/admin"); await pg.waitForTimeout(1500);
// the other admin tabs' startup loads get empty fake answers, so open the page view directly (the access check is not under test here)
await pg.evaluate(() => { document.getElementById("gate").style.display = "none"; document.getElementById("app").style.display = ""; });
const errsBefore = errs.splice(0);                                    // errors from those other tabs' empty answers, not this tab
await pg.click('.tab[data-tab="whopays"]'); await pg.waitForTimeout(800);
const read = () => pg.evaluate(() => ({ shown: document.getElementById("v-whopays").classList.contains("on"), head: document.getElementById("wp-head").textContent,
  now: [...document.querySelectorAll("#t-wpnow tr")].map((r) => r.textContent), remind: document.getElementById("wp-remind").textContent,
  means: [...document.querySelectorAll("#t-wpmeans tr")].map((r) => r.textContent) }));
let c = await read();
ok("4 the tab: both settings with their values (YES, YES), accounts (3, 997 to go), the payout wallet and its SOL", c.shown && /PlanetCompute pays by default/.test(c.head) &&
  c.now.some((x) => /TRANSFER_PLANETCOMPUTE_PAYSYES/.test(x)) && c.now.some((x) => /TRANSFER_CLAIM_USER_PAYYES/.test(x)) && c.now.some((x) => /^Accounts3997 to go until 1000/.test(x)) &&
  c.now.some((x) => /HU3ZmeHsgk.*SOL: 0 \(too little/.test(x)), c);
ok("5 the reminder: at 1,000 accounts set TRANSFER_PLANETCOMPUTE_PAYS to NO; the four combinations, the one in force marked (now)", /At 1,000 accounts, set TRANSFER_PLANETCOMPUTE_PAYS to NO/.test(c.remind) &&
  c.means.length === 5 && /YESYES.*\(now\)/.test(c.means[1]) && !/\(now\)/.test(c.means[2]), c);
await pg.screenshot({ path: OUT + "/admin_whopays.png", fullPage: true });
WP = { ...WP, users: 1004 }; await pg.click('.tab[data-tab="whopays"]'); await pg.waitForTimeout(800); c = await read();
ok("6 at 1,004 accounts with PlanetCompute still paying: DUE NOW, in red", /^DUE NOW: 1004 accounts/.test(c.remind) && (await pg.evaluate(() => document.getElementById("wp-remind").style.fontWeight)) === "700", c.remind);
WP = { ...WP, planetcompute_pays: false, planetcompute_pays_raw: "NO" }; await pg.click('.tab[data-tab="whopays"]'); await pg.waitForTimeout(800); c = await read();
ok("7 after it is set to NO: the reminder is done; the NO/YES row is marked (now)", /already NO/.test(c.remind) && /Every user approves and pays/.test(c.head) && /NOYES.*\(now\)/.test(c.means[2]), c);
ok("8 no page errors from this tab", errs.length === 0, { errs, otherTabs: errsBefore.length });
console.log(`\n${pass} passed, ${fail} failed`); await br.close(); process.exit(fail ? 1 : 0);
