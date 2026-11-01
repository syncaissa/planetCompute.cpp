// JobCoordinator "j:<n>" (or "j:<n>#<part>" for a part of a very large job): cuts the work into
// packs (square-root law), hands them to lane shards (push) or lets shards ask for them (pull),
// checks answers (quorum for new devices, sampled audits for trusted ones: more often for newly trusted
// devices, never below cfg.audit), hedges the slow last packs, cancels a pack's other copies once it is
// accepted, re-runs packs whose only answer came from a device later caught cheating ('redo'), and
// reports to the consumer. With the simple design (cfg.reliable 2) it also keeps a lease on every copy it
// handed out: a copy with no answer long after it should have finished (lost with a shard, a message or a
// device, wherever) is issued again, so no pack can be lost for good (design notes 15.11).
// Pure logic, acts only through ctx.
import { packUnits, dirOfJob } from './sizing.js';

export class Job {
  constructor(id, cfg, spec) {
    this.id = id; this.cfg = cfg;
    this.lane = spec.lane; this.work = spec.work; this.c = spec.consumer; this.at = spec.at;
    this.root = spec.root; this.nShards = spec.nShards;
    this.ut = cfg.lanes[this.lane].unitTime; this.dir = dirOfJob(cfg, this.lane, id);
    const units = Math.max(1, Math.ceil(this.work / this.ut));
    this.b = packUnits({ units, unitTime: this.ut, share: spec.share, overhead: cfg.overhead, kappa: cfg.kappa, tauMax: cfg.tauMax });
    this.n = Math.ceil(units / this.b); this.lastU = units - (this.n - 1) * this.b;
    this.tau = this.b * this.ut;
    const n = this.n;
    this.acc = new Uint8Array(n);       // accepted
    this.issued = new Uint8Array(n);    // copies handed out
    this.got = new Uint8Array(n);       // answers received
    this.need = new Uint8Array(n);      // matching answers needed (0 = not decided yet)
    this.hedged = new Uint8Array(n);
    this.inReady = new Uint8Array(n);   // copies waiting in `ready` (not handed out yet)
    this.leased = new Uint8Array(n);    // copies issued again because the lease ran out
    this.wrongAcc = new Uint8Array(n);  // accepted with a wrong answer (simulation bookkeeping only)
    this.where = new Map();             // pack -> shards holding its copies (to cancel them)
    this.issueAt = new Float32Array(n);
    this.res = new Map();               // pack -> [net, ok, device, shardIndex, ...] while being checked
    this.shardIds = []; this.shardIx = new Map();
    this.ready = []; this.rh = 0;       // pull: packs waiting for a shard to ask
    this.out = new Map();               // push: shard -> packs to send
    this.seen = new Set();              // shards that hold or asked for our packs
    this.left = n; this.firstAt = -1; this.lastProgress = spec.at;
    this.copies = 0; this.hedges = 0; this.wrong = 0; this.caught = 0; this.forced = 0; this.escalated = 0;
    this.late = 0; this.fixed = 0; this.redone = 0; this.cancels = 0; this.leases = 0; this.ticks = 0;
    this.stalled = false; this.finished = false; this.reported = -1; this.rr = 0; this.lastWant = spec.at;
  }

  units(pid) { return pid === this.n - 1 ? this.lastU : this.b; }
  readyLen() { return this.ready.length - this.rh; }
  push() { return this.cfg.policy !== 'pull'; }

  handle(m, ctx) {
    if (this.finished) return;
    switch (m.t) {
      case 'init': return this.init(ctx);
      case 'want': return this.want(m, ctx);
      case 'res': return this.results(m, ctx);
      case 'release': for (const p of m.packs) if (!this.acc[p.p]) { this.ready.push(p); this.inReady[p.p]++; } return this.report(ctx);
      case 'tick': return this.tick(ctx);
      case 'redo': return this.redo(m, ctx);
    }
  }

  init(ctx) {
    this.off = Math.floor(ctx.rand() * this.nShards);
    for (let pid = 0; pid < this.n; pid++) this.issue(pid, null, ctx, true);
    this.sendOut(ctx);
    ctx.send(this.dir, { t: 'jobOn', job: this.id, c: this.c, n: this.readyLen(), w: this.readyLen() * this.tau });
    this.reported = this.readyLen();
    ctx.timer(this.cfg.jobTick * (0.5 + ctx.rand()), { t: 'tick' });
  }

  issue(pid, excl, ctx, first, trustedOnly) {
    this.issued[pid]++; this.copies++; this.issueAt[pid] = ctx.now;
    const p = { j: this.id, p: pid, c: this.issued[pid], u: this.units(pid), x: excl };
    if (trustedOnly) p.tr = 1;
    if (!this.push()) { this.ready.push(p); this.inReady[pid]++; return; }
    // push: first copies round-robin over the lane's shards, later copies to a random one
    const k = first ? (this.off + this.rr++) % this.nShards : Math.floor(ctx.rand() * this.nShards);
    const s = `s:${this.lane}:${k}`;
    this.hold(pid, s);
    let o = this.out.get(s); if (!o) this.out.set(s, o = []);
    o.push(p);
  }

  hold(pid, s) { let a = this.where.get(pid); if (!a) this.where.set(pid, a = []); if (!a.includes(s)) a.push(s); }

  // The audit rate of a trusted device: high just after it earned trust, falling slowly with its record,
  // never below cfg.audit (a "sleeper" that cheats once trusted is checked often early on).
  auditRate(acc) { const c = this.cfg; return Math.max(c.audit, c.auditNew * c.trustAfter / Math.max(c.trustAfter, acc)); }

  sendOut(ctx) {
    for (const [s, packs] of this.out) { ctx.send(s, { t: 'packs', from: null, packs }); this.seen.add(s); }
    this.out.clear();
  }

  want(m, ctx) {
    this.seen.add(m.shard); this.lastWant = ctx.now;
    const give = [];
    while (give.length < m.k && this.rh < this.ready.length) {
      const p = this.ready[this.rh]; this.ready[this.rh++] = null;
      if (this.inReady[p.p]) this.inReady[p.p]--;
      if (!this.acc[p.p]) { give.push(p); this.issueAt[p.p] = ctx.now; this.hold(p.p, m.shard); }
    }
    if (this.rh > 1024 && this.rh * 2 > this.ready.length) { this.ready = this.ready.slice(this.rh); this.rh = 0; }
    ctx.send(m.shard, give.length ? { t: 'packs', from: this.id, packs: give } : { t: 'none', from: this.id });
    if (this.readyLen() === 0) this.report(ctx);
  }

  shardIndex(s) {
    let k = this.shardIx.get(s);
    if (k === undefined) { k = this.shardIds.length; this.shardIds.push(s); this.shardIx.set(s, k); }
    return k;
  }

  results(m, ctx) {
    const cfg = this.cfg, verdicts = new Map();
    // verdict per answer: 0 = wrong (caught), 1 = accepted on this answer alone (unverified), 2 = checked and right.
    // The shard keeps the unverified ones of each device until its next check: if the device is caught,
    // they are re-run ('redo').  `ok` rides along only so the simulator can count; a real job cannot know it.
    const say = (k, dev, code, pid, ok) => { const s = this.shardIds[k]; let v = verdicts.get(s); if (!v) verdicts.set(s, v = []); v.push(dev, code, pid, ok ? 1 : 0); };
    const here = this.shardIndex(m.shard);
    for (const [pid, , dev, net, ok, tacc] of m.items) {
      this.got[pid]++;
      if (this.acc[pid]) { this.late++; say(here, dev, ok ? 2 : 0, pid, ok); continue; }   // a late copy
      if (!this.need[pid]) this.need[pid] = tacc ? (ctx.rand() < this.auditRate(tacc) ? 2 : 1) : cfg.quorum;
      if (this.need[pid] === 1) { this.accept(pid, ok, ctx); say(here, dev, 1, pid, ok); continue; }
      let e = this.res.get(pid); if (!e) this.res.set(pid, e = []);
      e.push(net, ok ? 1 : 0, dev, here);
      // answers from cheaters differ from each other; only correct ones can match
      const nets = [];
      for (let k = 0; k < e.length; k += 4) if (e[k + 1] && !nets.includes(e[k])) nets.push(e[k]);
      if (nets.length >= this.need[pid]) { this.settle(pid, e, true, say, ctx); continue; }
      const short = this.need[pid] - nets.length - (this.issued[pid] - this.got[pid]);
      if (short <= 0) continue;
      const excl = []; for (let k = 0; k < e.length; k += 4) if (!excl.includes(e[k])) excl.push(e[k]);
      if (this.issued[pid] + short > cfg.maxCopies) {
        if (!cfg.noForce) { this.forced++; this.settle(pid, e, nets.length > 0, say, ctx); continue; }
        // never accepted without the matching answers it needs: the missing ones come from trusted devices only
        this.escalated++;
        for (let s = 0; s < short; s++) this.issue(pid, excl, ctx, false, true);
        continue;
      }
      for (let s = 0; s < short; s++) this.issue(pid, excl, ctx, false);
    }
    for (const [s, items] of verdicts) ctx.send(s, { t: 'verdict', job: this.id, items });
    this.sendOut(ctx);
    if (this.left === 0) return this.finish(ctx, false);
    this.report(ctx);
  }

  settle(pid, e, ok, say, ctx) {
    this.accept(pid, ok, ctx);
    for (let k = 0; k < e.length; k += 4) { say(e[k + 3], e[k + 2], e[k + 1] ? 2 : 0, pid, e[k + 1]); if (!e[k + 1]) this.caught++; }
    this.res.delete(pid);
  }

  accept(pid, ok, ctx) {
    this.acc[pid] = 1; this.left--;
    if (!ok) { this.wrong++; this.wrongAcc[pid] = 1; }
    // the other copies of this pack are now wasted work: cancel them where they wait or run
    const ws = this.where.get(pid);
    if (ws && this.issued[pid] > this.got[pid]) for (const s of ws) { ctx.send(s, { t: 'cancel', job: this.id, p: pid }); this.cancels++; }
    this.where.delete(pid);
    if (this.firstAt < 0) this.firstAt = ctx.now;
    this.lastProgress = ctx.now;
  }

  // A device whose answers were accepted alone was caught cheating: run those packs again with a quorum.
  redo(m, ctx) {
    for (const { p } of m.packs) {
      if (!this.acc[p]) continue;
      this.acc[p] = 0; this.left++; this.redone++;
      if (this.wrongAcc[p]) { this.wrongAcc[p] = 0; this.wrong--; this.fixed++; }
      this.need[p] = this.cfg.quorum; this.res.delete(p);
      for (let q = 0; q < this.cfg.quorum; q++) this.issue(p, null, ctx, false);
    }
    this.sendOut(ctx); this.report(ctx, true);
  }

  report(ctx, force) {
    if (this.push()) return;
    const n = this.readyLen();
    if (force || (n === 0) !== (this.reported === 0) || Math.abs(n - this.reported) > Math.max(8, this.reported / 4)) {
      this.reported = n;
      ctx.send(this.dir, { t: 'jobPending', job: this.id, n, w: n * this.tau });
    }
  }

  tick(ctx) {
    const cfg = this.cfg, now = ctx.now;
    if (now - this.at > cfg.ttl) return this.finish(ctx, true);
    if (!this.stalled && now - this.lastProgress > cfg.stallAfter) this.stalled = true;
    // end-game hedging: one extra copy of each slow last pack, on another machine
    if (cfg.hedge && this.left <= Math.max(2, cfg.hedgeFrac * this.n) && this.readyLen() === 0) {
      // a pack may wait inside a device's lease (low-cost design) before it starts: allow for that
      const late = now - cfg.hedgeAfter * this.tau - 30 - (cfg.leaseSec || 0);
      for (let pid = 0; pid < this.n; pid++) {
        if (this.acc[pid] || this.hedged[pid] || this.issued[pid] <= this.got[pid] || this.issueAt[pid] > late) continue;
        this.hedged[pid] = 1; this.hedges++; this.issue(pid, null, ctx, false);
      }
      this.sendOut(ctx); this.report(ctx);
    }
    // the lease on handed-out copies (simple design): no answer long after it was due -> issue it again
    if (cfg.reliable === 2 && !this.push() && ++this.ticks % 3 === 0) {
      const old = now - (cfg.packLease * this.tau + cfg.packLeaseAdd + 2 * (cfg.leaseSec || 0));
      let again = 0;
      for (let pid = 0; pid < this.n; pid++) {
        if (this.acc[pid] || this.leased[pid] >= 3 || this.issueAt[pid] > old) continue;
        if (this.issued[pid] <= this.got[pid] + this.inReady[pid]) continue;   // nothing out there
        this.leased[pid]++; this.leases++; again++; this.issue(pid, null, ctx, false);
      }
      if (again) this.report(ctx, true);
    }
    // heartbeat: packs waiting and nobody asked for a while -> remind the directory
    if (this.readyLen() > 0 && now - this.lastWant > cfg.jobTick) this.report(ctx, true);
    ctx.timer(cfg.jobTick, { t: 'tick' });
  }

  finish(ctx, cancelled) {
    this.finished = true;
    ctx.send('consumers', { t: 'jobDone', root: this.root, id: this.id, at: this.at, firstAt: this.firstAt,
      doneAt: ctx.now, cancelled, n: this.n, tau: this.tau, copies: this.copies, hedges: this.hedges,
      wrong: this.wrong, caught: this.caught, forced: this.forced, escalated: this.escalated, stalled: this.stalled, left: this.left,
      late: this.late, fixed: this.fixed, redone: this.redone, cancels: this.cancels, leases: this.leases });
    ctx.send(this.dir, { t: 'jobOff', job: this.id });
    for (const s of this.seen) ctx.send(s, { t: 'drop', job: this.id });
    ctx.exit();
  }
}
