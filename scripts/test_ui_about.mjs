// The program page's About box (TESTING.md test 62): plain words in a table, the engine's raw line only under
// "Technical details". Opens client/ui/index.html in headless Chromium (playwright-core) with /local/info faked. No keys.
//   cd <folder with playwright-core and its chromium> && node <repo>/scripts/test_ui_about.mjs <repo>/client/ui/index.html <screenshot.png>
import { createRequire } from "node:module"; import { readFileSync } from "node:fs";
const req = createRequire(process.cwd() + "/"), { chromium } = req("playwright-core");
const [html, shot] = process.argv.slice(2), page = readFileSync(html, "utf8");
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
const ENGINE = "planetCompute.cpp (based on llama.cpp d812350): CPU : SSE3 = 1 | SSSE3 = 1 | AVX = 1 | AVX2 = 1 | F16C = 1 | FMA = 1 | BMI2 = 1 | LLAMAFILE = 1 | OPENMP = 1 | REPACK = 1 |";
const SANDBOX = "Windows sandbox: AppContainer (no network; files only where given) in a job (no other programs)";
const br = await chromium.launch(), pg = await br.newPage({ viewport: { width: 1280, height: 900 } }), errs = [];
pg.on("pageerror", (e) => errs.push(e.message));
await pg.route("**/*", (rt) => { const u = new URL(rt.request().url());
  if (u.pathname === "/" || u.pathname === "/local/") return rt.fulfill({ contentType: "text/html", body: page });
  if (u.pathname === "/local/info") return rt.fulfill({ contentType: "application/json", body: JSON.stringify({ version: "0.1.0", os: "windows", arch: "x86_64", port: 7526,
    device: "f808264cb709", link: "https://planetcompute.ai/device/x", tunnel: "on", engine: ENGINE, sandbox: SANDBOX }) });
  return rt.fulfill({ contentType: "application/json", body: "{}" }); });
await pg.goto("http://localhost:7526/local/"); await pg.waitForTimeout(1500);
const rows = await pg.evaluate(() => Object.fromEntries([...document.querySelectorAll("#about tr")].map((r) => [r.cells[0].textContent, r.cells[1].textContent])));
const raw = await pg.textContent("#aboutRaw");
ok("1 About is a table in plain words: version, computer (Windows, 64-bit), local address, device ID", rows.Version === "planetCompute 0.1.0" &&
  rows.Computer === "Windows, 64-bit (Intel / AMD)" && rows["Local address"] === "http://localhost:7526" && rows["Device ID"] === "f808264cb709", rows);
ok("2 the engine is named without the raw feature line; processor features listed by name (no '= 1', no internal LLAMAFILE/OPENMP/REPACK)",
  rows["Model engine"] === "planetCompute.cpp (based on llama.cpp d812350)" && rows["Processor features"] === "SSE3, SSSE3, AVX, AVX2, F16C, FMA, BMI2", rows);
ok("3 engine safety in plain words; no Graphics row when the engine names no graphics backend", /^Sandboxed: the model engine has no internet/.test(rows["Engine safety"]) && !("Graphics" in rows), rows);
ok("4 the raw lines (llama.cpp system info, sandbox) are kept under Technical details, folded", raw.includes(ENGINE) && raw.includes(SANDBOX) &&
  !(await pg.evaluate(() => document.getElementById("aboutRaw").closest("details").open)), raw);
ok("5 no page errors", errs.length === 0, errs);
if (shot) { await pg.evaluate(() => { const c = document.getElementById("about").closest(".card").cloneNode(true); c.id = "shotcard"; c.querySelector("details").open = true;
  document.body.innerHTML = ""; document.body.append(c); c.style.margin = "20px"; c.style.maxWidth = "900px"; }); await (await pg.$("#shotcard")).screenshot({ path: shot }); }
await br.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
