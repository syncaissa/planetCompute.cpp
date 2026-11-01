// Test (TESTING.md test 39) of the program's viewer in headless Chromium, fake program answers (no engine, no keys): maximized,
// the text fades after 3 s still and comes back on a mouse move; Save to cloud gives Copy link, then Copy Cloud URL.
//   cd <folder with playwright-core and its chromium> && node <repo>/scripts/test_app_viewer_idle.mjs <repo>/client/ui/index.html
// (pictures: .ops/media_samples/out/flux-cat.png and flux-city.png on Cloud9; any two PNGs with those names will do)
import { chromium } from "playwright-core"; import { readFileSync } from "node:fs";
const html = readFileSync(process.argv[2], "utf8"), PICS = "/home/ubuntu/environment/planetCompute/planetCompute-CPP/.ops/media_samples/out/";
const files = ["flux-cat.png", "flux-city.png"].map((n, i) => ({ name: n, bytes: 1e6, at: Date.now() - i * 1e5, type: "image/png", meta: { kind: "image", prompt: n, model: "flux1-schnell-q4", width: 1024, height: 1024, steps: 4, seed: i, made_at: Date.now() } }));
files[1].cloud_url = "https://planetcompute.ai/u/ALREADY001";
const J = (x) => ({ status: 200, contentType: "application/json", body: JSON.stringify(x) });
const models = { downloaded: [{ id: "flux1-schnell-q4", name: "FLUX.1 schnell", kind: "image", state: "ready", size: 1024, steps: 4, verified: true, bytes: 9e9 }], library: [], used: 0, free: 1e10 };
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1300, height: 850 } }); const errs = []; pg.on("pageerror", (e) => errs.push(e.message));
await pg.route("http://127.0.0.1:7526/**", (r) => { const p = new URL(r.request().url()).pathname;
  if (p === "/local/") return r.fulfill({ contentType: "text/html", body: html });
  if (p.endsWith("/local/models")) return r.fulfill(J(models)); if (p.endsWith("/local/content")) return r.fulfill(J({ folder: "/p", files }));
  if (p.endsWith("/local/image/queue")) return r.fulfill(J({ jobs: [] }));
  const m = p.match(/\/local\/content\/file\/(.+)$/); if (m) return r.fulfill({ contentType: "image/png", body: readFileSync(PICS + decodeURIComponent(m[1])) });
  return r.fulfill(J({})); });
await pg.goto("http://127.0.0.1:7526/local/#harness"); await pg.waitForTimeout(1500);
await pg.goto("http://127.0.0.1:7526/local/#harness"); await pg.waitForTimeout(1500);
let uploads = 0; await pg.route("http://127.0.0.1:7526/**/local/content/cloud", (r) => { uploads++; r.fulfill(J({ url: "https://planetcompute.ai/u/TESTLINK01" })); });
await pg.evaluate(() => navigator.clipboard.writeText = (t) => { window.__clip = t; return Promise.resolve(); });
await pg.click("#gGrid .gtile"); await pg.waitForTimeout(700);
const vis = () => pg.evaluate(() => ["vx", "vtools", "vinfo", "vcap"].map((c) => getComputedStyle(document.querySelector("#viewer ." + c)).opacity).join(","));
await pg.waitForTimeout(3600);
ok("1 not maximized: the text stays (large view in the window)", (await vis()) === "1,1,1,1" && !(await pg.evaluate(() => document.getElementById("viewer").classList.contains("idle"))));
await pg.click("#viewer .vinfo button:has-text('Save to cloud')"); await pg.waitForTimeout(500);
const say = await pg.innerText("#viewer .vinfo .say");
ok("2 Save to cloud in the large view: the link and a Copy link button", /Saved to the cloud: https:\/\/planetcompute\.ai\/u\/TESTLINK01/.test(say) && /Copy link/.test(say), say);
await pg.click("#viewer .vinfo .say button:has-text('Copy link')"); await pg.waitForTimeout(300);
ok("3 Copy link copies the link", (await pg.evaluate(() => window.__clip)) === "https://planetcompute.ai/u/TESTLINK01");
ok("3b now in the cloud: the button says Copy Cloud URL (no Save to cloud)", await pg.evaluate(() => [...document.querySelectorAll("#viewer .vinfo .va > button")].map((b) => b.textContent).includes("Copy Cloud URL") &&
  ![...document.querySelectorAll("#viewer .vinfo .va > button")].some((b) => b.textContent === "Save to cloud")));
await pg.evaluate(() => window.__clip = ""); await pg.click("#viewer .vinfo .va > button:has-text('Copy Cloud URL')"); await pg.waitForTimeout(300);
ok("3c Copy Cloud URL copies the link without sending it again", (await pg.evaluate(() => window.__clip)) === "https://planetcompute.ai/u/TESTLINK01" && uploads === 1, uploads);
await pg.click("#viewer .vtools ~ * , #viewer", { position: { x: 5, y: 5 } }).catch(() => {}); await pg.evaluate(() => document.querySelector("#viewer .vx").click()); await pg.waitForTimeout(300);
await pg.click("#gGrid .gtile:nth-child(2)"); await pg.waitForTimeout(600);
ok("3d a file the program already knows is in the cloud (cloud_url): Copy Cloud URL straight away", await pg.evaluate(() => [...document.querySelectorAll("#viewer .vinfo .va > button")].some((b) => b.textContent === "Copy Cloud URL")));
await pg.evaluate(() => document.querySelector("#viewer .vx").click()); await pg.waitForTimeout(300);
await pg.click("#gGrid .gtile"); await pg.waitForTimeout(600);
await pg.click("#vMax"); await pg.mouse.move(650, 300); await pg.waitForTimeout(1500);
ok("4 maximized: shown at first", (await pg.evaluate(() => document.fullscreenElement === document.getElementById("viewer"))) && (await vis()) === "1,1,1,1");
await pg.waitForTimeout(2600);
ok("5 after 3 s with no mouse move: the buttons, information and caption are gone, and the pointer too", (await vis()) === "0,0,0,0" && (await pg.evaluate(() => getComputedStyle(document.getElementById("viewer")).cursor)) === "none", await vis());
await pg.mouse.move(700, 320); await pg.waitForTimeout(600);
ok("6 a mouse move brings them back", (await vis()) === "1,1,1,1");
await pg.hover("#vOne"); await pg.waitForTimeout(3800);
ok("7 the pointer resting on a button: they stay", (await vis()) === "1,1,1,1");
await pg.mouse.move(650, 400); await pg.waitForTimeout(3800);
ok("8 and fade again once it moves off and rests", (await vis()) === "0,0,0,0");
await pg.keyboard.press("Escape"); await pg.waitForTimeout(600);
ok("9 leaving full screen: everything shows again", (await vis()) === "1,1,1,1");
ok("10 no script errors", !errs.length, errs);
await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail);
