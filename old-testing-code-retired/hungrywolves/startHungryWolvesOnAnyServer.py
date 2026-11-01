#!/usr/bin/env python3
"""Install or update the hungrywolves on a server (docs/HUNGRYWOLVES.md): 1-5 Receive Compute users sending chat jobs.

    python3 scripts/startHungryWolvesOnAnyServer.py --server-id <workhorse id> [--wolves N] [--model ID] [--dry-run]

Uses the workhorse row (admin tab Workhorses, table <prefix>Workhorses) for the machine (IP, SSH user, port, key NAME:
~/.ssh/<name> on this machine) and for the wolves' sign-in (they sign in as that row's account, like the workhorse
agent). Over SSH, ONLY in /root/REMOTESERVERSACCESS/hungrywolves: bin/wolf.py, wolvesctl, etc/wolves.env (600: the
site, the server ID, HB_SERVER_SECRET, WOLVES, WOLF_MODEL), data/, logs/, run/; then ./wolvesctl restart N.
Nothing outside the folder is touched (no crontab: start them again after a reboot with .../hungrywolves/wolvesctl start).
"""
import argparse, os, shlex, subprocess, sys, tempfile
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
D = "/root/REMOTESERVERSACCESS/hungrywolves"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server-id", required=True)
    ap.add_argument("--wolves", type=int, default=2)
    ap.add_argument("--model", default="qwen2.5-0.5b-q4km")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if not 1 <= a.wolves <= 5:
        sys.exit("--wolves: 1 to 5")
    import boto3
    os.environ.setdefault("AWS_ACCESS_KEY_ID", ENV.get("AWS_ACCESS_KEY_ID", "")); os.environ.setdefault("AWS_SECRET_ACCESS_KEY", ENV.get("AWS_SECRET_ACCESS_KEY", ""))
    it = boto3.resource("dynamodb", region_name="us-east-1").Table("planetcompute-ai-Workhorses").get_item(Key={"server_id": a.server_id, "sk": "SERVER"}).get("Item")
    if not it:
        sys.exit(f"no workhorse {a.server_id}")
    key = os.path.expanduser("~/.ssh/" + it["ssh_key_name"])
    host, port = f"{it.get('ssh_user') or 'root'}@{it['public_ipv4']}", str(it.get("ssh_port") or 22)
    ssh = ["ssh", "-i", key, "-p", port, "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", host]
    scp = ["scp", "-q", "-i", key, "-P", port, "-o", "BatchMode=yes"]
    print(f"hungrywolves on {it.get('name')} ({host}:{port}), folder {D}, {a.wolves} wolves, model {a.model}, account {it.get('account_email')}")
    if a.dry_run:
        return
    with tempfile.TemporaryDirectory() as tmp:
        envf = os.path.join(tmp, "wolves.env")
        with open(envf, "w") as f:
            f.write(f"WOLF_SITE=https://planetcompute.ai\nWH_SERVER_ID={a.server_id}\nHB_SERVER_SECRET={derived_key(ENV['HB_SERVER_SECRET'], 'wh:' + a.server_id)}\n"
                    f"WOLVES={a.wolves}\nWOLF_MODEL={a.model}\nWOLF_MAX_TOKENS=64\nWOLF_MIN_S=5\nWOLF_MAX_S=30\n")
        q = shlex.quote(D)
        subprocess.run(ssh + [f"mkdir -p {q}/bin {q}/etc {q}/data {q}/logs {q}/run && chmod 700 {q} {q}/etc {q}/data"], check=True)
        subprocess.run(scp + [os.path.join(REPO, "hungrywolves", "wolf.py"), f"{host}:{D}/bin/wolf.py"], check=True)
        subprocess.run(scp + [os.path.join(REPO, "hungrywolves", "wolvesctl"), f"{host}:{D}/wolvesctl"], check=True)
        subprocess.run(scp + [envf, f"{host}:{D}/etc/wolves.env"], check=True)
        subprocess.run(ssh + [f"cd {q} && chmod 600 etc/wolves.env && chmod 755 wolvesctl && chmod 700 bin/wolf.py && ./wolvesctl restart {a.wolves} && sleep 8 && ./wolvesctl status && ./wolvesctl logs"], check=True)


if __name__ == "__main__":
    main()
