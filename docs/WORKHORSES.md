# Workhorses

Our own always-on Ubuntu servers that run 1 to 6 copies of the planetCompute **server build** and share their compute
with the PlanetCompute pool around the clock, so there is compute for people at any hour. As users share more, lower
or stop them on the admin page.

## The pieces

| Piece | Where | What |
|---|---|---|
| Server build `linux-x86_64-server` | CI (`.github/workflows/client.yml`), B2 `client/<version>/` | planetCompute without the window (Cargo feature `window` off): always headless, no WebKitGTK / GTK needed; CI checks that `ldd` shows no desktop library and runs the local-server test with a real chat model |
| Table `<prefix>Workhorses` | DynamoDB (`CreateTables.py`) | one row per server: name, IP, SSH user / port / key NAME, folder, copies (1-6), cores per copy, cap, account, orders, the agent's last report. No secrets |
| Admin tab **Workhorses** | planetcompute.ai/admin | add / edit / delete a server; Start / Restart / Stop; "restart a copy that stops"; each copy's state, port and device |
| Agent `workhorse/whagent.py` | the server, `DIR/bin/` | runs the copies, reports every 15 s (`POST /api/wh/agent`), follows the orders; gets the copies' sign-in from the website (`POST /api/wh/session`, renewed weekly); both signed with `HB_SERVER_SECRET` |
| `workhorse/whctl` | the server, `DIR/whctl` | `start / stop / restart / status / logs` of the agent (which starts and stops the copies) |
| `scripts/startWorkhorseOnAnyServer.py` | the admin machine (Cloud9) | install or update one server from its row (below) |

## One copy

Copy N (1-6): `HOME=DIR/data/iN` (its own device ID and sign-in), port `port_base + N` (row field `port_base`, empty = 7530;
a second row on the same server, such as the generouscows (retired; old-testing-code-retired/generouscows/GENEROUSCOWS.md), uses its own, e.g. 7540), started as
`planetCompute --headless --port <port> --contribute --cores <cores> --cap <cap>`, log `DIR/logs/iN.log` (cut back past
50 MB). Cores empty on the row: half the machine shared between the copies (on a shared server most of it stays free).
Every copy is a device of the row's account (its Compute Credit goes there); the capacity check credits up to 8 devices
per network, so 6 copies per server stay within it.

## Install or update a server

1. Admin page, Workhorses: add the server (name, IP, SSH user, key NAME as in `~/.ssh/` on the admin machine, copies,
   account email; folder empty = `/root/REMOTESERVERSACCESS/planetcomputeworkhorse`).
2. On the admin machine: `python3 scripts/startWorkhorseOnAnyServer.py --server-id <id>` (add `--boot` to also put ONE
   `@reboot DIR/whctl start` line in the SSH user's crontab; without it nothing outside DIR is touched).
3. The script prints the agent's first report (copies running, cores, load). Later changes of copies / cores / cap and
   Start / Restart / Stop on the admin page reach the server within 15 s.

On the server: `DIR/whctl status`, `DIR/whctl logs`, `DIR/whctl restart`.

## SherpaHub servers (role sherpahub)

A row with `role = sherpahub` (made on the admin tab SherpaHubs, not on Workhorses) runs 1-5 copies as SherpaHubs:
`planetCompute --headless --port <p> --sherpahub` (with SupplySimulation on: also `--contribute --cores N --cap P`); folder default
`/root/REMOTESERVERSACCESS/sherpahubs`; the account must be an admin account. Same install command (with `--boot`:
crontab line tagged `# planetcompute sherpahubs`). See docs/SHERPAHUB.md section 11.

### SupplySimulation and DemandSimulation (2026-10-30)
Two switches on a SherpaHub row (admin tab SherpaHubs, a box under the copies; fleet buttons at the top): the computing is
real, only the users are simulated. SupplySimulation = the copies also contribute (`--contribute --cores N --cap P`), as
the generous cows did; the copies need the models (tab SherpaHubs, Models). DemandSimulation = the agent itself sends test
jobs, as the hungry wolves did: chat jobs an hour (`/v1/jobs`) and pictures a day (`/api/pool/media`), all `"priority":
"low"` (behind real users, not counted, marked "demand"); today's numbers on the tab, one line per job in
`logs/demand.jsonl`. Row fields: supply, cores, cap, demand, demand_chat_per_hour, demand_images_per_day, demand_model,
demand_image_model. Design: WORKPACKS_STATUS_AND_SCIENCE_LANE.md section 13; tests: TESTING.md test 87.

### Rows on the shared server today (2026-10-30, after the wolves and cows were retired)
| Row | Folder | Copies | State |
|---|---|---|---|
| workhorse cb6de2a66794 | planetcomputeworkhorse | 2 x 4 cores, contribute | running |
| SherpaHub d0257f91c822 | sherpahubs | 2 x 4 cores, SupplySimulation on, DemandSimulation 800 chat jobs an hour | running (replaces the cows + wolves) |
| generouscows 8f8f9aea090f | generouscows | 2 x 2 cores | RETIRED 2026-10-30 16:32 UTC: Stop (agent still reports; boots stopped; folder + models kept) |
| hungrywolves (no row; uses the cows' row sign-in) | hungrywolves | 5 scripts | RETIRED 2026-10-30 16:32 UTC: `wolvesctl stop` (no boot line; logs kept) |

A new copy on a row (copies 1 -> 2) has no models yet: give them on the Models panel, or hard-link copy 1's on the server
(TESTING.md test 88 step 8). Raising the copies does not restart the copies already running; changing cores / cap /
SupplySimulation does (an unfinished picture is then lost). Live comparison and switch-over: TESTING.md test 88,
`scripts/compare_demand.py`. Old wolf / cow code and docs: `old-testing-code-retired/`.

