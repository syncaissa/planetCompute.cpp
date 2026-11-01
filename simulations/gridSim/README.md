# gridSim: the PlanetCompute orchestrator and a simulator to test it at a million devices

How should 10,000 consumers' jobs reach 1,000,000 volunteers' devices through Cloudflare Durable
Objects without grid locks (work waiting while devices sit idle), hot objects, or runaway cost?
This folder holds the answer as code, plus a discrete-event simulator to measure it.
Design notes: `howWorkPacksNeedtoBeDesigned.txt`, Sections 11, 14 and 15.

## Status and next steps

See `howWorkPacksNeedtoBeDesigned.txt` Section 15.7 (results), 15.8 (the RunPod test) and
15.9 (where we are, how to resume). In short: this simulator is layer A. Next: fix the open
items in 15.7, wrap `core/` as Durable Objects in a staging Worker (layer B), then the RunPod
test with two simulators around that real orchestrator:

```
planetComputeHarness_Simulator  --HTTP /v1/jobs-->  staging Worker + Durable Objects  <--WebSocket /v1/provider--  planetComputeContributor_Simulator
(10,000 consumers, 1 CPU pod)                   (real orchestrator = core/ classes)                         --mode load    fake devices, 25-35 CPU pods for 1 M
                                                                                                            --mode gpu     real llama.cpp, 20-50 GPU pods
                                                                                                            --mode browser real /contribute tabs, 1-2 CPU pods
```

## Layout

```
core/            the orchestrator: plain classes, one handle(message, ctx) method each
  shard.js       LaneScheduler shard "s:<lane>:<k>": ~1,000 devices' sockets, packs, leases, capacity checks
  job.js         JobCoordinator "j:<n>[#part]": pack sizing, quorum/audit, hedging, time-to-live
  directory.js   lane directory "d:<lane>:<k>": shard summaries, which jobs have work, fair hand-out
  plan.js        planner "plan": devices per lane and class, moves, the published plan
  intake.js      the stateless gateway Worker: places devices, admits and splits jobs
  sizing.js      square-root-law pack size, class speeds, hashes
sim/             the world around it
  world.js       event queue, latency, Durable Object service-time model, devices, consumers, chaos
  config.js      every parameter of a scenario (override with --name value)
  run.js         run one scenario, print a report, write results/<name>.json
  scenarios.sh   the standard set of scenarios
  summary.js     one table from all results/*.json
results/         reports (JSON) and logs
```

The core never touches clocks, the network or storage: it only calls `ctx.send`, `ctx.device`,
`ctx.timer`, `ctx.spawn`, `ctx.exit` and `ctx.rand`. A Durable Object wrapper maps those to
`stub.fetch`, WebSocket `send`, `setAlarm` and `storage`, so what the simulator tests is what ships.

## Run

Node 20 or later, nothing to install.

```
node sim/run.js --devices 100000 --consumers 10000 --hours 1 --name pull-100k                       # about 1.5 min
node --max-old-space-size=6200 sim/run.js --devices 1000000 --consumers 10000 --name pull-1M        # 1M devices
node sim/run.js --devices 100000 --policy push --name push-100k                                     # compare policies
node sim/run.js --devices 100000 --deployAt 1800 --jitter 0 --name deploy-storm                     # chaos
bash sim/scenarios.sh                                                                               # the standard set
```

## What the report shows

- per lane: average devices, share of time busy, and **idle-while-queued** (device time idle while
  packs for that lane were waiting anywhere): the grid-lock metric, which should stay near 0;
- jobs submitted, refused (and why), finished, cancelled by time-to-live, stalled (no progress for
  10 min), time to finish by size and time to first result (median, 95th, 99th percentile);
- checking: extra copies for quorum, audit and hedging; wrong answers accepted; cheaters caught;
- devices: packs, capacity checks, model downloads (GB), lane switches, devices removed;
- the busiest object of each kind (messages per second, share of time busy), messages per second
  by kind, the reconnect peak, ledger writes per second;
- an estimated Cloudflare + DynamoDB cost per hour. The prices are in `sim/config.js`;
  **check current pricing** before relying on them.

## Model, briefly

- Devices: 70 % browser CPU, 25 % browser WebGPU, 4 % 12 GB GPU, 1 % 24 GB GPU; log-normal speeds,
  log-normal sessions (median 40 min) and 10 min away on average; a network address shared by
  about three devices; 2 % cheaters, 0.2 % that take a pack and never answer.
- Lanes (model + runtime): CPU WASM, WebGPU embeddings, 8 B LLM, SDXL, 14 B LLM.
- Consumers: jobs arrive at random; their size is log-normal (median 2,000 device-seconds, a heavy tail
  up to 2 M); demand per lane is `load` x its nominal capacity.
- Durable Objects: single-threaded, 0.5 ms per message plus 0.02 ms per item in a batch, so a hot
  object queues up as it would on Cloudflare; 2-10 ms between objects, ~40 ms to a device.
