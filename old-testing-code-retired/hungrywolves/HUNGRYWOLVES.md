# Hungrywolves: Receive Compute on the grid, for testing (and maybe production)

> **RETIRED 30 October 2026.** Replaced by DemandSimulation on an in-house SherpaHub (docs/SHERPAHUB.md, paper section "In-House SherpaHubs"). Kept as a record; see ../README.md.

User, 2026-10-27: "just like heartbeat servers on interserv - add a folder called hungrywolves (these will do the part
of 'receive compute') and these will have the LLMs ... these will consume the resource provided by users 'Contribute
Compute' - so we can see how good that works - compute and receive"; "upto 5 instances per system"; chose "Real grid,
step by step".

## What runs where
- **Hungrywolves** (`/root/REMOTESERVERSACCESS/hungrywolves` on the InterServer, nothing outside the folder): 1-5
  `bin/wolf.py` processes. Each signs in as the workhorse row's account (POST /api/wh/session, signed with
  HB_SERVER_SECRET, like the workhorse agent), then keeps sending chat jobs, POST https://planetcompute.ai/v1/jobs
  (OpenAI chat body: model, messages, max_tokens), every 5-30 s, and writes one JSON line per job to logs/wolf<n>.jsonl.
- **The grid** (website, `worker.js`): the Durable Object "grid:main" keeps the volunteer programs that take jobs
  (their capacity-check socket said hello with `jobs: true` and their downloaded chat models). A job goes to a free
  program with the model (least busy first); when every program with the model is busy it waits in the QUEUE (oldest
  first, at most 2 minutes, at most 500 waiting; GRID_QUEUE_S, GRID_QUEUE_MAX), then 503 "stayed busy"; about one job in four (GRID_CHECK_P), when a second program with the
  model is free, both run it at temperature 0 with the same seed and the answers are compared.
- **Volunteers** (`client/src/contribute.rs`): a planetCompute program contributing in headless mode (the
  workhorse copies first) runs each job on its own llama.cpp, exactly as its local /v1/chat/completions, and answers.

## Credit
WU of a job = (prompt + completion tokens) x the model's GGUF size x 4 / the reference GPU's FLOP/s (~2 FLOP per
weight, ~2 weights per byte at 4-bit). The volunteer gets that WU and the bonus at the rule in force; the receiver's
account gets the same as lifetime_received_uwu (My Balance, Compute Received). A checked job whose answers disagree
credits nobody (it is logged). Step 1 does not yet strike or hold a program over disagreements.

## Control
- Install / update: `python3 scripts/startHungryWolvesOnAnyServer.py --server-id 8f8f9aea090f --wolves 5 [--model ID]`
  (since 2026-10-27 20:05 UTC the wolves sign in through the generouscows row 8f8f9aea090f, so their jobs are the
  account support@planetcompute.ai's; before that the workhorse row cb6de2a66794, account user@example.com.
  The server ID chooses the account: installing with cb6de2a66794 would switch them back)
- On the server: `.../hungrywolves/wolvesctl start [N] | stop | restart [N] | status | logs | stats` (N = 1-5).
- No boot entry (after a reboot: `wolvesctl start`).
- Admin page, tab **Grid jobs**: every job (time, model, result, which computer ran it, checked / agree, tokens,
  wait / run / total ms, WU) and the computers taking jobs now.

## Next steps (not built yet)
Strikes for programs whose checked answers disagree (a third run decides who is wrong); jobs for the browser console;
several grid objects (sharding) for many volunteers; several jobs at once per program (slots).

## Deploying a grid change (pitfall, 2026-10-27)
The grid is ONE Durable Object ("grid:main"). Cloudflare moves an object to new code only when no request is in
flight; 5 wolves keep jobs open (up to 3 minutes each), so after a deploy the OLD grid code kept answering. To deploy a
grid change: `wolvesctl stop` on the server, deploy, wait ~3-4 minutes (the open jobs end), send one job by hand
(the new behaviour answers), then `wolvesctl start`.

## Priority and activity (2026-10-27)
Every wolf job is sent with `"priority": "low"` (the site also treats the user-agent `hungrywolf/...` so): it waits
behind every normal job for the same model, and its details are kept for 1 in 1,000 jobs in the account's activity
(the totals in full). See My Balance, "My activity", signed in as the wolves' account.

## Successor: DemandSimulation (2026-10-30)
The wolves' work is now also a switch of an in-house SherpaHub (admin tab SherpaHubs, DemandSimulation: chat jobs an hour,
pictures a day; the agent sends them, `"priority": "low"`). The plan: run it beside the wolves, compare, then stop the
wolves (`./wolvesctl stop`; the folder stays, `./wolvesctl start` brings them back). Measured 2026-10-30: 5 wolves, about
227 jobs an hour each, all answered. See WORKHORSES.md and WORKPACKS_STATUS_AND_SCIENCE_LANE.md section 13.5-13.6.

