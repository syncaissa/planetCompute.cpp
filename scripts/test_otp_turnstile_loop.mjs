import fs from "fs";
const file = process.argv[2];
const src = fs.readFileSync(file, "utf8");
const a = src.indexOf('  var suToken = "", suWidget = null'), b = src.indexOf("  function verifyCode()", a);
const snippet = src.slice(a, b).replace(/\\\\/g, "\\");     // page template doubles backslashes
function run(label, script) {
  const el = {}; const $ = (id) => (el[id] ||= { hidden: true, disabled: false, value: id === "authEmail" ? "a@b.co" : "", textContent: "", focus() {} });
  let calls = [], server = [];   // queued server answers
  let cb = null, removed = 0;
  const window = { pcTurnstile: (f) => f(), turnstile: {
    render: (_sel, o) => { cb = o; return "w1"; }, reset: () => {}, remove: () => { removed++; cb = null; } } };
  const api = (path, body) => { calls.push(body); const r = server.shift() || { ok: true, status: 200, data: { ok: true } }; return { then: (f) => f(r) }; };
  const say = () => {}, view = () => {}, startResendTimer = () => {}, setTimeout = () => {};
  const document = { documentElement: { getAttribute: () => "dark" } };
  const env = { document, $, window, api, say, view, startResendTimer, setTimeout };
  const f = new Function(...Object.keys(env), snippet + "\nreturn { sendCode, suCheck };");
  const api_ = f(...Object.values(env));
  script({ ...api_, fire: (t) => cb && cb.callback(t), server, calls, cbOpts: () => cb, removed: () => removed });
  console.log(label, "code requests:", calls.length, JSON.stringify(calls));
  return calls.length;
}
let fail = 0;
// A: user presses Send, site wants the check, check passes, then Turnstile renews 12 times (= 1 hour)
const nA = run("A renewals:", (t) => {
  t.server.push({ ok: false, status: 428, data: { need_turnstile: true, sitekey: "k", error: "check" } });
  t.sendCode();
  if (t.cbOpts()["refresh-expired"] !== "manual") { console.log("FAIL refresh-expired not manual"); fail++; }
  t.fire("tok1");                          // the pass -> one send
  for (let i = 0; i < 12; i++) t.fire("tok" + (i + 2));   // renewals must send nothing
});
if (nA !== 2) { console.log("FAIL A expected 2 (the 428 one + one real send)"); fail++; }
// B: Resend after success: site asks again, one more send only
const nB = run("B resend:", (t) => {
  t.server.push({ ok: false, status: 428, data: { need_turnstile: true, sitekey: "k", error: "check" } });
  t.sendCode(); t.fire("x1");
  t.server.push({ ok: false, status: 428, data: { need_turnstile: true, sitekey: "k", error: "check" } });
  t.sendCode(); t.fire("x2"); t.fire("x3"); t.fire("x4");
});
if (nB !== 4) { console.log("FAIL B expected 4"); fail++; }
console.log(fail ? "FAILED" : "ALL PASS");
process.exit(fail ? 1 : 0);
