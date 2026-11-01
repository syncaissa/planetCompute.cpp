// One table from results/*.json:   node sim/summary.js [name-filter]
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'results');
const filter = process.argv[2] || '';
const f = (x, d = 0) => x === null || x === undefined ? '-' : Number(x).toFixed(d);
const rows = [];
for (const file of readdirSync(dir).filter(n => n.endsWith('.json') && n.includes(filter)).sort()) {
  const o = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const devs = o.lanes.reduce((s, l) => s + l.devices, 0);
  const iwq = Math.max(...o.lanes.map(l => l.idleWhileQueued)) * 100;
  const refused = Object.values(o.jobs.rejected).reduce((a, b) => a + b, 0);
  rows.push([o.name, devs, f(iwq, 2), o.jobs.finished, refused, o.jobs.cancelled, o.jobs.stalled,
    f(o.timesSeconds.small.p50), f(o.timesSeconds.small.p99), f(o.timesSeconds.large.p99), f(o.timeToFirstResult.p99),
    o.jobs.wrongAccepted, f(o.jobs.extraCopiesShare * 100, 1), o.devices.modelDownloads, o.devices.laneSwitches,
    f(Math.max(...Object.entries(o.peaks).filter(([k]) => k !== 'worker').map(([, p]) => p.util)) * 100),
    o.reconnectPeakPerSecond, f(o.costPerHourUSD_estimate.total)]);
}
const head = ['scenario', 'devices', 'idleQ%max', 'finished', 'refused', 'ttl', 'stalled', 'small p50', 'small p99',
  'large p99', '1st p99', 'wrong', 'extra%', 'downloads', 'switches', 'hotDO%', 'reconn/s', '$/h est'];
const w = head.map((h, k) => Math.max(h.length, ...rows.map(r => String(r[k]).length)));
console.log(head.map((h, k) => h.padStart(w[k])).join('  '));
for (const r of rows) console.log(r.map((x, k) => (k ? String(x).padStart(w[k]) : String(x).padEnd(w[k]))).join('  '));
