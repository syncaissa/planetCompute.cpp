// Test of the admin tab Move coins (TESTING.md test 49), a REAL devnet transfer. The given worker.js runs in-process
// against the TEST table pctest-ai-ledger-options (PlanetComp's devnet mint = the devnet test coin) with the devnet
// treasury key (TREASURY_SECRET_KEY) and sender 2 (COIN_SEND_KEYS); the admin handler is called directly.
//   AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. PCC_MINT=7vSu.. TREASURY_SECRET_FILE=.ops/devnet_treasury.secret \
//     SENDER2_SECRET_FILE=.ops/devnet_sender2.secret node scripts/test_move_coins.mjs website/worker.js   (folder with tweetnacl)
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const nacl = createRequire(process.cwd() + "/")("tweetnacl");
let src = readFileSync(process.argv[2], "utf8");
src = src.replace("async function sendCodeEmail(env, to, code, purpose) {", "async function sendCodeEmail(env, to, code, purpose) { (globalThis.__codes ||= []).push({ to, code, purpose }); return;");   // never real e-mail
src += "\nglobalThis.__m = { handleLedgerAdmin, ledgerRows, ddb, ledgerTable, M };";
const tmp = join(mkdtempSync(join(tmpdir(), "mv-")), "w.mjs"); writeFileSync(tmp, src); globalThis.WebSocketRequestResponsePair = class {};
await import(tmp); const X = globalThis.__m;
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, AWS_REGION: "us-east-1", DDB_PREFIX: "pctest-ai-",
  SOLANA_CLUSTER: "devnet", SOLANA_RPC_URL: "https://api.devnet.solana.com", PCC_MINT: process.env.PCC_MINT,
  TREASURY_SECRET_KEY: readFileSync(process.env.TREASURY_SECRET_FILE, "utf8").trim(), COIN_SEND_KEYS: readFileSync(process.env.SENDER2_SECRET_FILE, "utf8").trim() };
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (u) => { let n = BigInt("0x" + (Buffer.from(u).toString("hex") || "0")), o = ""; while (n > 0n) { o = B58[Number(n % 58n)] + o; n /= 58n; } for (const x of u) { if (x) break; o = "1" + o; } return o; };
const EMAIL = `move-test-${Date.now()}@invalid`, me = { user_id: "mv-test" };   // its own address each run (code limits per address)
const lastCode = () => ((globalThis.__codes || []).filter((c) => c.purpose === "move").at(-1) || {}).code || "";
const call = async (body) => { const r = await X.handleLedgerAdmin(env, me, EMAIL, "/api/admin/ledger-options/move", body ? "POST" : "GET", body || {}); return { s: r.status, j: await r.json() }; };
const g = await call();
const tre = "EFAkhAkLaGSoE1ThuQT7RP2Lw3vCYiHdvNxcJJpkBjG2", t = g.j.sources.find((w) => w.address === tre);
ok("1 the tab lists the wallets the website holds keys for (treasury + sender 2) with SOL and coin balances, cluster devnet",
  g.s === 200 && g.j.cluster === "devnet" && g.j.sources.length === 2 && t && t.sol > 0 && t.coins.some((c) => c.coin_id === "planetcomp" && Number(c.amount) > 1), g.j);
const to = b58(nacl.sign.keyPair().publicKey);
let r = await call({ from: tre, coin_id: "planetcomp", amount: "0.5", to, confirm: "xxxx" });
ok("2 a wrong confirmation (not the destination's last 4 characters) is refused", r.s === 400 && /last 4/.test(r.j.error), r);
r = await call({ from: b58(nacl.sign.keyPair().publicKey), coin_id: "planetcomp", amount: "0.5", to, confirm: to.slice(-4) });
ok("3 a source the website holds no key for is refused", r.s === 400 && /no key/.test(r.j.error), r);
r = await call({ from: tre, coin_id: "planetcomp", amount: "0.5", to: "BAbQwYKX3Eq7R2sBcrrvoE2t8DxwbWCJQyTpNBeCfuUz", confirm: "CfuUz".slice(-4) });
ok("4 a destination that is a token account is refused", r.s === 400 && /token account/.test(r.j.error), r);
r = await call({ from: tre, coin_id: "planetcomp", amount: "99999999", to, confirm: to.slice(-4) });
ok("5 more than the source holds is refused, nothing sent", r.s === 409 && /source holds/.test(r.j.error), r);
r = await call({ from: tre, coin_id: "planetcomp", amount: "0.5", to, confirm: to.slice(-4) });
ok("5b security review W6: a valid move first emails a code to the admin (428); nothing is sent yet", r.s === 428 && r.j.need_code && lastCode().length === 6, r);
r = await call({ from: tre, coin_id: "planetcomp", amount: "0.5", to, confirm: to.slice(-4), code: String((Number(lastCode()) + 1) % 1000000).padStart(6, "0") });
ok("5c a wrong code: refused, nothing sent", r.s === 401, r);
await new Promise((x) => setTimeout(x, 31000));
r = await call({ from: tre, coin_id: "planetcomp", amount: "0.5", to, confirm: to.slice(-4) });
r = await call({ from: tre, coin_id: "planetcomp", amount: "0.5", to, confirm: to.slice(-4), code: lastCode() });
console.log("  move:", r.s, r.j.status, r.j.explorer || r.j.error);
let bal = null;
for (let i = 0; i < 10 && !bal; i++) { const q = await (await fetch(env.SOLANA_RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [to, { mint: env.PCC_MINT }, { encoding: "jsonParsed", commitment: "confirmed" }] }) })).json();
  bal = q.result && q.result.value[0] ? q.result.value[0].account.data.parsed.info.tokenAmount.uiAmountString : null; if (!bal) await new Promise((x) => setTimeout(x, 2000)); }
ok("6 0.5 PlanetComp (devnet) moved from the treasury to a new wallet: settled, on chain exactly 0.5", r.s === 200 && r.j.status === "settled" && bal === "0.5", { r: r.j, bal });
const aud = (await X.ledgerRows(env, "AUDIT")).filter((a) => a.by_email === EMAIL && a.action === "move_coins");
ok("7 the move is in the audit trail with from, to, amount, status and the transaction", aud.length === 1 && JSON.parse(aud[0].after).signature === r.j.signature && JSON.parse(aud[0].after).to === to, aud);
for (const a of aud) await X.ddb(env, "DeleteItem", { TableName: X.ledgerTable(env), Key: X.M({ pk: "AUDIT", sk: a.sk }) });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
