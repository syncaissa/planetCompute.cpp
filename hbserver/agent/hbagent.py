#!/usr/bin/env python3
"""planetCompute heartbeat-server agent (docs/HEARTBEAT_SERVERS.md).

Runs the heartbeat program (DIR/bin/hbserver) as its child and, every few seconds, reports to planetcompute.ai
(POST /api/hb/agent, signed with HB_SERVER_SECRET) and follows the admin page's orders for this server:
  Start / Restart   a new command number: done once (the program is (re)started)
  Stop              desired state "stopped": the program is stopped and stays stopped until Start or Restart
  "Restart automatically if it stops or crashes"   on: a crash or any stop that was not the admin's Stop is
                    restarted after 2 s; off: it stays down and is reported "crashed" with its exit code
When the agent itself starts (boot, hbctl start) the program is started unless the admin's last order was Stop.
Without an answer from the website the agent keeps the last orders it had (DIR/data/agent.json).
Everything stays in DIR (the folder that holds bin/, etc/, data/, logs/, run/). Standard library only.
"""
import hashlib, hmac, json, os, signal, subprocess, sys, time, urllib.error, urllib.request

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(D, "data", "agent.json")


def env_file(path):
    out = {}
    try:
        for line in open(path):
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    except FileNotFoundError:
        pass
    return out


CFG = env_file(os.path.join(D, "etc", "hbserver.env"))
SITE, SECRET, SID = CFG.get("HB_SITE", "https://planetcompute.ai").rstrip("/"), CFG.get("HB_SERVER_SECRET", ""), CFG.get("HB_SERVER_ID", "")
iso = lambda t=None: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def log(*a):
    print(iso(), *a, flush=True)


class Agent:
    def __init__(self):
        s = {"desired": "running", "auto": True, "done_seq": 0}
        try:
            s.update(json.load(open(STATE)))
        except Exception:
            pass
        self.desired, self.auto, self.done_seq = s["desired"], s["auto"], int(s["done_seq"])
        self.proc, self.since, self.restarts, self.last_exit, self.crashed = None, "", 0, "", False
        try:
            self.version = subprocess.run([os.path.join(D, "bin", "hbserver"), "--version"], capture_output=True, text=True, timeout=10).stdout.split()[-1]
        except Exception:
            self.version = ""

    def save(self):
        tmp = STATE + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"desired": self.desired, "auto": self.auto, "done_seq": self.done_seq}, f)
        os.replace(tmp, STATE)

    def start(self, why):
        if self.proc:
            return
        out = open(os.path.join(D, "logs", "hbserver.log"), "ab")
        out.write(f"== start {iso()} ({why})\n".encode())
        out.flush()
        self.proc = subprocess.Popen([os.path.join(D, "bin", "hbserver")], env={**os.environ, **CFG, "HOME": os.path.join(D, "data")},
                                     stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        self.since, self.crashed = iso(), False
        log("hbserver started", self.proc.pid, why)

    def stop(self, why):
        if not self.proc:
            return
        self.proc.terminate()
        try:
            self.proc.wait(10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        log("hbserver stopped", why)
        self.proc, self.since = None, ""

    def reap(self):
        """The program ended on its own (crash, or killed from outside)."""
        if self.proc and self.proc.poll() is not None:
            self.last_exit = f"code {self.proc.returncode} at {iso()}"
            log("hbserver ended by itself:", self.last_exit)
            self.proc, self.since, self.crashed = None, "", True

    def tunnel(self):
        try:
            os.kill(int(open(os.path.join(D, "run", "tunnel.pid")).read()), 0)
            return "running"
        except Exception:
            return "stopped"

    def report(self):
        state = "running" if self.proc else ("stopped" if self.desired == "stopped" else "crashed" if self.crashed else "stopped")
        body = json.dumps({"server_id": SID, "at": int(time.time()), "done_seq": self.done_seq, "hbserver": state,
                           "pid": self.proc.pid if self.proc else 0, "since": self.since, "restarts": self.restarts,
                           "last_exit": self.last_exit, "tunnel": self.tunnel(), "version": self.version})
        ts = str(int(time.time()))
        sig = hmac.new(SECRET.encode(), f"agent|{ts}|{body}".encode(), hashlib.sha256).hexdigest()
        req = urllib.request.Request(SITE + "/api/hb/agent", data=body.encode(), method="POST",
                                     headers={"content-type": "application/json", "x-hb-sig": f"{ts}.{sig}", "user-agent": "hbagent/1"})
        try:
            return json.loads(urllib.request.urlopen(req, timeout=20).read())
        except Exception as e:
            log("report failed (keeping the last orders):", str(e)[:200])
            return None

    def follow(self, o):
        changed = False
        if o.get("desired_state") in ("running", "stopped") and o["desired_state"] != self.desired:
            self.desired, changed = o["desired_state"], True
        if isinstance(o.get("auto_restart"), bool) and o["auto_restart"] != self.auto:
            self.auto, changed = o["auto_restart"], True
        seq = int(o.get("cmd_seq") or 0)
        if seq > self.done_seq:
            if o.get("cmd") in ("start", "restart"):
                if o["cmd"] == "restart" and self.proc:
                    self.stop("Restart on the admin page")
                    self.restarts += 1
                self.start(f"{o['cmd'].capitalize()} on the admin page")
            self.done_seq, changed = seq, True
        if changed:
            self.save()

    def run(self):
        signal.signal(signal.SIGTERM, lambda *a: (self.stop("agent stopped"), sys.exit(0)))
        if self.desired == "running":
            self.start("agent started")
        every, next_report = 15, 0
        while True:
            self.reap()
            if self.desired == "stopped":
                self.stop("Stop on the admin page")
            elif not self.proc and self.auto:
                time.sleep(2)
                self.restarts += 1
                self.start("restarted automatically")
            if time.time() >= next_report:
                o = self.report()
                if o:
                    self.follow(o)
                    every = max(5, min(60, int(o.get("every_s") or 15)))
                    if self.desired == "stopped":
                        self.stop("Stop on the admin page")
                next_report = time.time() + every
            time.sleep(1)


if __name__ == "__main__":
    if not SECRET or not SID:
        sys.exit("etc/hbserver.env needs HB_SERVER_SECRET and HB_SERVER_ID")
    Agent().run()
