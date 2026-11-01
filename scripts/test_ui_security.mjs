// The program's page after the security review (TESTING.md test 60): website pages from the site port (E4), only site
// paths in #site= (E6), the emailed code for a new wallet address (W6), the switch for model files from outside the
// library (E5), the key for tools (E1), the theme to frames by message. client/ui/index.html in headless Chromium;
// the program and planetcompute.ai answered by the script.
//   cd <folder with playwright-core and chromium> && node <repo>/scripts/test_ui_security.mjs <repo>/client/ui/index.html
import { createRequire } from "node:module"; const req = createRequire(process.cwd() + "/"), { chromium } = req("playwright-core");
import { readFileSync } from "node:fs";
const page = readFileSync(process.argv[2], "utf8");
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
const KEY = "a".repeat(64), me = { user_id: "u1", first_name: "T", primary_email: "t@x", solana_address: "8XwKcJJGZ1ZwGyn99vBGfuNBwjAHq2F99nbTEyRWCCuB", solana_address_at: "2026-10-20T10:00:00Z" };
const posts = [], J = (o, s = 200) => ({ status: s, contentType: "application/json", body: JSON.stringify(o) });
async function open(hash = "") {
  const br = await chromium.launch(), pg = await br.newPage({ viewport: { width: 1280, height: 900 } }), errs = []; pg.on("pageerror", (e) => errs.push(e.message));
  await pg.addInitScript(() => { window.__msgs = []; const orig = Window.prototype.postMessage; });
  await pg.route("**/*", (rt) => { const u = new URL(rt.request().url()), m = rt.request().method();
    if (u.port === "17526") return rt.fulfill({ contentType: "text/html", body: "<html><body>site page " + u.pathname + u.search + "<script>addEventListener('message',e=>{document.body.dataset.theme=(e.data||{}).pcTheme||''})</script></body></html>" });
    if (u.pathname === "/" || u.pathname === "/local/") return rt.fulfill({ contentType: "text/html", body: page });
    if (u.pathname === "/local/info") return rt.fulfill(J({ version: "0.1.0", port: 7526, device: "abc123abc123", engine: "", site_port: 17526, api_key: KEY, open_url: "http://localhost:7526/local/?t=" + KEY, link: "x", link_id: "abc123abc123", tunnel: "on" }));
    if (u.pathname === "/local/models") return rt.fulfill(J({ downloaded: [], library: [], free: 1e12, used: 0, dir: "/m", allow_outside: false }));
    if (u.pathname === "/local/models/allow") { posts.push(["allow", JSON.parse(rt.request().postData())]); return rt.fulfill(J({ downloaded: [], library: [], free: 1e12, used: 0, dir: "/m", allow_outside: true })); }
    if (u.pathname === "/api/me") return rt.fulfill(J(me));
    if (u.pathname === "/api/me/balance") return rt.fulfill(J({ shared_wu: 1, received_wu: 0, difference_wu: 1, lifetime_contributed_wu: 1, lifetime_transferred_wu: 0, receiving_open: true }));
    if (u.pathname === "/api/me/solana-address" && m === "POST") { const b = JSON.parse(rt.request().postData()); posts.push(["addr", b]);
      return b.code ? rt.fulfill(J({ ok: true, solana_address: b.address, solana_address_at: "2026-10-28T10:00:00Z" })) : rt.fulfill(J({ need_code: true, sent_to: "t…@x", error: "We emailed a code" }, 428)); }
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return rt.fulfill(J({}));
    return rt.abort(); });
  await pg.goto("http://127.0.0.1:7526/local/" + hash); await pg.waitForTimeout(1800);
  return { br, pg, errs };
}
let { br, pg, errs } = await open();
let src = await pg.evaluate(() => document.getElementById("consoleFrame").src);
ok("1 E4: the website's console comes from the site port (another origin), not from the program's own port", src === "http://127.0.0.1:17526/?console=1", src);
await pg.click("#theme"); await pg.waitForTimeout(400);
const t = await pg.frames().find((f) => f.url().startsWith("http://127.0.0.1:17526/")).evaluate(() => document.body.dataset.theme);
ok("2 the day / night choice reaches the website's frame by message (it is another origin now)", t === (await pg.evaluate(() => document.documentElement.dataset.theme)), t);
const keyRow = await pg.evaluate(() => ({ shown: !document.getElementById("apiKeyRow").hidden, key: document.getElementById("apiKey").textContent, local: document.getElementById("local").href }));
ok("3 E1: the key for editors and tools is shown (with Copy); the 'open in a browser' link carries the program's secret", keyRow.shown && keyRow.key === KEY && keyRow.local.endsWith("?t=" + KEY), keyRow);
await pg.evaluate(() => { window.__codeAsked = ""; new MutationObserver(() => { const a = document.querySelector(".pc-toast.ask:not([data-seen])"); if (!a) return; a.dataset.seen = "1";
  window.__codeAsked += a.querySelector(".pc-t-msg").textContent + "|"; const i = a.querySelector("input"); setTimeout(() => { if (i) i.value = "123456"; a.querySelector(".pc-ok").click(); }, 0); })
  .observe(document, { childList: true, subtree: true }); });
await pg.click('header nav button[data-tab="balance"]'); await pg.waitForTimeout(900);
await pg.fill("#aAddr", "8XStVadubKdNsBqX9u1QtzMxBw463AH7bnkqxjrsjQeV"); await pg.click("#aSave"); await pg.waitForTimeout(900);
const ad = posts.filter((p) => p[0] === "addr").map((p) => p[1]), asked = await pg.evaluate(() => window.__codeAsked);
ok("4 W6: saving a new wallet address asks for the code emailed to the account, in the page, then sends it", ad.length === 2 && !ad[0].code && ad[1].code === "123456" &&
  /We emailed a 6-digit code to t…@x/.test(asked) && /Saved/.test(await pg.textContent("#aMsg")), { ad, asked, msg: await pg.textContent("#aMsg") });
await pg.evaluate(() => { go("harness"); }); await pg.waitForTimeout(300);
await pg.evaluate(() => { const c = document.getElementById("mAllow"); c.checked = true; c.dispatchEvent(new Event("change")); }); await pg.waitForTimeout(800);
const al = posts.filter((p) => p[0] === "allow");
ok("5 E5: switching on model files from outside the library asks first (with the warning), then tells the program", al.length === 1 && al[0][1].allow === true && /We do not check those files/.test(asked + await pg.evaluate(() => window.__codeAsked)), { al });
ok("6 no page errors", errs.length === 0, errs); await br.close();
({ br, pg, errs } = await open("#site=%2Fbalance"));
src = await pg.evaluate(() => document.getElementById("consoleFrame").src);
ok("7 a website page opened in the window (#site=/balance) is shown from the site port", src === "http://127.0.0.1:17526/balance", src); await br.close();
({ br, pg, errs } = await open("#site=%2F%5Cevil.example%2Fx"));
src = await pg.evaluate(() => document.getElementById("consoleFrame").src);
ok("8 E6: '#site=/\\evil.example/x' (another site) is refused: the frame keeps the console", src === "http://127.0.0.1:17526/?console=1", src); await br.close();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
