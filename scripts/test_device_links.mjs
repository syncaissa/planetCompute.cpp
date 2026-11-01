// Test of deleting device links (TESTING.md test 23): runs the website Worker's own DeviceTunnel Durable Object code in
// Node with an in-memory storage and fake WebSockets. No keys needed.
//   node scripts/test_device_links.mjs <path to worker.js>
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

globalThis.WebSocketRequestResponsePair = class { constructor(a, b) { this.a = a; this.b = b; } };
const src = resolve(process.argv[2] || "website/worker.js");
const tmp = join(mkdtempSync(join(tmpdir(), "pclinks-")), "worker.mjs");
copyFileSync(src, tmp);
const { DeviceTunnel } = await import(tmp);

let fails = 0;
const check = (name, ok) => { console.log((ok ? "PASS " : "FAIL ") + name); if (!ok) fails++; };

// one Durable Object per name, each with its own storage and sockets (as Cloudflare keeps them)
const objects = new Map();
function state() {
  const store = new Map(), sockets = [];
  return {
    sockets,
    setWebSocketAutoResponse() {},
    getWebSockets: () => sockets,
    acceptWebSocket(ws) { sockets.push(ws); },
    storage: {
      get: async (k) => store.get(k),
      put: async (k, v) => { store.set(k, v); },
      delete: async (k) => store.delete(k),
      list: async ({ prefix }) => new Map([...store].filter(([k]) => k.startsWith(prefix))),
    },
  };
}
const env = {
  TUNNEL: {
    idFromName: (n) => n,
    get: (n) => {
      if (!objects.has(n)) { const st = state(); objects.set(n, { st, obj: new DeviceTunnel(st, env) }); }
      const o = objects.get(n).obj;
      return { fetch: (u, init) => o.fetch(new Request(typeof u === "string" ? u : u.url, init)) };
    },
  },
};
const list = env.TUNNEL.get("tunnels:u1");
const set = (d) => list.fetch("https://tunnel.internal/set", { method: "POST", body: JSON.stringify(d) });
const devices = async () => ((await (await list.fetch("https://tunnel.internal/list")).json()).devices || []).map((x) => x.device).sort();
const revoked = async (id) => (await (await list.fetch(`https://tunnel.internal/revoked?device=${id}`)).json()).revoked;

await set({ device: "aaaaaaaaaaaa", name: "pc1", online: true });
await set({ device: "bbbbbbbbbbbb", name: "pc2", online: false });
await set({ device: "cccccccccccc", name: "pc3", online: true });
check("three device links listed", JSON.stringify(await devices()) === JSON.stringify(["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"]));
check("no link deleted yet", !(await revoked("aaaaaaaaaaaa")));

await list.fetch("https://tunnel.internal/revoke", { method: "POST", body: JSON.stringify({ devices: ["aaaaaaaaaaaa"] }) });
check("Delete: the link is off the list", JSON.stringify(await devices()) === JSON.stringify(["bbbbbbbbbbbb", "cccccccccccc"]));
check("Delete: the link is marked deleted (connect answers 410)", await revoked("aaaaaaaaaaaa"));
check("the other links still work", !(await revoked("bbbbbbbbbbbb")));
await set({ device: "aaaaaaaaaaaa", name: "pc1", online: false });    // the disconnected program's "offline" note
check("a deleted link does not come back on the list", !(await devices()).includes("aaaaaaaaaaaa"));

// a computer connected with a link is disconnected with close code 4003 (its program then makes a new link)
const closed = [];
const t = env.TUNNEL.get("tunnel:u1:cccccccccccc");
objects.get("tunnel:u1:cccccccccccc").st.sockets.push({ readyState: 1, close: (code, why) => closed.push([code, why]), deserializeAttachment: () => ({}) });
await t.fetch("https://tunnel.internal/kick");
check("Delete: a connected computer is closed with 4003", closed.length === 1 && closed[0][0] === 4003);

// Delete all links
await list.fetch("https://tunnel.internal/revoke", { method: "POST", body: JSON.stringify({ devices: await devices() }) });
check("Delete all links: the list is empty", (await devices()).length === 0);
check("Delete all links: every link is refused", (await revoked("bbbbbbbbbbbb")) && (await revoked("cccccccccccc")));
await set({ device: "dddddddddddd", name: "pc3", online: true });       // the program's new link
check("a new link is listed and works", JSON.stringify(await devices()) === JSON.stringify(["dddddddddddd"]) && !(await revoked("dddddddddddd")));

console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
