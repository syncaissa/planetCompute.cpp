// The program page: (1) the image check lines fold under "details", (2) My Balance has the Solana wallet address.
import { createRequire } from "node:module"; const req = createRequire(process.cwd() + "/"), { chromium } = req("playwright-core");
import { readFileSync } from "node:fs";
const [html, outDir] = process.argv.slice(2), page = readFileSync(html, "utf8");
const br = await chromium.launch(), pg = await br.newPage({ viewport: { width: 1280, height: 900 } }), errs = [];
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
pg.on("pageerror", (e) => errs.push(e.message));
const me = { user_id: "u1", first_name: "Test", last_name: "User", primary_email: "t@x", solana_address: "8XwKcJJGZ1ZwGyn99vBGfuNBwjAHq2F99nbTEyRWCCuB", solana_address_at: "2026-10-27T10:00:00Z" };
let posted = null, checkState = "pass", wd = null, moved = false, confirmText = "", MODES = { transfer_site_pays: false, transfer_user_pays: true }, siteSent = null;
const J = (o, s = 200) => ({ status: s, contentType: "application/json", body: JSON.stringify(o) });
await pg.route("**/*", (rt) => { const u = new URL(rt.request().url());
  if (u.pathname === "/" || u.pathname === "/local/") return rt.fulfill({ contentType: "text/html", body: page });
  if (u.pathname === "/local/info") return rt.fulfill(J({ version: "0.1.0", port: 7526, device: "abc123abc123", engine: {}, signed_in: true }));
  if (u.pathname === "/local/models") return rt.fulfill(J({ downloaded: [{ id: "zimage-turbo-q4k", name: "Z-Image Turbo (4-bit)", kind: "image", state: "ready" }], library: [], free: 1e12, used: 0 }));
  if (u.pathname === "/local/image/check") return rt.fulfill(J({ ok: true, way: "GPU", checks: [
    { name: "Engine", state: "pass", text: "the image engine is in this program" }, { name: "Model", state: "pass", text: "Z-Image Turbo (4-bit) and its 2 parts downloaded (6.1 GB)" },
    { name: "Graphics card", state: "pass", text: "Intel(R) Iris(R) Xe Graphics (built-in): 15.1 GB free of 15.9 GB" }, { name: "Before", state: checkState, text: "worked last time on the GPU" }] }));
  if (u.pathname === "/api/me") return rt.fulfill(J(me));
  if (u.pathname === "/api/me/token-risk") return rt.fulfill(J({ accepted: true, at: "2026-10-30T01:00:00Z", text: "I understand that PlanetComp is a ledger record only." }));   // both boxes checked: the token section shows (test 82)
  if (u.pathname === "/api/me/crypto-allowed") return rt.fulfill(J({ allowed: true, at: "2026-10-30T01:00:00Z" }));   // the confirmation box checked (test 82)
  if (u.pathname === "/api/me/balance") return rt.fulfill(J({ shared_wu: 1.5, received_wu: 0.2, difference_wu: 1.3, lifetime_contributed_wu: 3, lifetime_transferred_wu: 0, receiving_open: true }));
  if (u.pathname === "/api/me/credit") return rt.fulfill(J({ wallet_enabled: true, move_shown: true, cluster: "mainnet-beta", ...MODES, min_send: "0.01", bonus_available: moved ? "0" : "0.05",
    lifetime_left_wu: moved ? "0" : "3", lifetime_contribution_wu: "3", lifetime_redeemed_wu: moved ? "3" : "0" }));
  if (u.pathname === "/api/wallet/claim/quote") return rt.fulfill(J({ address: me.solana_address, fee_sol: "0.00001", deposit_sol: "0.00151384", new_account: true, need_sol: "0.00152384", has_sol: "0.05", enough: true }));
  if (u.pathname === "/api/wallet/history") return rt.fulfill(J({ transfers: [{ at: "2026-10-28T01:00:00Z", tokens: "0.05", coins: [{ name: "PlanetComp", amount: "0.05" }], wu: "3",
    to_wallet: me.solana_address, status: "settled", status_text: "sent", explorer: "https://solscan.io/tx/abc", account: "9KbbZmAbNPW7tNyYGz884aAUGxE2p6xFTh5kEtjRyd7T", account_url: "https://solscan.io/account/9KbbZmAbNPW7tNyYGz884aAUGxE2p6xFTh5kEtjRyd7T" }] }));
  if (u.pathname === "/api/wallet/withdraw") { siteSent = JSON.parse(rt.request().postData()); moved = true; return rt.fulfill(J({ ok: true, status: "settled", tokens_sent: "0.05", wu_moved: "3", explorer: "https://explorer.solana.com/tx/def" })); }
  if (u.pathname === "/local/open") { wd = JSON.parse(rt.request().postData()); return rt.fulfill(J({ ok: true })); }
  if (u.pathname === "/api/me/solana-address/holdings") return rt.fulfill(J({ shown: true, address: me.solana_address, cluster: "mainnet-beta", explorer: "https://solscan.io/account/" + me.solana_address,
    sol: 0.05, coins: [{ name: "PlanetComp", mint: "688c", amount: "1234.5" }], at: "2026-10-27T22:45:00Z",
    accounts: [{ kind: "wallet", address: me.solana_address, amount: 0.05, url: "https://solscan.io/account/" + me.solana_address },
      { kind: "token", name: "PlanetComp", address: "9KbbZmAbNPW7tNyYGz884aAUGxE2p6xFTh5kEtjRyd7T", amount: "1234.5", url: "https://solscan.io/account/9KbbZmAbNPW7tNyYGz884aAUGxE2p6xFTh5kEtjRyd7T" }] }));
  if (u.pathname === "/api/me/solana-address/history") return rt.fulfill(J({ changes: [{ changed_at: "2026-10-27T10:00:00Z", old_address: "", new_address: me.solana_address }] }));
  if (u.pathname === "/api/me/solana-address") { posted = JSON.parse(rt.request().postData()); return rt.fulfill(J({ ok: true, solana_address: posted.address, solana_address_at: "2026-10-27T18:00:00Z", previous: me.solana_address })); }
  if (u.hostname === "127.0.0.1") return rt.fulfill(J({}));
  return rt.abort(); });
// the program asks in the page now (pcConfirm / pcPrompt), not in a browser pop-up: answer OK and keep the question
const AUTO_OK = () => { if (window.__autoOk) return; window.__autoOk = 1; window.__asked = [];
  new MutationObserver(() => { const t = document.querySelector(".pc-toast.ask:not([data-seen])"); if (!t) return; t.dataset.seen = "1";
    window.__asked.push(t.querySelector(".pc-t-msg").textContent); setTimeout(() => t.querySelector(".pc-ok").click(), 0); })
    .observe(document, { childList: true, subtree: true }); };
const asked = () => pg.evaluate(() => (window.__asked || []).slice(-1)[0] || "");
await pg.addInitScript(AUTO_OK);
await pg.goto("http://127.0.0.1:7526/local/"); await pg.waitForTimeout(1500);
// 1. the checks
await pg.evaluate(() => { where = "local"; task = "image"; runChecks(); }); await pg.waitForTimeout(800);
let c = await pg.evaluate(() => { const b = document.getElementById("chkBox"), d = b.querySelector("details");
  return { first: b.firstElementChild && b.firstElementChild.className, way: b.querySelector(".way").textContent, sum: d && d.querySelector("summary").textContent, open: d && d.open, lines: d ? d.querySelectorAll("div").length : 0 }; });
ok("1 all checks pass: the outcome line shows, the 4 lines are folded under 'details' (closed)", c.first === "way" && /graphics card/.test(c.way) && c.sum === "details" && c.open === false && c.lines === 4, c);
await pg.evaluate(() => document.getElementById("chkBox").scrollIntoView()); await pg.screenshot({ path: outDir + "/chk_closed.png" });
await pg.evaluate(() => document.querySelector("#chkBox summary").click()); await pg.waitForTimeout(200);
ok("2 a click on 'details' opens the lines", await pg.evaluate(() => document.querySelector("#chkBox details").open), null);
await pg.screenshot({ path: outDir + "/chk_open.png" });
checkState = "warn"; await pg.evaluate(() => runChecks()); await pg.waitForTimeout(800);
c = await pg.evaluate(() => ({ open: document.querySelector("#chkBox details").open, btn: !!document.querySelector("#chkBox details button") }));
ok("3 a line that needs attention (warn): 'details' opens by itself, with its 'Try the GPU again' button", c.open && c.btn, c);
// 2. My Balance
await pg.click('header nav button[data-tab="balance"]'); await pg.waitForTimeout(800);
c = await pg.evaluate(() => ({ shown: !document.getElementById("addr").hidden, h: document.querySelector("#addr h2").textContent, p: document.querySelector("#addr p").textContent,
  v: document.getElementById("aAddr").value, since: document.getElementById("aSince").textContent, notice: /bragging rights only/.test(document.getElementById("aNotice").textContent) }));
ok("4 My Balance shows 'Your Tokens wallet address', its text, the current address, since, and the token notice", c.shown && c.h === "Your Tokens wallet address" &&
  /^Your Solana wallet address: the address of your own wallet/.test(c.p) && /It is the same address as on your profile\./.test(c.p) && c.v === me.solana_address && /2026-10-27 10:00/.test(c.since) && c.notice, c);
await pg.screenshot({ path: outDir + "/bal_wallet.png", fullPage: true });
c = await pg.evaluate(() => ({ shown: !document.getElementById("aHold").hidden, t: document.getElementById("aHold").textContent, href: (document.querySelector("#aHold a") || {}).href }));
ok("10 under the address: what the wallet holds (each coin and SOL), when it was read, and a Solscan link", c.shown &&
  c.t.startsWith("This wallet holds: 1234.5 PlanetComp · 0.05 SOL (read from Solana mainnet at 22:45 UTC)") && c.href === "https://solscan.io/account/" + me.solana_address, c);
await pg.evaluate(() => { window.__clip = null; navigator.clipboard.writeText = (t) => { window.__clip = t; return Promise.resolve(); }; });
await pg.evaluate(() => [...document.querySelectorAll("#aHold button")].find((x) => x.textContent === "Copy").click()); await pg.waitForTimeout(200);
c = await pg.evaluate(() => ({ clip: window.__clip, label: document.querySelector("#aHold button").textContent }));
ok("11 Copy next to View on Solscan copies the Solscan address", c.clip === "https://solscan.io/account/" + me.solana_address && c.label === "Copied", c);
c = await pg.evaluate(() => [...document.querySelectorAll("#aHold li")].map((x) => (x.querySelector("button") || {}).textContent));
await pg.evaluate(() => document.querySelectorAll("#aHold li")[1].querySelector("button").click()); await pg.waitForTimeout(200);
const c11 = await pg.evaluate(() => window.__clip);
ok("11b each account the wallet owns has a 'Copy address' button that copies that account's address", c.length === 2 && c.every((x) => x === "Copy address") && c11 === "9KbbZmAbNPW7tNyYGz884aAUGxE2p6xFTh5kEtjRyd7T", { c, c11 });
c = await pg.evaluate(() => ({ shown: !document.getElementById("mv").hidden, t: document.getElementById("mvText").textContent, dis: document.getElementById("mvGo").disabled }));
ok("12 Move my lifetime balance: shows the WU left (3) and the bonus to send (0.05); the button is on", c.shown && /Left to move: 3 WU/.test(c.t) && /bonus of 0\.05/.test(c.t) && !c.dis, c);
c = await pg.evaluate(() => ({ cost: document.getElementById("mvCost").textContent, hist: [...document.querySelectorAll("#mvHist tr")].map((r) => r.textContent) }));
const c13 = await pg.evaluate(() => ({ help: document.querySelector("#mv details summary") && document.querySelector("#mv details summary").textContent, helpText: document.querySelector("#mv details") ? document.querySelector("#mv details").textContent : "",
  acct: [...document.querySelectorAll("#mvHist tr")].map((r) => r.lastChild.textContent), href: (document.querySelector("#mvHist tr:nth-child(2) td:last-child a") || {}).href }));
ok("13b 'Can't see your PlanetComp?' explains the wallet app, Solscan's 'does not exist' and the links; each sent transfer shows 'Your coin account' with its Solscan link + Copy",
  c13.help === "Can't see your PlanetComp?" && /account does not exist/.test(c13.helpText) && /Manage tokens/.test(c13.helpText) && c13.acct[0] === "Your coin account" && /^PlanetComp 9Kbb…yd7T ?Copy$/.test(c13.acct[1]) &&
  c13.href === "https://solscan.io/account/9KbbZmAbNPW7tNyYGz884aAUGxE2p6xFTh5kEtjRyd7T", c13);
ok("13 next to the button the real charge (0.00001 SOL fee + 0.00151384 SOL one-time deposit = 0.00152384), and the history (sent, View + Copy)",
  /0\.00001 SOL network fee, plus 0\.00151384 SOL once/.test(c.cost) && /Total 0\.00152384 SOL/.test(c.cost) && /opens My Balance on planetcompute\.ai/.test(c.cost) &&
  c.hist.length === 2 && /0\.05 PlanetComp/.test(c.hist[1]) && /sent/.test(c.hist[1]) && /View/.test(c.hist[1]) && /Copy/.test(c.hist[1]), c);
await pg.click("#mvGo"); await pg.waitForTimeout(500);
ok("14 the button opens planetcompute.ai/balance in the browser (a browser wallet cannot connect to the program's window)", wd && wd.url === "https://planetcompute.ai/balance" &&
  /press Move there/.test(await pg.textContent("#mvMsg")), { wd, msg: await pg.textContent("#mvMsg") });
await pg.click("#aHist"); await pg.waitForTimeout(400);
ok("5 Previous addresses with only the first address saved: says there are none, and when the first was saved", /^No previous addresses: this is the first wallet address on your account, saved 2026-10-27 10:00 UTC\.$/.test(await pg.textContent("#aList")), await pg.textContent("#aList"));
const dis = () => pg.evaluate(() => document.getElementById("aSave").disabled);
const d0 = await dis(); await pg.fill("#aAddr", me.solana_address + " "); const d1 = await dis(); await pg.fill("#aAddr", "8XStVadubKdNsBqX9u1QtzMxBw463AH7bnkqxjrsjQeV"); const d2 = await dis();
await pg.fill("#aAddr", me.solana_address); const d3 = await dis();
ok("5b Update is on only when the address was changed (same address, even with a space: off; another: on; back to the same: off)", d0 && d1 && !d2 && d3, { d0, d1, d2, d3 });
await pg.fill("#aAddr", "8XStVadubKdNsBqX9u1QtzMxBw463AH7bnkqxjrsjQeV"); await pg.click("#aSave"); await pg.waitForTimeout(600);
ok("6 Update asks in the page (From / To), posts the address to /api/me/solana-address and shows Saved", posted && posted.address.startsWith("8XSt") && /Saved/.test(await pg.textContent("#aMsg")) &&
  /Change your wallet address\?\nFrom: 8XwK.*\nTo: 8XSt/s.test(await asked()), [posted, await pg.textContent("#aMsg"), await asked()]);
ok("6b after saving, Update is off again (the field equals the saved address)", await dis(), null);
c = await pg.evaluate(() => { const o = [...document.getElementById("iSize").options].find((x) => x.value === "1920x1080"); if (!o) return null;
  document.getElementById("iSize").value = "1920x1080"; const r = imageReq(false, "x"); return { label: o.textContent, w: r && r.width, h: r && r.height }; });
ok("8 Size has 1920 x 1080 for every image model; picked, the request asks 1920 x 1080", c && c.w === 1920 && c.h === 1080, c);
c = await pg.evaluate(() => { const o = [...document.getElementById("vSize").options].find((x) => x.value === "1920x1080"); return o ? o.textContent : null; });
ok("9 the video Size has 1920 x 1080 too (marked very slow)", c && /very slow/.test(c), c);
MODES = { transfer_site_pays: true, transfer_user_pays: true }; moved = false; wd = null;
await pg.click("#balRefresh"); await pg.waitForTimeout(900);
c = await pg.evaluate(() => ({ claim: !document.getElementById("mvClaim").hidden, cost: document.getElementById("mvCost").textContent }));
ok("15 both settings YES: 'Free for you: PlanetCompute pays' and the second button 'Approve it in my own wallet instead'", c.claim && /^For a limited time only\.\.\. Free for you: PlanetCompute pays the network charge\. Or approve it/.test(c.cost), c);
await pg.click("#mvGo"); await pg.waitForTimeout(1200); const conf3 = await asked();
ok("16 Move then sends from the program itself (PlanetCompute pays, no browser): withdraw for the saved address; receipt + link", siteSent && siteSent.to === me.solana_address && wd === null &&
  /Free for you/.test(conf3) && /Sent: 0\.05 in coins; 3 WU moved/.test(await pg.textContent("#mvMsg")), { siteSent, wd, conf3, msg: await pg.textContent("#mvMsg") });
ok("16b after the move nothing is left: both buttons off", await pg.evaluate(() => document.getElementById("mvGo").disabled && document.getElementById("mvClaim").disabled), null);
moved = false; wd = null; await pg.click("#balRefresh"); await pg.waitForTimeout(900);   // a new bonus to move
await pg.click("#mvClaim"); await pg.waitForTimeout(400);
ok("17 'Approve it in my own wallet instead' opens planetcompute.ai/balance and says which button to press there", wd && wd.url === "https://planetcompute.ai/balance" && /press Approve it in my own wallet instead there/.test(await pg.textContent("#mvMsg")), { wd, msg: await pg.textContent("#mvMsg") });
ok("7 no page errors", errs.length === 0, errs);
console.log(`\n${pass} passed, ${fail} failed`); await br.close(); process.exit(fail ? 1 : 0);
