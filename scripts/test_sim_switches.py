"""docs/TESTING.md test 87 (user 2026-10-30: "since we have sherpahub do we need generouscow and hungry wolf - make sherpahub do
both"): the server agent (workhorse/whagent.py) of an in-house SherpaHub row. SupplySimulation: its copies start as
SherpaHubs that also contribute (--sherpahub --contribute --cores N --cap P), and switching it restarts them.
DemandSimulation: the agent sends test jobs at the row's rates to a stand-in website (no real site): chat jobs to /v1/jobs and
pictures to /api/pool/media, every one "priority low", signed in with the row's session, today's numbers kept; off = none.
    python3 -I scripts/test_sim_switches.py
"""
import http.server, importlib.util, json, os, sys, tempfile, threading, time
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("whagent", os.path.join(here, "..", "workhorse", "whagent.py"))
wa = importlib.util.module_from_spec(spec); spec.loader.exec_module(wa)
ok_n = bad = 0
def ok(name, cond, extra=""):
    global ok_n, bad
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  {extra}")); ok_n += bool(cond); bad += (not cond)

# a folder of its own for the agent (its state, logs) and no real program: Popen is recorded, not run
tmp = tempfile.mkdtemp(prefix="sim-"); wa.D = tmp; wa.STATE = os.path.join(tmp, "data", "agent.json"); wa.SESSION = os.path.join(tmp, "data", "session.json")
for d in ("data", "logs", "run"): os.makedirs(os.path.join(tmp, d), exist_ok=True)
started = []
class FakeProc:
    pid = 4242
    def poll(self): return None
    def terminate(self): pass
    def wait(self, t=None): return 0
wa.subprocess.Popen = lambda cmd, **k: (started.append(cmd), FakeProc())[1]
wa.subprocess.run = lambda *a, **k: type("R", (), {"stdout": "planetCompute 0.1.0"})()

# the stand-in website: what the agent sends
seen = []
class Site(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        seen.append((self.path, body, self.headers.get("cookie", ""), self.headers.get("user-agent", "")))
        out = {"choices": [{"message": {"content": "ok"}}], "grid": {"device": "d1", "agree": True}} if self.path == "/v1/jobs" else {"ok": True, "hub": "h", "job": "j"}
        b = json.dumps(out).encode(); self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Site); threading.Thread(target=srv.serve_forever, daemon=True).start()
wa.SITE = f"http://127.0.0.1:{srv.server_address[1]}"

a = wa.Agent(); a.token = lambda: "TOK"
base = {"desired_state": "running", "auto_restart": True, "role": "sherpahub", "instances": 1, "cores": 3, "cap": 60}
a.follow(dict(base, supply=False)); a.start_all("test")
ok("1 SupplySimulation off: the copy starts as a SherpaHub only (no --contribute)", started and "--sherpahub" in started[-1] and "--contribute" not in started[-1], started[-1:])
n0 = len(started); a.follow(dict(base, supply=True))
ok("2 switching SupplySimulation on stops the copy (to start again)", a.supply is True and not a.copies[0].proc, a.supply)
a.start_all("test")
cmd = started[-1] if len(started) > n0 else []
ok("3 SupplySimulation on: --sherpahub --contribute --cores 3 --cap 60 (it organises AND contributes, as the cows did)",
   "--sherpahub" in cmd and cmd[cmd.index("--contribute"):cmd.index("--contribute") + 5] == ["--contribute", "--cores", "3", "--cap", "60"], cmd)
a.follow(dict(base, role="", supply=True))
ok("4 a regular (non-SherpaHub) row never gets SupplySimulation", a.supply is False)
a.follow(dict(base, supply=True))
ok("5 the settings are kept on disk (agent.json: supply)", json.load(open(wa.STATE)).get("supply") is True)

# DemandSimulation: 3600 chat jobs an hour (about one a second) and 2 pictures a day, for a few seconds
a.follow(dict(base, supply=True, demand={"chat_per_hour": 3600, "images_per_day": 2, "model": "qwen2.5-0.5b-q4km", "image_model": "zimage-turbo-q4k"}))
a.demand_run.start(); time.sleep(7)
chats = [s for s in seen if s[0] == "/v1/jobs"]; pics = [s for s in seen if s[0] == "/api/pool/media"]
ok("6 DemandSimulation on: chat jobs at about the rate set (3 to 14 in 7 s at 3,600 an hour)", 3 <= len(chats) <= 14, len(chats))
ok("7 every test job is 'priority low', signed in with the row's session, from the agent", all(s[1].get("priority") == "low" and s[2] == "pc_session=TOK" and s[3].startswith("whagent-demand") for s in chats + pics))
ok("8 chat jobs: the model set and a short prompt", all(s[1]["model"] == "qwen2.5-0.5b-q4km" and s[1]["messages"][0]["content"] in wa.DEMAND_PROMPTS for s in chats))
ok("9 pictures: one now, the next only after half a day (2 a day), the picture model set", len(pics) == 1 and pics[0][1]["model"] == "zimage-turbo-q4k" and pics[0][1]["task"] == "image", len(pics))
st = a.demand_run.stats
ok("10 today's numbers for the tab: chat sent / answered, pictures asked", st["chat_sent"] >= len(chats) - 1 and st["chat_ok"] >= 3 and st["images_sent"] == 1 and st["day"] == time.strftime("%Y-%m-%d", time.gmtime()), st)
ok("11 one line per job in logs/demand.jsonl", sum(1 for _ in open(os.path.join(tmp, "logs", "demand.jsonl"))) >= 4)
a.follow(dict(base, supply=True, demand=None)); time.sleep(1.5); n1 = len(seen); time.sleep(3)
ok("12 DemandSimulation off: no more test jobs", len(seen) == n1, len(seen) - n1)
a.follow(dict(base, supply=True, demand={"chat_per_hour": 3600}, desired_state="stopped")); time.sleep(1.5); n2 = len(seen); time.sleep(3)
ok("13 the row stopped on the admin page: no test jobs either", len(seen) == n2, len(seen) - n2)
srv.shutdown()
print(f"\n{ok_n} passed, {bad} failed"); sys.exit(1 if bad else 0)
