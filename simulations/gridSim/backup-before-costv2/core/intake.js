// Intake: the stateless gateway Worker. Places a connecting device in a lane and shard from the
// latest published plan (no Durable Object hit per connection), admits consumer jobs, splits
// very large jobs into parts, and passes arrival totals to the planner. Admission counts the work it
// admitted since the last plan, so a burst between two plans cannot all get in: a job is refused when
// the lane's estimated wait (its backlog plus what was admitted since, at the lane's capacity) passes
// cfg.maxWait.  Pure logic.
import { packUnits, hash32 } from './sizing.js';

export class Intake {
  constructor(id, cfg) {
    this.id = id; this.cfg = cfg;
    this.plan = cfg.initialPlan;
    this.arr = new Float64Array(cfg.lanes.length);
    this.adm = new Float64Array(cfg.lanes.length);   // work admitted since the last plan
    this.seq = 0;
  }

  handle(m, ctx) {
    switch (m.t) {
      case 'plan': this.plan = m; this.adm.fill(0); return;
      case 'tick':
        ctx.send('plan', { t: 'arr', w: Array.from(this.arr), dt: this.cfg.tick });
        this.arr.fill(0); ctx.timer(this.cfg.tick, { t: 'tick' }); return;
      case 'connect': {
        const lane = this.chooseLane(m, ctx);
        ctx.device(m.i, { t: 'assign', lane, shard: hash32(m.i) % this.plan.nShards[lane] });
        return;
      }
      case 'submit': return this.submit(m, ctx);
    }
  }

  chooseLane({ cls, loaded, disk, want }, ctx) {
    const P = this.plan, lanes = this.cfg.lanes;
    if (want >= 0) return want;
    if (loaded >= 0 && lanes[loaded].minClass <= cls) {
      if (!P.target) return loaded;
      if (P.cur[loaded][cls] <= P.target[loaded][cls] * 1.05 + 5) { P.cur[loaded][cls]++; return loaded; }
    }
    // next best: a lane that is short of this class and whose model is already on disk
    if (P.target) {
      let best = -1, bestD = 0;
      for (let L = 0; L < lanes.length; L++) {
        if (lanes[L].minClass > cls || !((disk >> L) & 1)) continue;
        const d = P.target[L][cls] - P.cur[L][cls];
        if (d > bestD) { best = L; bestD = d; }
      }
      if (best >= 0) { P.cur[best][cls]++; return best; }
      if (loaded >= 0 && lanes[loaded].minClass <= cls) { P.cur[loaded][cls]++; return loaded; }   // no download just to rebalance
    }
    const w = P.w[cls];
    let tot = 0; for (const x of w) tot += x;
    let r = ctx.rand() * tot, L = 0;
    for (; L < w.length - 1; L++) { r -= w[L]; if (r <= 0) break; }
    while (lanes[L].minClass > cls) L--;
    if (P.target) {                                        // this isolate's own view of the deficit
      P.cur[L][cls]++;
      w[L] = Math.max(0, P.target[L][cls] - P.cur[L][cls]) + 0.02 * P.target[L][cls] + 1;
    }
    return L;
  }

  submit(m, ctx) {
    const cfg = this.cfg, P = this.plan, L = m.lane, lane = cfg.lanes[L];
    if (cfg.admission) {
      const devices = P.cur ? P.cur[L].reduce((a, b) => a + b, 0) : 1;
      if (devices === 0) return ctx.send('consumers', { ...m, t: 'rejected', why: 'no providers' });
      const cap = P.cap ? P.cap[L] : 0;
      const wait = (P.wait ? P.wait[L] : 0) + (cap > 0 ? (this.adm[L] + m.work) / cap : 0);
      if (wait > cfg.maxWait) return ctx.send('consumers', { ...m, t: 'rejected', why: 'busy' });
      this.adm[L] += m.work;
    }
    const share = P.share ? P.share[L] : 100;
    const units = Math.max(1, Math.ceil(m.work / lane.unitTime));
    const n = Math.ceil(units / packUnits({ units, unitTime: lane.unitTime, share, overhead: cfg.overhead, kappa: cfg.kappa, tauMax: cfg.tauMax }));
    const parts = cfg.split ? Math.max(1, Math.ceil(n / cfg.split)) : 1;
    const root = `j:${++this.seq}`;
    for (let p = 0; p < parts; p++)
      ctx.spawn(parts > 1 ? `${root}#${p}` : root, 'job',
        { lane: L, work: m.work / parts, consumer: m.c, at: ctx.now, share, nShards: P.nShards[L], root });
    this.arr[L] += m.work;
    ctx.send('consumers', { t: 'accepted', root, c: m.c, lane: L, work: m.work, parts, first: m.first ?? ctx.now });
  }
}
