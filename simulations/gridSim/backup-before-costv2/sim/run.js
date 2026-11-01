// Run one scenario and print a report.
//   node --max-old-space-size=6000 sim/run.js --devices 1000000 --consumers 10000 --policy pull --name base
// Any value in sim/config.js can be overridden with --name value (true/false for switches).
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaults, CLASSES } from './config.js';
import { World } from './world.js';

const cfg = defaults();
const argv = process.argv.slice(2);
let name = '';
for (let k = 0; k < argv.length; k++) {
  const key = argv[k].replace(/^--/, ''), v = argv[k + 1];
  if (key === 'name') { name = v; k++; continue; }
  if (!(key in cfg)) { console.error(`unknown option --${key}`); process.exit(2); }
  k++;
  cfg[key] = v === 'true' ? true : v === 'false' ? false : isNaN(+v) ? v : +v;
}
name ||= `${cfg.policy}-${cfg.devices}`;

const wall0 = Date.now();
const world = new World(cfg);
console.log(`${name}: ${world.N.toLocaleString()} volunteers (${cfg.devices.toLocaleString()} online on average), ` +
  `${cfg.consumers.toLocaleString()} consumers, ${cfg.hours} h, policy ${cfg.policy}, load ${cfg.load}`);
const end = cfg.hours * 3600;
world.run(end, w => {
  let on = 0; for (let i = 0; i < w.N; i++) on += w.on[i];
  const jobs = [...w.actors.values()].filter(a => a._type === 'job').length;
  let pending = 0; for (const b of w.buckets.values()) pending += b.length;
  const heap = process.memoryUsage().heapUsed / 1e9;
  console.log(`  t=${Math.round(w.now)}s  online ${on}  jobs ${jobs}  events ${(w.events / 1e6).toFixed(1)}M  queued ${(pending / 1e6).toFixed(2)}M  heap ${heap.toFixed(2)} GB  wall ${((Date.now() - wall0) / 1000).toFixed(0)}s`);
});

// ---- report --------------------------------------------------------------------------------
const m = world.m, NL = world.NL, simS = end, perHour = 3600 / simS;
const pct = (a, p) => { if (!a.length) return null; const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r1 = x => x === null ? '-' : x < 10 ? x.toFixed(1) : Math.round(x).toLocaleString();
const lanes = cfg.lanes.map((l, L) => ({
  lane: l.name,
  devices: Math.round(m.devSec[L] / Math.max(1, simS - cfg.warmup)),
  utilisation: m.busySec[L] / Math.max(1, m.devSec[L]),
  idleWhileQueued: m.iwq[L] / Math.max(1, m.devSec[L]),
}));
const J = m.jobs, P = cfg.price;
const cost = {
  workers: m.workerReq * P.workerReqM / 1e6 * perHour,
  doRequests: (m.doReq + m.wsIn / P.wsRatio) * P.doReqM / 1e6 * perHour,
  doDuration: m.doActive * P.doGB * P.doGBs_M / 1e6 * perHour,
  dynamoWrites: m.ledgerWrites * P.ddbWriteM / 1e6 * perHour,
};
cost.total = cost.workers + cost.doRequests + cost.doDuration + cost.dynamoWrites;
let connPeak = 0, connPeakAt = 0;
m.connPerSec.forEach((n, s) => { if (n > connPeak && s > cfg.ramp + 5) { connPeak = n; connPeakAt = s; } });
const out = {
  name, cfg: { ...cfg, lanes: undefined, initialPlan: undefined, price: undefined }, population: world.N,
  wallSeconds: (Date.now() - wall0) / 1000, events: world.events,
  lanes,
  jobs: { submitted: m.submitted, rejected: m.rejected, gaveUp: m.gaveUp, finished: J.done, cancelled: J.cancelled,
    stalled: J.stalled, stillRunning: world.roots.size,
    extraCopiesShare: J.packs ? J.copies / J.packs - 1 : 0, hedges: J.hedges, wrongAccepted: J.wrong, cheatersCaught: J.caught, forced: J.forced,
    // 15.7 a: wrong answers still in delivered results = accepted wrong - corrected after delivery
    wrongFixedBeforeDelivery: J.fixed, packsRedoneInJob: J.redone, packsRedoneAfterDelivery: m.redoLate,
    wrongCorrectedAfterDelivery: m.lateFixed, wrongDeliveredUncorrected: J.wrong - m.lateFixed,
    // 15.7 c: copies answered after their pack was accepted (wasted), and copies stopped instead
    lateCopies: J.late, cancelMessages: J.cancels, copiesStopped: m.cancelledRuns, workStoppedSeconds: Math.round(m.cancelledWork) },
  timesSeconds: Object.fromEntries(Object.entries(m.times).map(([k, a]) => [k, { n: a.length, p50: pct(a, 0.5), p95: pct(a, 0.95), p99: pct(a, 0.99) }])),
  timeToFirstResult: { p50: pct(m.ttfr, 0.5), p95: pct(m.ttfr, 0.95), p99: pct(m.ttfr, 0.99) },
  creditLockedInOldJobsMax: m.lockedMax,
  devices: { packsRun: m.packsRun, capacityChecks: m.checks, modelDownloads: m.downloads, downloadGB: m.dlGB,
    diskLoads: m.diskLoads, laneSwitches: m.switches, kicked: m.kicks, plannerMoves: world.actors.get('plan').moves },
  peaks: m.peak, reconnectPeakPerSecond: connPeak, reconnectPeakAt: connPeakAt,
  perSecond: { wsIn: m.wsIn / simS, doRequests: m.doReq / simS, workerRequests: m.workerReq / simS, ledgerWrites: m.ledgerWrites / simS },
  messagesByType: Object.fromEntries(Object.entries(m.byMsg).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v / simS)])),
  droppedMessages: m.dropped, droppedBy: m.droppedBy,
  faults: cfg.faults ? { ...m.f, lostTotal: Object.values(m.f.lost).reduce((a, b) => a + b, 0),
    dupDeliveredTotal: Object.values(m.f.dupDelivered).reduce((a, b) => a + b, 0),
    creditMissing: m.f.creditSent - m.f.creditRecv, storageWritesPerSecond: m.f.storageWrites / simS } : null,
  costPerHourUSD_estimate: cost,
  series: { columns: ['t', ...cfg.lanes.map(l => 'n:' + l.name), ...cfg.lanes.map(l => 'idle:' + l.name), ...cfg.lanes.map(l => 'queued:' + l.name), 'jobs'], rows: m.series },
};
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'results');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${name}.json`), JSON.stringify(out, null, 1));

console.log(`\n== ${name}  (${out.wallSeconds.toFixed(0)} s wall, ${(world.events / 1e6).toFixed(1)} M events)`);
console.log('lane            devices   busy   idle-while-queued');
for (const l of lanes) console.log(`${l.lane.padEnd(15)} ${String(l.devices).padStart(8)}  ${(100 * l.utilisation).toFixed(1).padStart(5)}%  ${(100 * l.idleWhileQueued).toFixed(2).padStart(6)}%`);
const jj = out.jobs;
console.log(`jobs: ${jj.submitted} submitted, ${jj.finished} finished, ${jj.cancelled} cancelled (ttl), ${jj.stalled} stalled >${cfg.stallAfter}s, ${jj.stillRunning} running at end, ` +
  `refused ${JSON.stringify(jj.rejected)}, gave up ${jj.gaveUp}`);
console.log('time to finish (s)  ' + Object.entries(out.timesSeconds).map(([k, v]) => `${k}: n=${v.n} p50 ${r1(v.p50)} p95 ${r1(v.p95)} p99 ${r1(v.p99)}`).join(' | '));
console.log(`time to first result (s): p50 ${r1(out.timeToFirstResult.p50)} p95 ${r1(out.timeToFirstResult.p95)} p99 ${r1(out.timeToFirstResult.p99)}`);
console.log(`checking: extra copies ${(100 * jj.extraCopiesShare).toFixed(1)}%, hedges ${jj.hedges}, wrong accepted ${jj.wrongAccepted}, cheats caught ${jj.cheatersCaught}, forced ${jj.forced}`);
console.log(`cheats: wrong delivered uncorrected ${jj.wrongDeliveredUncorrected} (accepted ${jj.wrongAccepted}, fixed before delivery ${jj.wrongFixedBeforeDelivery}, corrected after ${jj.wrongCorrectedAfterDelivery}); redone in job ${jj.packsRedoneInJob}, after delivery ${jj.packsRedoneAfterDelivery}; late copies ${jj.lateCopies}, stopped ${jj.copiesStopped} (${jj.workStoppedSeconds} work-s)`);
const d = out.devices;
console.log(`devices: ${d.packsRun.toLocaleString()} packs, ${d.capacityChecks.toLocaleString()} checks, ${d.modelDownloads} downloads (${Math.round(d.downloadGB)} GB), ${d.laneSwitches} lane switches, ${d.kicked} kicked`);
console.log('busiest objects (peak msgs/s, peak busy share):');
for (const [t, p] of Object.entries(m.peak)) console.log(`  ${t.padEnd(7)} ${r1(p.rate).padStart(7)}/s ${p.rateId.padEnd(16)} busy ${(100 * p.util).toFixed(0).padStart(4)}% ${p.utilId}  (${p.count} objects at end)`);
console.log('DO messages per second by kind: ' + Object.entries(out.messagesByType).slice(0, 12).map(([k, v]) => `${k} ${v}`).join(', '));
console.log(`reconnect peak ${connPeak}/s at t=${connPeakAt}s; per second: ws in ${r1(out.perSecond.wsIn)}, DO requests ${r1(out.perSecond.doRequests)}, ledger writes ${r1(out.perSecond.ledgerWrites)}`);
console.log(`credit locked in jobs older than 30 min (max): ${Math.round(m.lockedMax).toLocaleString()} work-seconds; dropped messages ${m.dropped} ${JSON.stringify(m.droppedBy)}`);
if (out.faults) {
  const F = out.faults;
  console.log(`faults (reliable ${cfg.reliable}): refused ${F.refused} (retried ${F.retries}, lost ${F.lostTotal} ${JSON.stringify(F.lost)}), ` +
    `ws lost ${F.wsLost} (resent ${F.wsResent}), crashes ${JSON.stringify(F.crashes)}`);
  console.log(`  LOST: jobs ${F.jobsLost} (parts ${F.partsLost}), packs in shards ${F.packsLostInShards}, results in shards ${F.resultsLostInShards}, ` +
    `credit units ${F.creditMissing} of ${F.creditSent}; DOUBLE: processed twice ${F.dupDeliveredTotal} ${JSON.stringify(F.dupDelivered)}, ` +
    `duplicates dropped ${F.dupDropped}; pack leases ${F.leases}; storage writes ${r1(F.storageWritesPerSecond)}/s`);
}
console.log(`estimated Cloudflare+DynamoDB cost per hour (check prices): $${cost.total.toFixed(2)} ` +
  `(workers ${cost.workers.toFixed(2)}, DO requests ${cost.doRequests.toFixed(2)}, DO duration ${cost.doDuration.toFixed(2)}, writes ${cost.dynamoWrites.toFixed(2)})`);
void CLASSES;
