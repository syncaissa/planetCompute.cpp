// docs/TESTING.md test 65: the site's SherpaHub broker (website/worker.js SherpaBroker), run for real in the local
// Cloudflare runtime: `cd scripts/sherpa_dev && cp ../../website/worker.js . && npx wrangler dev --port 8799`, then
// `node scripts/test_sherpa_broker.mjs [http://127.0.0.1:8799]`. Plays hubs and devices of several accounts.
const BASE = process.argv[2] || "http://127.0.0.1:8799";
const WS = BASE.replace(/^http/, "ws");
let pass = 0, fail = 0;
const ok = (c, what) => { if (c) { pass++; console.log("PASS", what); } else { fail++; console.log("FAIL", what); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAGIC = 0x50574350;

// a socket that records everything it receives
function open(path, q) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS}${path}?${new URLSearchParams(q)}`);
    ws.binaryType = "arraybuffer";
    const s = { ws, texts: [], bins: [], closed: null, opened: false };
    ws.onopen = () => { s.opened = true; resolve(s); };
    ws.onmessage = (e) => { if (typeof e.data === "string") s.texts.push(JSON.parse(e.data)); else s.bins.push(new Uint8Array(e.data)); };
    ws.onclose = (e) => { s.closed = e.code; resolve(s); };
    ws.onerror = () => {};
  });
}
async function until(f, ms = 3000) { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await sleep(20); } return false; }
function pcwp(kind, body) {            // a header + body (the broker only checks size and magic)
  const b = new Uint8Array(8 + body); const v = new DataView(b.buffer);
  v.setUint32(0, MAGIC, true); b[4] = kind; b[5] = 1;
  for (let i = 8; i < b.length; i++) b[i] = i & 255;
  return b;
}
const get = async (p) => (await fetch(BASE + p)).json();
const hubName = (u, d) => `sherpa:hub:${u}:${d}`;
const status = (h, o) => h.ws.send(JSON.stringify({ t: "status", job: 1, done: 0, total: 100, open: true, ...o }));

// 1. no hub: a device is refused, status says 0 hubs
let d0 = await open("/api/sherpa/device", { user: "dA", device: "a00000000001" });
ok(!d0.opened, "1. device refused while no SherpaHub runs");
ok((await get("/api/sherpa/status")).hubs === 0, "1. /api/sherpa/status: 0 hubs");

// 2. a hub connects; a device connects and says hello; the hub is introduced to it
const H1 = await open("/api/sherpa/hub", { user: "hub1", device: "h00000000001", key: "k1" });
ok(H1.opened, "2. hub connects");
status(H1);
await sleep(200);
ok((await get("/api/sherpa/status")).hubs === 1, "2. /api/sherpa/status: 1 hub");
const dA = await open("/api/sherpa/device", { user: "dA", device: "a00000000001" });
ok(dA.opened, "2. device connects");
dA.ws.send(JSON.stringify({ t: "hello", cache: 64 << 20, cores: 4, kernels: [2] }));
ok(await until(() => H1.texts.some((m) => m.t === "hello")), "2. hub gets the device's hello");
const helloA = H1.texts.find((m) => m.t === "hello");
ok(helloA && helloA.cache === 64 << 20 && helloA.cores === 4 && helloA.dev > 0, "2. hello carries dev id, cache, cores");
const devA = helloA.dev;

// 3. device -> hub: a PCWP message arrives prefixed with the device id; junk is dropped
dA.ws.send(pcwp(2, 100));
dA.ws.send(new Uint8Array(50));                       // bad magic
ok(await until(() => H1.bins.length >= 1), "3. hub gets the device's message");
await sleep(300);
const b0 = H1.bins[0], v0 = new DataView(b0.buffer, b0.byteOffset);
ok(H1.bins.length === 1 && v0.getUint32(0, true) === devA && v0.getUint32(4, true) === MAGIC && b0.length === 112, "3. prefixed with the device id, body untouched; bad magic dropped");

// 4. hub -> device: [dev][message] arrives as the message alone
const m4 = pcwp(4, 300), f4 = new Uint8Array(4 + m4.length); new DataView(f4.buffer).setUint32(0, devA, true); f4.set(m4, 4);
H1.ws.send(f4);
ok(await until(() => dA.bins.length === 1), "4. device gets the hub's message");
ok(dA.bins[0] && dA.bins[0].length === m4.length && dA.bins[0].every((x, i) => x === m4[i]), "4. bytes identical");

// 5. credit and strike are counted per account
H1.ws.send(JSON.stringify({ t: "credit", dev: devA, units: 7 }));
H1.ws.send(JSON.stringify({ t: "credit", dev: devA, units: 5 }));
H1.ws.send(JSON.stringify({ t: "strike", dev: devA }));
await sleep(300);
let cr = (await get(`/credits?hub=${encodeURIComponent(hubName("hub1", "h00000000001"))}`)).accounts.find((x) => x.user === "dA");
ok(cr && cr.units === 12 && cr.strikes === 1, "5. credits 12 units, 1 strike for account dA");

// 6. a newer connection of the same device replaces the old one; the hub hears gone + a new hello
const dA2 = await open("/api/sherpa/device", { user: "dA", device: "a00000000001" });
dA2.ws.send(JSON.stringify({ t: "hello", cache: 32 << 20, cores: 2 }));
ok(await until(() => dA.closed === 4000), "6. old connection closed 4000 (replaced)");
ok(await until(() => H1.texts.some((m) => m.t === "gone" && m.dev === devA)), "6. hub gets gone for the old device id");
ok(await until(() => H1.texts.filter((m) => m.t === "hello").length === 2), "6. hub gets the new connection's hello");
const devA2 = H1.texts.filter((m) => m.t === "hello")[1].dev;
ok(devA2 !== devA, "6. the new connection has a new device id (old packs cannot cross)");

// 7. ping is answered without the hub
dA2.ws.send('{"t":"ping"}');
ok(await until(() => dA2.texts.some((m) => m.t === "pong")), "7. ping -> pong");

// 8. the hub restarts: the new hub connection is introduced to the devices still here; a foreign key is refused
const Hx = await open("/api/sherpa/hub", { user: "hub1", device: "h00000000001", key: "OTHER" });
ok(!Hx.opened, "8. another copy of the program (other device key) cannot take the hub name");
const H1b = await open("/api/sherpa/hub", { user: "hub1", device: "h00000000001", key: "k1" });
ok(await until(() => H1.closed === 4000), "8. old hub connection closed 4000 (replaced)");
ok(await until(() => H1b.texts.some((m) => m.t === "hello" && m.dev === devA2)), "8. restarted hub gets hello for the waiting device");
ok(dA2.closed === null, "8. the device stayed connected through the hub restart");
status(H1b);

// 9. ban: the device is closed 4008 and cannot come back to this hub
H1b.ws.send(JSON.stringify({ t: "ban", dev: devA2 }));
ok(await until(() => dA2.closed === 4008), "9. banned device closed 4008");
const dA3 = await open("/api/sherpa/device", { user: "dA", device: "a00000000001" });
ok(!dA3.opened, "9. banned device refused on reconnect");

// 10. two hubs: new devices are spread; a hub with no open job gets none
const H2 = await open("/api/sherpa/hub", { user: "hub2", device: "h00000000002", key: "k2" });
status(H2);
await sleep(16000);                                    // hub1's room reports its device count again (at most every 15 s)
const ds = [];
for (let i = 0; i < 6; i++) { const d = await open("/api/sherpa/device", { user: "dB" + i, device: "b0000000000" + i }); d.ws.send(JSON.stringify({ t: "hello", cache: 1 << 20, cores: 1 })); ds.push(d); }
await sleep(500);
const n1 = H1b.texts.filter((m) => m.t === "hello" && m.dev !== devA2).length, n2 = H2.texts.filter((m) => m.t === "hello").length;
ok(n1 + n2 === 6 && Math.abs(n1 - n2) <= 1, `10. 6 devices spread over two hubs (${n1} + ${n2})`);
status(H2, { open: false });
await sleep(16000);                                    // the room tells the directory at most every 15 s
status(H2, { open: false });
await sleep(300);
const before2 = H2.texts.filter((m) => m.t === "hello").length;
const late = await open("/api/sherpa/device", { user: "dC", device: "c00000000001" });
late.ws.send(JSON.stringify({ t: "hello", cache: 1 << 20, cores: 1 }));
await sleep(500);
ok(H2.texts.filter((m) => m.t === "hello").length === before2, "10. a hub whose job is finished gets no new devices");

// 11. a device leaves: the hub hears gone; the hub leaves: its devices are closed 4010 and it is off the directory
const leaver = ds.find((d) => d.closed === null);
leaver.ws.close();
await sleep(300);
const gonesBefore = H1b.texts.filter((m) => m.t === "gone").length + H2.texts.filter((m) => m.t === "gone").length;
ok(gonesBefore >= 1, "11. hub gets gone when a device closes");
const onH2 = H2.texts.filter((m) => m.t === "hello").map((m) => m.dev);
H2.ws.close();
await sleep(500);
const dir = await get("/dir");
ok(!dir.hubs.some((h) => h.name === hubName("hub2", "h00000000002")), "11. a hub that left is off the directory");
ok(onH2.length === 0 || ds.filter((d) => d.closed === 4010).length >= 1, "11. its devices are closed 4010 (connect again for another hub)");

// 12. a message over 1 MiB is never relayed; the hub is not affected
const big = await open("/api/sherpa/device", { user: "dD", device: "d00000000001" });
big.ws.send(JSON.stringify({ t: "hello", cache: 1 << 20, cores: 1 }));
await sleep(200);
const hubBins = H1b.bins.length;
big.ws.send(pcwp(2, 1 << 20));
await until(() => big.closed !== null, 1500);         // the runtime may close the sender (1009); the broker drops it anyway
ok(H1b.closed === null && H1b.bins.length === hubBins, `12. over-1 MiB message: the hub receives nothing and stays connected (sender ${big.closed === null ? "still open" : "closed " + big.closed})`);

for (const s of [H1b, dA2, late, big, ...ds]) try { s.ws.close(); } catch (e) {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
