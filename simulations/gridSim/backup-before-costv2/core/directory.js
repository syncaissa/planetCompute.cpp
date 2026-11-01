// Lane directory "d:<lane>": one per lane. Collects shard summaries, keeps the jobs that have
// packs waiting, tells hungry shards which jobs to pull from (fair per consumer: pick a
// consumer first, then one of its jobs), finds donors for stealing, relays planner moves and
// reports the lane to the planner.  Pure logic, acts only through ctx.
export class Directory {
  constructor(id, cfg) {
    this.id = id; this.cfg = cfg; this.lane = +id.split(':')[1];   // "d:<lane>:<k>"
    this.sums = new Map();                 // shard -> latest summary
    this.jobs = new Map();                 // job -> { c, n, w }
    this.pc = []; this.pcIx = new Map();   // consumers with work waiting
    this.cj = new Map();                   // consumer -> its jobs with work waiting
    this.hungry = new Set();               // shards told "nothing to do"
    this.donors = []; this.di = 0;
  }

  handle(m, ctx) {
    switch (m.t) {
      case 'sum':
        m.at = ctx.now; this.sums.set(m.shard, m);
        if (this.cfg.policy === 'pull' && m.idle > 0 && m.q === 0) this.sendJobs(m.shard, ctx);
        return;
      case 'dry': return this.sendJobs(m.shard, ctx);
      case 'jobOn': this.jobs.set(m.job, { c: m.c, n: 0, w: 0 }); return this.pending(m, ctx);
      case 'jobPending': return this.pending(m, ctx);
      case 'jobOff': { const j = this.jobs.get(m.job); if (j) { if (j.n > 0) this.unlist(m.job, j.c); this.jobs.delete(m.job); } return; }
      case 'needWork': {
        if (!this.donors.length) return;
        const d = this.donors[this.di++ % this.donors.length];
        if (d !== m.shard) ctx.send(m.shard, { t: 'donor', shard: d });
        return;
      }
      case 'move': return this.move(m, ctx);
      case 'tick': this.report(ctx); ctx.timer(this.cfg.tick, { t: 'tick' }); return;
    }
  }

  pending(m, ctx) {
    const j = this.jobs.get(m.job); if (!j) return;
    const was = j.n > 0; j.n = m.n; j.w = m.w;
    if (!was && j.n > 0) {
      this.list(m.job, j.c);
      // wake a few hungry shards, about one per 16 packs, not all of them
      if (this.cfg.wakeHungry) {
        let k = Math.ceil(j.n / 16);
        for (const s of this.hungry) { if (k-- <= 0) break; this.hungry.delete(s); ctx.send(s, { t: 'jobs', list: [m.job] }); }
      }
    } else if (was && j.n === 0) this.unlist(m.job, j.c);
  }

  list(job, c) {
    let a = this.cj.get(c);
    if (!a) { this.cj.set(c, a = []); this.pcIx.set(c, this.pc.length); this.pc.push(c); }
    a.push(job);
  }

  unlist(job, c) {
    const a = this.cj.get(c); if (!a) return;
    const k = a.indexOf(job); if (k >= 0) { a[k] = a[a.length - 1]; a.pop(); }
    if (!a.length) {
      this.cj.delete(c);
      const ix = this.pcIx.get(c), last = this.pc.pop();
      if (last !== c) { this.pc[ix] = last; this.pcIx.set(last, ix); }
      this.pcIx.delete(c);
    }
  }

  sendJobs(shard, ctx) {
    const out = [], K = this.cfg.dirJobs;
    for (let t = 0; t < K * 2 && out.length < K && this.pc.length; t++) {
      const c = this.pc[Math.floor(ctx.rand() * this.pc.length)], a = this.cj.get(c);
      const j = a[Math.floor(ctx.rand() * a.length)];
      if (out.includes(j)) continue;
      out.push(j);
      // hand each job out only about as often as it has batches left; the job reports again
      // (or sends a heartbeat) if packs are still waiting
      const e = this.jobs.get(j);
      e.n -= this.cfg.pullBatch;
      if (e.n <= 0) { e.n = 0; this.unlist(j, c); }
    }
    if (out.length) this.hungry.delete(shard); else this.hungry.add(shard);
    ctx.send(shard, { t: 'jobs', list: out });
  }

  move(m, ctx) {
    let k = m.k;
    const s = [...this.sums.values()].filter(x => x.cls[m.cls] > 0).sort((a, b) => b.icls[m.cls] - a.icls[m.cls]);
    for (const x of s) {
      if (k <= 0) break;
      const take = Math.min(k, Math.max(x.icls[m.cls], Math.ceil(x.cls[m.cls] * m.k / Math.max(1, this.total(m.cls)))));
      k -= take;
      ctx.send(x.shard, { t: 'move', cls: m.cls, k: take, to: m.to, download: m.download });
    }
  }

  total(c) { let n = 0; for (const x of this.sums.values()) n += x.cls[c]; return n; }

  report(ctx) {
    const now = ctx.now, r = { t: 'lane', dir: this.id, lane: this.lane, n: 0, idle: 0, q: 0, qWork: 0, pWork: 0, pPacks: 0,
      cls: [0, 0, 0, 0], icls: [0, 0, 0, 0], jobs: this.jobs.size, shards: 0 };
    const big = [];
    for (const [id, x] of this.sums) {
      if (now - x.at > 3 * this.cfg.tick + 1) { this.sums.delete(id); this.hungry.delete(id); continue; }
      r.shards++; r.n += x.n; r.idle += x.idle; r.q += x.q; r.qWork += x.qWork;
      for (let c = 0; c < 4; c++) { r.cls[c] += x.cls[c]; r.icls[c] += x.icls[c]; }
      if (x.q >= 2) big.push(x);
    }
    for (const j of this.jobs.values()) { r.pWork += j.w; r.pPacks += j.n; }
    big.sort((a, b) => b.q - a.q);
    this.donors = big.slice(0, 16).map(x => x.shard);
    ctx.send('plan', r);
  }
}
