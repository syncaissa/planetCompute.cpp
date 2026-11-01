#!/usr/bin/env python3
"""Get any EC2-type Linux server (AWS EC2, Hetzner, DigitalOcean, ...) ready as a planetCompute heartbeat server.

  python3 scripts/startHeartBeatEtcServerOnAnyEC2TypeServer.py --ip 203.0.113.10 --hostname hb1.planetcompute.ai \\
      --key ~/.ssh/planetcompute_hb [--user root] [--ssh-port 22] [--name hetzner-1] [--provider Hetzner] \\
      [--region fsn1] [--instance-type CPX21] [--ipv6 2001:db8::1] [--exe path/to/hbserver] [--activate]

Run from planetCompute-CPP/ on the admin machine (Cloud9). Safe to run again (updates the program and settings).
What it does, in order (CostOfComputeCFetc.txt; admin page tab Servers):
  1. SSH to the server (key file stays here; only its NAME goes into the table) and find its CPU (x86_64 / aarch64)
  2. the program: --exe, else the newest green CI build ("Heartbeat server" workflow, artifact hbserver-linux-<cpu>)
  3. on the server: user "hbserver", /opt/hbserver/hbserver, /var/lib/hbserver (journal), a self-signed TLS
     certificate (Cloudflare's SSL mode for planetcompute.ai is "Full": it accepts it), /etc/hbserver/hbserver.env
     with HB_SERVER_SECRET (sent through SSH's input, never on a command line), a systemd service that restarts on
     its own (Restart=always) and starts at boot
  4. firewall (ufw or firewalld): SSH stays open; port 443 only from Cloudflare's addresses (only Cloudflare's proxy
     may reach the server, so the volunteer address it passes on can be trusted)
  5. DNS: <hostname> -> the server, proxied by Cloudflare (orange cloud)
  6. the row in DynamoDB <prefix>HeartbeatEtcEC2TypeServers (same hostname = same row); with --activate and a passing
     health check through Cloudflare, status "active" (else it stays as it was, a new one "inactive")
Your provider's own firewall (AWS security group, Hetzner Cloud firewall) is outside the server: open TCP 443 there
from Cloudflare's addresses (https://www.cloudflare.com/ips/) yourself; the script reminds you.

--tunnel (for a server that already runs other things, e.g. containers): NO port is opened and the firewall is not
touched. hbserver listens on 127.0.0.1:18443 only (plain HTTP, no certificate), and a separate service
"hbserver-tunnel" runs cloudflared with planetcompute's own Cloudflare Tunnel (named planetcompute-<first label of the
hostname>, created through the API, ingress <hostname> -> http://127.0.0.1:18443); DNS: <hostname> is a proxied CNAME
to the tunnel. Its cloudflared is our own pinned copy (CF_VER, SHA-256 checked) in the install folder; a cloudflared
already on the server, and any other tunnel on it, are left alone.

--root-dir DIR (with --tunnel; for a shared server, e.g. --root-dir /root/REMOTESERVERSACCESS/planetcompute): NOTHING
outside DIR is touched: DIR/bin/hbserver, DIR/etc/ (hbserver.env, tunnel.env, cloudflared.yml; 600), DIR/data/ (the
journal; also HOME of both processes), DIR/logs/, DIR/run/ (pids), and DIR/hbctl start|stop|restart|status|logs, which
runs the agent (bin/hbagent.py: it runs hbserver and follows the admin page's Start / Restart / Stop and "restart
automatically") and the tunnel, each under a loop that restarts it after a crash. No system user, no systemd unit, no
cron, no kernel settings, no firewall. It does NOT start by itself after a reboot (that needs an entry outside DIR):
run DIR/hbctl start. Its cloudflared is DIR/bin/cloudflared (downloaded, checked); the server's own one is not used or changed.
Needs in ../.env: HB_SERVER_SECRET, CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL, AWS keys (DynamoDB), GITHUB_TOKEN (to fetch
the CI build). Standard library + boto3.
"""
import argparse, io, json, os, re, secrets, shlex, subprocess, sys, time, urllib.error, urllib.request, zipfile
import hashlib, hmac as _hmac
def derived_key(master, label):
    """The server's own key (security review W5): never the master HB_SERVER_SECRET on a server."""
    return _hmac.new(master.encode(), ("pc-derived|" + label).encode(), hashlib.sha256).hexdigest()

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
REPO = "syncaissa/planetCompute.cpp"
CF = "https://api.cloudflare.com/client/v4"
TUNNEL_PORT = 18443
ZONE = "planetcompute.ai"
SITE = "https://planetcompute.ai"


def load_env():
    env = {}
    for line in open(os.path.join(ROOT, ".env")):
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class Remote:
    def __init__(self, a):
        self.base = ["ssh", "-i", os.path.expanduser(a.key), "-p", str(a.ssh_port), "-o", "StrictHostKeyChecking=accept-new",
                     "-o", "ConnectTimeout=20", "-o", "BatchMode=yes", f"{a.user}@{a.ip}"]
        self.scp = ["scp", "-q", "-i", os.path.expanduser(a.key), "-P", str(a.ssh_port), "-o", "StrictHostKeyChecking=accept-new"]
        self.dest = f"{a.user}@{a.ip}"
        self.sudo = "" if a.user == "root" else "sudo -n "

    def run(self, script, check=True, quiet=False):
        """Run a bash script on the server, given through SSH's input (secrets never on a command line)."""
        r = subprocess.run(self.base + [self.sudo + "bash -s"], input=script, text=True, capture_output=True)
        if not quiet and r.stdout.strip():
            print(r.stdout.rstrip())
        if check and r.returncode != 0:
            sys.exit(f"remote step failed ({r.returncode}):\n{r.stderr[-2000:]}")
        return r

    def put(self, local, remote):
        subprocess.run(self.scp + [local, f"{self.dest}:{remote}"], check=True)


def gh(url, token, raw=False):
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json", "User-Agent": "planetcompute-hb"})
    data = urllib.request.urlopen(req, timeout=120).read()
    return data if raw else json.loads(data)


def ci_program(cpu, env):
    """The newest green CI build of the heartbeat server for this CPU."""
    name = {"x86_64": "hbserver-linux-x86_64", "aarch64": "hbserver-linux-aarch64", "arm64": "hbserver-linux-aarch64"}.get(cpu)
    if not name:
        sys.exit(f"no build for CPU {cpu}: give --exe")
    tok = env.get("GITHUB_TOKEN") or sys.exit("GITHUB_TOKEN missing in .env (or give --exe)")
    runs = gh(f"https://api.github.com/repos/{REPO}/actions/workflows/hbserver.yml/runs?branch=main&status=success&per_page=10", tok)["workflow_runs"]
    for run in runs:
        for art in gh(run["artifacts_url"], tok)["artifacts"]:
            if art["name"] == name and not art["expired"]:
                # the download URL redirects to storage that must be fetched WITHOUT the token
                req = urllib.request.Request(art["archive_download_url"], headers={"Authorization": "Bearer " + tok, "User-Agent": "planetcompute-hb"})

                class NoRedirect(urllib.request.HTTPRedirectHandler):
                    def redirect_request(self, *x, **k):
                        return None
                try:
                    urllib.request.build_opener(NoRedirect).open(req, timeout=60)
                    sys.exit("artifact download gave no redirect")
                except urllib.error.HTTPError as e:
                    loc = e.headers.get("Location")
                z = zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(loc, timeout=300).read()))
                data = z.read("hbserver")
                log(f"program: CI run {run['id']} ({run['head_sha'][:7]}), {name}, {len(data):,} bytes")
                return data
    sys.exit(f"no green CI build with artifact {name} yet (workflow 'Heartbeat server'): give --exe")


def cloudflare(env, method, path, body=None):
    req = urllib.request.Request(CF + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"X-Auth-Key": env["CLOUDFLARE_API_KEY"], "X-Auth-Email": env["CLOUDFLARE_EMAIL"], "Content-Type": "application/json"})
    j = json.loads(urllib.request.urlopen(req, timeout=60).read())
    if not j.get("success"):
        sys.exit(f"Cloudflare {method} {path}: {j.get('errors')}")
    return j["result"]


def cloudflare_ranges():
    out = []
    for u in ("https://www.cloudflare.com/ips-v4", "https://www.cloudflare.com/ips-v6"):
        out += [x.strip() for x in urllib.request.urlopen(u, timeout=30).read().decode().split() if x.strip()]
    if len(out) < 10:
        sys.exit("could not read Cloudflare's address list")
    return out


def dns(env, a):
    zone = cloudflare(env, "GET", f"/zones?name={ZONE}")[0]["id"]
    for typ, content in (("A", a.ip), ("AAAA", a.ipv6)):
        if not content:
            continue
        rec = {"type": typ, "name": a.hostname, "content": content, "proxied": True, "ttl": 1, "comment": "planetCompute heartbeat server"}
        have = cloudflare(env, "GET", f"/zones/{zone}/dns_records?type={typ}&name={a.hostname}")
        if have:
            cloudflare(env, "PUT", f"/zones/{zone}/dns_records/{have[0]['id']}", rec)
            log(f"DNS {typ} {a.hostname} -> {content} (updated, proxied)")
        else:
            cloudflare(env, "POST", f"/zones/{zone}/dns_records", rec)
            log(f"DNS {typ} {a.hostname} -> {content} (created, proxied)")
    ssl = cloudflare(env, "GET", f"/zones/{zone}/settings/ssl")["value"]
    if ssl != "full":
        log(f"WARNING: Cloudflare SSL mode is '{ssl}': a self-signed origin certificate needs 'full' ('strict' would refuse it)")


def tunnel(env, a):
    """planetcompute's own tunnel for this hostname: create or reuse, point it at hbserver, CNAME the hostname to it.
    Returns the tunnel token (it goes to the server only, through SSH's input)."""
    zone = cloudflare(env, "GET", f"/zones?name={ZONE}")[0]
    acct = zone["account"]["id"]
    name = "planetcompute-" + a.hostname.split(".")[0]
    have = cloudflare(env, "GET", f"/accounts/{acct}/cfd_tunnel?name={name}&is_deleted=false")
    if have:
        tid = have[0]["id"]
        log(f"tunnel {name} exists ({tid[:8]}…)")
    else:
        import base64
        tid = cloudflare(env, "POST", f"/accounts/{acct}/cfd_tunnel", {"name": name, "config_src": "cloudflare",
                         "tunnel_secret": base64.b64encode(secrets.token_bytes(32)).decode()})["id"]
        log(f"tunnel {name} created ({tid[:8]}…)")
    cloudflare(env, "PUT", f"/accounts/{acct}/cfd_tunnel/{tid}/configurations", {"config": {"ingress": [
        {"hostname": a.hostname, "service": f"http://127.0.0.1:{TUNNEL_PORT}"}, {"service": "http_status:404"}]}})
    token = cloudflare(env, "GET", f"/accounts/{acct}/cfd_tunnel/{tid}/token")
    zid = zone["id"]
    for typ in ("A", "AAAA"):
        for r in cloudflare(env, "GET", f"/zones/{zid}/dns_records?type={typ}&name={a.hostname}"):
            cloudflare(env, "DELETE", f"/zones/{zid}/dns_records/{r['id']}")
            log(f"DNS {typ} {a.hostname} removed (the tunnel replaces it)")
    rec = {"type": "CNAME", "name": a.hostname, "content": f"{tid}.cfargotunnel.com", "proxied": True, "ttl": 1,
           "comment": "planetCompute heartbeat server (Cloudflare Tunnel)"}
    old = cloudflare(env, "GET", f"/zones/{zid}/dns_records?type=CNAME&name={a.hostname}")
    if old:
        cloudflare(env, "PUT", f"/zones/{zid}/dns_records/{old[0]['id']}", rec)
    else:
        cloudflare(env, "POST", f"/zones/{zid}/dns_records", rec)
    log(f"DNS CNAME {a.hostname} -> tunnel (proxied)")
    return token


def table(env):
    import boto3
    os.environ.setdefault("AWS_ACCESS_KEY_ID", env.get("AWS_ACCESS_KEY_ID", ""))
    os.environ.setdefault("AWS_SECRET_ACCESS_KEY", env.get("AWS_SECRET_ACCESS_KEY", ""))
    prefix = env.get("DYNAMODB_TABLE_PREFIX", "planetcompute-ai-")
    return boto3.resource("dynamodb", region_name=env.get("AWS_REGION", "us-east-1")).Table(prefix + "HeartbeatEtcEC2TypeServers")


def find_row(t, hostname):
    kw = {}
    while True:
        r = t.scan(**kw)
        for it in r["Items"]:
            if it.get("sk") == "SERVER" and it.get("hostname") == hostname:
                return it
        if "LastEvaluatedKey" not in r:
            return None
        kw["ExclusiveStartKey"] = r["LastEvaluatedKey"]


SETUP = r"""
set -e
id hbserver >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin hbserver
mkdir -p /opt/hbserver /etc/hbserver /var/lib/hbserver
chown hbserver:hbserver /var/lib/hbserver && chmod 700 /var/lib/hbserver
command -v openssl >/dev/null || (apt-get update -qq && apt-get install -y -qq openssl) || (dnf -y -q install openssl) || true
if [ "__TLS__" = 1 ] && [ ! -s /etc/hbserver/tls.crt ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 -subj "/CN=__HOST__" \
    -addext "subjectAltName=DNS:__HOST__" -keyout /etc/hbserver/tls.key -out /etc/hbserver/tls.crt 2>/dev/null
fi
if [ "__TLS__" = 1 ]; then chown root:hbserver /etc/hbserver/tls.key /etc/hbserver/tls.crt && chmod 640 /etc/hbserver/tls.key && chmod 644 /etc/hbserver/tls.crt; fi
umask 077
cat > /etc/hbserver/hbserver.env <<'ENVEOF'
__ENV__
ENVEOF
chmod 600 /etc/hbserver/hbserver.env
cat > /etc/systemd/system/hbserver.service <<'UNITEOF'
[Unit]
Description=planetCompute heartbeat server
After=network-online.target
Wants=network-online.target

[Service]
User=hbserver
EnvironmentFile=/etc/hbserver/hbserver.env
ExecStart=/opt/hbserver/hbserver
Restart=always
RestartSec=2
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/hbserver
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
UNITEOF
cat > /etc/sysctl.d/90-hbserver.conf <<'SYSEOF'
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.ip_local_port_range = 1024 65535
SYSEOF
sysctl -q --system || true
systemctl stop hbserver 2>/dev/null || true
install -m 755 /tmp/hbserver.new /opt/hbserver/hbserver && rm -f /tmp/hbserver.new
/opt/hbserver/hbserver --version
systemctl daemon-reload && systemctl enable --now hbserver >/dev/null 2>&1 && systemctl restart hbserver
sleep 2
systemctl is-active hbserver
curl -sk --max-time 5 __HEALTH__ || (journalctl -u hbserver -n 30 --no-pager; exit 1)
echo
"""

TUNNEL = r"""
set -e
# cloudflared of our own (never the server's): a pinned release, checked by SHA-256. Versions before 2026.10.2 trust the
# compromised eMudhra (emSign) intermediates (Cloudflare notice of 2026-10-20); raise CF_VER and the sums for a newer one.
CF_VER=2026.10.4
case "$(uname -m)" in
  x86_64) CF_ARCH=amd64; CF_SUM=ae5e8add7884b0531d66bbca4570d1de491ff6da51e4ebe7eb160cdf241d9e42 ;;
  aarch64|arm64) CF_ARCH=arm64; CF_SUM=2b7203b4fb0ba28a0c1e12f8855ce2c25f76d266a8d5edafac5540b6812acff6 ;;
  *) echo "no cloudflared for $(uname -m)"; exit 1 ;;
esac
cf_fetch() {   # cf_fetch <path>: put cloudflared $CF_VER at <path> unless it is there already
  if [ -x "$1" ] && "$1" --version 2>/dev/null | grep -q "version $CF_VER "; then return; fi
  curl -fsSL -o "$1.new" "https://github.com/cloudflare/cloudflared/releases/download/$CF_VER/cloudflared-linux-$CF_ARCH"
  echo "$CF_SUM  $1.new" | sha256sum -c - >/dev/null || { echo "cloudflared download: wrong SHA-256"; rm -f "$1.new"; exit 1; }
  chmod 700 "$1.new" && mv "$1.new" "$1"; "$1" --version
}
mkdir -p /opt/hbserver && CF=/opt/hbserver/cloudflared && cf_fetch $CF
umask 077
cat > /etc/hbserver/tunnel.env <<'TEOF'
TUNNEL_TOKEN=__TOKEN__
TEOF
chmod 600 /etc/hbserver/tunnel.env
printf 'no-autoupdate: true\n' > /etc/hbserver/cloudflared.yml   # never read another tunnel's default config
cat > /etc/systemd/system/hbserver-tunnel.service <<UEOF
[Unit]
Description=planetCompute heartbeat server: Cloudflare Tunnel (outbound only; no port opened)
After=network-online.target hbserver.service
Wants=network-online.target

[Service]
User=hbserver
EnvironmentFile=/etc/hbserver/tunnel.env
ExecStart=$CF --config /etc/hbserver/cloudflared.yml tunnel --no-autoupdate run
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UEOF
systemctl daemon-reload && systemctl enable --now hbserver-tunnel >/dev/null 2>&1 && systemctl restart hbserver-tunnel
sleep 4; systemctl is-active hbserver-tunnel
"""

# --root-dir: EVERYTHING for planetcompute in one folder on a shared server, nothing outside it (user's rule,
# 2026-10-26): no system user, no systemd units, no cron, no kernel settings, no firewall, nothing in /tmp or /root.
# DIR/hbctl start|stop|restart|status|logs runs both processes under a loop that restarts them after a crash;
# start-at-boot would need an entry outside DIR, so it is left to the owner (run "DIR/hbctl start" after a reboot).
SETUP_DIR = r"""
set -e
D=__DIR__
mkdir -p $D/bin $D/etc $D/data $D/logs $D/run && chmod 700 $D $D/etc $D/data
umask 077
cat > $D/etc/hbserver.env <<'ENVEOF'
__ENV__
ENVEOF
chmod 600 $D/etc/hbserver.env
# cloudflared of our own (never the server's): a pinned release, checked by SHA-256. Versions before 2026.10.2 trust the
# compromised eMudhra (emSign) intermediates (Cloudflare notice of 2026-10-20); raise CF_VER and the sums for a newer one.
CF_VER=2026.10.4
case "$(uname -m)" in
  x86_64) CF_ARCH=amd64; CF_SUM=ae5e8add7884b0531d66bbca4570d1de491ff6da51e4ebe7eb160cdf241d9e42 ;;
  aarch64|arm64) CF_ARCH=arm64; CF_SUM=2b7203b4fb0ba28a0c1e12f8855ce2c25f76d266a8d5edafac5540b6812acff6 ;;
  *) echo "no cloudflared for $(uname -m)"; exit 1 ;;
esac
cf_fetch() {   # cf_fetch <path>: put cloudflared $CF_VER at <path> unless it is there already
  if [ -x "$1" ] && "$1" --version 2>/dev/null | grep -q "version $CF_VER "; then return; fi
  curl -fsSL -o "$1.new" "https://github.com/cloudflare/cloudflared/releases/download/$CF_VER/cloudflared-linux-$CF_ARCH"
  echo "$CF_SUM  $1.new" | sha256sum -c - >/dev/null || { echo "cloudflared download: wrong SHA-256"; rm -f "$1.new"; exit 1; }
  chmod 700 "$1.new" && mv "$1.new" "$1"; "$1" --version
}
CF=$D/bin/cloudflared && cf_fetch $CF
PY=$(command -v python3 || true)
[ -n "$PY" ] || { echo "python3 is not installed on this server (the agent needs it)"; exit 1; }
cat > $D/hbctl <<CTLEOF
#!/bin/bash
# planetCompute heartbeat server: everything lives in $D (nothing outside it).
#   $D/hbctl start | stop | restart | status | logs
# Two processes, each under a loop that starts it again after a crash: the agent (bin/hbagent.py: runs the heartbeat
# program, reports to planetcompute.ai, follows the admin page's Start / Restart / Stop) and the tunnel.
D=$D
CF=$CF
PY=$PY
cmd_agent()    { HOME=\$D/data exec \$PY \$D/bin/hbagent.py; }
cmd_tunnel()   { set -a; . \$D/etc/tunnel.env; set +a; HOME=\$D/data exec \$CF --config \$D/etc/cloudflared.yml tunnel --no-autoupdate run; }
alive() { [ -s \$D/run/\$1.pid ] && kill -0 "\$(cat \$D/run/\$1.pid)" 2>/dev/null; }
start1() {
  alive \$1 && { echo "\$1 already running (pid \$(cat \$D/run/\$1.pid))"; return; }
  [ \$1 = tunnel ] && [ ! -s \$D/etc/tunnel.env ] && { echo "tunnel: no etc/tunnel.env yet"; return; }
  # a loop that starts it again 2 s after it stops; the log is cut back when it passes 50 MB
  setsid bash -c "while true; do
      [ \\\$(stat -c %s \$D/logs/\$1.log 2>/dev/null || echo 0) -gt 52428800 ] && tail -c 5000000 \$D/logs/\$1.log > \$D/logs/\$1.log.tmp && mv \$D/logs/\$1.log.tmp \$D/logs/\$1.log
      echo \"== start \\\$(date -u +%FT%TZ)\" >> \$D/logs/\$1.log
      \$D/hbctl run-\$1 >> \$D/logs/\$1.log 2>&1
      sleep 2
    done" < /dev/null > /dev/null 2>&1 &
  echo \$! > \$D/run/\$1.pid; echo "\$1 started (pid \$!)"
}
stop1() { alive \$1 && { kill -- -"\$(cat \$D/run/\$1.pid)" 2>/dev/null; sleep 1; echo "\$1 stopped"; }; rm -f \$D/run/\$1.pid; }
case "\$1" in
  run-agent) cmd_agent ;;
  run-tunnel) cmd_tunnel ;;
  start) start1 agent; start1 tunnel ;;
  stop) stop1 tunnel; stop1 agent ;;
  restart) stop1 tunnel; stop1 agent; start1 agent; start1 tunnel ;;
  status) for n in agent tunnel; do alive \$n && echo "\$n running (pid \$(cat \$D/run/\$n.pid))" || echo "\$n NOT running"; done
          echo "orders: \$(cat \$D/data/agent.json 2>/dev/null)"; curl -s --max-time 5 __HEALTH__; echo ;;
  logs) tail -n 40 \$D/logs/agent.log \$D/logs/hbserver.log \$D/logs/tunnel.log ;;
  *) echo "usage: \$0 start|stop|restart|status|logs" ;;
esac
CTLEOF
chmod 700 $D/hbctl
printf '# planetCompute heartbeat tunnel: its settings come with the token (set at Cloudflare). This file exists so that\n# cloudflared never reads the default places, e.g. /etc/cloudflared/config.yml of another tunnel on this server.\nno-autoupdate: true\n' > $D/etc/cloudflared.yml
$D/hbctl stop >/dev/null 2>&1 || true
for n in hbserver; do [ -s $D/run/$n.pid ] && kill -- -"$(cat $D/run/$n.pid)" 2>/dev/null; rm -f $D/run/$n.pid; done   # the old layout (no agent)
install -m 700 $D/bin/hbserver.new $D/bin/hbserver && rm -f $D/bin/hbserver.new
install -m 700 $D/bin/hbagent.py.new $D/bin/hbagent.py && rm -f $D/bin/hbagent.py.new
$D/bin/hbserver --version
$D/hbctl start
sleep 2
curl -s --max-time 5 __HEALTH__ || (tail -n 30 $D/logs/hbserver.log; exit 1)
echo
"""

TUNNEL_DIR = r"""
set -e
D=__DIR__
umask 077
cat > $D/etc/tunnel.env <<'TEOF'
TUNNEL_TOKEN=__TOKEN__
TEOF
chmod 600 $D/etc/tunnel.env
$D/hbctl restart
sleep 6
$D/hbctl status
"""

FIREWALL = r"""
set -e
SSHP=__SSHPORT__
if command -v ufw >/dev/null 2>&1 || (command -v apt-get >/dev/null && apt-get install -y -qq ufw >/dev/null 2>&1); then
  ufw allow "$SSHP"/tcp >/dev/null
  for r in __RANGES__; do ufw allow proto tcp from "$r" to any port 443 >/dev/null; done
  ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null
  ufw --force enable >/dev/null
  echo "ufw: SSH $SSHP open, 443 only from Cloudflare ($(ufw status | grep -c ' 443 ') rules)"
elif command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd -q --permanent --add-port="$SSHP"/tcp
  for r in __RANGES__; do firewall-cmd -q --permanent --add-rich-rule="rule family=$( [ "${r#*:}" != "$r" ] && echo ipv6 || echo ipv4 ) source address=$r port port=443 protocol=tcp accept"; done
  firewall-cmd -q --reload
  echo "firewalld: SSH $SSHP open, 443 only from Cloudflare"
else
  echo "WARNING: no ufw or firewalld: port 443 is open to everyone (use your provider's firewall)"
fi
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0], formatter_class=argparse.RawDescriptionHelpFormatter, epilog="\n".join(__doc__.splitlines()[1:]))
    ap.add_argument("--ip", required=True, help="public IPv4 of the server")
    ap.add_argument("--hostname", required=True, help="e.g. hb1.planetcompute.ai")
    ap.add_argument("--key", required=True, help="SSH private key file (stays on this machine)")
    ap.add_argument("--user", default="root")
    ap.add_argument("--ssh-port", type=int, default=22)
    ap.add_argument("--name", default="")
    ap.add_argument("--ipv6", default="")
    ap.add_argument("--provider", default="")
    ap.add_argument("--region", default="")
    ap.add_argument("--instance-type", default="")
    ap.add_argument("--weight", default="50")
    ap.add_argument("--exe", default="", help="the hbserver program to copy (default: the newest green CI build)")
    ap.add_argument("--activate", action="store_true", help="set the server active when it passes the health check")
    ap.add_argument("--no-firewall", action="store_true")
    ap.add_argument("--no-dns", action="store_true")
    ap.add_argument("--tunnel", action="store_true", help="Cloudflare Tunnel: no port opened, firewall untouched (see above)")
    ap.add_argument("--root-dir", default="", help="with --tunnel: keep every file in this folder on the server (see above)")
    a = ap.parse_args()
    a.hostname = a.hostname.lower().strip()
    if a.root_dir and (not a.tunnel or not re.fullmatch(r"/[A-Za-z0-9._/-]+", a.root_dir) or ".." in a.root_dir):
        sys.exit("--root-dir needs --tunnel and an absolute path of letters, digits, . _ - /")
    if not re.fullmatch(r"([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+planetcompute\.ai", a.hostname):
        sys.exit("--hostname must be a name under planetcompute.ai, e.g. hb1.planetcompute.ai")
    if not re.fullmatch(r"(\d{1,3}\.){3}\d{1,3}", a.ip):
        sys.exit("--ip must be an IPv4 address")
    env = load_env()
    secret = env.get("HB_SERVER_SECRET") or sys.exit("HB_SERVER_SECRET missing in ../.env (the website has the same one)")
    if not os.path.exists(os.path.expanduser(a.key)):
        sys.exit(f"no key file {a.key}")

    # 1. reach the server
    rm = Remote(a)
    info = rm.run("uname -m; . /etc/os-release 2>/dev/null; echo \"$PRETTY_NAME\"; nproc; free -m | awk '/Mem/{print $2}'", quiet=True).stdout.split("\n")
    cpu = info[0].strip()
    log(f"server {a.ip}: {info[1].strip()}, {cpu}, {info[2].strip()} CPUs, {info[3].strip()} MB")

    # 2. the program
    data = open(a.exe, "rb").read() if a.exe else ci_program(cpu, env)
    if data[:4] != b"\x7fELF":
        sys.exit("the program is not a Linux executable")
    tmp = os.path.join(HERE, "..", ".ops", "hbserver.upload")
    with open(tmp, "wb") as f:
        f.write(data)
    if a.root_dir:
        rm.run(f"mkdir -p {a.root_dir}/bin && chmod 700 {a.root_dir}", quiet=True)
    rm.put(tmp, f"{a.root_dir}/bin/hbserver.new" if a.root_dir else "/tmp/hbserver.new")
    if a.root_dir:   # the agent: Start / Restart / Stop and automatic restart from the admin page
        rm.put(os.path.join(HERE, "..", "hbserver", "agent", "hbagent.py"), f"{a.root_dir}/bin/hbagent.py.new")
    os.remove(tmp)

    # the table row (same hostname = same server): its ID goes into the server's settings
    t = table(env)
    row = find_row(t, a.hostname)
    sid = row["server_id"] if row else secrets.token_hex(6)
    log(("existing" if row else "new") + f" server row {sid}")

    # 3. install + service
    listen = [f"HB_LISTEN=127.0.0.1:{TUNNEL_PORT}"] if a.tunnel else ["HB_LISTEN=0.0.0.0:443", "HB_TLS_CERT=/etc/hbserver/tls.crt", "HB_TLS_KEY=/etc/hbserver/tls.key"]
    envfile = "\n".join([f"HB_SERVER_SECRET={derived_key(secret, 'hb')}", f"HB_SERVER_ID={sid}", f"HB_SITE={SITE}", *listen,
                         "HB_DATA=/var/lib/hbserver", "HB_INGEST_S=600"])
    log("installing the service" + (" (tunnel mode: 127.0.0.1 only)" if a.tunnel else ""))
    health_url = f"http://127.0.0.1:{TUNNEL_PORT}/health" if a.tunnel else "https://127.0.0.1/health"
    if a.root_dir:
        envfile = envfile.replace("HB_DATA=/var/lib/hbserver", f"HB_DATA={a.root_dir}/data")
        out = rm.run(SETUP_DIR.replace("__DIR__", a.root_dir).replace("__ENV__", envfile).replace("__HEALTH__", health_url)).stdout
    else:
        out = rm.run(SETUP.replace("__HOST__", a.hostname).replace("__ENV__", envfile).replace("__TLS__", "0" if a.tunnel else "1")
                     .replace("__HEALTH__", health_url)).stdout
    version = (re.search(r"hbserver (\S+)", out) or [None, ""])[1]

    if a.tunnel:
        token = tunnel(env, a)
        rm.run((TUNNEL_DIR.replace("__DIR__", a.root_dir) if a.root_dir else TUNNEL).replace("__TOKEN__", token))
    # 4. firewall (not in tunnel mode: nothing is opened)
    if not a.no_firewall and not a.tunnel:
        ranges = cloudflare_ranges()
        rm.run(FIREWALL.replace("__SSHPORT__", str(a.ssh_port)).replace("__RANGES__", " ".join(shlex.quote(r) for r in ranges)))
    if not a.tunnel:
        log("REMINDER: in your provider's firewall (AWS security group / Hetzner Cloud firewall) allow TCP 443 from "
            "Cloudflare's addresses (https://www.cloudflare.com/ips/) and TCP %d from your own address" % a.ssh_port)

    # 5. DNS (tunnel mode: done above, a CNAME to the tunnel)
    if not a.no_dns and not a.tunnel:
        dns(env, a)

    # 6. health through Cloudflare, then the row
    health, err, lat = "down", "", None
    for i in range(24):
        t0 = time.time()
        try:
            j = json.loads(urllib.request.urlopen(urllib.request.Request(f"https://{a.hostname}/health", headers={"User-Agent": "planetcompute-hb"}), timeout=10).read())
            if j.get("ok"):
                health, lat, err = "ok", int((time.time() - t0) * 1000), ""
                break
        except Exception as e:
            err = str(e)[:200]
        time.sleep(5)
    log(f"health through Cloudflare: {health}" + (f" ({lat} ms)" if lat else f" ({err})"))
    now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    who = "startHeartBeatEtcServerOnAnyEC2TypeServer.py"
    item = dict(row or {"server_id": sid, "sk": "SERVER", "role": "heartbeat", "status": "inactive", "created_at": now, "created_by": who})
    item.update({"name": a.name or (row or {}).get("name") or a.hostname.split(".")[0], "hostname": a.hostname, "public_ipv4": a.ip,
                 "public_ipv6": a.ipv6, "provider": a.provider or (row or {}).get("provider", ""), "region": a.region or (row or {}).get("region", ""),
                 "instance_type": a.instance_type or (row or {}).get("instance_type", ""), "ssh_user": a.user, "ssh_port": str(a.ssh_port),
                 "ssh_key_name": os.path.basename(a.key), "weight": str(a.weight), "health": health, "last_check_at": now,
                 "last_error": err, "version": version, "updated_at": now, "updated_by": who})
    if lat is not None:
        item["latency_ms"] = lat
    if health == "ok":
        item["last_ok_at"] = now
        if a.activate:
            item["status"] = "active"
    t.put_item(Item=item)
    log(f"table row {sid}: status {item['status']}, health {health}")
    print(f"\nDONE: {a.hostname} ({a.ip}) runs hbserver {version}.",
          "It takes heartbeats now." if item["status"] == "active" and health == "ok" else
          "Activate it on the admin page (tab Servers) when you are ready." if health == "ok" else
          "It does not answer through Cloudflare yet: check your provider's firewall (TCP 443 from Cloudflare) and run this again.")


if __name__ == "__main__":
    main()
