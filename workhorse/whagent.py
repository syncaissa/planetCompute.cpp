#!/usr/bin/env python3
"""planetCompute workhorse agent (docs/WORKHORSES.md).

Runs 1-6 copies of the planetCompute server program (DIR/bin/planetCompute, the build without a window) that share
this machine's compute with the PlanetCompute pool, and every few seconds reports to planetcompute.ai
(POST /api/wh/agent, signed with HB_SERVER_SECRET) and follows the admin page (tab Workhorses):
  Start / Restart      a new command number: done once (every copy is (re)started)
  Stop                 desired state "stopped": every copy stops and stays stopped until Start or Restart
  copies, cores, cap   from the row: the copies are started or stopped to match, and restarted when cores or cap change
  restart a copy that stops (checkbox)   a copy that ends by itself is started again after 2 s
Each copy N (1-6) has its own HOME (DIR/data/iN: its own device ID and sign-in) and its own port (7530 + N), and is
signed in as the row's account: the agent asks the website for a sign-in (POST /api/wh/session) and renews it weekly.
Without an answer from the website the agent keeps the last orders it had (DIR/data/agent.json).
Update to newest build (admin tab SherpaHubs): the newest server build from planetcompute.ai/download/latest.json,
its SHA-256 checked, swapped in, the copies restarted. Models: every minute each copy's models are reported (from its
local API, with its own key); download / delete orders from the tab are carried out the same way.
Role "sherpahub" on the row (admin tab SherpaHubs): up to 5 copies, each started as a SherpaHub (--sherpahub): it takes
the jobs given on the tab from its room on the site (docs/SHERPAHUB.md section 11). Two switches on the row (paper
sec:inhouse; the computing is real, only the users are simulated):
  SupplySimulation   the copies also contribute (--contribute --cores --cap), as the generous cows did: pool chat,
                     pool pictures (as a device of a SherpaHub), grid work
  DemandSimulation   this agent sends test jobs, as the hungry wolves did: chat jobs an hour (POST /v1/jobs) and pictures
                     a day (POST /api/pool/media), all "priority low": behind every real user, not counted in any limit,
                     marked as test. Today's numbers go to the tab; one line per job in logs/demand.jsonl.
Everything stays in DIR (bin/, etc/, data/, logs/, run/). Standard library only.
"""
import base64
import hashlib, hmac, json, os, random, signal, subprocess, sys, threading, time, urllib.request, urllib.error

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE, SESSION = os.path.join(D, "data", "agent.json"), os.path.join(D, "data", "session.json")
BIN, MAX, PORT0, RENEW_S = os.path.join(D, "bin", "planetCompute"), 6, 7530, 7 * 86400
iso = lambda t=None: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


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


CFG = env_file(os.path.join(D, "etc", "workhorse.env"))
SITE, SECRET, SID = CFG.get("WH_SITE", "https://planetcompute.ai").rstrip("/"), CFG.get("HB_SERVER_SECRET", ""), CFG.get("WH_SERVER_ID", "")


def log(*a):
    print(iso(), *a, flush=True)


def signed(path, what, body):
    """POST a body signed '<what>|<ts>|<body>' to the website; its JSON answer, or None."""
    raw, ts = json.dumps(body), str(int(time.time()))
    sig = hmac.new(SECRET.encode(), f"{what}|{ts}|{raw}".encode(), hashlib.sha256).hexdigest()
    req = urllib.request.Request(SITE + path, data=raw.encode(), method="POST",
                                 headers={"content-type": "application/json", "x-wh-sig": f"{ts}.{sig}", "user-agent": "whagent/1"})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=20).read())
    except Exception as e:
        log(path, "failed:", str(e)[:200])
        return None



# Signed releases (security issue 2, 2026-10-30): a build is installed only with an Ed25519 signature of
# "planetCompute release|<sha256>" made by PlanetCompute's release key (kept offline, never on the website or in B2), so
# someone who could change the downloads or the site still cannot push their own program to the servers.
RELEASE_PUBKEY = base64.b64decode("bKDl4tSPBczPVVFT0I17coFKVUn3c7TwA4KJC0uIPgY=")


def ed25519_verify(pk, msg, sig):
    """RFC 8032 Ed25519 verification in plain Python (no extra library on the server)."""
    p = 2 ** 255 - 19
    L = 2 ** 252 + 27742317777372353535851937790883648493
    d = -121665 * pow(121666, p - 2, p) % p
    I = pow(2, (p - 1) // 4, p)

    def xrecover(y, sign):
        xx = (y * y - 1) * pow(d * y * y + 1, p - 2, p) % p
        x = pow(xx, (p + 3) // 8, p)
        if (x * x - xx) % p:
            x = x * I % p
        if (x * x - xx) % p:
            raise ValueError("not a point")
        if (x & 1) != sign:
            x = p - x
        return x

    def add(P, Q):
        (X1, Y1, Z1, T1), (X2, Y2, Z2, T2) = P, Q
        A = (Y1 - X1) * (Y2 - X2) % p
        B = (Y1 + X1) * (Y2 + X2) % p
        C = T1 * 2 * d * T2 % p
        D = Z1 * 2 * Z2 % p
        E, F, G, H = B - A, D - C, D + C, B + A
        return (E * F % p, G * H % p, F * G % p, E * H % p)

    def mul(s, P):
        Q = (0, 1, 1, 0)
        while s:
            if s & 1:
                Q = add(Q, P)
            P = add(P, P)
            s >>= 1
        return Q

    def decode(b):
        y = int.from_bytes(b, "little") & ((1 << 255) - 1)
        if y >= p:
            raise ValueError("bad point")
        x = xrecover(y, b[31] >> 7)
        return (x, y, 1, x * y % p)

    def encode(P):
        X, Y, Z, _ = P
        zi = pow(Z, p - 2, p)
        x, y = X * zi % p, Y * zi % p
        return (y | ((x & 1) << 255)).to_bytes(32, "little")

    try:
        if len(pk) != 32 or len(sig) != 64:
            return False
        s = int.from_bytes(sig[32:], "little")
        if s >= L:
            return False
        By = 4 * pow(5, p - 2, p) % p
        B = (xrecover(By, 0), By, 1, xrecover(By, 0) * By % p)
        h = int.from_bytes(hashlib.sha512(sig[:32] + pk + msg).digest(), "little") % L
        return encode(mul(s, B)) == encode(add(decode(sig[:32]), mul(h, decode(pk))))
    except (ValueError, TypeError):
        return False


class Copy:
    """One planetCompute copy: its own HOME, port, log and sign-in."""

    def __init__(self, i):
        self.i, self.port, self.home = i, int(CFG.get("WH_PORT0") or PORT0) + i, os.path.join(D, "data", f"i{i}")
        self.proc, self.since, self.restarts, self.last_exit, self.crashed = None, "", 0, "", False
        self.model_list = None

    def cfg(self, name):
        return os.path.join(self.home, ".config", "planetCompute", name)

    def local(self, path, body=None, timeout=20):
        """This copy's local API (127.0.0.1, its own key); the JSON answer or None."""
        try:
            tok = open(self.cfg("local_token")).read().strip()
            req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=json.dumps(body).encode() if body is not None else None,
                                         method="POST" if body is not None else "GET",
                                         headers={"authorization": "Bearer " + tok, "content-type": "application/json"})
            return json.loads(urllib.request.urlopen(req, timeout=timeout).read())
        except urllib.error.HTTPError as e:
            try:
                return {"error": json.loads(e.read()).get("error", str(e))}
            except Exception:
                return {"error": str(e)}
        except Exception as e:
            return None

    def models(self):
        """[[id, percent], ...] of this copy's models (100 = ready), or None if it does not answer."""
        a = self.local("/local/models")
        if not a or "downloaded" not in a:
            return None
        out = []
        for m in a["downloaded"][:30]:
            b = m.get("bytes") or 0
            pct = 100 if (b and (m.get("done") or m.get("disk") or 0) >= b) or m.get("installed") else int(100 * (m.get("done") or 0) / b) if b else 0
            out.append([str(m.get("id", ""))[:80], min(100, pct)] + ([str(m["error"])[:60]] if m.get("error") else []))
        return out

    def device(self):
        try:
            return open(self.cfg("device_id")).read().strip()[:12]
        except Exception:
            return ""

    def start(self, token, cores, cap, why, role="", supply=False):
        if self.proc:
            return
        os.makedirs(os.path.dirname(self.cfg("session")), exist_ok=True)
        if token:                                            # the copy signs in with this at start
            with open(os.open(self.cfg("session"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
                f.write(token)
        lp = os.path.join(D, "logs", f"i{self.i}.log")
        if os.path.exists(lp) and os.path.getsize(lp) > 50 * 2**20:       # keep the last 5 MB of a big log
            data = open(lp, "rb").read()[-5 * 2**20:]
            open(lp, "wb").write(data)
        out = os.fdopen(os.open(lp, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600), "ab")   # security review P4: owner only
        try:
            os.chmod(lp, 0o600)                                # logs made before this change too
        except OSError:
            pass
        out.write(f"== start {iso()} ({why}) {('SherpaHub + SupplySimulation, cores ' + str(cores) + ' cap ' + str(cap)) if role == 'sherpahub' and supply else 'SherpaHub' if role == 'sherpahub' else f'cores {cores} cap {cap}'}\n".encode())
        out.flush()
        env = {k: v for k, v in os.environ.items() if not k.startswith("XDG_")}
        env["HOME"] = self.home
        env["PLANETCOMPUTE_IMAGE_LOCK"] = os.path.join(D, "run", "image.lock")   # one picture at a time in this folder
        if role == "sherpahub":                              # it ORGANISES work; with SupplySimulation it also contributes
            cmd = [BIN, "--headless", "--port", str(self.port), "--sherpahub"] + (["--contribute", "--cores", str(cores), "--cap", str(cap)] if supply else [])
        else:
            cmd = [BIN, "--headless", "--port", str(self.port), "--contribute", "--cores", str(cores), "--cap", str(cap)]
        self.proc = subprocess.Popen(cmd, env=env, cwd=self.home, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
        self.since, self.crashed = iso(), False
        log(f"copy {self.i} started (pid {self.proc.pid}, port {self.port}, {why})")

    def stop(self, why):
        if not self.proc:
            return
        self.proc.terminate()
        try:
            self.proc.wait(15)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        log(f"copy {self.i} stopped ({why})")
        self.proc, self.since = None, ""

    def reap(self):
        if self.proc and self.proc.poll() is not None:
            self.last_exit = f"code {self.proc.returncode} at {iso()}"
            log(f"copy {self.i} ended by itself: {self.last_exit}")
            self.proc, self.since, self.crashed = None, "", True

    def state(self, desired):
        return "running" if self.proc else "stopped" if desired == "stopped" else "crashed" if self.crashed else "stopped"


# DemandSimulation: the hungry wolves' work, inside the agent of an in-house SherpaHub
DEMAND_PROMPTS = ["Name one planet of the solar system and say one fact about it.", "What is 17 times 23? Answer with the number.",
                  "Write a haiku about sharing computers.", "Give three uses of a spare laptop.", "Translate 'good morning' into French and Spanish.",
                  "In one sentence: why is the sky blue?", "List the first five prime numbers.", "Suggest a name for a friendly robot.",
                  "What is the capital of Japan?", "Explain a Work Unit to a child in one sentence."]
DEMAND_PICTURES = ["A red fox in fresh snow, morning light", "A lighthouse on a cliff at dusk, soft clouds", "A bowl of ramen, top-down food photograph",
                   "A hot air balloon over green hills at sunrise", "A cozy reading nook by a rainy window"]
DEMAND_PARALLEL = 8                                         # chat jobs under way at once, at most


class Demand(threading.Thread):
    """Sends test jobs at the rates on the row while DemandSimulation is on (and the row is not stopped)."""

    def __init__(self, agent):
        super().__init__(daemon=True)
        self.agent, self.active, self.lock = agent, 0, threading.Lock()
        self.next_chat = self.next_image = 0.0
        self.stats = {"day": "", "chat_sent": 0, "chat_ok": 0, "chat_failed": 0, "images_sent": 0, "images_failed": 0, "last_error": ""}

    def count(self, k, err=""):
        with self.lock:
            self.stats[k] = self.stats.get(k, 0) + 1
            if err:
                self.stats["last_error"] = err[:120]

    def post(self, path, body, timeout):
        tok = self.agent.token()
        req = urllib.request.Request(SITE + path, data=json.dumps(body).encode(), method="POST",
                                     headers={"content-type": "application/json", "cookie": f"pc_session={tok}", "user-agent": "whagent-demand/1"})
        try:
            r = urllib.request.urlopen(req, timeout=timeout)
            return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read() or b"{}")
            except Exception:
                return e.code, {}
        except Exception as e:
            return 0, {"error": {"message": str(e)[:200]}}

    def note(self, row):
        lp = os.path.join(D, "logs", "demand.jsonl")
        try:
            with open(lp, "a") as f:
                f.write(json.dumps(row) + "\n")
            if os.path.getsize(lp) > 20 << 20:                   # keep the last part
                data = open(lp, "rb").read()[-(5 << 20):]
                open(lp, "wb").write(data[data.find(b"\n") + 1:])
        except Exception:
            pass

    def chat(self, cfg):
        t0 = time.time()
        status, a = self.post("/v1/jobs", {"model": cfg.get("model") or "qwen2.5-0.5b-q4km", "max_tokens": 64, "priority": "low",
                                           "messages": [{"role": "user", "content": random.choice(DEMAND_PROMPTS)}]}, 330)
        err = "" if status == 200 else f"chat {status}: " + str((a.get("error") or {}).get("message", ""))
        self.count("chat_ok" if status == 200 else "chat_failed", err)
        g = a.get("grid") or {}
        self.note({"at": iso(), "kind": "chat", "status": status, "ms": int((time.time() - t0) * 1000), "device": g.get("device", ""),
                   "agree": g.get("agree"), "error": err})
        with self.lock:
            self.active -= 1

    def image(self, cfg):
        status, a = self.post("/api/pool/media", {"task": "image", "model": cfg.get("image_model") or "zimage-turbo-q4k", "prompt": random.choice(DEMAND_PICTURES),
                                                  "width": 512, "height": 512, "priority": "low"}, 60)
        err = "" if status == 200 else f"picture {status}: " + str((a.get("error") or {}).get("message", ""))
        if err:
            self.count("images_failed", err)
        self.note({"at": iso(), "kind": "image", "status": status, "job": a.get("job", ""), "hub": a.get("hub", ""), "error": err})

    def run(self):
        while True:
            try:
                day = time.strftime("%Y-%m-%d", time.gmtime())
                if self.stats["day"] != day:
                    with self.lock:
                        self.stats = {"day": day, "chat_sent": 0, "chat_ok": 0, "chat_failed": 0, "images_sent": 0, "images_failed": 0, "last_error": ""}
                cfg = self.agent.demand if self.agent.role == "sherpahub" and self.agent.desired == "running" else None
                now = time.time()
                if cfg:
                    cph, ipd = int(cfg.get("chat_per_hour") or 0), int(cfg.get("images_per_day") or 0)
                    if cph > 0 and now >= self.next_chat and self.active < DEMAND_PARALLEL:
                        self.next_chat = now + random.uniform(0.5, 1.5) * 3600 / cph   # on average cph an hour
                        with self.lock:
                            self.active += 1
                        self.count("chat_sent")
                        threading.Thread(target=self.chat, args=(cfg,), daemon=True).start()
                    if ipd > 0 and now >= self.next_image and self.stats.get("images_sent", 0) < ipd:
                        self.next_image = now + 86400 / ipd
                        self.count("images_sent")
                        self.image(cfg)
            except Exception as e:
                log("DemandSimulation error:", str(e)[:200])
            time.sleep(1)


class Agent:
    def __init__(self):
        s = {"desired": "running", "auto": True, "done_seq": 0, "instances": 1, "cores": 0, "cap": 100, "role": "", "model_seq": 0, "supply": False, "demand": None}
        try:
            s.update(json.load(open(STATE)))
        except Exception:
            pass
        self.desired, self.auto, self.done_seq = s["desired"], s["auto"], int(s["done_seq"])
        self.n, self.cores_set, self.cap, self.role = int(s["instances"]), int(s["cores"]), int(s["cap"]), str(s.get("role") or "")
        self.model_seq, self.model_last, self.update_last, self.models_at = int(s.get("model_seq") or 0), {}, {}, 0
        self.supply, self.demand = bool(s.get("supply")), s.get("demand") if isinstance(s.get("demand"), dict) else None
        self.token_lock = threading.Lock()
        self.demand_run = Demand(self)
        self.copies = [Copy(i) for i in range(1, MAX + 1)]
        self.session = {}
        try:
            self.session = json.load(open(SESSION))
        except Exception:
            pass
        try:
            self.version = subprocess.run([BIN, "--version"], capture_output=True, text=True, timeout=20).stdout.split()[1]
        except Exception:
            self.version = ""

    def save(self):
        tmp = STATE + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"desired": self.desired, "auto": self.auto, "done_seq": self.done_seq, "instances": self.n, "cores": self.cores_set, "cap": self.cap, "role": self.role,
                       "model_seq": self.model_seq, "supply": self.supply, "demand": self.demand}, f)
        os.replace(tmp, STATE)

    def cores(self):
        # empty on the row: half the machine, shared between the copies (it is somebody else's server too)
        return self.cores_set if self.cores_set > 0 else max(1, (os.cpu_count() or 2) // (2 * max(1, self.n)))

    def token(self):
        """The sign-in for the copies; a new one from the website when there is none or it is a week old."""
        with self.token_lock:
            return self._token()

    def _token(self):
        if self.session.get("token") and time.time() - self.session.get("at", 0) < RENEW_S:
            return self.session["token"]
        a = signed("/api/wh/session", "whsession", {"server_id": SID})
        if a and a.get("token"):
            self.session = {"token": a["token"], "at": int(time.time()), "account": a.get("account_email", "")}
            fd = os.open(SESSION, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump(self.session, f)
            log("new sign-in for", self.session["account"] or "the row's account")
            for c in self.copies:                               # the copies read it at start
                if c.proc:
                    c.stop("new sign-in")
        return self.session.get("token", "")

    def start_all(self, why):
        tok = self.token()
        for c in self.copies[: self.n]:
            c.start(tok, self.cores(), self.cap, why, self.role, self.supply)

    def stop_all(self, why, only_extra=False):
        for c in self.copies[(self.n if only_extra else 0):]:
            c.stop(why)

    def version_of_bin(self):
        try:
            return subprocess.run([BIN, "--version"], capture_output=True, text=True, timeout=20).stdout.split()[1]
        except Exception:
            return ""

    def update(self):
        return self._update()

    def _update(self):
        """Update to newest build: download, check the SHA-256, swap in, restart the copies."""
        try:
            lat = json.loads(urllib.request.urlopen(urllib.request.Request(SITE + "/download/latest.json", headers={"user-agent": "whagent/1"}), timeout=30).read())
            b = lat["builds"]["linux-server"]
            # security review P3: the v2 signature also covers the build time and the platform; once a v2-signed build is
            # installed (its build time is kept beside the program), only v2-signed builds that are not older are taken
            bt = int(b.get("build_time") or 0)
            try:
                have_bt = int(open(BIN + ".build_time").read().strip() or 0)
            except Exception:
                have_bt = 0
            if b.get("sig2"):
                ok = ed25519_verify(RELEASE_PUBKEY, f"planetCompute release v2|{b['sha256']}|{bt}|linux-server".encode(), base64.b64decode(b.get("sig2") or ""))
            else:
                ok = not have_bt and ed25519_verify(RELEASE_PUBKEY, f"planetCompute release|{b['sha256']}".encode(), base64.b64decode(b.get("sig") or ""))
            if not ok:
                self.update_last = {"at": iso(), "result": "FAILED: the build is not signed by PlanetCompute's release key (nothing changed)"}
                log("update refused: no valid release signature")
                return
            if have_bt and bt < have_bt:
                self.update_last = {"at": iso(), "result": "FAILED: the offered build is older than the one installed (nothing changed)"}
                log("update refused: older build", bt, "<", have_bt)
                return
            have = hashlib.sha256(open(BIN, "rb").read()).hexdigest()
            if have == b["sha256"]:
                if b.get("sig2") and bt and not have_bt:          # start the rollback protection on this build too (P3)
                    with open(BIN + ".build_time", "w") as f:
                        f.write(str(bt))
                self.update_last = {"at": iso(), "result": "already the newest build", "commit": lat.get("commit", "")[:7]}
                return
            tmp = BIN + ".new"
            h = hashlib.sha256()
            with urllib.request.urlopen(urllib.request.Request(SITE + b["url"], headers={"user-agent": "whagent/1"}), timeout=600) as r, open(tmp, "wb") as f:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    h.update(chunk)
                    f.write(chunk)
            if h.hexdigest() != b["sha256"]:
                os.remove(tmp)
                self.update_last = {"at": iso(), "result": "FAILED: the download's SHA-256 does not match (nothing changed)"}
                return
            os.chmod(tmp, 0o755)
            for c in self.copies:
                c.stop("update to the newest build")
            os.replace(tmp, BIN)
            if b.get("sig2") and bt:
                with open(BIN + ".build_time", "w") as f:
                    f.write(str(bt))
            self.version = self.version_of_bin()
            self.update_last = {"at": iso(), "result": "updated", "commit": lat.get("commit", "")[:7], "sha256": b["sha256"][:16]}
            log("updated to", lat.get("commit", "")[:7])
        except Exception as e:
            self.update_last = {"at": iso(), "result": "FAILED: " + str(e)[:150]}
            log("update failed:", e)

    def model_order(self, cmd):
        """Download or delete a model on the copies named (all running copies when none)."""
        act, mid, which = cmd.get("action"), str(cmd.get("model") or ""), cmd.get("copies") or []
        res = {}
        for c in self.copies[: self.n]:
            if which and c.i not in which:
                continue
            if not c.proc:
                res[str(c.i)] = "not running"
                continue
            a = c.local("/local/models/download" if act == "download" else "/local/models/delete", {"id": mid}, timeout=60)
            res[str(c.i)] = "started" if act == "download" and a and not a.get("error") else "deleted" if a and not a.get("error") else (a or {}).get("error", "no answer")[:80]
        self.model_last = {"seq": self.model_seq, "at": iso(), "action": act, "model": mid, "results": res}
        self.models_at = 0                                   # report the models again at once
        log("models:", act, mid, res)

    def report(self):
        if time.time() - self.models_at > 60:               # each copy's models, every minute
            self.models_at = time.time()
            for c in self.copies[: self.n]:
                c.model_list = c.models() if c.proc else None
        inst = [{"i": c.i, "state": c.state(self.desired), "pid": c.proc.pid if c.proc else 0, "port": c.port, "since": c.since,
                 "restarts": c.restarts, "last_exit": c.last_exit, "device": c.device(), "models": c.model_list} for c in self.copies[: self.n]]
        load = " ".join(f"{x:.2f}" for x in os.getloadavg())
        return signed("/api/wh/agent", "workhorse", {"server_id": SID, "at": int(time.time()), "done_seq": self.done_seq, "instances": inst,
                                                      "version": self.version, "cores_total": os.cpu_count() or 0, "load": load,
                                                      "model_last": self.model_last, "update_last": self.update_last,
                                                      "supply": self.supply, "demand": self.demand_run.stats if self.demand else None})

    def follow(self, o):
        changed, again = False, False
        if o.get("desired_state") in ("running", "stopped") and o["desired_state"] != self.desired:
            self.desired, changed = o["desired_state"], True
        if isinstance(o.get("auto_restart"), bool) and o["auto_restart"] != self.auto:
            self.auto, changed = o["auto_restart"], True
        role = "sherpahub" if o.get("role") == "sherpahub" else ""
        if role != self.role:                                 # the copies start again in their new role
            self.role, changed, again = role, True, True
        n = max(1, min(5 if self.role == "sherpahub" else MAX, int(o.get("instances") or 1)))
        if n != self.n:
            self.n, changed = n, True
            self.stop_all("fewer copies on the admin page", only_extra=True)
        supply = self.role == "sherpahub" and o.get("supply") is True
        if supply != self.supply:                             # the copies start again with or without contributing
            self.supply, changed, again = supply, True, True
        demand = o.get("demand") if self.role == "sherpahub" and isinstance(o.get("demand"), dict) else None
        if demand != self.demand:
            self.demand, changed = demand, True
            log("DemandSimulation", "off" if not demand else f"on: {demand.get('chat_per_hour', 0)} chat jobs an hour, {demand.get('images_per_day', 0)} pictures a day")
        cores, cap = int(o.get("cores") or 0), max(10, min(100, int(o.get("cap") or 100)))
        if (cores, cap) != (self.cores_set, self.cap):
            self.cores_set, self.cap, changed, again = cores, cap, True, True
        seq = int(o.get("cmd_seq") or 0)
        if seq > self.done_seq:
            if o.get("cmd") == "restart":
                again = True
            self.done_seq, changed = seq, True
            if o.get("cmd") == "update":                      # the copies start again on the new build (below)
                self.save()
                self.update()
        mseq = int(o.get("model_seq") or 0)
        if mseq > self.model_seq and isinstance(o.get("model_cmd"), dict):
            self.model_seq, changed = mseq, True
            self.save()
            self.model_order(o["model_cmd"])
        if again:
            for c in self.copies:
                if c.proc:
                    c.stop("Restart (or new cores / cap) on the admin page")
                    c.restarts += 1
        if changed:
            self.save()

    def run(self):
        signal.signal(signal.SIGTERM, lambda *a: (self.stop_all("agent stopped"), sys.exit(0)))
        self.demand_run.start()
        o = self.report()                       # the admin's orders first (copies, cores, cap, Stop), then start
        if o:
            self.follow(o)
        if self.desired == "running":
            self.start_all("agent started")
        every, next_report = 15, time.time() + 15
        while True:
            for c in self.copies:
                c.reap()
            if self.desired == "stopped":
                self.stop_all("Stop on the admin page")
            else:
                for c in self.copies[: self.n]:
                    if not c.proc and (self.auto or not c.crashed):
                        if c.crashed:
                            time.sleep(2)
                            c.restarts += 1
                        c.start(self.token(), self.cores(), self.cap, "restarted automatically" if c.crashed else "started", self.role, self.supply)
            if time.time() >= next_report:
                o = self.report()
                if o:
                    self.follow(o)
                    every = max(5, min(60, int(o.get("every_s") or 15)))
                next_report = time.time() + every
            time.sleep(1)


if __name__ == "__main__":
    if not SECRET or not SID:
        sys.exit("etc/workhorse.env needs HB_SERVER_SECRET and WH_SERVER_ID")
    Agent().run()
