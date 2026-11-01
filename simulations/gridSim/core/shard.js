// LaneScheduler shard "s:<lane>:<k>": holds the WebSockets of about a thousand warm providers in
// one lane, gives them packs, leases them, runs their capacity checks between packs, sends
// results to jobs in batches and rolls credit up to the ledger. It keeps, per device, the last 256
// packs accepted on that device's answer alone (a passed check does not clear them: a device that
// cheats sometimes also passes sometimes); if the device is caught cheating, those jobs re-run them
// ('redo'). A job cancels the other copies of an accepted pack ('cancel').
// Low-cost design (cfg.leaseSec > 0): a device gets a lease of several packs (about leaseSec of work, at most
// cfg.leaseJobCap of one job) in one message and answers them all in one message; credit is rolled up to the
// ledger every cfg.ledgerEvery seconds instead of every minute.
//
// Pure logic: it acts only through ctx (send, device, timer), so the same class runs inside a
// Durable Object or inside the simulator (gridSim/sim).
import { dirOfShard } from './sizing.js';

export class LaneShard {
  constructor(id, cfg) {
    const p = id.split(':');
    this.id = id; this.lane = +p[1]; this.cfg = cfg; this.L = cfg.lanes[this.lane];
    this.dir = dirOfShard(cfg, this.lane, +p[2]);
    this.dev = new Map();            // device -> record
    this.idle = []; this.nIdle = 0;  // stack of idle devices (entries checked when popped)
    this.cls = [0, 0, 0, 0]; this.icls = [0, 0, 0, 0];
    this.queue = []; this.qh = 0; this.qWork = 0;   // push/steal: the shard's packs; pull: prefetch buffer
    this.out = new Map();            // job -> results waiting for the next flush
    this.rel = new Map();            // job -> packs to give back (pull)
    this.dead = new Map();           // finished jobs -> when we heard
    this.jobs = []; this.asking = new Map(); this.askedK = 0; this.dryAsked = false;
    this.running = new Map();        // "job|pack" -> devices running a copy (to cancel it)
    this.ticking = false; this.flushing = false; this.ticks = 0; this.credited = 0; this.lastCredit = 0;
    this.avgWork = 30;               // running average of a pack's work (s), to size leases and pulls
  }

  handle(m, ctx) {
    switch (m.t) {
      case 'hello': return this.hello(m, ctx);
      case 'close': { const r = this.dev.get(m.i); if (r) this.remove(r, ctx); return; }
      case 'done': return this.done(m, ctx);
      case 'checked': { const r = this.dev.get(m.i); if (r && r.checking) { r.checking = false; r.nextCheck = ctx.now + this.cfg.checkEvery * (0.5 + ctx.rand()); this.give(r, ctx); } return; }
      case 'packs': return this.packs(m, ctx);
      case 'none': { this.answered(m.from); this.jobs = this.jobs.filter(j => j !== m.from); this.pull(ctx); return; }
      // an empty answer means: wait to be woken (or for the next summary), do not ask again now
      case 'jobs': { this.jobs = m.list; this.dryAsked = m.list.length === 0; this.pull(ctx); return; }
      case 'verdict': return this.verdict(m, ctx);
      case 'cancel': return this.cancel(m, ctx);
      case 'drop': { this.dead.set(m.job, ctx.now); this.jobs = this.jobs.filter(j => j !== m.job); return; }
      case 'move': return this.move(m, ctx);
      case 'donor': if (m.shard && m.shard !== this.id) ctx.send(m.shard, { t: 'steal', shard: this.id, k: Math.max(4, this.nIdle * 2) }); return;
      case 'steal': return this.giveAway(m, ctx);
      case 'restart': return this.restart(ctx);
      case 'tick': return this.tick(ctx);
      case 'flush': return this.flush(ctx);
    }
  }

  // ---- devices -------------------------------------------------------------------------
  hello(m, ctx) {
    const old = this.dev.get(m.i); if (old) this.remove(old, ctx);
    const r = { i: m.i, cls: m.cls, net: m.net, disk: m.disk, acc: m.acc, acc0: m.acc, str: m.strikes, str0: m.strikes,
      packs: null, due: 0, idle: false, checking: false, since: ctx.now, moveTo: -1, unv: m.unv || [],
      nextCheck: ctx.now + this.cfg.checkEvery * ctx.rand() };
    this.dev.set(m.i, r); this.cls[r.cls]++;
    this.ensureTick(ctx);
    this.give(r, ctx);
  }

  remove(r, ctx) {
    if (r.packs) { for (const p of r.packs) this.release(p, ctx); this.unrun(r); }
    if (r.idle) { r.idle = false; this.nIdle--; this.icls[r.cls]--; }
    this.dev.delete(r.i); this.cls[r.cls]--;
    // the reputation and the not-yet-checked acceptances live on with the device record
    if (r.acc !== r.acc0 || r.str !== r.str0 || r.unv.length) ctx.send('ledger', { t: 'rep', i: r.i, dAcc: r.acc - r.acc0, dStr: r.str - r.str0, unv: r.unv });
  }

  unrun(r) {
    const ps = r.packs; r.packs = null;
    if (!ps) return;
    for (const p of ps) {
      const k = p.j + '|' + p.p, a = this.running.get(k);
      if (a) { const i = a.indexOf(r.i); if (i >= 0) a.splice(i, 1); if (!a.length) this.running.delete(k); }
    }
  }

  trusted(r) { return r.acc >= this.cfg.trustAfter && r.str === 0; }

  // A device is free: switch lane if asked, capacity check if due, else the next pack.
  give(r, ctx) {
    if (r.moveTo >= 0) { const to = r.moveTo; this.remove(r, ctx); ctx.device(r.i, { t: 'switch', lane: to }); return; }
    if (this.cfg.checkEvery > 0 && ctx.now >= r.nextCheck) { r.checking = true; ctx.device(r.i, { t: 'check' }); return; }
    const ps = this.lease(r, ctx);
    if (ps) this.run(r, ps, ctx);
    else { this.setIdle(r); this.pull(ctx); }
  }

  // The packs for one run: one pack (original design), or a lease of about cfg.leaseSec of work.
  lease(r, ctx) {
    const cfg = this.cfg;
    if (!(cfg.leaseSec > 0) || (!cfg.leaseUntrusted && !this.trusted(r))) { const p = this.take(r, ctx); return p ? [p] : null; }
    const out = [], per = new Map(); let work = 0;
    while (work < cfg.leaseSec) {
      const p = this.take(r, ctx, (q) => (per.get(q.j) || 0) >= cfg.leaseJobCap);
      if (!p) break;
      out.push(p); per.set(p.j, (per.get(p.j) || 0) + 1); work += p.u * this.L.unitTime;
    }
    return out.length ? out : null;
  }
  perLease() { return this.cfg.leaseSec > 0 ? Math.max(1, Math.ceil(this.cfg.leaseSec / this.avgWork)) : 1; }

  setIdle(r) { if (!r.idle) { r.idle = true; this.idle.push(r.i); this.nIdle++; this.icls[r.cls]++; } }

  popIdle() {
    while (this.idle.length) {
      const r = this.dev.get(this.idle.pop());
      if (r && r.idle) { r.idle = false; this.nIdle--; this.icls[r.cls]--; return r; }
    }
    return null;
  }

  run(r, ps, ctx) {
    let work = 0;
    for (const p of ps) {
      work += p.u * this.L.unitTime;
      const k = p.j + '|' + p.p; let a = this.running.get(k); if (!a) this.running.set(k, a = []); a.push(r.i);
    }
    r.packs = ps; r.due = ctx.now + 4 * work + 60;        // the lease
    ctx.device(r.i, { t: 'run', packs: ps });
  }

  done(m, ctx) {
    const r = this.dev.get(m.i);
    if (!r || r.packs !== m.packs) return;                // late answer for packs already re-issued or cancelled
    this.unrun(r);
    const tr = this.trusted(r) ? r.acc : 0;
    m.packs.forEach((p, k) => {
      let o = this.out.get(p.j); if (!o) this.out.set(p.j, o = []);
      o.push([p.p, p.c, r.i, r.net, m.oks[k], tr]);
    });
    this.scheduleFlush(ctx);
    this.give(r, ctx);
  }

  // items: device, code (0 wrong, 1 accepted alone, 2 checked and right), pack, ok (simulator only)
  verdict(m, ctx) {
    const v = m.items;
    for (let k = 0; k < v.length; k += 4) {
      const code = v[k + 1], r = this.dev.get(v[k]);
      if (!r) {                                           // the device left: its record (and list) is in the ledger
        ctx.send('ledger', { t: 'rep', i: v[k], dAcc: code ? 1 : 0, dStr: code ? 0 : 1, caught: code === 0,
          unvAdd: code === 1 ? [m.job, v[k + 2], v[k + 3]] : null });
        continue;
      }
      if (code === 0) { r.str++; this.redoAll(r.unv, ctx); r.unv = []; this.remove(r, ctx); ctx.device(r.i, { t: 'kick' }); continue; }
      r.acc++; this.credited++;
      if (code === 1) { r.unv.push([m.job, v[k + 2], v[k + 3]]); if (r.unv.length > 256) r.unv.shift(); }
    }
  }

  // A cheater was caught: every pack accepted on its word alone since its last check is run again.
  redoAll(list, ctx) {
    const byJob = new Map();
    for (const [j, p, ok] of list) { let a = byJob.get(j); if (!a) byJob.set(j, a = []); a.push({ p, ok }); }
    for (const [j, packs] of byJob) ctx.send(j, { t: 'redo', packs });
  }

  // A pack was accepted elsewhere: drop its copies waiting here, stop the ones running here.
  cancel(m, ctx) {
    const q = this.queue;
    for (let k = this.qh; k < q.length; k++) {
      const p = q[k];
      if (p && p.j === m.job && p.p === m.p) { q[k] = q[this.qh]; q[this.qh++] = null; this.qWork -= p.u * this.L.unitTime; }
    }
    const devs = this.running.get(m.job + '|' + m.p);
    if (!devs) return;
    for (const i of devs.slice()) {
      const r = this.dev.get(i);
      // a lease of several packs runs to its end (the device cannot drop one pack of it here)
      if (!r || !r.packs || r.packs.length !== 1 || r.packs[0].j !== m.job || r.packs[0].p !== m.p) continue;
      this.unrun(r); ctx.device(r.i, { t: 'cancel' }); this.give(r, ctx);
    }
  }

  // ---- packs ---------------------------------------------------------------------------
  queued() { return this.queue.length - this.qh; }

  // First runnable pack near the head of the queue: skips packs of finished jobs and copies
  // that must run on a different network than this device's.
  take(r, ctx, skip) {
    const q = this.queue, end = Math.min(q.length, this.qh + (skip ? 256 : 64));
    for (let k = this.qh; k < end; k++) {
      const p = q[k];
      if (!p) continue;
      if (this.dead.has(p.j)) { q[k] = q[this.qh]; q[this.qh++] = null; this.qWork -= p.u * this.L.unitTime; continue; }
      if (p.x && p.x.includes(r.net)) continue;
      if (p.tr && !this.trusted(r)) continue;            // an escalated copy: trusted devices only
      if (skip && skip(p)) continue;
      q[k] = q[this.qh]; q[this.qh++] = null; this.qWork -= p.u * this.L.unitTime;
      if (this.qh > 4096 && this.qh * 2 > q.length) { this.queue = q.slice(this.qh); this.qh = 0; }
      return p;
    }
    return null;
  }

  packs(m, ctx) {
    if (m.from) this.answered(m.from);
    for (const p of m.packs) { p.qAt = ctx.now; this.queue.push(p); this.qWork += p.u * this.L.unitTime; this.avgWork += 0.02 * (p.u * this.L.unitTime - this.avgWork); }
    this.ensureTick(ctx);
    this.drain(ctx);
  }

  // Give queued packs to idle devices.
  drain(ctx) {
    const keep = [];
    while (this.nIdle > 0 && this.queued() > 0) {
      const r = this.popIdle(); if (!r) break;
      const ps = this.lease(r, ctx);
      if (ps) this.run(r, ps, ctx);
      else { keep.push(r); if (keep.length >= 32) break; }
    }
    for (const r of keep) this.setIdle(r);
    this.pull(ctx);
  }

  release(p, ctx) {
    if (this.cfg.policy === 'pull') {
      let o = this.rel.get(p.j); if (!o) this.rel.set(p.j, o = []);
      o.push(p); this.scheduleFlush(ctx);
    } else {
      if (this.qh > 0) this.queue[--this.qh] = p; else this.queue.unshift(p);
      this.qWork += p.u * this.L.unitTime;
    }
  }

  // pull: keep a small buffer of packs for the devices that are (about to be) free.
  pull(ctx) {
    if (this.cfg.policy !== 'pull') return;
    const want = (this.nIdle + Math.ceil(this.cfg.prefetch * this.dev.size)) * this.perLease() - this.queued() - this.askedK;
    if (want <= 0 || this.nIdle === 0 && this.queued() > 0) return;
    const free = this.jobs.filter(j => !this.asking.has(j) && !this.dead.has(j));
    if (!free.length) {
      if (!this.dryAsked && this.nIdle > 0 && this.asking.size === 0) { this.dryAsked = true; ctx.send(this.dir, { t: 'dry', shard: this.id }); }
      return;
    }
    let left = want;
    for (let n = 0; n < free.length && left > 0; n++) {
      const j = free[Math.floor(ctx.rand() * free.length)];
      if (this.asking.has(j)) continue;
      const k = Math.min(left, this.cfg.pullBatch);
      this.asking.set(j, [k, ctx.now]); this.askedK += k; left -= k;
      ctx.send(j, { t: 'want', shard: this.id, k });
    }
  }

  answered(job) { const a = this.asking.get(job); if (a) { this.asking.delete(job); this.askedK -= a[0]; } }

  giveAway(m, ctx) {
    const k = Math.min(m.k, Math.floor(this.queued() / 2));
    if (k <= 0) return;
    const packs = this.queue.splice(this.queue.length - k, k);
    for (const p of packs) this.qWork -= p.u * this.L.unitTime;
    ctx.send(m.shard, { t: 'packs', packs });
  }

  // ---- rebalancing ---------------------------------------------------------------------
  // Planner asked for k devices of a class to switch lane: first those that already hold the
  // target model on disk; others (a download) only when the planner allows it.
  move(m, ctx) {
    let k = m.k;
    const minAge = ctx.now - this.cfg.minDwell, bit = 1 << m.to;
    for (let pass = 0; pass < (m.download ? 2 : 1) && k > 0; pass++) {
      for (const r of this.dev.values()) {
        if (k <= 0) break;
        if (r.cls !== m.cls || r.since > minAge || r.moveTo >= 0) continue;
        if (pass === 0 && !(r.disk & bit)) continue;
        k--;
        if (r.idle) { this.remove(r, ctx); ctx.device(r.i, { t: 'switch', lane: m.to }); }
        else r.moveTo = m.to;                              // after the current pack
      }
    }
  }

  // ---- housekeeping --------------------------------------------------------------------
  scheduleFlush(ctx) { if (!this.flushing) { this.flushing = true; ctx.timer(this.cfg.flush, { t: 'flush' }); } }

  flush(ctx) {
    this.flushing = false;
    for (const [j, items] of this.out) ctx.send(j, { t: 'res', shard: this.id, items });
    this.out.clear();
    for (const [j, packs] of this.rel) ctx.send(j, { t: 'release', packs });
    this.rel.clear();
  }

  ensureTick(ctx) {
    if (!this.ticking) { this.ticking = true; ctx.timer(this.cfg.tick * (0.5 + ctx.rand()), { t: 'tick' }); }
  }

  tick(ctx) {
    const now = ctx.now, cfg = this.cfg;
    this.ticks++;
    // leases: a device that has not answered in 4x the pack time loses the pack
    for (const r of this.dev.values()) {
      if (r.packs && r.due <= now) { const ps = r.packs; this.unrun(r); for (const p of ps) this.release(p, ctx); this.remove(r, ctx); ctx.device(r.i, { t: 'kick' }); }
    }
    // pull: a buffered pack nobody here could run in a minute goes back to its job
    if (cfg.policy === 'pull' && this.nIdle > 0 && this.queued() > 0) {
      const q = this.queue;
      for (let k = this.qh; k < q.length; k++) {
        const p = q[k];
        if (p && now - p.qAt > 60) { q[k] = q[this.qh]; q[this.qh++] = null; this.qWork -= p.u * this.L.unitTime; if (!this.dead.has(p.j)) this.release(p, ctx); }
      }
    }
    // a request that got no answer in 30 s (lost in a restart) is forgotten
    for (const [j, a] of this.asking) if (now - a[1] > 30) this.answered(j);
    // credit roll-up: one ledger write per device credited since the last roll-up (at most one per device)
    if (now - this.lastCredit >= cfg.ledgerEvery) {
      if (this.credited) { ctx.send('ledger', { t: 'credit', n: Math.min(this.credited, this.dev.size) }); this.credited = 0; }
      this.lastCredit = now;
    }
    if (this.ticks % 12 === 0) for (const [j, at] of this.dead) if (now - at > 120) this.dead.delete(j);
    ctx.send(this.dir, { t: 'sum', shard: this.id, n: this.dev.size, idle: this.nIdle, q: this.queued(),
      qWork: this.qWork, cls: this.cls.slice(), icls: this.icls.slice() });
    if (cfg.policy === 'steal' && this.nIdle > 0 && this.queued() === 0) ctx.send(this.dir, { t: 'needWork', shard: this.id });
    if (cfg.policy === 'pull') this.pull(ctx);
    if (this.dev.size > 0 || this.queued() > 0) ctx.timer(cfg.tick, { t: 'tick' });
    else this.ticking = false;
  }

  // After a deploy every WebSocket is gone. Durable state (queue, results) survives; the
  // packs that were running are released.
  restart(ctx) {
    for (const r of this.dev.values()) {
      if (r.packs) { for (const p of r.packs) this.release(p, ctx); r.packs = null; }
      if (r.unv.length) ctx.send('ledger', { t: 'rep', i: r.i, dAcc: 0, dStr: 0, unv: r.unv });
    }
    this.dev.clear(); this.idle = []; this.nIdle = 0; this.running.clear();
    this.cls = [0, 0, 0, 0]; this.icls = [0, 0, 0, 0];
    this.asking.clear(); this.askedK = 0; this.dryAsked = false;
    this.flush(ctx);
  }
}
