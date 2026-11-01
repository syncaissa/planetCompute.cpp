// Test of the ledger options (TESTING.md test 44): the pool of coins the bonus is paid in and each coin's share,
// effective-dated. The given worker.js runs in-process against the TEST table pctest-ai-ledger-options (real DynamoDB;
// seeded by database/CreateTables.py with PlanetComp, active, 100 %). The admin handler is called directly (the
// admin sign-in itself is covered by the other admin tests). Everything this test adds is deleted after; the seed stays.
//   AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. node scripts/test_ledger_options.mjs website/worker.js
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { randomBytes } from "node:crypto";
let src = readFileSync(process.argv[2], "utf8");
src += "\nglobalThis.__l = { handleLedgerAdmin, ledgerAt, ledgerRows, ddb, ledgerTable, M };";
const tmp = join(mkdtempSync(join(tmpdir(), "lo-")), "w.mjs"); writeFileSync(tmp, src); globalThis.WebSocketRequestResponsePair = class {};
await import(tmp); const L = globalThis.__l;
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, AWS_REGION: "us-east-1", DDB_PREFIX: "pctest-ai-" };
if (!env.AWS_ACCESS_KEY_ID) { console.log("needs AWS keys in the environment"); process.exit(2); }
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
const me = { user_id: "lo-test" }, EMAIL = "ledger-test@invalid";
const call = async (path, body) => { const r = await L.handleLedgerAdmin(env, me, EMAIL, path, body ? "POST" : "GET", body || {}); return { s: r.status, j: await r.json() }; };
const t0 = new Date().toISOString(), soon = new Date(Date.now() + 3600e3).toISOString(), later = new Date(Date.now() + 7200e3).toISOString();
const ADDR = "EFAkhAkLaGSoE1ThuQT7RP2Lw3vCYiHdvNxcJJpkBjG2", MINT = "7vSuZp6HJ7pi23gUHbrbtLJWVtjfH43chMhtHeiQpm2z";
const C2 = "test-" + randomBytes(3).toString("hex");

let g = await call("/api/admin/ledger-options");
const pc = g.j.coins.find((c) => c.coin_id === "planetcomp"), cur = g.j.sets.find((s) => s.phase === "in force");
ok("1 seeded: PlanetComp active (mainnet mint set, Token-2022, 6 decimals; devnet sends from the treasury), 100 % in force",
  pc && pc.status === "active" && (process.env.PCC_MINT_MAINNET ? pc.mint_mainnet === process.env.PCC_MINT_MAINNET : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pc.mint_mainnet)) && pc.decimals === 6 && pc.token_program === "token-2022" &&
  pc.address_from_devnet === ADDR && "address_from" in pc && cur && cur.shares.length === 1 && cur.shares[0].coin_id === "planetcomp" && cur.shares[0].pct === 100, { pc, cur });
let r = await call("/api/admin/ledger-options/coin", { coin_id: C2, name: "Test coin", decimals: 6, address_from: "not-an-address" });
ok("2 an address that is not a Solana public address is refused", r.s === 400 && /not a Solana address/.test(r.j.error), r);
r = await call("/api/admin/ledger-options/coin", { coin_id: C2, name: "Test coin", symbol: "TST", decimals: 6, decimals_devnet: 9, mint_devnet: MINT, address_from: ADDR, address_from_devnet: ADDR, status: "active" });
ok("3 a second coin is added to the pool, with its send-from address", r.s === 200, r);
r = await call("/api/admin/ledger-options/set", { effective_from: soon, shares: [{ coin_id: "planetcomp", pct: 60 }, { coin_id: C2, pct: 30 }] });
ok("4a shares that do not add up to 100 % are refused", r.s === 400 && /add up to 100/.test(r.j.error), r);
r = await call("/api/admin/ledger-options/set", { effective_from: t0, shares: [{ coin_id: "planetcomp", pct: 100 }] });
ok("4b a set that starts in the past is refused (changes only take effect in the future)", r.s === 400 && /future/.test(r.j.error), r);
r = await call("/api/admin/ledger-options/set", { effective_from: soon, shares: [{ coin_id: "planetcomp", pct: 60 }, { coin_id: C2, pct: 40 }], note: "test 60-40" });
const s1 = r.j.set_id;
ok("5 a set of PlanetComp 60 % + the test coin 40 % is scheduled", r.s === 200 && !!s1, r);
g = await call("/api/admin/ledger-options");
ok("6 it shows as scheduled; PlanetComp 100 % stays in force until then", g.j.sets.find((s) => s.set_id === s1).phase === "scheduled" && g.j.sets.find((s) => s.phase === "in force").shares[0].pct === 100);
const now1 = await L.ledgerAt(env, new Date().toISOString()), then1 = await L.ledgerAt(env, new Date(Date.now() + 5400e3).toISOString());
ok("7 the coins in force now: PlanetComp 100 %; after the set starts: PlanetComp 60 % + test coin 40 %", now1.length === 1 && now1[0].pct === 100 &&
  then1.length === 2 && then1[0].coin.coin_id === "planetcomp" && then1[0].pct === 60 && then1[1].coin.address_from === ADDR && then1[1].pct === 40, { now1, then1 });
r = await call("/api/admin/ledger-options/coin", { coin_id: C2, name: "Test coin", decimals: 6, decimals_devnet: 9, status: "inactive" });
ok("8 a coin in a scheduled set cannot be made inactive", r.s === 409, r);
r = await call("/api/admin/ledger-options/cancel", { set_id: s1 });
ok("9 the scheduled set is cancelled (not deleted)", r.s === 200 && (await call("/api/admin/ledger-options")).j.sets.find((s) => s.set_id === s1).phase === "cancelled", r);
r = await call("/api/admin/ledger-options/coin", { coin_id: C2, name: "Test coin", decimals: 6, decimals_devnet: 9, status: "inactive" });
ok("10 then the coin can be made inactive, and an inactive coin cannot be put in a set", r.s === 200 &&
  (await call("/api/admin/ledger-options/set", { effective_from: later, shares: [{ coin_id: C2, pct: 100 }] })).s === 400, r);
g = await call("/api/admin/ledger-options");
const mine = g.j.audit.filter((a) => a.by_email === EMAIL);
ok("11 every change is in the audit trail (add coin, create set, cancel set, change coin)", ["add_coin", "create_set", "cancel_set", "change_coin"].every((a) => mine.some((x) => x.action === a)), mine.map((x) => x.action));
// clean up what this test added (the seed stays)
for (const it of [{ pk: "COIN", sk: C2 }, ...g.j.sets.filter((s) => s.created_by === me.user_id).map((s) => ({ pk: "SET", sk: s.sk })), ...mine.map((a) => ({ pk: "AUDIT", sk: a.sk }))])
  await L.ddb(env, "DeleteItem", { TableName: L.ledgerTable(env), Key: L.M(it) });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
