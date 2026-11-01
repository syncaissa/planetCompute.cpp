// Device pages on their own origin (TESTING.md test 57; security review T1). The given worker.js in-process; the signed-in
// user and the device (a DeviceTunnel answering with a page) are faked. No keys, no network.
//   node scripts/test_device_host.mjs website/worker.js
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
let src = readFileSync(process.argv[2], "utf8");
src = src.replace("async function currentUser(env, request) {", "async function currentUser(env, request) { if (globalThis.__signed) return { user_id: 'u1', token: 't' }; return null;");
const tmp = join(mkdtempSync(join(tmpdir(), "dh-")), "w.mjs"); writeFileSync(tmp, src); globalThis.WebSocketRequestResponsePair = class {};
const W = (await import(tmp)).default;
let relayed = [];
const env = { AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "y", SESSION_SECRET: "s".repeat(40), TUNNEL: { idFromName: (n) => n, get: (n) => ({ fetch: async (u, init) => {
  relayed.push({ name: n, path: init.headers["x-pc-path"], method: init.headers["x-pc-method"] });
  if (init.headers["x-pc-path"].startsWith("/local/big")) return new Response("<html><body>" + "x".repeat(5 * 1024 * 1024) + "</body></html>", { headers: { "content-type": "text/html; charset=utf-8" } });
  return new Response("<html><body><h1>program</h1></body></html>", { headers: { "content-type": "text/html; charset=utf-8" } }); } }) } };
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, JSON.stringify(x)); } };
const go = (u, init = {}) => W.fetch(new Request(u, { redirect: "manual", ...init }), env);
const D = "aaaaaaaaaaaa", D2 = "bbbbbbbbbbbb";
globalThis.__signed = false;
let r = await go(`https://planetcompute.ai/device/${D}/local/`);
ok("1 not signed in on planetcompute.ai: the sign-in page (401), nothing relayed", r.status === 401 && relayed.length === 0, r.status);
globalThis.__signed = true;
r = await go(`https://planetcompute.ai/device/${D}/local/?embed=1`);
const loc = r.headers.get("location") || "";
ok("2 signed in: planetcompute.ai sends the browser to device.planetcompute.ai with a ticket (nothing relayed on planetcompute.ai)",
  r.status === 302 && loc.startsWith(`https://device.planetcompute.ai/device/${D}/local/?embed=1&pcticket=`) && relayed.length === 0, loc);
r = await go(`https://planetcompute.ai/device/${D}/local/models/delete`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
ok("3 a POST on planetcompute.ai/device/... is refused (409): no device actions on the site's origin", r.status === 409 && relayed.length === 0, r.status);
globalThis.__signed = false;                               // the device host never uses the site's sign-in
r = await go(loc);
const ck = (r.headers.get("set-cookie") || "");
ok("4 the device host turns the ticket into its own cookie for that link only (HttpOnly, Secure, Path=/device/<id>/) and drops the ticket from the address",
  r.status === 302 && r.headers.get("location") === `/device/${D}/local/?embed=1` && /^pc_dev=[^;]+; Path=\/device\/aaaaaaaaaaaa\/; HttpOnly; Secure; SameSite=Lax/.test(ck), { loc: r.headers.get("location"), ck });
const cookie = ck.split(";")[0];
r = await go(`https://device.planetcompute.ai/device/${D}/local/`, { headers: { cookie } });
const csp = r.headers.get("content-security-policy") || "", body = await r.text();
ok("5 with that cookie the page is relayed from the device; framed only by planetcompute.ai; fetches only below its path",
  r.status === 200 && /program/.test(body) && relayed.at(-1).name === `tunnel:u1:${D}` && /frame-ancestors https:\/\/planetcompute\.ai;/.test(csp) &&
  /connect-src https:\/\/device\.planetcompute\.ai\/device\/aaaaaaaaaaaa\/;/.test(csp) && !r.headers.get("x-frame-options"), { csp, xfo: r.headers.get("x-frame-options") });
const n0 = relayed.length;
r = await go(`https://device.planetcompute.ai/device/${D2}/local/`, { headers: { cookie } });
ok("6 the cookie of one device link does not open another device (sent back to planetcompute.ai to sign in)", r.status === 302 && relayed.length === n0 &&
  r.headers.get("location") === `https://planetcompute.ai/device/${D2}/local/`, r.headers.get("location"));
r = await go(`https://device.planetcompute.ai/device/${D}/local/?pcticket=u9.9999999999.deadbeef`);
ok("7 a forged ticket gives no cookie", r.status === 302 && !r.headers.get("set-cookie"), r.headers.get("set-cookie"));
r = await go(`https://device.planetcompute.ai/device/${D}/local/?pcticket=` + loc.split("pcticket=")[1].replace(/\.(\d+)\./, (_, e) => "." + (Number(e) - 1000) + "."));
ok("8 an altered (expired) ticket gives no cookie", r.status === 302 && !r.headers.get("set-cookie"), r.headers.get("set-cookie"));
for (const p of ["/", "/api/me", "/balance", "/admin", "/u/x/file"]) {
  r = await go("https://device.planetcompute.ai" + p, { headers: { cookie } });
  if (r.status !== 404) { ok("9 the device host serves nothing but device pages", false, p + " " + r.status); break; }
  if (p === "/u/x/file") ok("9 the device host serves nothing but device pages (/, /api/me, /balance, /admin, /u/...: 404)", true);
}
r = await go(`https://device.planetcompute.ai/device/${D}/local/models/delete`, { method: "POST", body: "{}", headers: { cookie, origin: "https://planetcompute.ai", "content-type": "application/json" } });
ok("10 a POST to the device from another origin (even planetcompute.ai) is refused", r.status === 403, r.status);
r = await go(`https://device.planetcompute.ai/device/${D}/local/big`, { headers: { cookie } });
ok("12 T3: a page from the computer larger than 4 MB is refused (502), not read into memory whole", r.status === 502, r.status);
globalThis.__signed = true;
const page = await (await go("https://planetcompute.ai/harness")).text(), site = await go("https://planetcompute.ai/");
ok("11 the site may frame only itself and the device host; the device frame is sandboxed (no top navigation)",
  /frame-src 'self' https:\/\/challenges\.cloudflare\.com https:\/\/device\.planetcompute\.ai;/.test(site.headers.get("content-security-policy") || "") &&
  /id="devFrame"[^>]*sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"/.test(page) && !/devFrame[^>]*allow-top-navigation/.test(page), null);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
