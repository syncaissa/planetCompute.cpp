# Old testing code (retired 30 October 2026)

Before the in-house SherpaHub existed, two groups of programs on one rented Ubuntu server tested the live grid:

| Folder | What it was | Replaced by |
|---|---|---|
| [`hungrywolves/`](hungrywolves/HUNGRYWOLVES.md) | 1-5 Python scripts (`wolf.py`, controlled by `wolvesctl`, installed by `startHungryWolvesOnAnyServer.py`) that signed in as a user and kept sending chat jobs to the grid (`POST /v1/jobs`), logging every answer | **DemandSimulation** on an in-house SherpaHub (`workhorse/whagent.py`, class `Demand`) |
| [`generouscows/`](generouscows/GENEROUSCOWS.md) | a Workhorses row running 2 copies of the planetCompute server build that always contributed, so a job got an answer at any hour | **SupplySimulation** on an in-house SherpaHub (the copies run `--sherpahub --contribute --cores N --cap P`) |

Why they were retired: an in-house SherpaHub with both switches ran beside them for about eight hours on
30 October 2026 (07:45-15:42 UTC). Hungry wolves: 5,769 chat jobs (730 an hour), 99.9% answered, median 3.2 s.
DemandSimulation: 4,384 chat jobs (555 an hour), 99.8% answered, median 3.5 s; both answered by the same five
volunteer computers, and the SherpaHub's own copy answered grid jobs too. The paper has the full comparison
(section "In-House SherpaHubs", table "Hungry wolves and DemandSimulation side by side").

This code is kept as a record of how the grid was first tested. It is not maintained, and its paths assume the
old layout (`hungrywolves/`, `scripts/`, `docs/` at the top of the repository), so it does not run from here as it is.
