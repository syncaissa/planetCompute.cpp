// Test of the Wallets section on My Balance (testing, devnet; TESTING.md test 38): the given worker.js runs in-process
// against the TEST tables (prefix pctest-ai-, never the live ones) with real DynamoDB and the signed-in user faked; the
// Solana network is faked (no tokens move). Headless Chromium creates test wallets in the browser (tweetnacl served from
// the local node_modules), links them by signature, lists them, changes the default, removes one, links a fake Phantom,
// and checks a transfer to a wallet that is not yours is refused.
//   cd <folder with playwright-core, tweetnacl and chromium> && AWS_ACCESS_KEY_ID=.. AWS_SECRET_ACCESS_KEY=.. \
//     node <repo>/scripts/test_site_wallets.mjs <worker.js> <screenshot dir>
import { createRequire } from "node:module";
const req = createRequire(process.cwd() + "/"), { chromium } = req("playwright-core");
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { randomBytes } from "node:crypto";
const NACL = readFileSync(req.resolve("tweetnacl/nacl-fast.min.js"), "utf8"), nacl = req("tweetnacl");
let src = readFileSync(process.argv[2], "utf8");
src = src.replace("async function currentUser(env, request) {", "async function currentUser(env, request) { if (globalThis.__user) return { user_id: globalThis.__user, token: 't' };");
src = src.replace("async function cachedUser(env, request) {", "async function cachedUser(env, request) { if (globalThis.__user) return { user_id: globalThis.__user, token: 't' };");
const tmp = join(mkdtempSync(join(tmpdir(), "wal-")), "w.mjs"); writeFileSync(tmp, src); globalThis.WebSocketRequestResponsePair = class {};
// the site asks in the page now (pcConfirm), not in a browser pop-up: answer OK and keep the question (window.__asked)
const AUTO_OK = () => { if (window.__autoOk) return; window.__autoOk = 1; window.__asked = [];
  new MutationObserver(() => { const t = document.querySelector(".pc-toast.ask:not([data-seen])"); if (!t) return; t.dataset.seen = "1";
    window.__asked.push(t.querySelector(".pc-t-msg").textContent); setTimeout(() => t.querySelector(".pc-ok").click(), 0); })
    .observe(document, { childList: true, subtree: true }); };
const asked = (where) => where.evaluate(() => (window.__asked || []).slice(-1)[0] || "");
const W = (await import(tmp)).default, OUT = process.argv[3], PREFIX = "pctest-ai-";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (u) => { let n = BigInt("0x" + (Buffer.from(u).toString("hex") || "0")), o = ""; while (n > 0n) { o = B58[Number(n % 58n)] + o; n /= 58n; } for (const x of u) { if (x) break; o = "1" + o; } return o; };
const treasury = nacl.sign.keyPair(), mint = b58(nacl.sign.keyPair().publicKey);
const env = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY, AWS_REGION: process.env.AWS_REGION || "us-east-1",
  DDB_PREFIX: PREFIX, SESSION_SECRET: "s".repeat(40), MAIL_FROM: "test@planetcompute.ai", TRANSFER_PLANETCOMPUTE_PAYS: "YES",
  WALLET_TEST: "1", SOLANA_CLUSTER: "devnet", SOLANA_RPC_URL: "https://rpc.test.invalid/", PCC_MINT: mint, TREASURY_SECRET_KEY: b58(treasury.secretKey) };
if (!env.AWS_ACCESS_KEY_ID) { console.log("needs AWS keys in the environment"); process.exit(2); }
const realFetch = globalThis.fetch;                       // the fake Solana network: every wallet holds 0 test tokens
globalThis.fetch = async (u, o) => String(u).startsWith(env.SOLANA_RPC_URL)
  ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: [] } }), { headers: { "content-type": "application/json" } }) : realFetch(u, o);
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
const user = "wt" + randomBytes(5).toString("hex"); globalThis.__user = user;
const api = async (path, body, e = env) => { const r = await W.fetch(new Request("https://planetcompute.ai" + path, body ? { method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", origin: "https://planetcompute.ai" } } : {}), e); return { s: r.status, j: await r.json().catch(() => ({})) }; };

let c = await api("/api/me/credit");
ok("1 /api/me/credit says wallets are on for testing (WALLET_TEST=1) and set up", c.s === 200 && c.j.wallet_test === true && c.j.wallet_enabled === true && c.j.cluster === "devnet", c);
c = await api("/api/me/credit", null, { ...env, WALLET_TEST: "" });
ok("2 without WALLET_TEST the buttons are off (production)", c.s === 200 && c.j.wallet_test === false, c.j);

const br = await chromium.launch(), errs = [];
const pg = await br.newPage({ viewport: { width: 1300, height: 900 } }); pg.on("pageerror", (e) => errs.push(e.message));
await pg.addInitScript(AUTO_OK); await pg.evaluate(AUTO_OK);
await pg.route(/^https:\/\/planetcompute\.ai\//, async (rt) => { const u = new URL(rt.request().url()), rq = rt.request();
  globalThis.__bodies = (globalThis.__bodies || "") + u.href + (rq.postData() || "");
  if (u.pathname === "/api/me") return rt.fulfill({ contentType: "application/json", body: JSON.stringify({ user_id: user, primary_email: "wallet-test@invalid" }) });
  const res = await W.fetch(new Request(u.toString(), { method: rq.method(), headers: { "content-type": "application/json", origin: "https://planetcompute.ai" }, body: rq.method() === "POST" ? rq.postData() : undefined }), env);
  const hd = {}; res.headers.forEach((v, k) => hd[k] = v); rt.fulfill({ status: res.status, headers: hd, body: Buffer.from(await res.arrayBuffer()) }); });
await pg.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/tweetnacl@1\.0\.3\//, (rt) => rt.fulfill({ contentType: "application/javascript", body: NACL }));
await pg.route(/^https?:\/\/(?!planetcompute\.ai\/|cdn\.jsdelivr\.net\/npm\/tweetnacl)/, (rt) => rt.abort());
await pg.goto("https://planetcompute.ai/balance"); await pg.waitForTimeout(1500);
ok("3 the Wallets section shows, marked testing · devnet, with Create a wallet, Transfer to my wallet, List wallets",
  await pg.evaluate(() => !document.getElementById("wal").hidden && /testing · devnet/i.test(document.querySelector("#wal h2").innerText) &&
    ["wCreate", "wSend", "wList"].every((i) => !document.getElementById(i).disabled)));
await pg.click("#wList"); await pg.waitForTimeout(800);
ok("4 List wallets with none yet: No wallet yet", /No wallet yet/.test(await pg.innerText("#wBox")));

async function browserWallet() {
  await pg.click("#wCreate"); await pg.waitForTimeout(800);
  await pg.click("#wBox .opt:has-text('Test wallet in this browser')"); await pg.waitForTimeout(800);
  const t = await pg.innerText("#wBox"), addr = (await pg.innerText("#wBox p .mono")).trim(), secret = (await pg.innerText("#wBox .secret .mono")).trim();
  await pg.click("#wBox button:has-text('link this wallet')"); await pg.waitForTimeout(1500);
  return { t, addr, secret };
}
const w1 = await browserWallet();
ok("5 Create a wallet offers Phantom (recommended), Solflare and a test wallet in this browser; the test wallet shows its address and secret key with copy and download",
  /Your test wallet/.test(w1.t) && w1.addr.length >= 32 && w1.secret.length >= 80 && /Copy secret key/.test(w1.t) && /Download key file/.test(w1.t), w1.t);
ok("6 the secret key matches the address (the wallet really is that key) and the key was never sent to the website",
  (() => { try { const sk = Uint8Array.from(Buffer.from(BigInt([...w1.secret].reduce((n, ch) => n * 58n + BigInt(B58.indexOf(ch)), 0n)).toString(16).padStart(128, "0"), "hex")); return b58(sk.slice(32)) === w1.addr; } catch { return false; } })() && !globalThis.__bodies.includes(w1.secret));
let l = await api("/api/wallet/list");
ok("7 after linking: one wallet, the default, kind browser, with an explorer link (devnet)", l.j.wallets.length === 1 && l.j.wallets[0].address === w1.addr && l.j.wallets[0].default &&
  l.j.wallets[0].kind === "browser" && /cluster=devnet/.test(l.j.wallets[0].explorer) && l.j.wallets[0].tokens === "0", l.j);
await pg.evaluate(() => { window.__asked = []; });
const w2 = await browserWallet();
ok("8 Create a wallet again first asks: You already have a wallet … create another one?", /You already have a wallet/.test((await asked(pg))) && /create another/.test((await asked(pg))), (await asked(pg)));
l = await api("/api/wallet/list");
ok("9 two wallets now, the new one is the default, the first is kept", l.j.wallets.length === 2 && l.j.default === w2.addr && l.j.wallets.some((w) => w.address === w1.addr && !w.default), l.j);
await pg.click("#wList"); await pg.waitForTimeout(1200);
ok("10 List wallets shows both, one marked default", (await pg.$$eval("#wBox tr", (r) => r.length)) === 3 && /default/.test(await pg.innerText("#wBox")));
await pg.screenshot({ path: OUT + "/wallets_list.png" });
await pg.click("#wBox button:has-text('Make default')"); await pg.waitForTimeout(1500);
l = await api("/api/wallet/list");
ok("11 Make default switches the default to the first wallet", l.j.default === w1.addr, l.j.default);
const bad = await api("/api/wallet/withdraw", { amount: "1", to: b58(nacl.sign.keyPair().publicKey) });
ok("12 a transfer to a wallet that is not yours is refused", bad.s === 400 && /not one of yours/.test(bad.j.error), bad);
await pg.click("#wSend"); await pg.waitForTimeout(1200);
ok("13 Transfer to my wallet: choose the wallet (default first) and the bonus amount; says the WU stay", (await pg.$$eval("#wBox select option", (o) => o.length)) === 2 &&
  /default/.test(await pg.$eval("#wBox select", (s) => s.options[s.selectedIndex].text)) && /Bonus to send: 0 test tokens/.test(await pg.innerText("#wBox")) && /never takes Work Units/.test(await pg.innerText("#wBox")));
await pg.click("#wList"); await pg.waitForTimeout(1200);
await pg.click("#wBox tr:has-text('" + w2.addr.slice(0, 6) + "') button:has-text('Remove')"); await pg.waitForTimeout(1500);
l = await api("/api/wallet/list");
ok("14 Remove takes one wallet off the account (after asking); the other stays default", l.j.wallets.length === 1 && l.j.default === w1.addr, l.j);
await pg.click("#wCreate"); await pg.waitForTimeout(800); await pg.click("#wBox .opt:has-text('Phantom')"); await pg.waitForTimeout(500);
ok("15 Phantom not in the browser: says so, how to switch it to devnet, and a Get Phantom link", /Phantom is not in this browser/.test(await pg.innerText("#wBox")) &&
  /Devnet/.test(await pg.innerText("#wBox")) && (await pg.$eval("#wBox a", (a) => a.href)).includes("phantom.com"));
await pg.evaluate(() => { const kp = nacl.sign.keyPair(), A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const b = (u) => { let d = [0], o = ""; for (const x of u) { let c = x; for (let j = 0; j < d.length; j++) { c += d[j] << 8; d[j] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } } for (const x of u) { if (x) break; o += "1"; } for (let q = d.length - 1; q >= 0; q--) o += A[d[q]]; return o; };
  window.__ph = b(kp.publicKey);
  window.phantom = { solana: { isPhantom: true, connect: async () => ({ publicKey: { toString: () => window.__ph } }), signMessage: async (m) => ({ signature: nacl.sign.detached(m, kp.secretKey) }) } }; });
await pg.click("#wCreate"); await pg.waitForTimeout(800); await pg.click("#wBox .opt:has-text('Phantom')"); await pg.waitForTimeout(2000);
const ph = await pg.evaluate(() => window.__ph); l = await api("/api/wallet/list");
ok("16 with Phantom: connect, sign the message, linked as kind phantom and made the default", l.j.default === ph && l.j.wallets.find((w) => w.address === ph)?.kind === "phantom" && l.j.wallets.length === 2, l.j);
await pg.screenshot({ path: OUT + "/wallets_phantom.png" });
ok("17 no page errors", errs.length === 0, errs);
await br.close();
// clean up the test account's items
for (const w of l.j.wallets) await api("/api/wallet/unlink", { wallet: w.address });
l = await api("/api/wallet/list"); ok("18 clean up: no wallets left on the test account", l.j.wallets.length === 0, l.j);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
