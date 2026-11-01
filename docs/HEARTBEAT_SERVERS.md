# Heartbeat servers

Our own always-on servers ("EC2-type": AWS EC2, Hetzner, DigitalOcean, any Linux machine) that take the volunteers'
heartbeats first. When none is running, volunteers report to the website as before, so nothing depends on them.
Why: at a million volunteers, heartbeats sent straight to the website are a large share of the Worker-request and
DynamoDB bill; through our servers the website handles one batch per server instead of one request per volunteer
(see "Next step").

Built 2026-10-26. Website live from version 9bb6846f; server program `hbserver/`; install script
`scripts/startHeartBeatEtcServerOnAnyEC2TypeServer.py`; test 25 in `docs/TESTING.md`.

## How it works

```
 volunteer (website console or planetCompute app)
   1. GET  planetcompute.ai/api/hb/config?device=<id>   (signed in)
        <- { servers: ["https://hb1.planetcompute.ai", ...], token: <pass for this device, 1 day>, until }
           servers = active rows of the table that pass the health check; [] when none (or no shared secret)
   2. every 5 min working / 15 min idle:
        POST https://hb1.planetcompute.ai/beat   Authorization: Bearer <pass>   body = the usual report
        -> 200 {ok, via: "server"}                         done
        -> anything else, or no answer in 5 s              next server, then the website:
        POST planetcompute.ai/api/volunteer/heartbeat      (the path used before; always works)

 hbserver (Rust, behind Cloudflare's proxy, port 443 open only to Cloudflare)
   - checks the pass itself (HMAC with HB_SERVER_SECRET: no database)
   - keeps the newest beat per device and session (a beat carries the session's running totals), appends it to a
     journal on disk (/var/lib/hbserver/journal.jsonl: a restart or crash loses nothing)
   - every 10 minutes (HB_INGEST_S 600), and at once when a device pauses or stops:
        POST planetcompute.ai/api/hb/ingest   x-hb-sig: <time>.<HMAC("ingest|<time>|<body>")>
        body { server_id, beats: [{token, at, ip, country, beat}] }   at most 100 per request
 website (/api/hb/ingest)
   - checks the signature (5-minute window), each pass, the time and that the beat is for the pass's device
   - runs each beat through the SAME heartbeat() as a direct report, with the server's receive time and the
     volunteer's address and country: credit is the verified capacity x the time since the device's last report
     (at most 30 minutes for server beats), sessions and balances as before; a beat not newer than the device's last
     one is skipped, so a resent batch counts once
```

Hourly (Cron Trigger `17 * * * *`): every active server is health-checked (`GET https://<hostname>/health`).
When none is active and healthy, the admins (ADMIN_EMAILS) get the email "No heartbeat server is running", at most
once a day (default), week or month, or never: set on the admin page.

## The table: planetcompute-ai-HeartbeatEtcEC2TypeServers

One row per server (`server_id` 12 hex, `sk` "SERVER"), plus the settings row (`server_id` "_settings", `sk`
"SETTINGS": `alert_every`, `last_alert_at`). Created by `CreateTables.py`; point-in-time recovery and delete protection on.

| Field | Meaning |
|---|---|
| name, role | e.g. hetzner-1; role "heartbeat" |
| status | active / inactive (a new server starts inactive) |
| hostname | the HTTPS name volunteers use; must be under planetcompute.ai (the pages may only connect there) |
| public_ipv4, public_ipv6 | the machine's addresses (DNS points the hostname at them) |
| provider, region, instance_type | where it runs |
| ssh_user, ssh_port, ssh_key_name | how the admin reaches it; only the NAME of the key file |
| weight | 0-100, higher is tried first |
| health, last_check_at, last_ok_at, last_error, latency_ms, version | the last health check |
| last_ingest_at, beats_in | the last batch it handed in, beats handed in so far |
| notes, created_at/by, updated_at/by | |

**No secrets in the table.** The SSH private key stays on the admin machine (Cloud9 `~/.ssh`, chmod 600); the admin
tab refuses anything that looks like a key. The secret shared by the website and the servers, `HB_SERVER_SECRET`, is
a Worker secret and a line in `../.env`; the install script writes it to `/etc/hbserver/hbserver.env` (mode 600) on
each server through SSH's input, never on a command line.

## Admin page, tab Servers

Add a server (name, hostname, addresses, provider, SSH user/port/key name, weight, notes), edit it, activate or
inactivate it, "Check now" (health check), delete it from the list (the machine is not touched). The reminder email:
once a day / a week / a month / never, "Check now (and email if none runs)", and the time of the last email.
API (admins only): `GET /api/admin/servers`; `POST /api/admin/servers/save | status | check | delete | settings |
alert-test | control | autorestart`.

## Setting up a server

Requirements: a Linux machine (Ubuntu/Debian with ufw, or a firewalld system) with a public IPv4, SSH access with a
key, and in your provider's own firewall (AWS security group, Hetzner Cloud firewall) TCP 443 open from Cloudflare's
addresses (https://www.cloudflare.com/ips/) and SSH from your address. 1 vCPU / 1 GB is plenty to start; the program
is a single static file.

From `planetCompute-CPP/` on Cloud9:

```
python3 scripts/startHeartBeatEtcServerOnAnyEC2TypeServer.py --ip 203.0.113.10 --hostname hb1.planetcompute.ai \
    --key ~/.ssh/planetcompute_hb --user ubuntu --name hetzner-1 --provider Hetzner --region fsn1 --activate
```

It reaches the server over SSH; takes the program from the newest green CI build ("Heartbeat server" workflow,
artifact hbserver-linux-x86_64 or -aarch64; or `--exe <file>`); creates user `hbserver`, `/opt/hbserver/hbserver`,
`/var/lib/hbserver`, a self-signed TLS certificate (Cloudflare's SSL mode for planetcompute.ai is "Full", which
accepts it; "Full (strict)" would not), `/etc/hbserver/hbserver.env`, and a systemd service with `Restart=always`
that starts at boot; sets the firewall (SSH stays open, 443 only from Cloudflare, so the volunteer address Cloudflare
passes on can be trusted); points the hostname at the server in Cloudflare DNS (proxied); writes the table row (same
hostname = same row); checks `https://<hostname>/health` through Cloudflare and, with `--activate`, makes it active.
Run it again to update the program or the settings.

### A server that already runs other things: `--tunnel --root-dir`

For a shared machine (containers, other services, another Cloudflare Tunnel) use

```
python3 scripts/startHeartBeatEtcServerOnAnyEC2TypeServer.py --ip <ip> --hostname hbN.planetcompute.ai \
    --key ~/.ssh/<key> --user root --name <name> --tunnel --root-dir /root/REMOTESERVERSACCESS/planetcompute
```

- **No port is opened and the firewall is not touched.** hbserver listens on 127.0.0.1:18443 only (plain HTTP), and
  planetcompute's own Cloudflare Tunnel (`planetcompute-<first label of the hostname>`, created through the API, its
  route set at Cloudflare) carries `https://hbN.planetcompute.ai` to it; DNS is a proxied CNAME to the tunnel.
- **Everything is in one folder**, nothing outside it: `bin/hbserver`; `etc/hbserver.env`, `etc/tunnel.env`,
  `etc/cloudflared.yml` (mode 600; the last one exists so cloudflared never reads the default places such as another
  tunnel's `/etc/cloudflared/config.yml`); `data/` (the journal, and HOME of both processes); `logs/`; `run/` (pids);
  `hbctl`. No system user, no systemd unit, no cron entry, no kernel settings. Its `cloudflared` is our own pinned copy, `bin/cloudflared` (version CF_VER in the install script, SHA-256 checked; 2026.10.4 since 2026-10-26, after Cloudflare's notice that versions before 2026.10.2 trust compromised eMudhra certificates). A `cloudflared` already on the server is neither used nor changed.
- `hbctl start | stop | restart | status | logs` runs hbserver and the tunnel, each under a loop that starts it again
  2 s after it stops (logs cut back past 50 MB). It does not start by itself after a reboot unless the owner allows
  one entry outside the folder; on storage-bz-1 that is ONE line in root's crontab (added 2026-10-26 at the owner's
  request; root had no crontab before, the previous state is kept in `etc/root-crontab.before-boot-entry`):
  `@reboot sleep 20; /root/REMOTESERVERSACCESS/planetcompute/hbctl start >> /root/REMOTESERVERSACCESS/planetcompute/logs/boot.log 2>&1`.
  To remove it: `crontab -e` and delete that line.

### Servers in use

| Name | Hostname | Machine | Mode | Since |
|---|---|---|---|---|
| storage-bz-1 (row 75be3101b7e0) | hb1.planetcompute.ai | 203.0.113.10 (process.storage.bz), Ubuntu 24.04, 16 cores, 128 GB, shared with other work | tunnel, all files in `/root/REMOTESERVERSACCESS/planetcompute` (owner's rule: nothing else on this server is touched) | 2026-10-26, active after an end-to-end check (forged pass 401, genuine 200, handed in and recorded by the website in 12 s) |

### Start / Restart / Stop from the admin page

Each server row on the tab Servers has **Start**, **Restart** and **Stop** buttons and the box **"Restart
automatically if it stops or crashes (not after Stop here)"** (on by default), with a line showing the program's state
as its agent last reported it (running / stopped / crashed, pid, since when, restarts, last exit, tunnel, how long ago
the agent reported; "NOT REPORTING" after 90 s means the machine or its agent is down).

The website cannot reach into a machine, so a small **agent** does it (`hbserver/agent/hbagent.py`, Python standard
library, installed in one-folder mode as `bin/hbagent.py`; `hbctl` runs the agent and the tunnel, the agent runs the
heartbeat program as its child). Every 15 s it reports to `POST /api/hb/agent` (signed like the batches,
`x-hb-sig: <time>.<HMAC("agent|<time>|<body>")>`) and gets the orders back:
- **Stop** sets the server's `desired_state` to stopped: the program is stopped and stays stopped, also with automatic
  restart on, until Start or Restart.
- **Start / Restart** set `desired_state` running and a new command number (`cmd_seq`, `cmd`): each number is carried
  out once; Restart replaces a running process.
- **Automatic restart** on: a crash, or any stop that was not the admin's Stop, is restarted after 2 s; off: the
  program stays down and is reported "crashed" with its exit code until Start or Restart.
- When the agent starts (boot, `hbctl start`) it starts the program unless the last order was Stop. Without an answer
  from the website it keeps its last orders (`data/agent.json`).
Orders take effect within about 15-30 s. Stop / Start act on the PROGRAM on the machine; Activate / Inactivate only
decide whether volunteers are sent to the server.

## Running it

| Task | Command (on the server) |
|---|---|
| state, recent log | `systemctl status hbserver`, `journalctl -u hbserver -n 50` (one-folder mode: `<folder>/hbctl status`, `<folder>/hbctl logs`) |
| health | `curl -sk https://127.0.0.1/health` (pending = beats not yet handed in) |
| restart | `systemctl restart hbserver` (the journal keeps every beat) |
| stop using it | admin tab: Inactivate (volunteers move to the website or the other servers within 30 minutes) |
| update the program | run the install script again |

A server that dies: volunteers notice at their next beat (no answer in 5 s) and report to the website; the website
stops offering it after its next health check (at most 2 minutes for new volunteers, the hourly check otherwise);
its unsent beats are on its disk and are handed in when it comes back (a beat older than the device's newest report
is skipped; the newer report already carries the session's running totals). No credit is lost when a server fails
(website fix of 2026-10-26): the device record notes whether its last report came through a server (`last_via`),
and the first direct report after that may cover the server's hand-in window (up to 30 minutes) instead of the
normal 10; it is still never more than the verified capacity times the time that really passed.

## Testing

- Website side: `node scripts/test_hb_servers.mjs website/worker.js` (TESTING.md test 25, 32 checks).
- Heartbeat ledger, unchanged: TESTING.md test 8 on the staging copy (15 checks).
- The program: the CI workflow "Heartbeat server" (health, genuine pass 200, forged pass 401, other device 403,
  browser preflight, a beat kept across a restart).

## Limits and next step

- The website still does the accounting, once per device per 10 minutes instead of every 5: DynamoDB stays the
  largest cost at a million working volunteers. Next: the server keeps the accounting itself (verified capacity from
  the website once an hour) and hands in only credit totals and session rows, which cuts that cost again.
- A server has to hand beats in within 15 minutes of receiving them (the website's "active" window is 20 minutes,
  credit per beat at most 30). `HB_INGEST_S` is limited to 900.
- Browsers only talk to names under planetcompute.ai (the page's content-security-policy); the app has no such limit
  but also uses only those.
- One shared secret for all servers: changing it means setting the Worker secret and re-running the install script
  on every server.
