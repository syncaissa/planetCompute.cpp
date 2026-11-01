#!/usr/bin/env python3
"""Test the website's heartbeat ledger (website/worker.js heartbeat) on a STAGING copy with TEST tables.

Never run this against the live site or live tables. You need your own Cloudflare and AWS accounts:
  1. DYNAMODB_TABLE_PREFIX=pctest-ai- python3 database/CreateTables.py
  2. deploy website/wrangler-staging.toml (see docs/TESTING.md, test 8) with secrets AWS_ACCESS_KEY_ID,
     AWS_SECRET_ACCESS_KEY and SESSION_SECRET (keep a copy of the SESSION_SECRET in a file)
  3. STAGING_URL=https://<your staging worker> SESSION_SECRET_FILE=<file> python3 scripts/test_heartbeat_ledger.py

AWS credentials come from the usual places (environment, ~/.aws). The script makes a test account, a session and
an already-verified device directly in the test tables, sends heartbeats, and checks after each step what the
tables hold: pending totals on the device item, the Contributor-Sessions row, and the BALANCE.
"""
import base64, hashlib, json, os, secrets, socket, ssl, sys, threading, time, urllib.error, urllib.request

import boto3

BASE = os.environ.get("STAGING_URL", "").rstrip("/")
PREFIX = os.environ.get("DDB_PREFIX", "pctest-ai-")
if not BASE or not os.environ.get("SESSION_SECRET_FILE") or not PREFIX.startswith("pctest"):
    sys.exit(__doc__)
SECRET = open(os.environ["SESSION_SECRET_FILE"]).read().strip()
HOST = BASE.split("://", 1)[1]
c = boto3.client("dynamodb", region_name=os.environ.get("AWS_REGION", "us-east-1"))
U, D, TOKEN = "aaaa" + secrets.token_hex(4), "abcd" + secrets.token_hex(4), secrets.token_urlsafe(32)
h = hashlib.sha256(f"{SECRET}|session|{TOKEN}".encode()).hexdigest()
now = int(time.time())
c.put_item(TableName=PREFIX + "user", Item={"pk": {"S": "USER#" + U}, "sk": {"S": "PROFILE"}, "user_id": {"S": U},
    "primary_email": {"S": "ledger-test@invalid"}, "created_at": {"S": "2026-10-21T00:00:00Z"}})
c.put_item(TableName=PREFIX + "user", Item={"pk": {"S": "SESSION#" + h}, "sk": {"S": "SESSION"}, "user_id": {"S": U},
    "expires_at": {"N": str(now + 3600)}, "created_at": {"N": str(now)}})
# a device whose capacity is already verified (1000 WU/s, so every reported WU is credited) and seen a minute ago
c.put_item(TableName=PREFIX + "user", Item={"pk": {"S": "USER#" + U}, "sk": {"S": "DEVICE#" + D}, "user_id": {"S": U},
    "device_id": {"S": D}, "police_verified": {"BOOL": True}, "verified_cpu_wu_s": {"N": "1000"},
    "verified_gpu_wu_s": {"N": "0"}, "last_seen": {"N": str(now - 60)}})


def beat(sid, state, wu):
    body = json.dumps({"device_id": D, "session_id": sid, "state": state, "cores": 2, "cpu_cap": 50, "cpu_pct": 10,
                       "packs": int(wu * 1000), "wu": wu, "browser": "ledger-test", "platform": "Linux", "host": "app",
                       "hw_cores": 4}).encode()
    rq = urllib.request.Request(BASE + "/api/volunteer/heartbeat", data=body, headers={
        "content-type": "application/json", "cookie": "pc_session=" + TOKEN, "user-agent": "planetCompute-ledger-test"})
    try:
        return json.loads(urllib.request.urlopen(rq, timeout=30).read())
    except urllib.error.HTTPError as e:
        return {"http": e.code, "body": e.read().decode()[:200]}


def dev():
    return c.get_item(TableName=PREFIX + "user", Key={"pk": {"S": "USER#" + U}, "sk": {"S": "DEVICE#" + D}}, ConsistentRead=True)["Item"]


def size(it):
    def sz(v):
        (t, x), = v.items()
        return len(x.encode()) if t == "S" else (len(x.lstrip("-").replace(".", "")) + 1) // 2 + 1 if t == "N" else 1
    return sum(len(k) + sz(v) for k, v in it.items())


def rows():
    items = c.query(TableName=PREFIX + "Contributor-Sessions", KeyConditionExpression="user_id = :u",
                    ExpressionAttributeValues={":u": {"S": U}}, ConsistentRead=True)["Items"]
    return sorted([(r["sk"]["S"], int(r["beats"]["N"]), int(r["reported_uwu"]["N"]), int(r["credited_uwu"]["N"]), "ended_at" in r)
                   for r in items])


def first_row():
    return rows()[0][1:4]


def bal():
    it = c.get_item(TableName=PREFIX + "user-credits", Key={"user_id": {"S": U}, "sk": {"S": "BALANCE"}}, ConsistentRead=True).get("Item", {})
    return int(it.get("available_uwu", {"N": "0"})["N"])


ok = True


def check(name, cond, detail=""):
    global ok
    ok &= bool(cond)
    print(("PASS " if cond else "FAIL ") + name, detail, flush=True)


def police_open():
    s = ssl.create_default_context().wrap_socket(socket.create_connection((HOST, 443), timeout=20), server_hostname=HOST)
    key = base64.b64encode(secrets.token_bytes(16)).decode()
    s.send((f"GET /api/police/ws?device={D} HTTP/1.1\r\nHost: {HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nCookie: pc_session={TOKEN}\r\n"
            f"User-Agent: planetCompute-ledger-test\r\n\r\n").encode())
    print("capacity-check socket:", s.recv(200).split(b"\r\n")[0].decode())
    time.sleep(2)
    return s


def wait_flushed():
    for _ in range(15):
        time.sleep(2)
        if "p_n" not in dev():
            return True
    return False


sid = secrets.token_hex(8)
print("beat 1", beat(sid, "running", 0.010))
check("1. first beat of a session writes the session row at once", first_row() == (1, 10000, 10000), rows())
check("2. ...and credits the balance", bal() == 10000, bal())
for wu in (0.020, 0.030, 0.040):
    time.sleep(1.2)
    print("beat", beat(sid, "running", wu))
d = dev()
check("3. later beats only add pending totals to the device item", d.get("p_n", {}).get("N") == "3" and d["p_r"]["N"] == "30000" and first_row()[0] == 1)
check("4. the balance waits for the flush", bal() == 10000, bal())
check("5. the device item stays under 1 KB (one write unit)", size(d) < 1024, size(d))
time.sleep(1.2)
res = [None, None]
threads = [threading.Thread(target=lambda i=i: res.__setitem__(i, beat(sid, "running", 0.050))) for i in (0, 1)]
[t.start() for t in threads]
[t.join() for t in threads]
d = dev()
check("6. two beats at once: both accepted, the work counted once", all(x and x.get("ok") for x in res) and d["p_n"]["N"] == "5" and d["p_r"]["N"] == "40000", res)
time.sleep(1.2)
print("pause", beat(sid, "paused", 0.060))
check("7. pause flushes everything to the session row", first_row() == (7, 60000, 60000) and rows()[0][4], rows())
check("8. ...and to the balance", bal() == 60000, bal())
check("9. ...leaving nothing pending", "p_n" not in dev())
time.sleep(1.2)
print("resume", beat(sid, "running", 0.070))
check("10. pending again after resuming", dev().get("p_n", {}).get("N") == "1")
s = police_open()
mask, payload = secrets.token_bytes(4), bytes([0x03, 0xE8])            # a proper close frame, code 1000
s.send(bytes([0x88, 0x80 | len(payload)]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
time.sleep(1)
s.close()
check("11. closing the capacity-check socket flushes", wait_flushed() and first_row() == (8, 70000, 70000), rows())
check("12. ...and credits", bal() == 70000, bal())
time.sleep(1.2)
print("resume", beat(sid, "running", 0.080))
police_open().close()                                                  # vanish without a close frame
check("13. a socket that just disappears also flushes", wait_flushed() and first_row() == (9, 80000, 80000), rows())
time.sleep(1.2)
print("new session", beat(secrets.token_hex(8), "running", 0.005))
check("14. a new session gets its own row", len(rows()) == 2 and any(r[1:4] == (1, 5000, 5000) for r in rows()), rows())
check("15. the balance equals everything credited", bal() == 85000, bal())
print("\nALL PASS" if ok else "\nSOME FAILED")
sys.exit(0 if ok else 1)
