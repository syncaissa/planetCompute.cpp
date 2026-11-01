// The simulated world around the scheduler: an event queue, network latency, a single-threaded
// service-time model for every Durable Object (so hot objects queue up, as they would on
// Cloudflare), a million simulated devices and the consumers' job arrivals.
// The scheduler classes in ../core are used unchanged.
import { LaneShard } from '../core/shard.js';
import { Job } from '../core/job.js';
import { Directory } from '../core/directory.js';
import { Plan } from '../core/plan.js';
import { Intake } from '../core/intake.js';
import { classSpeed } from '../core/sizing.js';
import { mulberry32, expo, lognormal } from './rng.js';

const MSG = 1, WAKE = 2, DEV = 3, SYS = 4;
const RES = 0.01;                                  // event-queue bucket (s)
const DO_TYPES = new Set(['shard', 'job', 'dir', 'plan']);

export class World {
  constructor(cfg) {
    this.cfg = cfg; this.r = mulberry32(cfg.seed); this.now = 0;
    this.buckets = new Map(); this.cur = 0; this.events = 0;
    this.actors = new Map();
    this.NL = cfg.lanes.length;
    const NL = this.NL;
    this.m = {
      wsIn: 0, doReq: 0, workerReq: 0, ledgerWrites: 0, dropped: 0, droppedBy: {}, byMsg: {}, doActive: 0,
      packsRun: 0, workRun: 0, checks: 0, downloads: 0, dlGB: 0, diskLoads: 0, switches: 0, kicks: 0,
      cancelledRuns: 0, cancelledWork: 0, redoLate: 0, lateFixed: 0,
      connPerSec: new Int32Array(Math.ceil(cfg.hours * 3600) + 2),
      devSec: new Float64Array(NL), busySec: new Float64Array(NL), iwq: new Float64Array(NL),
      peak: {}, series: [],
      submitted: 0, rejected: {}, gaveUp: 0,
      jobs: { done: 0, cancelled: 0, stalled: 0, copies: 0, packs: 0, hedges: 0, wrong: 0, caught: 0, forced: 0,
        late: 0, fixed: 0, redone: 0, cancels: 0 },
      times: { small: [], medium: [], large: [] }, ttfr: [], e2e: [], lockedMax: 0,
      // faults (design notes 15.11)
      f: { refused: 0, retries: 0, lost: {}, wsLost: 0, wsResent: 0, crashes: {}, jobsLost: 0, partsLost: 0,
        packsLostInShards: 0, resultsLostInShards: 0, dupDropped: 0, dupDelivered: {}, storageWrites: 0,
        creditSent: 0, creditRecv: 0, leases: 0 },
    };
    this.setupCtx();
    this.setupPlanAndRates();
    this.setupDevices();
    this.setupActors();
  }

  // ---- event queue ---------------------------------------------------------------------
  push(at, ev) {
    if (at < this.now) at = this.now;
    let b = Math.floor(at / RES); if (b < this.cur) b = this.cur;
    ev.at = at;
    let a = this.buckets.get(b); if (!a) this.buckets.set(b, a = []);
    a.push(ev);
  }

  run(until, onProgress) {
    const end = Math.floor(until / RES);
    while (this.cur <= end) {
      const a = this.buckets.get(this.cur);
      if (a) {
        for (let k = 0; k < a.length; k++) {
          const ev = a[k]; a[k] = null;
          if (ev.at > this.now) this.now = ev.at;
          this.events++;
          switch (ev.k) {
            case MSG: this.deliver(ev.a, ev.b); break;
            case WAKE: this.wake(ev.a); break;
            case DEV: this.devEvent(ev); break;
            case SYS: ev.a(); break;
          }
        }
        this.buckets.delete(this.cur);
      }
      this.cur++;
      if (onProgress && this.cur % 30000 === 0) onProgress(this);
    }
  }

  // ---- actors (Durable Objects, the Worker, and two sinks) -----------------------------
  add(id, obj, type, parallel) {
    obj.id = id; obj._type = type; obj._par = parallel;
    obj._busy = 0; obj._bt = 0; obj._bt0 = 0; obj._w = 0; obj._q = []; obj._qh = 0; obj._wake = false;
    this.actors.set(id, obj);
    return obj;
  }

  actor(id) {
    let a = this.actors.get(id);
    if (!a && id.startsWith('s:')) a = this.add(id, new LaneShard(id, this.cfg), 'shard', false);
    return a;
  }

  deliver(id, msg) {
    const a = this.actor(id);
    if (!a) {
      // a finished job's object still answers: nothing left to hand out
      if (msg.t === 'tick') return;                    // a finished job's alarm
      if (msg.t === 'want') this.push(this.now + this.doLat(), { k: MSG, a: msg.shard, b: { t: 'none', from: id } });
      // a finished job asked to re-run packs of a caught cheater: in the real system those results are
      // corrected after delivery (the consumer is told); here they are counted
      else if (msg.t === 'redo') { this.m.redoLate += msg.packs.length; for (const x of msg.packs) if (!x.ok) this.m.lateFixed++; }
      else { this.m.dropped++; this.m.droppedBy[msg.t] = (this.m.droppedBy[msg.t] || 0) + 1; }
      return;
    }
    if (DO_TYPES.has(a._type)) {
      this.m.doReq++; const k = a._type + '.' + msg.t; this.m.byMsg[k] = (this.m.byMsg[k] || 0) + 1;
      if (this.cfg.faults && this.cfg.reliable === 2 && msg.t !== 'tick') this.m.f.storageWrites++;   // saved before acknowledging
    }
    if (a._par || (a._busy <= this.now && a._qh === a._q.length)) return this.exec(a, msg);
    a._q.push(msg);
    if (!a._wake) { a._wake = true; this.push(a._busy, { k: WAKE, a }); }
  }

  wake(a) {
    a._wake = false;
    // work through one time step's worth of the inbox (events inside a step are not time-ordered,
    // so the step is measured from the current clock, not from the step boundary)
    const stepEnd = this.now + RES;
    do {
      if (a._dead || a._qh >= a._q.length) return;
      const msg = a._q[a._qh]; a._q[a._qh++] = undefined;
      if (a._qh === a._q.length) { a._q = []; a._qh = 0; }
      this.exec(a, msg);
    } while (a._busy < stepEnd);
    if (a._qh < a._q.length) { a._wake = true; this.push(a._busy, { k: WAKE, a }); }
  }

  exec(a, msg) {
    const cfg = this.cfg;
    const n = msg.items ? msg.items.length : msg.packs ? msg.packs.length : 0;
    const cost = a._par ? 0 : cfg.msgCost + n * cfg.itemCost;
    a._busy = Math.max(this.now, a._busy) + cost; a._bt += cost; a._w++;
    const ctx = this.ctx; ctx.now = this.now; ctx.self = a;
    a.handle(msg, ctx);
  }

  // A request between objects (or to the ledger / the consumer) under faults. Refused: lost for good with
  // reliable 0; with an outbox (1, 2) sent again after a growing pause. Delivered but its reply lost: the
  // sender sends it again; with reliable 2 the receiver recognises the message ID and drops the copy,
  // with reliable 1 the copy is processed a second time.
  sendF(to, msg, n) {
    const cfg = this.cfg, f = this.m.f;
    if (msg.t === 'credit' && n === 0) f.creditSent += msg.n;
    if (this.r() < cfg.refuse) {
      f.refused++;
      if (cfg.reliable >= 1) { f.retries++; this.push(this.now + Math.min(10, 0.2 * 2 ** n) * (0.5 + this.r()), { k: SYS, a: () => this.sendF(to, msg, n + 1) }); }
      else f.lost[msg.t] = (f.lost[msg.t] || 0) + 1;
      return;
    }
    this.push(this.now + this.doLat(), { k: MSG, a: to, b: msg });
    if (cfg.reliable >= 1 && this.r() < cfg.ackLoss) {
      if (cfg.reliable === 2) f.dupDropped++;
      else { f.dupDelivered[msg.t] = (f.dupDelivered[msg.t] || 0) + 1; this.push(this.now + 1 + this.doLat(), { k: MSG, a: to, b: msg }); }
    }
  }

  doLat() { return 0.002 + 0.008 * this.r(); }
  wsLat() { return Math.min(1, lognormal(this.r, 0.04, 0.5)); }

  setupCtx() {
    const w = this;
    this.ctx = {
      now: 0, self: null, rand: this.r,
      send(to, msg) { if (w.cfg.faults) w.sendF(to, msg, 0); else w.push(w.now + w.doLat(), { k: MSG, a: to, b: msg }); },
      device(i, msg) { w.toDevice(i, msg); },
      timer(d, msg) { w.push(w.now + d, { k: MSG, a: this.self.id, b: msg }); },
      spawn(id, kind, spec) {
        w.add(id, new Job(id, w.cfg, spec), 'job', false);
        w.push(w.now + w.doLat(), { k: MSG, a: id, b: { t: 'init' } });
      },
      exit() { const a = this.self; a._dead = true; w.actors.delete(a.id); },
    };
  }

  // ---- plan at t = 0 and consumer arrival rates ----------------------------------------
  setupPlanAndRates() {
    const cfg = this.cfg, lanes = cfg.lanes, NL = this.NL;
    const meanSpeed = Math.exp(0.5 * 0.5 / 2);
    this.onlineByClass = cfg.classMix.map(f => cfg.devices * f);
    const nominal = lanes.map(l => [0, 1, 2, 3].map(c => (l.from[c] || 0) * this.onlineByClass[c]));
    const cap = nominal.map((t, L) => t.reduce((s, n, c) => s + n * classSpeed(c, lanes[L].minClass) * meanSpeed, 0));
    cfg.initialPlan = {
      w: [0, 1, 2, 3].map(c => lanes.map(l => l.from[c] || 0)),
      nShards: nominal.map(t => Math.max(1, Math.ceil(t.reduce((a, b) => a + b, 0) / cfg.perShard))),
    };
    cfg.initialPlan.dirs = cfg.initialPlan.nShards.map(n => Math.max(1, Math.ceil(n / cfg.shardsPerDir)));
    const meanWork = cfg.jobMedian * Math.exp(cfg.jobSigma * cfg.jobSigma / 2);
    this.rate = cap.map(c => cfg.load * c / meanWork);           // jobs per second per lane
    const tot = this.rate.reduce((a, b) => a + b, 0);
    let base = 0;
    this.consumerRange = this.rate.map(r => { const n = Math.max(1, Math.round(cfg.consumers * r / tot)); const x = [base, n]; base += n; return x; });
    this.capacity = cap;
  }

  // ---- devices -------------------------------------------------------------------------
  setupDevices() {
    const cfg = this.cfg, r = this.r;
    const onMean = cfg.onMedian * Math.exp(cfg.onSigma * cfg.onSigma / 2);
    const fOn = onMean / (onMean + cfg.offMean);
    const N = this.N = Math.round(cfg.devices / fOn);
    const nets = cfg.networks || Math.ceil(N / 3);
    this.cls = new Uint8Array(N); this.spd = new Float32Array(N); this.net = new Int32Array(N);
    this.on = new Uint8Array(N); this.ep = new Int32Array(N); this.sess = new Int32Array(N);
    this.shard = new Array(N).fill(null); this.loaded = new Int8Array(N).fill(-1); this.disk = new Uint8Array(N);
    this.cheat = new Uint8Array(N); this.hung = new Uint8Array(N); this.acc = new Int32Array(N); this.str = new Uint8Array(N);
    this.bw = new Float32Array(N);
    this.unv = new Array(N).fill(null);    // ledger: packs accepted on a device's answer alone since its last check
    this.runTok = new Int32Array(N); this.runAt = new Float64Array(N); this.runWork = new Float32Array(N);
    const mixCum = []; cfg.classMix.reduce((s, f, c) => (mixCum[c] = s + f), 0);
    for (let i = 0; i < N; i++) {
      const x = r(); let c = 0; while (c < 3 && x > mixCum[c]) c++;
      this.cls[i] = c;
      this.spd[i] = Math.min(5, Math.max(0.2, lognormal(r, 1, 0.5)));
      this.net[i] = Math.floor(r() * nets);
      this.cheat[i] = r() < cfg.cheaters ? 1 : 0;
      this.hung[i] = r() < cfg.hung ? 1 : 0;
      // honest devices may already have a reputation; cheaters only if they first earned it ("sleepers")
      this.acc[i] = r() < cfg.trustedAtStart && (!this.cheat[i] || cfg.sleepers) ? cfg.trustAfter + Math.floor(r() * 100) : 0;
      this.bw[i] = Math.max(2, lognormal(r, cfg.bwMedian, 0.8));
      const L = c === 0 ? 0 : c === 1 ? 1 : c === 2 ? (r() < 0.7 ? 2 : 3) : 4;
      this.loaded[i] = L; this.disk[i] = 1 << L;
      if (c >= 2 && r() < 0.5) this.disk[i] |= 1 << (2 + Math.floor(r() * (c === 3 ? 3 : 2)));
      if (r() < fOn) {
        this.on[i] = 1; this.sess[i] = 1;
        this.push(r() * cfg.ramp, { k: DEV, a: i, b: 'connect', c: -1, e: 0 });
        this.push(cfg.ramp + this.onTime() * r(), { k: DEV, a: i, b: 'leave', c: 1 });
      } else this.push(expo(r, cfg.offMean), { k: DEV, a: i, b: 'return', c: 0 });
    }
  }

  onTime() { return Math.min(43200, lognormal(this.r, this.cfg.onMedian, this.cfg.onSigma)); }

  connect(i, want) {
    this.m.workerReq++;
    const s = Math.floor(this.now); if (s < this.m.connPerSec.length) this.m.connPerSec[s]++;
    this.push(this.now + this.wsLat(), { k: MSG, a: 'intake', b: { t: 'connect', i, cls: this.cls[i], loaded: this.loaded[i], disk: this.disk[i], want } });
  }

  wsSend(i, to, msg) {
    this.m.wsIn++;
    const cfg = this.cfg;
    if (cfg.faults && msg.t !== 'close' && this.r() < cfg.wsLoss) {
      this.m.f.wsLost++;
      // the device keeps the message until the shard acknowledges it (simple design: it resends until acknowledged)
      if (cfg.reliable >= 1) this.push(this.now + 5 + 5 * this.r(), { k: SYS, a: () => {
        if (this.on[i] && this.shard[i] === to) { this.m.f.wsResent++; this.wsSend(i, to, msg); } } });
      return;
    }
    if (msg.t === 'done' && cfg.faults) msg = { ...msg };          // a resent answer is a new message object
    this.push(this.now + this.wsLat(), { k: MSG, a: to, b: msg });
  }

  endSession(i, close) {
    if (close && this.shard[i]) this.wsSend(i, this.shard[i], { t: 'close', i });
    this.ep[i]++; this.on[i] = 0; this.shard[i] = null; this.sess[i]++;
  }

  // A message from a Durable Object or the Worker to a device.
  toDevice(i, msg) {
    const from = this.ctx.self;
    if (from && from._type === 'shard' && this.shard[i] !== from.id) {
      // that WebSocket is gone (e.g. a hello that arrived after a deploy): the shard sees it close
      this.push(this.now + this.wsLat(), { k: MSG, a: from.id, b: { t: 'close', i } });
      return;
    }
    if (!this.on[i]) return;
    const e = this.ep[i], cfg = this.cfg;
    if (cfg.faults && this.r() < cfg.wsLoss) {
      this.m.f.wsLost++;
      // the sender resends what the device did not acknowledge (simple design); otherwise only the lease helps
      if (cfg.reliable >= 1) this.push(this.now + 5 + 5 * this.r(), { k: SYS, a: () => {
        if (this.on[i] && this.ep[i] === e) { this.m.f.wsResent++; const s = this.ctx.self; this.ctx.self = from; this.toDevice(i, msg); this.ctx.self = s; } } });
      return;
    }
    if (msg.t === 'run') {
      if (this.hung[i]) return;
      const p = msg.pack, L = cfg.lanes[this.loaded[i]];
      const dur = p.u * L.unitTime / (classSpeed(this.cls[i], L.minClass) * this.spd[i]) * lognormal(this.r, 1, 0.15);
      this.m.packsRun++; this.m.workRun += p.u * L.unitTime;
      this.runTok[i]++; this.runAt[i] = this.now; this.runWork[i] = p.u * L.unitTime;
      this.push(this.now + 2 * this.wsLat() + dur, { k: DEV, a: i, b: 'done', c: p, e, f: this.runTok[i] });
    } else if (msg.t === 'cancel') {                      // stop the pack (its answer is no longer needed)
      this.runTok[i]++; this.m.cancelledRuns++; this.m.cancelledWork += this.runWork[i];
    } else if (msg.t === 'check') {
      this.m.checks++;
      this.push(this.now + 2 * this.wsLat() + cfg.checkTime / this.spd[i], { k: DEV, a: i, b: 'checked', e });
    } else this.push(this.now + this.wsLat(), { k: DEV, a: i, b: 'recv', c: msg, e });
  }

  devEvent(ev) {
    const i = ev.a, cfg = this.cfg, r = this.r;
    switch (ev.b) {
      case 'leave':
        if (ev.c !== this.sess[i] || !this.on[i]) return;
        this.endSession(i, true);
        this.push(this.now + expo(r, cfg.offMean), { k: DEV, a: i, b: 'return', c: this.sess[i] });
        return;
      case 'return':
        if (ev.c !== this.sess[i] || this.on[i]) return;
        this.on[i] = 1; this.sess[i]++;
        this.push(this.now + this.onTime(), { k: DEV, a: i, b: 'leave', c: this.sess[i] });
        this.connect(i, -1);
        return;
      case 'closeLate': this.wsSend(i, ev.c, { t: 'close', i }); return;
    }
    if (ev.e !== this.ep[i] || !this.on[i]) return;          // that connection is gone
    switch (ev.b) {
      case 'connect': return this.connect(i, ev.c);
      case 'done':
        if (ev.f !== this.runTok[i]) return;               // cancelled meanwhile
        return this.wsSend(i, this.shard[i], { t: 'done', i, pack: ev.c, ok: !(this.cheat[i] && r() < cfg.cheatRate) });
      case 'checked': return this.wsSend(i, this.shard[i], { t: 'checked', i });
      case 'ready':
        this.loaded[i] = ev.c.lane; this.disk[i] |= 1 << ev.c.lane; this.shard[i] = ev.c.sid;
        { const unv = this.unv[i] || []; this.unv[i] = null;
          return this.wsSend(i, ev.c.sid, { t: 'hello', i, cls: this.cls[i], net: this.net[i], disk: this.disk[i], acc: this.acc[i], strikes: this.str[i], unv }); }
      case 'recv': return this.recv(i, ev.c);
    }
  }

  recv(i, msg) {
    const cfg = this.cfg, m = this.m;
    switch (msg.t) {
      case 'assign': {
        const lane = msg.lane, sid = `s:${lane}:${msg.shard}`, L = cfg.lanes[lane];
        let t = 0;
        if (this.loaded[i] !== lane) {
          if ((this.disk[i] >> lane) & 1) { t = cfg.diskLoad * (0.5 + this.r()); m.diskLoads++; }
          else { t = L.modelGB * 8000 / this.bw[i] + cfg.diskLoad; m.downloads++; m.dlGB += L.modelGB; }
        }
        this.push(this.now + t, { k: DEV, a: i, b: 'ready', c: { lane, sid }, e: this.ep[i] });
        return;
      }
      case 'switch': this.ep[i]++; this.shard[i] = null; m.switches++; return this.connect(i, msg.lane);
      case 'kick':
        m.kicks++; this.endSession(i, false);
        this.push(this.now + expo(this.r, cfg.offMean), { k: DEV, a: i, b: 'return', c: this.sess[i] });
        return;
    }
  }

  // ---- orchestrator objects, sinks, arrivals, chaos, sampling --------------------------
  setupActors() {
    const cfg = this.cfg, w = this;
    for (let L = 0; L < this.NL; L++) for (let k = 0; k < cfg.initialPlan.dirs[L]; k++) {
      const id = `d:${L}:${k}`;
      this.add(id, new Directory(id, cfg), 'dir', false);
      this.push(cfg.tick * this.r(), { k: MSG, a: id, b: { t: 'tick' } });
    }
    this.add('plan', new Plan('plan', cfg), 'plan', false);
    this.push(cfg.planTick, { k: MSG, a: 'plan', b: { t: 'tick' } });
    this.add('intake', new Intake('intake', cfg), 'worker', true);
    this.push(cfg.tick, { k: MSG, a: 'intake', b: { t: 'tick' } });
    this.add('ledger', { handle(msg) {
      if (msg.t === 'rep') {
        w.acc[msg.i] += msg.dAcc; w.str[msg.i] = Math.min(255, w.str[msg.i] + msg.dStr); w.m.ledgerWrites++;
        if (msg.unv) w.unv[msg.i] = msg.unv.length ? msg.unv.slice(-256) : null;
        if (msg.unvClear) w.unv[msg.i] = null;
        if (msg.unvAdd) { const a = w.unv[msg.i] || (w.unv[msg.i] = []); a.push(msg.unvAdd); if (a.length > 256) a.shift(); }
        if (msg.caught && w.unv[msg.i]) {                // caught after leaving: re-run its unchecked acceptances
          const byJob = new Map();
          for (const [j, p, ok] of w.unv[msg.i]) { let a = byJob.get(j); if (!a) byJob.set(j, a = []); a.push({ p, ok }); }
          for (const [j, packs] of byJob) w.push(w.now + w.doLat(), { k: MSG, a: j, b: { t: 'redo', packs } });
          w.unv[msg.i] = null;
        }
      }
      else if (msg.t === 'credit') { w.m.ledgerWrites += msg.n; w.m.f.creditRecv += msg.n; }
    } }, 'sink', true);
    this.roots = new Map();
    this.add('consumers', { handle: (msg) => this.consumerMsg(msg) }, 'sink', true);

    for (let L = 0; L < this.NL; L++) if (this.rate[L] > 0) this.nextArrival(L);
    this.push(cfg.sample, { k: SYS, a: () => this.sampleTick() });
    if (cfg.deployAt >= 0) this.push(cfg.deployAt, { k: SYS, a: () => this.deploy() });
    if (cfg.outageAt >= 0) this.push(cfg.outageAt, { k: SYS, a: () => this.outage() });
    if (cfg.burstAt >= 0) this.push(cfg.burstAt, { k: SYS, a: () => this.burst() });
    if (cfg.faults && cfg.crashPerHour > 0) this.push(10, { k: SYS, a: () => this.crashTick() });
  }

  // Every 10 s each Durable Object crashes with probability crashPerHour * 10 / 3600.
  crashTick() {
    const p = this.cfg.crashPerHour * 10 / 3600;
    for (const a of [...this.actors.values()]) if (DO_TYPES.has(a._type) && !a._dead && this.r() < p) this.crash(a);
    this.push(this.now + 10, { k: SYS, a: () => this.crashTick() });
  }

  // A Durable Object restarts: its memory is gone, its WebSockets drop. With the simple design (reliable 2)
  // its state was saved before every acknowledgement, so only the sockets and a few seconds are lost; without
  // it the object starts empty: a shard loses its buffered packs and unsent results, a job is lost with
  // everything it held, a directory forgets its jobs, the planner its picture.
  crash(a) {
    const cfg = this.cfg, f = this.m.f, t = a._type, durable = cfg.reliable === 2, ctx = this.ctx;
    f.crashes[t] = (f.crashes[t] || 0) + 1;
    if (t === 'shard') {
      for (const i of a.dev.keys()) if (this.on[i] && this.shard[i] === a.id) {
        this.ep[i]++; this.shard[i] = null;
        this.push(this.now + cfg.restartTime + 10 * this.r(), { k: DEV, a: i, b: 'connect', c: -1, e: this.ep[i] });
      }
      if (durable) { ctx.now = this.now; ctx.self = a; a.handle({ t: 'restart' }, ctx); a._busy = Math.max(a._busy, this.now + cfg.restartTime); return; }
      f.packsLostInShards += a.queued(); for (const o of a.out.values()) f.resultsLostInShards += o.length;
      this.replace(a, new LaneShard(a.id, cfg));
      return;
    }
    if (durable) { a._busy = Math.max(a._busy, this.now + cfg.restartTime); return; }
    if (t === 'job') {
      a._dead = true; this.actors.delete(a.id); f.partsLost++;
      if (this.roots.has(a.root)) { this.roots.delete(a.root); f.jobsLost++; }
      return;
    }
    if (t === 'dir') this.replace(a, new Directory(a.id, cfg));
    else if (t === 'plan') { const moves = a.moves; const n = this.replace(a, new Plan(a.id, cfg)); n.moves = moves; }
  }

  replace(a, obj) {
    a._dead = true; this.actors.delete(a.id);
    return this.add(a.id, obj, a._type, a._par);
  }

  nextArrival(L) {
    this.push(this.now + expo(this.r, 1 / this.rate[L]), { k: SYS, a: () => {
      const [b, n] = this.consumerRange[L];
      this.submit(b + Math.floor(this.r() * n), L, Math.min(this.cfg.jobMax, lognormal(this.r, this.cfg.jobMedian, this.cfg.jobSigma)), 0);
      this.nextArrival(L);
    } });
  }

  submit(c, lane, work, tries, first) {
    this.m.workerReq++; if (!tries) this.m.submitted++;
    this.push(this.now + this.wsLat(), { k: MSG, a: 'intake', b: { t: 'submit', c, lane, work, tries, first: first ?? this.now } });
  }

  consumerMsg(msg) {
    const m = this.m, cfg = this.cfg;
    if (msg.t === 'accepted') {
      this.roots.set(msg.root, { c: msg.c, lane: msg.lane, work: msg.work, left: msg.parts, first: msg.first, at: this.now,
        firstAt: -1, cancelled: false, stalled: false, copies: 0, n: 0, hedges: 0, wrong: 0, caught: 0, forced: 0 });
    } else if (msg.t === 'rejected') {
      m.rejected[msg.why] = (m.rejected[msg.why] || 0) + 1;
      if (msg.tries < cfg.retries) this.push(this.now + 60 * 2 ** msg.tries, { k: SYS, a: () => this.submit(msg.c, msg.lane, msg.work, msg.tries + 1, msg.first) });
      else m.gaveUp++;
    } else if (msg.t === 'jobDone') {
      const r = this.roots.get(msg.root); if (!r) return;
      r.left--; r.copies += msg.copies; r.n += msg.n; r.hedges += msg.hedges; r.wrong += msg.wrong; r.caught += msg.caught; r.forced += msg.forced;
      r.late = (r.late || 0) + msg.late; r.fixed = (r.fixed || 0) + msg.fixed; r.redone = (r.redone || 0) + msg.redone; r.cancels = (r.cancels || 0) + msg.cancels;
      r.leases = (r.leases || 0) + (msg.leases || 0);
      if (msg.firstAt >= 0 && (r.firstAt < 0 || msg.firstAt < r.firstAt)) r.firstAt = msg.firstAt;
      r.cancelled ||= msg.cancelled; r.stalled ||= msg.stalled;
      if (r.left > 0) return;
      this.roots.delete(msg.root);
      const J = m.jobs;
      if (r.cancelled) J.cancelled++; else J.done++;
      if (r.stalled) J.stalled++;
      J.copies += r.copies; J.packs += r.n; J.hedges += r.hedges; J.wrong += r.wrong; J.caught += r.caught; J.forced += r.forced;
      J.late += r.late || 0; J.fixed += r.fixed || 0; J.redone += r.redone || 0; J.cancels += r.cancels || 0;
      m.f.leases += r.leases || 0;
      if (r.first >= cfg.warmup && !r.cancelled) {
        const k = r.work < 1e3 ? 'small' : r.work < 3e4 ? 'medium' : 'large';
        m.times[k].push(this.now - r.at);
        m.e2e.push(this.now - r.first);
        if (r.firstAt >= 0) m.ttfr.push(r.firstAt - r.at);
      }
    }
  }

  deploy() {
    // every WebSocket drops; shards keep their durable state; devices reconnect with jitter
    const ctx = this.ctx;
    for (const a of this.actors.values()) if (a._type === 'shard') { ctx.now = this.now; ctx.self = a; a.handle({ t: 'restart' }, ctx); }
    for (let i = 0; i < this.N; i++) if (this.on[i]) {
      this.ep[i]++; this.shard[i] = null;
      this.push(this.now + 0.1 + this.cfg.jitter * this.r(), { k: DEV, a: i, b: 'connect', c: -1, e: this.ep[i] });
    }
  }

  outage() {
    const cfg = this.cfg;
    for (let i = 0; i < this.N; i++) if (this.on[i] && this.r() < cfg.outageFrac) {
      const sid = this.shard[i];
      this.endSession(i, false);
      if (sid && !cfg.outageSilent) this.push(this.now + 10 + 50 * this.r(), { k: DEV, a: i, b: 'closeLate', c: sid });
      this.push(this.now + cfg.outageFor * (0.8 + 0.4 * this.r()), { k: DEV, a: i, b: 'return', c: this.sess[i] });
    }
  }

  burst() {
    const cfg = this.cfg, [b, n] = this.consumerRange[cfg.burstLane];
    for (let k = 0; k < cfg.burstN; k++)
      this.push(this.now + 10 * this.r(), { k: SYS, a: () => this.submit(b + (k % n), cfg.burstLane, cfg.burstWork, 0) });
  }

  sampleTick() {
    const cfg = this.cfg, dt = cfg.sample, NL = this.NL, m = this.m;
    const n = new Float64Array(NL), idle = new Float64Array(NL), q = new Float64Array(NL), ready = new Float64Array(NL);
    let jobs = 0;
    for (const a of this.actors.values()) {
      const t = a._type;
      if (t === 'shard') { n[a.lane] += a.dev.size; idle[a.lane] += a.nIdle; q[a.lane] += a.queued(); }
      else if (t === 'job') { ready[a.lane] += a.readyLen(); jobs++; }
      if (t === 'sink') continue;
      const rate = a._w / dt, util = (a._bt - a._bt0) / dt;
      const pk = m.peak[t] || (m.peak[t] = { rate: 0, rateId: '', util: 0, utilId: '', count: 0 });
      if (rate > pk.rate) { pk.rate = rate; pk.rateId = a.id; pk.rateAt = this.now; }
      if (util > pk.util) { pk.util = util; pk.utilId = a.id; }
      if (DO_TYPES.has(t) && a._w > 0) m.doActive += dt;
      a._w = 0; a._bt0 = a._bt;
    }
    for (const t in m.peak) m.peak[t].count = 0;
    for (const a of this.actors.values()) if (m.peak[a._type]) m.peak[a._type].count++;
    if (this.now >= cfg.warmup) for (let L = 0; L < NL; L++) {
      m.devSec[L] += n[L] * dt; m.busySec[L] += (n[L] - idle[L]) * dt;
      m.iwq[L] += Math.min(idle[L], q[L] + ready[L]) * dt;
    }
    let locked = 0;
    for (const r of this.roots.values()) if (this.now - r.at > 1800) locked += r.work;
    m.lockedMax = Math.max(m.lockedMax, locked);
    m.series.push([Math.round(this.now), ...Array.from(n, Math.round), ...Array.from(idle, Math.round), ...Array.from(q, (x, L) => Math.round(x + ready[L])), jobs]);
    this.push(this.now + dt, { k: SYS, a: () => this.sampleTick() });
  }
}
