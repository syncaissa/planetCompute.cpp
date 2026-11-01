// Planner "plan": one object. Every planTick seconds it decides how many devices of each class
// each lane should hold, sends moves (with hysteresis and a cap per round) and publishes the
// plan the intake uses to place connecting devices and admit jobs.  Pure logic.
import { classSpeed } from './sizing.js';

export class Plan {
  constructor(id, cfg) {
    this.id = id; this.cfg = cfg;
    this.NL = cfg.lanes.length;
    this.lanes = new Array(this.NL).fill(null);
    this.dirs = cfg.lanes.map(() => new Map());       // lane -> directory shard -> latest report
    this.arr = new Float64Array(this.NL); this.arrSeen = false;
    this.nShards = cfg.initialPlan.nShards.slice();
    this.moves = 0;
    this.short = cfg.lanes.map(() => [0, 0, 0, 0]);   // planning rounds in a row a lane was short of a class
  }

  handle(m, ctx) {
    if (m.t === 'lane') { this.dirs[m.lane].set(m.dir, m); this.lanes[m.lane] = this.sumLane(m.lane); }
    else if (m.t === 'arr') {
      for (let L = 0; L < this.NL; L++) {
        const r = m.w[L] / m.dt;
        this.arr[L] = this.arrSeen ? (1 - this.cfg.arrAlpha) * this.arr[L] + this.cfg.arrAlpha * r : r;
      }
      this.arrSeen = true;
    } else if (m.t === 'tick') { this.replan(ctx); ctx.timer(this.cfg.planTick, { t: 'tick' }); }
  }

  sumLane(L) {
    const r = { n: 0, idle: 0, q: 0, qWork: 0, pWork: 0, pPacks: 0, cls: [0, 0, 0, 0], icls: [0, 0, 0, 0], jobs: 0, shards: 0 };
    for (const x of this.dirs[L].values()) {
      for (const k of ['n', 'idle', 'q', 'qWork', 'pWork', 'pPacks', 'jobs', 'shards']) r[k] += x[k];
      for (let c = 0; c < 4; c++) { r.cls[c] += x.cls[c]; r.icls[c] += x.icls[c]; }
    }
    return r;
  }

  // a move goes to the directory shards of the source lane, in proportion to their devices of that class
  sendMove(ctx, from, c, k, to, download) {
    const ds = [...this.dirs[from].values()].filter(x => x.cls[c] > 0);
    const tot = ds.reduce((s, x) => s + x.cls[c], 0);
    let left = k;
    for (let n = 0; n < ds.length && left > 0; n++) {
      const kk = n === ds.length - 1 ? left : Math.min(left, Math.ceil(k * ds[n].cls[c] / tot));
      left -= kk;
      ctx.send(ds[n].dir, { t: 'move', cls: c, k: kk, to, download });
    }
  }

  replan(ctx) {
    const cfg = this.cfg, NL = this.NL, lanes = cfg.lanes;
    if (this.lanes.some(x => !x)) return;                          // wait for every lane's first report
    const cur = this.lanes.map(x => x.cls.slice());
    const avail = [0, 0, 0, 0];
    for (let L = 0; L < NL; L++) for (let c = 0; c < 4; c++) avail[c] += cur[L][c];
    const backlog = this.lanes.map(x => x.qWork + x.pWork);
    const demand = backlog.map((b, L) => (this.arr[L] + b / cfg.drain) * cfg.headroom);

    // Most exclusive lanes first (big-GPU lanes), each drawing the least capable class that can serve it.
    const target = lanes.map(() => [0, 0, 0, 0]), left = avail.slice();
    const groups = [...new Set(lanes.map(l => l.minClass))].sort((a, b) => b - a);
    for (const g of groups) {
      const Ls = lanes.map((l, L) => L).filter(L => lanes[L].minClass === g);
      let supply = 0; for (let c = g; c < 4; c++) supply += left[c] * classSpeed(c, g);
      const tot = Ls.reduce((s, L) => s + demand[L], 0);
      const f = tot > supply ? supply / tot : 1;
      for (const L of Ls) {
        let rem = demand[L] * f;
        for (let c = g; c < 4 && rem > 0; c++) {
          if (c === g + 1) rem /= cfg.headroom;            // borrow stronger devices for the backlog only, not for headroom
          const s = classSpeed(c, g), take = Math.min(left[c], Math.ceil(rem / s));
          target[L][c] += take; left[c] -= take; rem -= take * s;
        }
      }
    }
    // Devices nobody needs right now stay where they are (warm, on standby).
    for (let c = 0; c < 4; c++) {
      if (left[c] <= 0) continue;
      let tot = 0; const sur = [];
      for (let L = 0; L < NL; L++) { sur[L] = Math.max(0, cur[L][c] - target[L][c]); tot += sur[L]; }
      for (let L = 0; L < NL; L++) target[L][c] += tot ? Math.round(left[c] * sur[L] / tot) : 0;
    }

    // a lane's backlog in seconds at its current strength
    const wait = [], caps = [];
    for (let L = 0; L < NL; L++) {
      let cap = 0; for (let c = 0; c < 4; c++) cap += cur[L][c] * classSpeed(c, lanes[L].minClass);
      wait[L] = cap > 0 ? backlog[L] / cap : Infinity; caps[L] = cap;
    }
    if (cfg.rebalance) {
      for (let c = 0; c < 4; c++) {
        let budget = Math.ceil(cfg.moveCap * avail[c]);
        const def = [], sur = [];
        for (let L = 0; L < NL; L++) {
          const d = target[L][c] - cur[L][c];
          // download a model only for a shortage that persisted and a backlog that outlasts the download 3x
          const dl = lanes[L].modelGB * 8000 / cfg.bwMedian;
          if (d >= Math.max(cfg.moveMin, 0.1 * target[L][c])) { this.short[L][c]++; if (this.short[L][c] >= 2) def.push([L, d, this.short[L][c] >= 4 && wait[L] > 3 * dl]); }
          else { this.short[L][c] = 0; if (d < 0) sur.push([L, -d]); }
        }
        def.sort((a, b) => b[1] - a[1]); sur.sort((a, b) => b[1] - a[1]);
        for (const dd of def) for (const ss of sur) {
          const k = Math.min(dd[1], ss[1], budget);
          if (k <= 0) continue;
          dd[1] -= k; ss[1] -= k; budget -= k; this.moves += k;
          this.sendMove(ctx, ss[0], c, k, dd[0], dd[2]);
        }
      }
    }

    const w = [0, 1, 2, 3].map(c => lanes.map((l, L) => l.minClass > c ? 0 : Math.max(0, target[L][c] - cur[L][c]) + 0.02 * target[L][c] + 1));
    const share = [];
    for (let L = 0; L < NL; L++) {
      share[L] = Math.max(1, cur[L].reduce((a, b) => a + b, 0) / Math.max(1, this.lanes[L].jobs));
      const want = Math.ceil(target[L].reduce((a, b) => a + b, 0) / cfg.perShard);
      this.nShards[L] = Math.max(this.nShards[L], want);
    }
    ctx.send('intake', { t: 'plan', w, nShards: this.nShards.slice(), wait, cap: caps, share, target, cur });
  }
}
