//! The SherpaHub: it ORGANISES a BatchMode job (docs/SHERPAHUB.md section 5). Cuts the job into units, sizes packs
//! per device (the research's square-root law), sends them, checks EVERY returned unit (Freivalds), keeps a
//! crash-safe checkpoint, hedges the slow tail, strikes and bans liars, and assembles the result.
//!
//! A pure state machine: time is passed in (`now`, milliseconds), never read, and nothing runs in the background.
//! The same calls give the same outputs, so the simulator replays every failure exactly. The network layer only
//! moves bytes and calls `on_hello` / `on_message` / `on_gone` / `tick`.

use crate::device::as_i8;
use crate::kernels::{freivalds, Rng, Rng64, KERNEL_MATMUL_I8};
use crate::store::{JobSpec, Store};
use crate::wire::{block_id, decode, encode, Block, BlockId, Msg, Pack, UnitSpec, MAX_UNITS};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::path::Path;

pub type DevId = u32;

#[derive(Clone, Debug)]
pub struct Config {
    /// Tail coefficient of the square-root law (1 with hedging, 2-3 without).
    pub kappa: f64,
    /// Longest pack, ms.
    pub tau_max_ms: f64,
    /// First guess of a device's time per unit, ms (until it returns a pack).
    pub t_unit_guess_ms: f64,
    /// First guess of the per-pack overhead (round trip + transfer), ms.
    pub t_o_guess_ms: f64,
    /// First guess of departures per device-ms.
    pub leave_rate_guess: f64,
    /// Copies of a unit at most (1 = no hedging).
    pub max_copies: u8,
    /// Packs in flight per device at most (1 = wait for each RESULT). Devices handle messages strictly in order, so
    /// later packs queue on the device while earlier ones compute and travel; the hub also keeps the blocks of all
    /// packs in flight within half the device's cache.
    pub max_inflight: usize,
    /// Freivalds rounds per unit (each lets a wrong tile through with probability <= 2^-16).
    pub rounds: u32,
    pub strikes_to_ban: u32,
    /// Make the checkpoint durable at least this often (ms) or after this many checked units.
    pub flush_ms: u64,
    pub flush_units: usize,
    /// Bytes of input blocks the hub keeps in memory (it re-makes or re-reads the rest).
    pub hub_block_bytes: usize,
    /// Secret seed of the Freivalds vectors.
    pub seed: u64,
    /// Largest message the network carries (a RESULT must fit: it limits units per pack). The site broker carries 1 MiB.
    pub max_message: usize,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            kappa: 1.5,
            tau_max_ms: 300_000.0,
            t_unit_guess_ms: 2_000.0,
            t_o_guess_ms: 1_000.0,
            leave_rate_guess: 1.0 / 1_800_000.0,
            max_copies: 2,
            max_inflight: 1,
            rounds: 2,
            strikes_to_ban: 3,
            flush_ms: 250,
            flush_units: 256,
            hub_block_bytes: 256 << 20,
            seed: 0x5EED_5EED_5EED_5EED,
            max_message: crate::wire::MAX_MESSAGE,
        }
    }
}

/// What the network layer must do after a call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Out {
    Send(DevId, Vec<u8>),
    /// Checked units the device computed (credit them once; never sent twice for the same unit).
    Credit(DevId, u32),
    Strike(DevId),
    Ban(DevId),
    /// Every unit is done AND the whole product passed the final check.
    Done,
    /// Every unit is done but the final whole-product check failed (should never happen; the job is not reported).
    Corrupt,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub packs_sent: u64,
    pub units_sent: u64,
    pub hedges: u64,
    pub timeouts: u64,
    pub results: u64,
    pub units_accepted: u64,
    pub units_duplicate: u64,
    pub units_failed: u64,
    pub credited: u64,
    pub refused: u64,
    pub stale: u64,
    pub needs: u64,
    pub blocks_sent: u64,
    pub bytes_out: u64,
    pub bytes_in: u64,
    pub strikes: u64,
    pub bans: u64,
}

const WAITING: u8 = 0;
const OUT: u8 = 1;
const DONE: u8 = 2;

struct Dev {
    cache_blocks: usize,
    held: VecDeque<BlockId>, // the hub's picture of the device's cache, least recently used first
    t_unit: f64,
    measured: bool,
    inflight: Vec<u64>, // packs sent and not answered, oldest first
    queued_ms: f64,     // expected compute of the packs in flight
    footprint: usize,   // blocks used by the packs in flight
    joined: u64,
}

struct PackRec {
    dev: DevId,
    units: Vec<u32>,
    issued: u64,
    deadline: u64,
    open: bool,
    expected: u64, // the time this pack should take on its device (ms), counting the packs queued before it
    work_ms: f64,  // its own expected compute
    nblocks: usize,
    alone: bool, // sent while the device had nothing in flight: its round trip measures the overhead
    needs: u8,
    bytes: Vec<u8>, // the encoded PACK (sent again after a NEED)
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum BKey {
    A(u32),
    Bt(u32),
}

pub struct Hub {
    cfg: Config,
    store: Store,
    job: JobSpec,
    state: Vec<u8>,
    copies: Vec<u8>,
    col_wait: Vec<Vec<u32>>, // waiting units per column block (weight-stationary: devices stay on a column)
    waiting: usize,
    devs: BTreeMap<DevId, Dev>,
    idle: BTreeSet<DevId>,
    strikes: BTreeMap<DevId, u32>,
    banned: BTreeSet<DevId>,
    packs: BTreeMap<u64, PackRec>,
    by_deadline: BTreeSet<(u64, u64)>,
    order: VecDeque<u64>, // open packs in issue order (hedging takes the oldest)
    next_pack: u64,
    blocks: HashMap<BKey, (BlockId, Vec<u8>, u64)>,
    block_keys: HashMap<BlockId, BKey>,
    block_bytes: usize,
    block_tick: u64,
    t_o: f64,
    t_med: f64,
    leaves: f64,
    dev_ms: f64,
    last_flush: u64,
    pending: usize,
    rng: Rng64,
    finished: bool,
    pub stats: Stats,
}

fn ewma(old: f64, x: f64) -> f64 {
    0.7 * old + 0.3 * x
}

impl Hub {
    /// Start a new job in an empty checkpoint directory.
    pub fn create(dir: &Path, job: JobSpec, cfg: Config) -> Result<Hub, String> {
        let store = Store::create(dir, job)?;
        Ok(Hub::from_store(store, cfg))
    }

    /// Continue a job from its checkpoint directory only (after a crash or restart): new epoch, done units kept,
    /// everything else waiting again.
    pub fn resume(dir: &Path, cfg: Config) -> Result<Hub, String> {
        Ok(Hub::from_store(Store::open(dir)?, cfg))
    }

    fn from_store(store: Store, cfg: Config) -> Hub {
        let job = store.job.clone();
        assert!(job.k > 0 && job.k <= crate::kernels::FREIVALDS_MAX && job.tm <= crate::kernels::FREIVALDS_MAX && job.tn <= crate::kernels::FREIVALDS_MAX);
        let units = job.units();
        let (mut state, mut col_wait) = (vec![WAITING; units], vec![Vec::new(); job.col_blocks()]);
        let mut waiting = 0;
        // push in reverse so units pop in increasing row order
        for u in (0..units).rev() {
            if store.is_done(u) {
                state[u] = DONE;
            } else {
                col_wait[u % job.col_blocks()].push(u as u32);
                waiting += 1;
            }
        }
        let rng = Rng64::new(cfg.seed ^ job.id ^ ((store.epoch as u64) << 32));
        Hub {
            t_o: cfg.t_o_guess_ms,
            t_med: cfg.t_unit_guess_ms,
            next_pack: (store.epoch as u64) << 40,
            cfg,
            job,
            store,
            copies: vec![0; units],
            state,
            col_wait,
            waiting,
            devs: BTreeMap::new(),
            idle: BTreeSet::new(),
            strikes: BTreeMap::new(),
            banned: BTreeSet::new(),
            packs: BTreeMap::new(),
            by_deadline: BTreeSet::new(),
            order: VecDeque::new(),
            blocks: HashMap::new(),
            block_keys: HashMap::new(),
            block_bytes: 0,
            block_tick: 0,
            leaves: 0.0,
            dev_ms: 0.0,
            last_flush: 0,
            pending: 0,
            rng,
            finished: false,
            stats: Stats::default(),
        }
    }

    pub fn epoch(&self) -> u32 {
        self.store.epoch
    }
    pub fn job(&self) -> &JobSpec {
        &self.job
    }
    pub fn done_units(&self) -> usize {
        self.store.done
    }
    pub fn is_finished(&self) -> bool {
        self.finished
    }
    /// The assembled product (row-major). For tests and small jobs.
    pub fn result(&mut self) -> Result<Vec<i32>, String> {
        self.store.assemble()
    }

    // ---------- input blocks (synthetic job: made from the seeds; real jobs read files) ----------

    /// The bytes of a block: A row block i (rows x k) or BT column block j (cols x k).
    pub fn block_bytes_for(job: &JobSpec, key_a: bool, idx: usize) -> Vec<u8> {
        let rows = if key_a { job.tile_dims(idx, 0).0 } else { job.tile_dims(0, idx).1 };
        let seed = if key_a { job.seed_a } else { job.seed_b };
        let mut v = vec![0i8; rows * job.k];
        Rng::new(seed ^ (idx as u32).wrapping_add(1).wrapping_mul(0x9E37_79B1)).fill_i8(&mut v);
        v.into_iter().map(|x| x as u8).collect()
    }

    fn block(&mut self, key: BKey) -> (BlockId, &[u8]) {
        self.block_tick += 1;
        let tick = self.block_tick;
        if !self.blocks.contains_key(&key) {
            let bytes = match key {
                BKey::A(i) => Hub::block_bytes_for(&self.job, true, i as usize),
                BKey::Bt(j) => Hub::block_bytes_for(&self.job, false, j as usize),
            };
            while self.block_bytes + bytes.len() > self.cfg.hub_block_bytes && !self.blocks.is_empty() {
                let old = *self.blocks.iter().min_by_key(|(_, v)| v.2).map(|(k, _)| k).unwrap();
                let (oid, ob, _) = self.blocks.remove(&old).unwrap();
                self.block_bytes -= ob.len();
                let _ = oid;
            }
            let id = block_id(&bytes);
            self.block_keys.insert(id, key);
            self.block_bytes += bytes.len();
            self.blocks.insert(key, (id, bytes, tick));
        }
        let e = self.blocks.get_mut(&key).unwrap();
        e.2 = tick;
        (e.0, &e.1)
    }

    fn block_id_of(&mut self, key: BKey) -> BlockId {
        self.block(key).0
    }

    // ---------- events ----------

    /// A device can take packs. `cache_bytes`: how much of the job's blocks it keeps.
    pub fn on_hello(&mut self, now: u64, dev: DevId, cache_bytes: usize) -> Vec<Out> {
        if self.banned.contains(&dev) {
            return vec![];
        }
        self.release_device(dev);
        let block = self.job.tm.max(self.job.tn) * self.job.k;
        self.devs.insert(dev, Dev { cache_blocks: (cache_bytes / block).max(2), held: VecDeque::new(), t_unit: self.t_med, measured: false, inflight: Vec::new(), queued_ms: 0.0, footprint: 0, joined: now });
        self.idle.insert(dev);
        self.tick(now)
    }

    /// The device left (closed its tab, lost its connection). Its pack goes back to waiting.
    pub fn on_gone(&mut self, now: u64, dev: DevId) -> Vec<Out> {
        if let Some(d) = self.devs.get(&dev) {
            self.dev_ms += now.saturating_sub(d.joined) as f64;
            self.leaves += 1.0;
        }
        self.release_device(dev);
        self.tick(now)
    }

    fn release_device(&mut self, dev: DevId) {
        if let Some(d) = self.devs.remove(&dev) {
            for p in d.inflight {
                self.close_pack(p);
            }
        }
        self.idle.remove(&dev);
    }

    /// Close a pack: its units not done lose a copy; a unit with no copy left is waiting again.
    fn close_pack(&mut self, p: u64) {
        let Some(rec) = self.packs.get_mut(&p) else { return };
        if !rec.open {
            return;
        }
        rec.open = false;
        let (deadline, units) = (rec.deadline, std::mem::take(&mut rec.units));
        self.by_deadline.remove(&(deadline, p));
        for &u in &units {
            let ui = u as usize;
            if self.state[ui] != DONE {
                self.copies[ui] = self.copies[ui].saturating_sub(1);
                if self.copies[ui] == 0 && self.state[ui] == OUT {
                    self.state[ui] = WAITING;
                    self.col_wait[ui % self.job.col_blocks()].push(u);
                    self.waiting += 1;
                }
            }
        }
        // keep the unit list: a late RESULT for this pack is still checked and, if not done yet, accepted
        self.packs.get_mut(&p).unwrap().units = units;
    }

    /// A message from a device (RESULT or NEED).
    pub fn on_message(&mut self, now: u64, dev: DevId, bytes: &[u8]) -> Vec<Out> {
        self.stats.bytes_in += bytes.len() as u64;
        if self.banned.contains(&dev) {
            return vec![];
        }
        let msg = match decode(bytes) {
            Ok(m) => m,
            Err(_) => {
                self.stats.refused += 1;
                return vec![];
            }
        };
        let mut out = Vec::new();
        match msg {
            Msg::Need(n) => {
                if n.job != self.job.id || n.epoch != self.store.epoch {
                    self.stats.stale += 1;
                    return out;
                }
                let Some(rec) = self.packs.get(&n.pack) else {
                    self.stats.refused += 1;
                    return out;
                };
                if rec.dev != dev || !rec.open {
                    self.stats.refused += 1;
                    return out;
                }
                if rec.needs >= 2 {
                    // the device keeps losing the blocks (or plays games): withdraw the pack, it goes to others
                    self.stats.refused += 1;
                    self.close_pack(n.pack);
                    self.landed(dev, n.pack);
                    out.extend(self.tick(now));
                    return out;
                }
                self.packs.get_mut(&n.pack).unwrap().needs += 1;
                let rec = &self.packs[&n.pack];
                // only blocks this pack really uses
                let units = rec.units.clone();
                let resend = rec.bytes.clone();
                let mut allowed = Vec::new();
                for &u in &units {
                    let (i, j) = self.job.tile(u as usize);
                    allowed.push(BKey::A(i as u32));
                    allowed.push(BKey::Bt(j as u32));
                }
                self.stats.needs += 1;
                for id in n.blocks {
                    match self.block_keys.get(&id).copied() {
                        Some(k) if allowed.contains(&k) => {
                            let (bid, b) = self.block(k);
                            let msg = encode(&Msg::Block(Block { id: bid, bytes: b.to_vec() }));
                            self.stats.blocks_sent += 1;
                            self.stats.bytes_out += msg.len() as u64;
                            out.push(Out::Send(dev, msg));
                            self.mark_held(dev, id);
                        }
                        _ => self.stats.refused += 1,
                    }
                }
                self.stats.bytes_out += resend.len() as u64;
                out.push(Out::Send(dev, resend));
            }
            Msg::Result(r) => {
                if r.job != self.job.id || r.epoch != self.store.epoch {
                    self.stats.stale += 1;
                    return out;
                }
                let Some(rec) = self.packs.get(&r.pack) else {
                    self.stats.refused += 1;
                    return out;
                };
                if rec.dev != dev {
                    self.stats.refused += 1;
                    return out;
                }
                self.stats.results += 1;
                let (pack_units, issued, was_open) = (rec.units.clone(), rec.issued, rec.open);
                let (mut credit, mut failed, mut seen) = (0u32, false, Vec::with_capacity(r.units.len()));
                for uo in &r.units {
                    let u = uo.unit as usize;
                    if !pack_units.contains(&uo.unit) || seen.contains(&uo.unit) || u >= self.state.len() {
                        self.stats.refused += 1;
                        continue;
                    }
                    seen.push(uo.unit);
                    let (i, j) = self.job.tile(u);
                    let (rows, cols) = self.job.tile_dims(i, j);
                    if uo.m as usize != rows || uo.n as usize != cols {
                        failed = true;
                        self.stats.units_failed += 1;
                        continue;
                    }
                    if self.state[u] == DONE {
                        self.stats.units_duplicate += 1;
                        continue;
                    }
                    let ok = self.check(u, &uo.c);
                    if ok {
                        if let Err(e) = self.store.put(u, &uo.c) {
                            panic!("checkpoint write failed: {e}");
                        }
                        self.state[u] = DONE;
                        self.waiting_remove_if_waiting(u);
                        self.pending += 1;
                        credit += 1;
                        self.stats.units_accepted += 1;
                    } else {
                        failed = true;
                        self.stats.units_failed += 1;
                    }
                }
                if was_open {
                    self.close_pack(r.pack);
                }
                let alone = self.packs.get(&r.pack).map(|x| x.alone).unwrap_or(false);
                self.landed(dev, r.pack);
                if let Some(d) = self.devs.get_mut(&dev) {
                    if credit > 0 && !failed && r.compute_ms > 0 {
                        let per = (r.compute_ms as f64 / r.units.len() as f64).max(0.01);
                        d.t_unit = if d.measured { ewma(d.t_unit, per) } else { per };
                        d.measured = true;
                        self.t_med = ewma(self.t_med, per);
                        // only a pack that waited behind no other measures the overhead (else queueing would count)
                        if alone {
                            let rtt = now.saturating_sub(issued) as f64;
                            self.t_o = ewma(self.t_o, (rtt - r.compute_ms as f64).max(1.0));
                        }
                    }
                }
                if credit > 0 {
                    self.stats.credited += credit as u64;
                    out.push(Out::Credit(dev, credit));
                }
                if failed {
                    self.stats.strikes += 1;
                    out.push(Out::Strike(dev));
                    let s = self.strikes.entry(dev).or_insert(0);
                    *s += 1;
                    if *s >= self.cfg.strikes_to_ban {
                        self.banned.insert(dev);
                        self.stats.bans += 1;
                        out.push(Out::Ban(dev));
                        self.release_device(dev);
                    }
                }
            }
            Msg::Pack(_) | Msg::Block(_) => self.stats.refused += 1,
        }
        out.extend(self.tick(now));
        out
    }

    /// A pack of this device is answered, withdrawn or expired: it no longer counts as in flight.
    fn landed(&mut self, dev: DevId, p: u64) {
        let (work, nb) = self.packs.get(&p).map(|x| (x.work_ms, x.nblocks)).unwrap_or((0.0, 0));
        if let Some(d) = self.devs.get_mut(&dev) {
            if let Some(i) = d.inflight.iter().position(|&x| x == p) {
                d.inflight.remove(i);
                d.queued_ms = (d.queued_ms - work).max(0.0);
                d.footprint = d.footprint.saturating_sub(nb);
                if d.inflight.is_empty() {
                    d.queued_ms = 0.0;
                    d.footprint = 0;
                }
            }
        }
        self.update_idle(dev);
    }

    /// How many packs this device should have in flight: enough to cover the round trip while it computes
    /// (1 + overhead / pack time, rounded), at most `max_inflight`. Where the square-root law already makes a pack
    /// long compared with the round trip this is 1, as before; it grows only where packs are short and the round
    /// trip long (the live broker: ~9 ms packs, ~0.4 s round trips).
    fn window(&self, d: &Dev) -> usize {
        let pack_ms = (self.pack_units(d) as f64 * d.t_unit).max(1.0);
        ((1.0 + (self.t_o / pack_ms + 0.5).floor()) as usize).clamp(1, self.cfg.max_inflight.max(1))
    }

    /// A device can take another pack while it has fewer than its window in flight and the blocks its packs in
    /// flight use stay within half its cache (so a later pack's blocks do not push out an earlier pack's).
    fn update_idle(&mut self, dev: DevId) {
        let room = match self.devs.get(&dev) {
            Some(d) => d.inflight.is_empty() || (d.inflight.len() < self.window(d) && d.footprint * 2 <= d.cache_blocks),
            None => false,
        };
        if room {
            self.idle.insert(dev);
        } else {
            self.idle.remove(&dev);
        }
    }

    /// A unit that a late copy finished while it was waiting again: take it off its column's waiting list.
    fn waiting_remove_if_waiting(&mut self, u: usize) {
        let col = &mut self.col_wait[u % self.job.col_blocks()];
        if let Some(p) = col.iter().rposition(|&x| x as usize == u) {
            col.swap_remove(p);
            self.waiting -= 1;
        }
    }

    /// Freivalds on one tile, with the hub's own copies of its input blocks.
    fn check(&mut self, u: usize, c: &[i32]) -> bool {
        let (i, j) = self.job.tile(u);
        let (rows, cols) = self.job.tile_dims(i, j);
        let k = self.job.k;
        let (ka, kb) = (BKey::A(i as u32), BKey::Bt(j as u32));
        // make sure both blocks are in memory (just touched, so neither is the one evicted), then borrow, no copy
        self.block(ka);
        self.block(kb);
        if !self.blocks.contains_key(&ka) {
            self.block(ka);
        }
        let (a, bt) = (&self.blocks[&ka].1, &self.blocks[&kb].1);
        freivalds(as_i8(a), as_i8(bt), rows, k, cols, c, &mut self.rng, self.cfg.rounds)
    }

    fn mark_held(&mut self, dev: DevId, id: BlockId) {
        if let Some(d) = self.devs.get_mut(&dev) {
            if let Some(p) = d.held.iter().position(|x| *x == id) {
                d.held.remove(p);
            }
            d.held.push_back(id);
            while d.held.len() > d.cache_blocks {
                d.held.pop_front();
            }
        }
    }

    /// Time passes: expire late packs, give idle devices work, make the checkpoint durable, finish.
    pub fn tick(&mut self, now: u64) -> Vec<Out> {
        let mut out = Vec::new();
        if self.finished {
            return out;
        }
        while let Some(&(deadline, p)) = self.by_deadline.iter().next() {
            if deadline > now {
                break;
            }
            let dev = self.packs[&p].dev;
            self.close_pack(p);
            self.stats.timeouts += 1;
            self.landed(dev, p);
        }
        // rounds: every device with room gets one pack per round, emptiest pipelines first, until no one has room or
        // there is no work (so the first devices to ask do not take everything)
        'give: loop {
            let mut idle: Vec<(usize, DevId)> = self.idle.iter().map(|d| (self.devs.get(d).map(|x| x.inflight.len()).unwrap_or(0), *d)).collect();
            if idle.is_empty() {
                break;
            }
            idle.sort();
            for (_, dev) in idle {
                if self.idle.contains(&dev) && !self.assign(now, dev, &mut out) {
                    break 'give; // no work for anyone right now
                }
            }
        }
        if self.pending > 0 && (self.pending >= self.cfg.flush_units || now.saturating_sub(self.last_flush) >= self.cfg.flush_ms) {
            self.flush(now);
        }
        if self.store.done == self.state.len() {
            self.flush(now);
            self.finished = true;
            out.push(if self.final_check() { Out::Done } else { Out::Corrupt });
        }
        out
    }

    fn flush(&mut self, now: u64) {
        if let Err(e) = self.store.flush() {
            panic!("checkpoint flush failed: {e}");
        }
        self.pending = 0;
        self.last_flush = now;
    }

    /// The research's square-root law (docs/SHERPAHUB.md 5.3), in units for this device.
    fn pack_units(&self, d: &Dev) -> usize {
        let p = self.devs.len().max(1) as f64;
        let remaining = (self.state.len() - self.store.done) as f64;
        let t_ideal = remaining * self.t_med / p;
        let lambda = if self.leaves >= 3.0 && self.dev_ms > 0.0 { self.leaves / self.dev_ms } else { self.cfg.leave_rate_guess };
        let hi = self.cfg.tau_max_ms.min(0.05 / lambda);
        let tau = (self.t_o * t_ideal / self.cfg.kappa).sqrt().max(9.0 * self.t_o).min(hi);
        let b = (tau / d.t_unit).round().max(1.0) as usize;
        // the tail: never hand one device more than its share of what is still waiting
        let share = self.waiting.div_ceil(self.devs.len().max(1)).max(1);
        // a RESULT must fit in one message (header 32 bytes, per unit 12 + tile)
        let fit = (self.cfg.max_message.saturating_sub(32) / (12 + self.job.tm * self.job.tn * 4)).max(1);
        b.min(share).min(fit).clamp(1, MAX_UNITS)
    }

    /// Give one idle device a pack. Returns false when there is no work to give.
    fn assign(&mut self, now: u64, dev: DevId, out: &mut Vec<Out>) -> bool {
        let Some(d) = self.devs.get(&dev) else {
            self.idle.remove(&dev);
            return true;
        };
        let want = self.pack_units(d);
        let mut units: Vec<u32> = Vec::with_capacity(want);
        let mut hedge = false;
        if self.waiting > 0 {
            // a column whose BT block the device holds, else the column with most waiting units
            // ONE column per pack: its units share the BT block, so a pack needs units + 1 blocks, which must fit
            // the device's cache (else it could never hold a whole pack)
            let want = want.min(d.cache_blocks.saturating_sub(1)).max(1);
            let held_cols: Vec<usize> = d.held.iter().rev().filter_map(|id| match self.block_keys.get(id) { Some(BKey::Bt(j)) => Some(*j as usize), _ => None }).collect();
            let col = held_cols
                .iter()
                .copied()
                .find(|&j| !self.col_wait[j].is_empty())
                .unwrap_or_else(|| (0..self.col_wait.len()).max_by_key(|&j| (self.col_wait[j].len(), std::cmp::Reverse(j))).unwrap());
            // rows whose A block the device holds first (no transfer), then the rest in order
            let held_rows: HashSet<u32> = d.held.iter().filter_map(|id| match self.block_keys.get(id) { Some(BKey::A(i)) => Some(*i), _ => None }).collect();
            if !held_rows.is_empty() {
                let cb = self.job.col_blocks();
                let mut x = self.col_wait[col].len();
                while x > 0 && units.len() < want {
                    x -= 1;
                    let u = self.col_wait[col][x];
                    if held_rows.contains(&((u as usize / cb) as u32)) {
                        self.col_wait[col].remove(x);
                        self.waiting -= 1;
                        if self.state[u as usize] == WAITING {
                            units.push(u);
                        }
                    }
                }
            }
            while units.len() < want {
                let Some(u) = self.col_wait[col].pop() else { break };
                self.waiting -= 1;
                if self.state[u as usize] == WAITING {
                    units.push(u);
                }
            }
        } else if self.cfg.max_copies > 1 {
            let want = want.min(d.cache_blocks / 2).max(1);
            // end game: a copy of the oldest unit still out with one copy, not already on this device
            while let Some(&p) = self.order.front() {
                if self.packs.get(&p).map(|r| r.open).unwrap_or(false) {
                    break;
                }
                self.order.pop_front();
            }
            'outer: for &p in self.order.iter() {
                let rec = &self.packs[&p];
                if !rec.open || rec.dev == dev {
                    continue;
                }
                // only LATE packs are worth a copy (the research: hedge the slowest packs at the end, not all);
                // late = twice its expected time (about half of all packs pass their mean time by nature)
                if now < rec.issued + 2 * rec.expected {
                    continue;
                }
                for &u in &rec.units {
                    if self.state[u as usize] == OUT && self.copies[u as usize] == 1 && !units.contains(&u) {
                        units.push(u);
                        if units.len() >= want {
                            break 'outer;
                        }
                    }
                }
            }
            hedge = true;
        }
        if units.is_empty() {
            return false;
        }
        // blocks first (the ones the device does not hold), then the pack
        let mut specs = Vec::with_capacity(units.len());
        let mut used: Vec<BlockId> = Vec::new();
        for &u in &units {
            let ui = u as usize;
            self.state[ui] = OUT;
            self.copies[ui] += 1;
            let (i, j) = self.job.tile(ui);
            let (rows, cols) = self.job.tile_dims(i, j);
            let (aid, btid) = (self.block_id_of(BKey::A(i as u32)), self.block_id_of(BKey::Bt(j as u32)));
            for (key, id) in [(BKey::A(i as u32), aid), (BKey::Bt(j as u32), btid)] {
                let held = self.devs[&dev].held.contains(&id);
                if !held {
                    let (bid, b) = self.block(key);
                    let msg = encode(&Msg::Block(Block { id: bid, bytes: b.to_vec() }));
                    self.stats.blocks_sent += 1;
                    self.stats.bytes_out += msg.len() as u64;
                    out.push(Out::Send(dev, msg));
                }
                self.mark_held(dev, id);
                if !used.contains(&id) {
                    used.push(id);
                }
            }
            specs.push(UnitSpec { unit: u, m: rows as u32, k: self.job.k as u32, n: cols as u32, a: aid, bt: btid });
        }
        let pack = self.next_pack;
        self.next_pack += 1;
        let bytes = encode(&Msg::Pack(Pack { job: self.job.id, pack, epoch: self.store.epoch, kernel: KERNEL_MATMUL_I8, units: specs }));
        let d = &self.devs[&dev];
        let work = units.len() as f64 * d.t_unit;
        let (alone, ahead) = (d.inflight.is_empty(), d.queued_ms);
        let expected = (ahead + work + self.t_o) as u64;
        let deadline = now + (3.0 * (ahead + work) + 2.0 * self.t_o).max(1_000.0) as u64;
        self.stats.packs_sent += 1;
        self.stats.units_sent += units.len() as u64;
        if hedge {
            self.stats.hedges += 1;
        }
        self.stats.bytes_out += bytes.len() as u64;
        out.push(Out::Send(dev, bytes.clone()));
        let nblocks = used.len();
        self.packs.insert(pack, PackRec { dev, units, issued: now, deadline, open: true, expected, work_ms: work, nblocks, alone, needs: 0, bytes });
        self.by_deadline.insert((deadline, pack));
        self.order.push_back(pack);
        let d = self.devs.get_mut(&dev).unwrap();
        d.inflight.push(pack);
        d.queued_ms += work;
        d.footprint += nblocks;
        self.update_idle(dev);
        true
    }

    /// Freivalds over the WHOLE product, tile by tile, before the job is reported done.
    fn final_check(&mut self) -> bool {
        let job = self.job.clone();
        let (k, cb, rb) = (job.k, job.col_blocks(), job.row_blocks());
        for _ in 0..self.cfg.rounds {
            let r: Vec<i64> = (0..job.n).map(|_| (self.rng.next_u64() & 0xffff) as i64 - 32768).collect();
            let mut y = vec![0i64; k];
            for j in 0..cb {
                let bt = self.block(BKey::Bt(j as u32)).1.to_vec();
                let cols = job.tile_dims(0, j).1;
                for c in 0..cols {
                    let rj = r[j * job.tn + c];
                    for t in 0..k {
                        y[t] += bt[c * k + t] as i8 as i64 * rj;
                    }
                }
            }
            for i in 0..rb {
                let a = self.block(BKey::A(i as u32)).1.to_vec();
                let rows = job.tile_dims(i, 0).0;
                let mut rhs = vec![0i64; rows];
                for j in 0..cb {
                    let cols = job.tile_dims(i, j).1;
                    let tile = match self.store.get(i * cb + j) {
                        Ok(t) => t,
                        Err(_) => return false,
                    };
                    for row in 0..rows {
                        for c in 0..cols {
                            rhs[row] += tile[row * cols + c] as i64 * r[j * job.tn + c];
                        }
                    }
                }
                for row in 0..rows {
                    let lhs: i64 = (0..k).map(|t| a[row * k + t] as i8 as i64 * y[t]).sum();
                    if lhs != rhs[row] {
                        return false;
                    }
                }
            }
        }
        true
    }
}
