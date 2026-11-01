// Test-only Worker for the SherpaHub broker (docs/TESTING.md test 65): the REAL SherpaBroker class from the site
// (website/worker.js), with sign-in replaced by ?user=&device= so tests can play many accounts. Never deployed.
import { SherpaBroker } from "./worker.js";
export { SherpaBroker };
const stub = (env, n) => env.SHERPA.get(env.SHERPA.idFromName(n));
export default {
  async fetch(request, env) {
    const url = new URL(request.url), device = url.searchParams.get("device") || "000000000001", user = url.searchParams.get("user") || "u-" + device;
    const h = new Headers(request.headers); h.set("x-pc-user", user); h.set("x-pc-device", device);
    if (url.pathname === "/api/sherpa/status") return stub(env, "sherpa:dir").fetch("https://sherpa.internal/dir/count");
    if (url.pathname === "/dir") return stub(env, "sherpa:dir").fetch("https://sherpa.internal/dir/list");
    if (url.pathname === "/jobs" || url.pathname === "/jobs/add" || url.pathname === "/jobs/cancel" || url.pathname === "/hublog" || url.pathname === "/drain")   // the admin tab's calls, straight to a room
      return stub(env, url.searchParams.get("hub")).fetch(new Request("https://sherpa.internal" + url.pathname + url.search, { method: request.method, body: request.method === "POST" ? await request.text() : undefined }));
    if (url.pathname === "/credits") return stub(env, url.searchParams.get("hub")).fetch("https://sherpa.internal/credits");
    if (url.pathname === "/api/sherpa/hub") {
      h.set("x-pc-keyh", url.searchParams.get("key") || "k-" + device);
      return stub(env, `sherpa:hub:${user}:${device}`).fetch(new Request("https://sherpa.internal/hub", { headers: h }));
    }
    if (url.pathname === "/api/sherpa/device") {
      const kinds = String(url.searchParams.get("kinds") || "packs").split(",");
      h.set("x-pc-kinds", kinds.join(","));
      const pick = await (await stub(env, "sherpa:dir").fetch("https://sherpa.internal/dir/pick", { method: "POST", body: JSON.stringify({ kinds }) })).json();
      if (!pick.hub) return Response.json({ error: "No SherpaHub is running now." }, { status: 503 });
      return stub(env, pick.hub).fetch(new Request("https://sherpa.internal/device", { headers: h }));
    }
    return new Response("not found", { status: 404 });
  },
};
