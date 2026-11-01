#!/usr/bin/env python3
"""planetCompute hungrywolf (docs/HUNGRYWOLVES.md): one Receive Compute user that keeps sending chat jobs to the grid.

    HOME=<DIR>/data python3 bin/wolf.py <n>        (n = 1..5; started by ./wolvesctl)

It signs in as the workhorse row's account (POST /api/wh/session, signed with HB_SERVER_SECRET, like the workhorse
agent; renewed weekly, shared by the wolves in data/session.json), then in a loop sends POST /v1/jobs (an OpenAI chat
body) with a prompt from its list, waits for the answer, writes one JSON line per job to logs/wolf<n>.jsonl (time,
status, the grid's facts: device, checked, agree, wait_ms, run_ms, total_ms, tokens, WU) and sleeps a random
WOLF_MIN_S..WOLF_MAX_S. Everything stays in DIR. Standard library only.
"""
import hashlib, hmac, json, os, random, sys, time, urllib.error, urllib.request

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
N = int(sys.argv[1]) if len(sys.argv) > 1 else 1


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


CFG = env_file(os.path.join(D, "etc", "wolves.env"))
SITE, SECRET, SID = CFG.get("WOLF_SITE", "https://planetcompute.ai").rstrip("/"), CFG.get("HB_SERVER_SECRET", ""), CFG.get("WH_SERVER_ID", "")
MODEL, MAXTOK = CFG.get("WOLF_MODEL", "qwen2.5-0.5b-q4km"), int(CFG.get("WOLF_MAX_TOKENS", "64"))
MIN_S, MAX_S = float(CFG.get("WOLF_MIN_S", "5")), float(CFG.get("WOLF_MAX_S", "30"))
SESSION, LOG = os.path.join(D, "data", "session.json"), os.path.join(D, "logs", f"wolf{N}.jsonl")
PROMPTS = ["Name one planet of the solar system and say one fact about it.", "What is 17 times 23? Answer with the number.",
           "Write a haiku about sharing computers.", "Give three uses of a spare laptop.", "Translate 'good morning' into French and Spanish.",
           "In one sentence: why is the sky blue?", "List the first five prime numbers.", "Suggest a name for a friendly robot.",
           "What is the capital of Japan?", "Explain a Work Unit to a child in one sentence."]


def say(*a):
    print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), f"wolf{N}", *a, flush=True)


def token():
    try:
        s = json.load(open(SESSION))
        if s.get("token") and time.time() - s.get("at", 0) < 7 * 86400:
            return s["token"]
    except Exception:
        pass
    raw, ts = json.dumps({"server_id": SID}), str(int(time.time()))
    sig = hmac.new(SECRET.encode(), f"whsession|{ts}|{raw}".encode(), hashlib.sha256).hexdigest()
    req = urllib.request.Request(SITE + "/api/wh/session", data=raw.encode(), method="POST",
                                 headers={"content-type": "application/json", "x-wh-sig": f"{ts}.{sig}", "user-agent": "hungrywolf/1"})
    a = json.loads(urllib.request.urlopen(req, timeout=20).read())
    fd = os.open(SESSION + f".{N}.tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"token": a["token"], "at": int(time.time()), "account": a.get("account_email", "")}, f)
    os.replace(SESSION + f".{N}.tmp", SESSION)
    say("new sign-in for", a.get("account_email", "the row's account"))
    return a["token"]


def job(tok):
    # "priority": "low": test traffic waits behind real users' jobs and keeps 1 in 1,000 job details (the totals in full)
    body = json.dumps({"model": MODEL, "messages": [{"role": "user", "content": random.choice(PROMPTS)}], "max_tokens": MAXTOK, "priority": "low"}).encode()
    req = urllib.request.Request(SITE + "/v1/jobs", data=body, method="POST",
                                 headers={"content-type": "application/json", "cookie": f"pc_session={tok}", "user-agent": "hungrywolf/1"})
    t0 = time.time()
    try:
        r = urllib.request.urlopen(req, timeout=330)   # up to 2 min in the queue + 3 min running
        status, a = r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        status, a = e.code, (json.loads(e.read() or b"{}") if e.code < 600 else {})
    except Exception as e:
        status, a = 0, {"error": {"message": str(e)[:200]}}
    return status, a, int((time.time() - t0) * 1000)


def main():
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    say("started: model", MODEL, "every", MIN_S, "-", MAX_S, "s")
    while True:
        try:
            tok = token()
            status, a, ms = job(tok)
            if status == 401:
                os.path.exists(SESSION) and os.remove(SESSION)
            g = a.get("grid") or {}
            row = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "wolf": N, "status": status, "ms": ms, "ok": status == 200,
                   "error": (a.get("error") or {}).get("message", "") if status != 200 else "", "device": g.get("device", ""),
                   "checked": g.get("checked"), "agree": g.get("agree"), "wait_ms": g.get("wait_ms"), "run_ms": g.get("run_ms"),
                   "total_ms": g.get("total_ms"), "tokens": (a.get("usage") or {}).get("completion_tokens"), "wu": g.get("wu"),
                   "answer": ((a.get("choices") or [{}])[0].get("message") or {}).get("content", "")[:120]}
            with open(LOG, "a") as f:
                f.write(json.dumps(row) + "\n")
            if os.path.getsize(LOG) > 20 << 20:                  # keep the last part
                data = open(LOG, "rb").read()[-(5 << 20):]
                open(LOG, "wb").write(data[data.find(b"\n") + 1:])
        except Exception as e:
            say("error:", str(e)[:200])
        time.sleep(random.uniform(MIN_S, MAX_S))


if __name__ == "__main__":
    main()
