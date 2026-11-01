// Default scenario. Every value can be overridden on the command line: --name value.
export const CLASSES = ['cpu', 'webgpu', 'gpu12', 'gpu24'];

export function defaults() {
  return {
    // scale
    devices: 100000,        // devices ONLINE on average (the population is larger: people come and go)
    consumers: 10000,
    hours: 1,
    load: 0.5,              // consumer demand as a share of the nominal capacity of each lane
    seed: 1,
    // volunteers
    classMix: [0.70, 0.25, 0.04, 0.01],   // browser CPU, browser WebGPU, desktop 12 GB GPU, desktop 24 GB GPU
    onMedian: 2400, onSigma: 1.0,         // session length (s), log-normal
    offMean: 600,                         // time away between sessions (s)
    ramp: 120,                            // devices online at t=0 connect over this many seconds
    networks: 0,                          // distinct network addresses (0 = devices / 3)
    cheaters: 0.02, cheatRate: 0.7,       // share of devices that cheat, share of their answers that are wrong
    sleepers: false,                      // true: cheaters first earned a reputation, then start cheating
    hung: 0.002,                          // share of devices that take a pack and never answer
    trustedAtStart: 0.8,                  // share of devices with a reputation already
    bwMedian: 50,                         // download speed, Mbit/s (log-normal)
    diskLoad: 20,                         // load a model already on disk (s)
    // lanes: model + quantisation + runtime. from = nominal share of each device class.
    lanes: [
      { name: 'cpu.wasm',     minClass: 0, unitTime: 1,   modelGB: 0.01, from: { 0: 1 } },
      { name: 'embed.webgpu', minClass: 1, unitTime: 0.5, modelGB: 0.15, from: { 1: 1 } },
      { name: 'llm8b.gpu12',  minClass: 2, unitTime: 4,   modelGB: 5,    from: { 2: 0.7 } },
      { name: 'sdxl.gpu12',   minClass: 2, unitTime: 6,   modelGB: 7,    from: { 2: 0.3 } },
      { name: 'llm14b.gpu24', minClass: 3, unitTime: 8,   modelGB: 9,    from: { 3: 1 } },
    ],
    // consumers' jobs: work in reference-device seconds, log-normal
    jobMedian: 2000, jobSigma: 1.5, jobMax: 2e6, retries: 3,
    // orchestrator
    policy: 'pull',          // push | steal | pull
    admission: true, rebalance: true, hedge: true, wakeHungry: true,
    split: 5000,             // packs per job part (0 = never split)
    quorum: 3, audit: 0.05, auditNew: 0.3, trustAfter: 20, maxCopies: 8,
    // shardsPerDir 50 -> 25 (2026-10-21): at 1 M the busiest directory peaked at ~820 msgs/s, too close to the
    // ~1,000 requests/s a real Durable Object is advised to take; 25 halves it.
    perShard: 1000, shardsPerDir: 25, prefetch: 0.05, dirJobs: 8, pullBatch: 64,
    tick: 5, flush: 1, jobTick: 10, planTick: 15,
    drain: 120, headroom: 1.25, arrAlpha: 0.05, moveMin: 5, moveCap: 0.05, minDwell: 600,
    checkEvery: 600, checkTime: 3,
    overhead: 3, kappa: 1.5, tauMax: 300,
    maxWait: 300, ttl: 7200, stallAfter: 600, hedgeFrac: 0.05, hedgeAfter: 2,
    // Durable Object service time: per message, plus per item in a batch (s)
    msgCost: 0.0005, itemCost: 0.00002,
    // chaos (times in s; -1 = off)
    deployAt: -1, jitter: 30,
    outageAt: -1, outageFrac: 0.3, outageFor: 600, outageSilent: false,
    burstAt: -1, burstN: 2000, burstLane: 2, burstWork: 50000,
    // faults (design notes 15.11): refused requests between objects (overloaded / restarting), lost
    // WebSocket messages, Durable Object crashes (memory lost), replies lost after delivery (the sender
    // sends again). reliable: 0 = as before (nothing retried), 1 = retries only, 2 = the simple design
    // chosen 2026-10-22 (design notes 15.12): the sender resends until acknowledged + message IDs (repeats
    // dropped) + state saved before acknowledging + job-level pack lease. No queue service, no load balancer.
    faults: false, refuse: 0.01, wsLoss: 0.002, crashPerHour: 0.5, ackLoss: 0.002, restartTime: 2,
    reliable: 2, packLease: 4, packLeaseAdd: 300,
    // reporting
    sample: 10, warmup: 300,
    // Approximate prices (USD). CHECK CURRENT CLOUDFLARE AND AWS PRICING before relying on them.
    price: { workerReqM: 0.30, doReqM: 0.15, wsRatio: 20, doGBs_M: 12.5, doGB: 0.128, ddbWriteM: 0.625 },
  };
}
