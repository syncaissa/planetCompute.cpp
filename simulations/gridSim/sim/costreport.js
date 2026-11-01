// Cost table from finished runs (results/<name>.json), with the volunteers' heartbeats added (CostOfComputeCFetc.txt).
//   node sim/costreport.js cost-v1-100k:site cost-v2-lease1800-100k:ws300 ...      (<run>:<heartbeat style>)
// Heartbeat styles, per online device:
//   site    the live website until 2026-10-26: POST /api/volunteer/heartbeat once a minute = 1 Worker request, 1
//           strongly consistent DynamoDB read and ~1.8 write units (device row 1; live index moves every 5 min = 2 units
//           per 5 beats; profile last_seen every 5 min = 1 per 5; session row + balance every 10 min = 2 per 10)
//   site2   the live website since 2026-10-26 (586b235e), every device working: a beat every 5 min, ~2.08 write units
//           (row 1; index every 20 min 0.5; profile 0.25; session row + balance every 30 min 0.33)
//   site2i  the same, every device idle: a beat every 15 min, ~4.25 write units (1 + 1.5 + 0.75 + 1)
//   ws60    a message on the open WebSocket once a minute (billed at 1/20 of a request), no database
//   ws300   the same every 5 minutes (the low-cost design)
// Prices as in sim/config.js plus DynamoDB reads ($0.125 per million, on-demand): CHECK CURRENT PRICES.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaults } from './config.js';

const P = { ...defaults().price, ddbReadM: 0.125 };
const HB = {
  site: (n) => { const b = n * 3600 / 60; return b * (P.workerReqM + P.ddbReadM + 1.8 * P.ddbWriteM) / 1e6; },
  site2: (n) => { const b = n * 3600 / 300; return b * (P.workerReqM + P.ddbReadM + 2.08 * P.ddbWriteM) / 1e6; },
  site2i: (n) => { const b = n * 3600 / 900; return b * (P.workerReqM + P.ddbReadM + 4.25 * P.ddbWriteM) / 1e6; },
  ws60: (n) => n * 3600 / 60 / P.wsRatio * P.doReqM / 1e6,
  ws300: (n) => n * 3600 / 300 / P.wsRatio * P.doReqM / 1e6,
};
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'results');
const f = (x) => x.toFixed(2).padStart(8);
console.log('run                          hb      online  orchestr.v1 orch.billed heartbeat   total/h  per month 24x7  x10 (1M) per month');
for (const arg of process.argv.slice(2)) {
  const [name, hb] = arg.split(':');
  const r = JSON.parse(readFileSync(join(dir, name + '.json'), 'utf8'));
  const v2 = r.costPerHourUSD_v2, online = r.billing.onlineAverage;
  const orch = v2.total - v2.heartbeats;                      // as billed, without run.js's own heartbeat line
  const h = HB[hb](online), tot = orch + h;
  console.log(`${name.padEnd(28)} ${hb.padEnd(6)} ${String(online).padStart(7)} ${f(r.costPerHourUSD_estimate.total)}    ${f(orch)} ${f(h)} ${f(tot)}  ${String(Math.round(tot * 730)).padStart(10)}  ${String(Math.round(tot * 7300)).padStart(12)}`);
}
