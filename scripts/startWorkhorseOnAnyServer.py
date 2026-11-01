#!/usr/bin/env python3
"""Install or update a workhorse server (docs/WORKHORSES.md): 1-6 planetCompute copies sharing compute with the pool.

    python3 scripts/startWorkhorseOnAnyServer.py --server-id <id> [--boot] [--binary <file>] [--dry-run]

The server's row comes from the admin page (tab Workhorses, table <prefix>Workhorses): its IP address, SSH user,
port and key NAME (the key file is ~/.ssh/<name> on this machine and never leaves it), the folder (root_dir,
default /root/REMOTESERVERSACCESS/planetcomputeworkhorse), copies, cores, cap and the account.
The script
  1. takes the newest server build (linux-x86_64-server, no desktop libraries) from B2 client/LATEST.json and checks
     its SHA-256 (or --binary: a file you give),
  2. over SSH, ONLY in root_dir: bin/planetCompute, bin/whagent.py, whctl, etc/workhorse.env (600: the site, the
     server ID and HB_SERVER_SECRET), data/, logs/, run/,
  3. starts (or restarts) the agent: ./whctl restart,
  4. waits until the website has the agent's first report (the row's agent_seen_at) and prints the copies.
--boot also adds ONE line to the SSH user's crontab, "@reboot sleep 30; <root_dir>/whctl start ..." (the only thing outside the
folder; without --boot nothing outside it is touched: start it again after a reboot with <root_dir>/whctl start).
Keys from ../.env: AWS_* (the row), B2_* (the build), HB_SERVER_SECRET (the agent's signing secret).
"""
import argparse, hashlib, json, os, shlex, subprocess, sys, tempfile, time, urllib.request
import hashlib, hmac as _hmac
def derived_key(master, label):
    """The server's own key (security review W5): never the master HB_SERVER_SECRET on a server."""
    return _hmac.new(master.encode(), ("pc-derived|" + label).encode(), hashlib.sha256).hexdigest()

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
ENV = {}
for line in open(os.path.join(REPO, "..", ".env")):
    line = line.strip()
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        ENV[k.strip()] = v.strip().strip('"').strip("'")


def die(msg):
    sys.exit("startWorkhorseOnAnyServer: " + msg)


def row(server_id):
    import boto3
    t = boto3.resource("dynamodb", region_name=ENV.get("AWS_REGION", "us-east-1"), aws_access_key_id=ENV["AWS_ACCESS_KEY_ID"],
                       aws_secret_access_key=ENV["AWS_SECRET_ACCESS_KEY"]).Table(ENV.get("DYNAMODB_TABLE_PREFIX", "planetcompute-ai-") + "Workhorses")
    it = t.get_item(Key={"server_id": server_id, "sk": "SERVER"}, ConsistentRead=True).get("Item")
    if not it:
        die(f"no workhorse {server_id} in the table (add it on the admin page, tab Workhorses)")
    return t, it


def server_build(dest):
    sys.path.insert(0, HERE)
    from publish_client import B2
    b = B2()
    latest = json.loads(b.get("client/LATEST.json"))
    f = latest.get("builds", {}).get("linux-x86_64-server")
    if not f:
        die("no linux-x86_64-server build in B2 yet (publish a green CI run with publish_client.py), or give --binary")
    data = b.get(f"client/{latest['version']}/{f['file']}")
    if hashlib.sha256(data).hexdigest() != f["sha256"]:
        die("the server build from B2 does not match its SHA-256")
    open(dest, "wb").write(data)
    os.chmod(dest, 0o755)
    return f"{latest['version']} ({latest.get('commit', '')[:7]}), {len(data):,} bytes, sha256 {f['sha256'][:16]}…"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server-id", required=True)
    ap.add_argument("--binary", help="a planetCompute server build to install instead of B2's newest")
    ap.add_argument("--boot", action="store_true", help="also start it after a reboot (one @reboot crontab line)")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if not ENV.get("HB_SERVER_SECRET"):
        die("HB_SERVER_SECRET is not in ../.env")
    table, it = row(a.server_id)
    D = it.get("root_dir") or "/root/REMOTESERVERSACCESS/planetcomputeworkhorse"
    if not D.startswith("/") or ".." in D or D.rstrip("/") in ("", "/root", "/home", "/usr", "/etc", "/var", "/opt"):
        die(f"refusing the folder {D!r}: give a folder of its own")
    key = os.path.expanduser("~/.ssh/" + it["ssh_key_name"])
    if not os.path.exists(key):
        die(f"the SSH key {key} is not on this machine")
    host = f"{it.get('ssh_user') or 'root'}@{it['public_ipv4']}"
    port = str(it.get("ssh_port") or 22)
    ssh = ["ssh", "-i", key, "-p", port, "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-o", "StrictHostKeyChecking=accept-new", host]
    print(f"workhorse {it.get('name')} ({a.server_id}) at {host}:{port}, folder {D}, copies {it.get('instances', 1)}, account {it.get('account_email')}")
    if a.dry_run:
        return
    with tempfile.TemporaryDirectory() as tmp:
        b = os.path.join(tmp, "planetCompute")
        if a.binary:
            import shutil
            shutil.copy(a.binary, b)
            print("program:", a.binary)
        else:
            print("program: B2 server build", server_build(b))
        envf = os.path.join(tmp, "workhorse.env")
        with open(envf, "w") as f:
            # WH_PORT0: copy N listens on WH_PORT0 + N (a second row on the same server sets its own, e.g. 7540)
            f.write(f"WH_SITE=https://planetcompute.ai\nWH_SERVER_ID={a.server_id}\nHB_SERVER_SECRET={derived_key(ENV['HB_SERVER_SECRET'], 'wh:' + a.server_id)}\nWH_PORT0={it.get('port_base') or 7530}\n")
        q = shlex.quote(D)
        subprocess.run(ssh + [f"mkdir -p {q}/bin {q}/etc {q}/data {q}/logs {q}/run && chmod 700 {q} {q}/etc {q}/data"], check=True)
        scp = ["scp", "-q", "-i", key, "-P", port, "-o", "BatchMode=yes"]
        # the program goes in as a new file, then is renamed over the old one (a running copy keeps its file)
        subprocess.run(scp + [b, f"{host}:{D}/bin/planetCompute.new"], check=True)
        subprocess.run(scp + [os.path.join(REPO, "workhorse", "whagent.py"), f"{host}:{D}/bin/whagent.py"], check=True)
        subprocess.run(scp + [os.path.join(REPO, "workhorse", "whctl"), f"{host}:{D}/whctl"], check=True)
        subprocess.run(scp + [envf, f"{host}:{D}/etc/workhorse.env"], check=True)
        remote = (f"cd {q} && chmod 600 etc/workhorse.env && chmod 755 bin/planetCompute.new whctl && chmod 700 bin/whagent.py && "
                  f"mv -f bin/planetCompute.new bin/planetCompute && ./bin/planetCompute --version | head -1 && ./whctl restart")
        if a.boot:
            # one line, like the heartbeat server's (a short wait for the network, a boot log); an older workhorse line goes
            # the tag names the folder, so two rows on one server (the workhorse, the generouscows) keep a line each
            tag = "# planetcompute workhorse" if D.rstrip("/").endswith("/planetcomputeworkhorse") else f"# planetcompute {os.path.basename(D.rstrip('/'))}"
            line = f"@reboot sleep 30; {D}/whctl start >> {D}/logs/boot.log 2>&1  {tag}"
            remote += (f" && (crontab -l 2>/dev/null | grep -vF {shlex.quote(tag)}; echo {shlex.quote(line)}) | crontab - && echo 'boot: @reboot line in crontab' && crontab -l")
        subprocess.run(ssh + [remote], check=True)
    seen0 = it.get("agent_seen_at", "")
    print("waiting for the agent's first report on the website…")
    for _ in range(36):
        time.sleep(5)
        r = table.get_item(Key={"server_id": a.server_id, "sk": "SERVER"}, ConsistentRead=True)["Item"]
        if r.get("agent_seen_at", "") > seen0:
            st = json.loads(r.get("agent_state") or "{}")
            run = [c for c in st.get("instances", []) if c.get("state") == "running"]
            print(f"reported {r['agent_seen_at']}: {len(run)} of {len(st.get('instances', []))} copies running, {st.get('cores_total')} cores, load {st.get('load')}, v{st.get('version')}")
            for c in st.get("instances", []):
                print(f"  copy {c['i']}: {c['state']} port {c['port']} pid {c['pid']} device {c.get('device') or '(starting)'}")
            return
    die("no report from the agent within 3 minutes: see " + D + "/logs/agent.log (ssh in, ./whctl logs)")


if __name__ == "__main__":
    main()
