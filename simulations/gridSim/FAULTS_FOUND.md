# gridSim: results of the first runs and the faults the simulator found (2026-10-21)

Section 15.7 of the project's design notes, copied unchanged. The paper's Section 8 ("Results and faults found")
cites the seven faults below. Paths are relative to the project folder: `gridSim/results/` here is
`simulations/gridSim/results/` in this repository; the runs before the later fixes are in `results/before-15.7abc/`.
The items "Still open" a-c were fixed afterwards (sleepers, admission, late copies): see README.md, "Where the paper's numbers come from".

```
15.7 Results (layer A, gridSim, 2026-10-21)
  Full reports: gridSim/results/<scenario>.json; table: `node gridSim/sim/summary.js`.
  All runs: one simulated hour, 10,000 consumers, demand = 50 % of nominal capacity unless
  stated, pull policy unless stated. idleQ = idle-while-queued, worst lane.

  1 M volunteers (pull-1M; ~917 k online on average, 1.15 M in total; 19 min to simulate):
    idleQ 0.09-0.26 % in every lane; 254,656 jobs finished, none refused, cancelled or stalled;
    time to finish p50/p99: small 71/144 s, medium 111/182 s, large 161/417 s;
    first result p99 20 s; 66 M packs; wrong answers accepted 0; 184,931 cheats caught;
    extra copies (quorum + audit + hedge) 19.4 %; model downloads 0; lane switches 3,476;
    objects: 1,025 lane shards (busiest 5 % busy), 22 lane directories (busiest 41 %),
    ~7,000 jobs (busiest 4 %), 1 planner (<1 %); 20 k WebSocket messages/s in,
    70 k Durable Object requests/s, 15 k ledger writes/s;
    estimated cost ~121 USD per hour (DO duration 49, DO requests 38, DynamoDB writes 33,
    Workers 1; list prices guessed in gridSim/sim/config.js, CHECK before relying on them).

  100 k volunteers, one change at a time (~91 k online):
    scenario            idleQ   stalled  small p99  large p99  note
    pull (baseline)     0.22 %      1      149 s      513 s
    push               32.9 %   4,466      857 s    1,660 s   GRID LOCK: packs stuck in shards whose devices left
    steal               1.47 %      0      151 s      534 s   push + stealing mostly fixes it
    deploy, jitter 30 s 0.51 %      0      150 s      488 s   reconnect peak 3,157/s
    deploy, no jitter   0.32 %      0      153 s      549 s   reconnect peak 91,074/s (at 1 M: ~900 k/s)
    outage 30 %         0.55 %      0      151 s      464 s
    outage, silent      0.57 %      0      190 s      498 s   ghosts found by leases
    burst 2,000 x 50 k  0.41 %     23      154 s      684 s   2,815 refused, 607 gave up; 100 M work-s waiting >30 min
    burst, no admission 0.40 %     16      154 s      607 s
    40 networks only    0.32 %      0      147 s      496 s   quorum of 3 networks still fine with 40
    sleeper cheaters    0.19 %      0      148 s      528 s   5,278 WRONG ANSWERS ACCEPTED
    no job splitting    0.19 %      0      143 s      486 s   fine at 100 k; matters at 1 M
    no rebalancing      0.25 %      0      143 s      479 s   steady load needs no moves
    load 90 %           0.01 %  6,319    1,869 s    2,623 s   overloaded, yet nothing refused

  Bugs and design faults the simulator found and that were fixed in gridSim/core:
    1. one lane directory per lane is a hot spot (67 % busy at 100 k): directories sharded,
       "d:<lane>:<k>", ~50 lane shards each (22 at 1 M, busiest 41 %);
    2. pull wasted 95 % of its requests ("none left"): the directory hands a job out only as
       often as it has batches left; jobs send a heartbeat if passed over;
    3. livelock: a shard told "nothing to do" asked again at once (2,500 msgs/s, directory
       100 % busy): an empty answer now means wait to be woken or for the next summary;
    4. download thrash (11,600 downloads, 31 TB per hour at 100 k): moves prefer devices
       with the model on disk; downloads only for a shortage lasting >= 4 planning rounds whose
       backlog outlasts 3x the download; borrowing stronger devices only for backlog, not
       headroom; returning devices stay where their model is;
    5. a shard waiting forever on a lost request: requests time out after 30 s, and a
       finished job still answers "none";
    6. leases kept in a list per shard: 2.1 M entries at 200 k devices: the lease now lives on
       the device record and is checked on each tick;
    7. a hello arriving after a deploy made a shard talk to a dead socket: the shard sees a close.

  Still open (next fixes, then re-run):
    a. sleepers: a device that earned trust and then cheats passes ~95 % of the time until an
       audit catches it (5,278 wrong at 100 k). Fix ideas: when a device is caught, re-run every
       pack it did since its last passed audit; audit rate falls with reputation slowly, never
       below ~5 %; consumers told which results were re-done.
    b. admission is too lax and too slow: count jobs admitted since the last plan at the
       intake; refuse when the estimated wait passes minutes, not 30 min; reserve credit only
       for admitted work.
    c. late copies (audit/hedge answers after the job finished, ~106 k per hour at 1 M) are
       wasted volunteer work: cancel outstanding copies when a pack is accepted.
    d. ledger writes are the largest single cost after DO duration: roll up less often or
       write per shard, not per device.
    e. the start-up model puts ~917 k online instead of 1 M; raise the population a little.

```
