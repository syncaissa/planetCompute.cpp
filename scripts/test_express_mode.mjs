// docs/TESTING.md test 77: Receive Compute with no PC connected = Express mode (banner per system / phone, locked fields, chat,
// pictures with Download, automatic connect, Connect messages, slim strip, email link, signed out, computer list).
//   cd <folder with playwright-core> && node <repo>/scripts/test_express_mode.mjs <worker.js> [screenshot dir]
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/")("playwright-core");
import { copyFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const tmp = join(mkdtempSync(join(tmpdir(), "ex-")), "w.mjs"); copyFileSync(process.argv[2], tmp); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default, SHOTS = process.argv[3] || "";
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, x === undefined ? "" : JSON.stringify(x).slice(0, 400)); } };
const b = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell" });
const ME = { user_id: "u1", primary_email: "user@example.com", first_name: "Milind" };
const POOL = { open: true, limit: 200, used: 3, models: [{ id: "qwen3-4b-instruct-2507", name: "Qwen3 4B", computers: 2 }], media_open: true, media_limit: 10, media_used: 1,
  image_models: [{ id: "zimage-turbo-q4k", name: "Z-Image Turbo", computers: 2 }], video_models: [], hubs: 1 };
async function open({ ua, w, signed = true, devices = [] , seen = false }) {
  const st = { devices, posts: [], media: [] };
  const ctx = await b.newContext({ viewport: { width: w, height: 900 }, userAgent: ua });
  if (seen) await ctx.addInitScript(() => localStorage.setItem("pc-xp-seen", "1"));
  await ctx.route("**/*", async (r) => { const u = new URL(r.request().url()); if (u.hostname !== "planetcompute.ai") return r.fulfill({ body: "" });
    const J = (x, s = 200) => r.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(x) });
    const p = u.pathname, m = r.request().method();
    if (m === "POST") st.posts.push([p, r.request().postData()]);
    if (!signed && p.startsWith("/api/")) return J({ error: "Not signed in." }, 401);
    if (p === "/api/me") return J(ME);
    if (p === "/api/tunnel/devices") return J({ devices: st.devices });
    if (p === "/api/pool") return J(POOL);
    if (p === "/api/pool/chat") return J({ choices: [{ message: { role: "assistant", content: "Paris is the capital of France." } }] });
    if (p === "/api/pool/media" && m === "POST") { st.media.unshift({ hub: "sherpa:hub:u1:3eb5be2903aa", job: "00000000000000a1", task: "image", model: "zimage-turbo-q4k", prompt: JSON.parse(r.request().postData()).prompt, width: 1080, height: 1350, created_at: "2026-10-29T18:00:00Z", state: "waiting", ready: false }); return J({ ok: true, hub: "h", job: "00000000000000a1", eta: "usually 30 to 60 minutes" }); }
    if (p === "/api/pool/media") return J({ items: st.media });
    if (p === "/api/pool/media/file") return r.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("89504e470d0a1a0a", "hex") });
    if (p === "/api/me/email-download-link") return J({ ok: true, to: "user@example.com" });
    if (p.startsWith("/device/")) return r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><body>PROGRAM</body>" });
    if (p.startsWith("/api/")) return J({});
    const res = await W.fetch(new Request(u.toString(), { headers: r.request().headers() }), {}); const h = {}; res.headers.forEach((v, k) => h[k] = v); return r.fulfill({ status: res.status, headers: h, body: Buffer.from(await res.arrayBuffer()) }); });
  const page = await ctx.newPage(); await page.goto("https://planetcompute.ai/harness#inference"); await page.waitForTimeout(1200);
  return { page, ctx, st };
}
const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
let x = await open({ ua: WIN, w: 1280 });
// The same frame and row for both modes (user 2026-10-29: "the appearance and all should look SAME on the UI")
const row = (pg) => pg.evaluate(() => { const v = (id) => { const e = document.getElementById(id); return e && getComputedStyle(e).display !== "none" && !e.closest("[hidden]"); };
  return { row: v("devRow"), pc: v("devSel"), x: v("xConn2"), dl: document.getElementById("xDl2").textContent, href: document.getElementById("xDl2").getAttribute("href"),
    src: document.getElementById("devFrame").dataset.at || document.getElementById("devFrame").getAttribute("src") || "", frame: v("devFrame"), getApp: v("getApp"), banner: v("xBanner"), msg: document.getElementById("xRowMsg").textContent,
    title: document.getElementById("xConn2").title }; });
let t = await row(x.page);
ok("1 desktop, no PC: the row above the frame says Express mode, with ONE 'Download for Windows' (/download/windows) and Connect to my PC; no old box, no banner", t.row && t.x && !t.pc && t.dl === "Download for Windows" && t.href === "/download/windows" && !t.getApp && !t.banner, t);
ok("2 the SAME frame as with a PC (devFrame) shows the program's own page in Express (/express/local/)", t.frame && t.src.startsWith("/express/local/?embed=1&tab=inference"), t.src);
ok("2b Connect's hint names the email to sign in with", /signed in as user@example\.com/.test(t.title), t.title);
// the PC comes online: the same frame switches to it by itself
x.st.devices = [{ device: "aaaaaaaaaaaa", name: "DESKTOP-HOME", online: true, since: "2026-10-29T10:00:00Z", link: "https://planetcompute.ai/device/aaaaaaaaaaaa/" }];
await x.page.waitForTimeout(11500);
t = await row(x.page);
ok("9 the PC comes online: within ~10 s the same frame shows the PC (no click), the row shows the computer, 'Connected to DESKTOP-HOME'", t.frame && t.src.startsWith("/device/aaaaaaaaaaaa/local/") && t.pc && !t.x && /Connected to DESKTOP-HOME/.test(await x.page.evaluate(() => document.body.innerText)), t);
await x.ctx.close();
x = await open({ ua: WIN, w: 1280, devices: [{ device: "bbbbbbbbbbbb", name: "LAPTOP", online: false, since: "2026-10-20T10:00:00Z", link: "https://planetcompute.ai/device/bbbbbbbbbbbb/" }] });
await x.page.click("#xConn2"); await x.page.waitForTimeout(600);
ok("10 Connect to my PC, PC known but off: 'Your PC LAPTOP is offline…' in the row", (await x.page.textContent("#xRowMsg")).includes("Your PC LAPTOP is offline"));
await x.ctx.close();
x = await open({ ua: WIN, w: 1280 }); await x.page.click("#xConn2"); await x.page.waitForTimeout(600);
ok("11 Connect, no PC at all: names the browser's account ('signed in as user@example.com … same email')", (await x.page.textContent("#xRowMsg")).includes("We can't see planetCompute signed in as user@example.com") && (await x.page.textContent("#xRowMsg")).includes("same email"));
await x.ctx.close();
x = await open({ ua: WIN, w: 1280, seen: true });
t = await row(x.page);
ok("12 a later visit: the same row and frame (nothing else to dismiss)", t.row && t.frame && !t.banner, t);
await x.ctx.close();
x = await open({ ua: IPHONE, w: 390 });
t = await row(x.page);
ok("14 phone: the row offers 'Email me the download link'", t.dl === "Email me the download link", t);
await x.page.click("#xDl2"); await x.page.waitForTimeout(500);
ok("15 Email me the download link: posted, 'Sent to user@example.com' in the row", x.st.posts.some((p) => p[0] === "/api/me/email-download-link") && (await x.page.textContent("#xRowMsg")).includes("Sent to user@example.com"));
ok("16 phone page is not wider than the screen; the header buttons share the first row with the logo", await x.page.evaluate(() => { const e = document.querySelector("header.bar .pc-end").getBoundingClientRect(), br = document.querySelector("header.bar .brand").getBoundingClientRect(); return document.documentElement.scrollWidth <= innerWidth + 1 && Math.abs(e.top - br.top) < 12; }));
await x.ctx.close();
x = await open({ ua: WIN, w: 1280, signed: false });
t = await row(x.page);
ok("17 signed out: no frame; 'Sign in to use Express mode or to connect your PC.' with Sign In", !t.frame && (await x.page.textContent("#xTitle")).includes("Sign in to use Express mode") && (await x.page.getAttribute("#xSignIn", "href")) === "/?auth=signin");
await x.ctx.close();
x = await open({ ua: WIN, w: 1280, devices: [["WASMONE", "2026-10-29T10:00:00Z"], ["ip-172-31-82-204", "2026-10-28T10:00:00Z"], ["31c98b72784b", "2026-10-29T12:00:00Z"], ["8e281a540a74", "2026-10-27T10:00:00Z"],
  ["866e44f92102", "2026-10-26T10:00:00Z"], ["9c0222da3b4c", "2026-10-25T10:00:00Z"]].map((d, i) => ({ device: String(i).repeat(12), name: d[0], online: false, since: d[1], link: "https://planetcompute.ai/device/" + String(i).repeat(12) + "/" })) });
t = await row(x.page);
ok("18 six computers: Connect's hint lists only 'WASMONE, ip-172-31-82-204 and 4 more'", t.title.includes("Your computers: WASMONE, ip-172-31-82-204 and 4 more"), t.title);
await x.page.click("#xConn2"); await x.page.waitForTimeout(600);
ok("19 Connect names the most recent named computer: 'Your PC WASMONE is offline…'", (await x.page.textContent("#xRowMsg")).includes("Your PC WASMONE is offline"));
await x.ctx.close();
// Disconnect from my PC: the same frame goes to Express (no automatic reconnect, kept after a reload); Connect brings the PC back
x = await open({ ua: WIN, w: 1280, devices: [{ device: "aaaaaaaaaaaa", name: "DESKTOP-HOME", online: true, since: "2026-10-29T10:00:00Z", link: "https://planetcompute.ai/device/aaaaaaaaaaaa/" }] });
t = await row(x.page);
ok("20 PC online: its window in the frame, the row with the computer and 'Disconnect from my PC'", t.frame && t.src.startsWith("/device/aaaaaaaaaaaa/") && t.pc && await x.page.isVisible("#devOff"), t);
await x.page.click("#devOff"); await x.page.waitForTimeout(400);
t = await row(x.page);
ok("21 Disconnect: the same frame shows Express, the row says it and names the PC", t.frame && t.src.startsWith("/express/local/") && t.x && /Disconnected from DESKTOP-HOME/.test(t.msg), t);
await x.page.waitForTimeout(11500);
ok("22 it does not reconnect by itself (the PC is still online)", (await row(x.page)).src.startsWith("/express/local/"));
await x.page.reload(); await x.page.waitForTimeout(1500);
ok("23 still disconnected after a reload", (await row(x.page)).src.startsWith("/express/local/"));
await x.page.click("#xConn2"); await x.page.waitForTimeout(900);
ok("24 Connect to my PC: the PC's window again in the same frame", (await row(x.page)).src.startsWith("/device/aaaaaaaaaaaa/"));
await x.ctx.close();
await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
