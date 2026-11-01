// Test of My content's large view with mouse-wheel zoom (TESTING.md test 32), in headless Chromium: the given worker.js
// answers in-process, the account and its files are faked (pictures from .ops/media_samples/out).
//   cd <folder with playwright-core and its chromium> && node <repo>/scripts/test_site_zoom.mjs <worker.js> <pictures dir>
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/")("playwright-core");
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const tmp = join(mkdtempSync(join(tmpdir(), "zm-")), "w.mjs"); copyFileSync(process.argv[2], tmp);
globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default, PICS = process.argv[3];
const FILES = { files: [["flux-cat.png", "AAAAAAAAAA"], ["flux-city.png", "BBBBBBBBBB"], ["flux-sign.png", "CCCCCCCCCC"]].map(([n, t], i) => ({ name: n, bytes: 1e6, at: Date.now() - i * 1e5, views: 1, type: "image/png", url: "https://planetcompute.ai/u/" + t })),
  trash: [], used: 3e6, quota: 5e8, trash_days: 30 };
const TOK = Object.fromEntries(FILES.files.map((f) => [f.url.split("/u/")[1], f.name]));
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
const b = await chromium.launch(); const errs = [];
const pg = await b.newPage({ viewport: { width: 1300, height: 850 } }); pg.on("pageerror", (e) => errs.push(e.message));
await pg.route(/^https:\/\/planetcompute\.ai\//, async (r) => { const u = new URL(r.request().url()), p = u.pathname;
  const J = (x, st = 200) => r.fulfill({ status: st, contentType: "application/json", body: JSON.stringify(x) });
  if (p === "/api/me") return J({ user_id: "u1", primary_email: "a@b.c" }); if (p === "/api/mycontent") return J(FILES);
  if (p.startsWith("/api/")) return J({}, 401);
  const m = p.match(/^\/u\/([A-Za-z0-9]{10})\/file$/); if (m) return r.fulfill({ contentType: "image/png", body: readFileSync(join(PICS, TOK[m[1]])) });
  const res = await W.fetch(new Request(u.toString()), {}); const h = {}; res.headers.forEach((v, k) => h[k] = v); r.fulfill({ status: res.status, headers: h, body: Buffer.from(await res.arrayBuffer()) }); });
await pg.route(/^https?:\/\/(?!planetcompute\.ai\/)/, (r) => r.abort());
await pg.goto("https://planetcompute.ai/mycontent"); await pg.waitForTimeout(1500);
ok("1 the page has the five buttons on top, My Content lit", (await pg.evaluate(() => [...document.querySelectorAll(".pcbar .modes [data-mode]")].length)) === 5 && (await pg.evaluate(() => (document.querySelector(".pcbar .modes [aria-current]") || {}).dataset?.mode)) === "content");
await pg.click(".thumb.open"); await pg.waitForTimeout(800);
const img = () => pg.evaluate(() => { const e = document.querySelector("#lbStage img"); if (!e) return null; const r = e.getBoundingClientRect(); return { t: e.style.transform, l: r.left, tp: r.top, w: r.width, h: r.height, src: e.src, z: document.getElementById("lbZoom").textContent }; });
const a = await img(); ok("2 a click on a picture opens the large view", !!a && a.w > 300 && /AAAAAAAAAA\/file$/.test(a.src), a);
const px = a.l + a.w * 0.7, py = a.tp + a.h * 0.25, fx = (px - a.l) / a.w, fy = (py - a.tp) / a.h;
await pg.mouse.move(px, py); for (let i = 0; i < 3; i++) { await pg.mouse.wheel(0, -200); await pg.waitForTimeout(80); }
const z1 = await img(); ok("3 mouse wheel up zooms in, the zoom shows in %", z1.w / a.w > 1.5 && /%$/.test(z1.z), [z1.w / a.w, z1.z]);
ok("4 the point under the pointer stays on the same spot of the picture", Math.abs((px - z1.l) / z1.w - fx) < 0.01 && Math.abs((py - z1.tp) / z1.h - fy) < 0.01);
await pg.mouse.down(); await pg.mouse.move(px - 100, py + 80, { steps: 5 }); await pg.mouse.up(); await pg.waitForTimeout(100); const d = await img();
ok("5 drag moves the zoomed picture, and the view stays open", Math.abs(d.l - z1.l + 100) < 3 && Math.abs(d.tp - z1.tp - 80) < 3 && (await pg.evaluate(() => !document.getElementById("lb").hidden)), [d.l - z1.l, d.tp - z1.tp]);
for (let i = 0; i < 20; i++) { await pg.mouse.wheel(0, 300); await pg.waitForTimeout(30); }
const o = await img(); ok("6 mouse wheel down zooms out to fit, no further", Math.abs(o.w - a.w) < 1 && o.z === "Fit", [o.w, a.w, o.z]);
await pg.click("#lbIn"); await pg.click("#lbIn"); ok("7 the + button zooms in", (await img()).w > a.w * 1.5);
await pg.click("#lbFit"); ok("8 Fit", (await img()).z === "Fit");
await pg.mouse.dblclick(px, py); await pg.waitForTimeout(150); ok("9 double-click: 250%", (await img()).z === "250%");
await pg.keyboard.press("ArrowRight"); await pg.waitForTimeout(500); const n = await img();
ok("10 right arrow: the next picture, at fit", /BBBBBBBBBB\/file$/.test(n.src) && n.z === "Fit", [n.src.slice(-20), n.z]);
await pg.keyboard.press("Escape"); ok("11 Esc closes", await pg.evaluate(() => document.getElementById("lb").hidden));
// ⓘ on each file: the information the shared page's ⓘ shows
ok("11a every file: the information icon, Maximize, then Open", await pg.evaluate(() => [...document.querySelectorAll(".card .acts")].every((a) => a.children[0].title === "Information" && !!a.children[0].querySelector("svg circle") && a.children[1].title.startsWith("Maximize") && a.children[2].textContent === "Open")));
await pg.click('.card .acts .ib[title^="Maximize"]'); await pg.waitForTimeout(600);
ok("11e a file's Maximize: the large view in full screen at once", await pg.evaluate(() => !document.getElementById("lb").hidden && document.fullscreenElement === document.getElementById("lb")));
await pg.keyboard.press("Escape"); await pg.waitForTimeout(300); await pg.evaluate(() => { if (document.fullscreenElement) document.exitFullscreen(); document.getElementById("lbX").click(); }); await pg.waitForTimeout(300);
await pg.click('.card .acts .ib[title="Information"]'); await pg.waitForTimeout(300);
const it = await pg.evaluate(() => ({ open: !document.getElementById("ip").hidden, t: document.getElementById("ipL").innerText, links: [...document.querySelectorAll("#ipA a")].map((a) => a.getAttribute("href")).join(" ") }));
ok("11b ⓘ shows: planetCompute.cpp, Picture, shared date, views, size, file, link; Its page and Download", it.open && /planetCompute\.cpp/.test(it.t) && /Picture/.test(it.t) && /Shared\s*\d{4}-\d\d-\d\d/.test(it.t) && /Views\s*1/.test(it.t) && /1\.0 MB/.test(it.t) && /flux-cat\.png/.test(it.t) && /planetcompute\.ai\/u\/AAAAAAAAAA/.test(it.t) &&
  it.links === "https://planetcompute.ai/u/AAAAAAAAAA https://planetcompute.ai/u/AAAAAAAAAA/download", it);
await pg.keyboard.press("Escape"); ok("11c Esc closes it", await pg.evaluate(() => document.getElementById("ip").hidden));
await pg.click(".seg [data-v=list]"); await pg.waitForTimeout(300);
ok("11d the list view has the information icon too", (await pg.evaluate(() => document.querySelectorAll('table .acts .ib[title="Information"]').length)) === 3);
await pg.click(".seg [data-v=grid]"); await pg.waitForTimeout(300);
// inside Harness Compute, Cloud Content (the page in a frame)
await pg.goto("https://planetcompute.ai/harness#cloud"); await pg.waitForTimeout(1800);
const mc = pg.frames().find((f) => f.url().includes("/mycontent?embed=1"));
await mc.click(".thumb.open"); await pg.waitForTimeout(700);
const fr = await mc.evaluate(() => { const e = document.querySelector("#lbStage img"); return e && e.getBoundingClientRect().width; });
const box = await (await pg.$("#cloudFrame")).boundingBox(); await pg.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 30); await pg.mouse.wheel(0, -400); await pg.waitForTimeout(200);
const fr2 = await mc.evaluate(() => document.querySelector("#lbStage img").getBoundingClientRect().width);
ok("12 inside Harness Compute, Cloud Content: the large view zooms with the wheel too", fr > 100 && fr2 > fr * 1.3, [fr, fr2]);
ok("13 no script errors", !errs.length, errs);
await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
