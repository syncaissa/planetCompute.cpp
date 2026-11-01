// docs/TESTING.md test 64: the SherpaHub fault simulator. A real Hub and real Devices (the real kernel computes
// every tile) on a virtual clock, with scripted trouble. Every scenario must end with: Done; the product equal to
// the reference byte for byte; no honest device ever struck; every unit credited exactly once; the same seed giving
// the same run.
use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap};
use std::path::PathBuf;
use workpack::device::{Device, Reply};
use workpack::hub::{Config, DevId, Hub, Out, Stats};
use workpack::kernels::{matmul_i8, Rng64};
use workpack::store::JobSpec;
use workpack::wire::{decode, encode, Msg};

#[derive(Clone)]
struct Scenario {
    name: &'static str,
    devices: u32,
    job: JobSpec,
    /// log-normal speed spread (sigma) around 50 ms per unit
    sigma: f64,
    /// share of devices 20x slower
    stragglers: f64,
    /// share of devices that lie on every pack
    liars: f64,
    /// departures per device per hour (each comes back after ~10 virtual minutes)
    leave_per_hour: f64,
    /// share of RESULT messages delivered twice, the copy 0-30 s late
    duplicates: f64,
    /// share of messages to the hub damaged (cut, junk, foreign job, wrong epoch)
    damaged: f64,
    /// hub crashes (state rebuilt from the checkpoint directory only)
    crashes: u32,
    cache_bytes: usize,
    max_copies: u8,
    /// packs in flight per device (Config::max_inflight)
    inflight: usize,
    /// median compute per unit, ms
    ms_unit: f64,
    /// one-way message delay: base + up to `lat_jitter` ms
    lat_base: u64,
    lat_jitter: u64,
    /// largest message (a RESULT must fit)
    max_message: usize,
    seed: u64,
}

impl Scenario {
    fn new(name: &'static str, devices: u32, job: JobSpec) -> Self {
        Scenario { name, devices, job, sigma: 0.8, stragglers: 0.0, liars: 0.0, leave_per_hour: 0.0, duplicates: 0.0, damaged: 0.0, crashes: 0, cache_bytes: 64 << 20, max_copies: 2, inflight: 1, ms_unit: 50.0, lat_base: 20, lat_jitter: 80, max_message: workpack::wire::MAX_MESSAGE, seed: 1 }
    }
}

fn job(id: u64, m: usize, k: usize, n: usize, t: usize) -> JobSpec {
    JobSpec { id, m, k, n, tm: t, tn: t, seed_a: 11 + id as u32, seed_b: 77 + id as u32 }
}

/// The exact product, made from the same blocks the hub serves.
fn reference(j: &JobSpec) -> Vec<i32> {
    let mut a = Vec::with_capacity(j.m * j.k);
    for i in 0..j.row_blocks() {
        a.extend(Hub::block_bytes_for(j, true, i).into_iter().map(|x| x as i8));
    }
    let mut bt = Vec::with_capacity(j.n * j.k);
    for c in 0..j.col_blocks() {
        bt.extend(Hub::block_bytes_for(j, false, c).into_iter().map(|x| x as i8));
    }
    let mut c = vec![0i32; j.m * j.n];
    matmul_i8(&a, &bt, j.m, j.k, j.n, &mut c);
    c
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum Ev {
    ToDev(DevId, u64, Vec<u8>), // device, its connection number, bytes
    ToHub(DevId, Vec<u8>),
    Join(DevId),
    Leave(DevId),
    Tick,
    Crash,
}

struct SimDev {
    dev: Device,
    to_dev_at: u64, // the last delivery time to the device (messages arrive in order)
    to_hub_at: u64,
    ms_per_unit: f64,
    liar: bool,
    present: bool,
    conn: u64,
    free_at: u64,
}

struct Report {
    stats: Stats,
    makespan_ms: u64,
    ideal_ms: u64,
    credited: u64,
    struck: BTreeSet<DevId>,
    banned: BTreeSet<DevId>,
    liars: BTreeSet<DevId>,
    trace: u64,
    real_ms: u128,
}

fn lognormal(g: &mut Rng64, sigma: f64) -> f64 {
    let (u1, u2) = (g.unit().max(1e-12), g.unit());
    ((-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos() * sigma).exp()
}

fn tmpdir(name: &str, seed: u64) -> PathBuf {
    let d = std::env::temp_dir().join(format!("workpack-sim-{}-{}-{}", name, seed, std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn run(s: &Scenario) -> Report {
    let started = std::time::Instant::now();
    let dir = tmpdir(s.name, s.seed);
    let cfg = Config { max_copies: s.max_copies, max_inflight: s.inflight, max_message: s.max_message, t_unit_guess_ms: 200.0, t_o_guess_ms: 100.0, seed: s.seed ^ 0xABCDEF, ..Config::default() };
    let mut hub = Hub::create(&dir, s.job.clone(), cfg.clone()).unwrap();
    let mut g = Rng64::new(s.seed);
    let mut devs: BTreeMap<DevId, SimDev> = BTreeMap::new();
    let mut liars = BTreeSet::new();
    let mut total_speed = 0.0;
    for d in 0..s.devices {
        let mut ms = s.ms_unit * lognormal(&mut g, s.sigma);
        if g.unit() < s.stragglers {
            ms *= 20.0;
        }
        let liar = g.unit() < s.liars;
        if liar {
            liars.insert(d);
        }
        total_speed += 1.0 / ms;
        devs.insert(d, SimDev { dev: Device::new(s.cache_bytes), to_dev_at: 0, to_hub_at: 0, ms_per_unit: ms, liar, present: false, conn: 0, free_at: 0 });
    }
    let ideal_ms = 2_000 + (s.job.units() as f64 / total_speed) as u64; // joins take up to 2 s
    let mut q: BinaryHeap<Reverse<(u64, u64, Ev)>> = BinaryHeap::new();
    let mut seq = 0u64;
    let mut push = |q: &mut BinaryHeap<Reverse<(u64, u64, Ev)>>, t: u64, e: Ev| {
        seq += 1;
        q.push(Reverse((t, seq, e)));
    };
    for d in 0..s.devices {
        push(&mut q, g.below(2_000), Ev::Join(d));
    }
    push(&mut q, 100, Ev::Tick);
    let crash_every = if s.crashes > 0 { (ideal_ms * 2).max(4_000) / (s.crashes as u64 + 1) } else { 0 };
    for c in 1..=s.crashes as u64 {
        push(&mut q, crash_every * c + g.below(500), Ev::Crash);
    }
    let (mut credited, mut struck, mut banned) = (0u64, BTreeSet::new(), BTreeSet::new());
    let mut trace: u64 = 0xcbf29ce484222325;
    let mut makespan = 0u64;
    let mut done = false;
    let mut carry = Stats::default();
    let (lb, lj) = (s.lat_base, s.lat_jitter.max(1));
    let lat = move |g: &mut Rng64| lb + g.below(lj);
    let limit = 50_000_000u64; // 50,000 virtual seconds: a run that has not finished by then has failed
    while let Some(Reverse((now, _, ev))) = q.pop() {
        assert!(now < limit, "{}: did not finish ({} of {} units)", s.name, hub.done_units(), s.job.units());
        let outs = match ev {
            Ev::Tick => {
                if !done {
                    push(&mut q, now + 100, Ev::Tick);
                }
                hub.tick(now)
            }
            Ev::Join(d) => {
                let sd = devs.get_mut(&d).unwrap();
                sd.present = true;
                sd.conn += 1;
                sd.dev = Device::new(s.cache_bytes); // a new tab / restarted program: empty cache
                sd.free_at = now;
                if s.leave_per_hour > 0.0 {
                    let stay = (-g.unit().max(1e-12).ln() * 3_600_000.0 / s.leave_per_hour) as u64;
                    push(&mut q, now + stay.max(1), Ev::Leave(d));
                }
                hub.on_hello(now, d, s.cache_bytes)
            }
            Ev::Leave(d) => {
                let sd = devs.get_mut(&d).unwrap();
                sd.present = false;
                push(&mut q, now + 300_000 + g.below(600_000), Ev::Join(d));
                hub.on_gone(now, d)
            }
            Ev::Crash => {
                carry = add(&carry, &hub.stats);
                drop(hub);
                hub = Hub::resume(&dir, cfg.clone()).unwrap();
                // devices reconnect to the restarted hub
                let present: Vec<DevId> = devs.iter().filter(|(_, v)| v.present).map(|(k, _)| *k).collect();
                let mut outs = Vec::new();
                for d in present {
                    outs.extend(hub.on_hello(now, d, s.cache_bytes));
                }
                outs
            }
            Ev::ToDev(d, conn, bytes) => {
                let sd = devs.get_mut(&d).unwrap();
                if !sd.present || sd.conn != conn {
                    continue; // the device left; what was sent to it is lost
                }
                let units = match decode(&bytes) {
                    Ok(Msg::Pack(p)) => p.units.len(),
                    _ => 0,
                };
                let reply = sd.dev.handle(&bytes);
                let start = sd.free_at.max(now);
                match reply {
                    Reply::None => {}
                    Reply::Need(n) => {
                        let t = (start + lat(&mut g)).max(sd.to_hub_at);
                        sd.to_hub_at = t;
                        push(&mut q, t, Ev::ToHub(d, encode(&Msg::Need(n))));
                    }
                    Reply::Result(mut r) => {
                        let ms = (units as f64 * sd.ms_per_unit).max(1.0) as u64;
                        sd.free_at = start + ms;
                        r.compute_ms = ms as u32;
                        if sd.liar {
                            let u = g.below(r.units.len() as u64) as usize;
                            let cells = r.units[u].c.len();
                            if g.unit() < 0.5 {
                                let p = g.below(cells as u64) as usize;
                                r.units[u].c[p] = r.units[u].c[p].wrapping_add(1);
                            } else {
                                for x in r.units[u].c.iter_mut() {
                                    *x = g.next_u64() as i32;
                                }
                            }
                        }
                        let bytes = encode(&Msg::Result(r));
                        let t = (sd.free_at + lat(&mut g)).max(sd.to_hub_at);
                        sd.to_hub_at = t;
                        if g.unit() < s.duplicates {
                            push(&mut q, t + g.below(30_000), Ev::ToHub(d, bytes.clone()));
                        }
                        push(&mut q, t, Ev::ToHub(d, bytes));
                    }
                }
                continue;
            }
            Ev::ToHub(d, mut bytes) => {
                if !devs[&d].present {
                    continue;
                }
                if g.unit() < s.damaged {
                    match g.below(4) {
                        0 => bytes.truncate(g.below(bytes.len() as u64) as usize),
                        1 => bytes = (0..g.below(64)).map(|_| g.next_u64() as u8).collect(),
                        2 => bytes[8] ^= 0x5a,  // foreign job id
                        _ => bytes[24] ^= 0x01, // wrong epoch
                    }
                }
                hub.on_message(now, d, &bytes)
            }
        };
        for o in outs {
            trace = (trace ^ fnv(&o)).wrapping_mul(0x100000001b3);
            match o {
                Out::Send(d, b) => {
                    let sd = devs.get_mut(&d).unwrap();
                    let t = (now + lat(&mut g)).max(sd.to_dev_at);
                    sd.to_dev_at = t;
                    push(&mut q, t, Ev::ToDev(d, sd.conn, b));
                }
                Out::Credit(_, n) => credited += n as u64,
                Out::Strike(d) => {
                    struck.insert(d);
                }
                Out::Ban(d) => {
                    banned.insert(d);
                }
                Out::Done => {
                    done = true;
                    makespan = now;
                }
                Out::Corrupt => panic!("{}: the final whole-product check failed", s.name),
            }
        }
        if done {
            break;
        }
    }
    assert!(done, "{}: the event queue ran dry before the job finished", s.name);
    let stats = add(&carry, &hub.stats);
    let got = hub.result().unwrap();
    assert!(got == reference(&s.job), "{}: the assembled product differs from the reference", s.name);
    let _ = std::fs::remove_dir_all(&dir);
    Report { stats, makespan_ms: makespan, ideal_ms, credited, struck, banned, liars, trace, real_ms: started.elapsed().as_millis() }
}

fn fnv(o: &Out) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    let mut eat = |b: &[u8]| {
        for x in b {
            h = (h ^ *x as u64).wrapping_mul(0x100000001b3);
        }
    };
    match o {
        Out::Send(d, b) => {
            eat(&d.to_le_bytes());
            eat(b);
        }
        Out::Credit(d, n) => {
            eat(&d.to_le_bytes());
            eat(&n.to_le_bytes());
        }
        Out::Strike(d) | Out::Ban(d) => eat(&d.to_le_bytes()),
        Out::Done => eat(b"done"),
        Out::Corrupt => eat(b"corrupt"),
    }
    h
}

fn add(a: &Stats, b: &Stats) -> Stats {
    Stats {
        packs_sent: a.packs_sent + b.packs_sent,
        units_sent: a.units_sent + b.units_sent,
        hedges: a.hedges + b.hedges,
        timeouts: a.timeouts + b.timeouts,
        results: a.results + b.results,
        units_accepted: a.units_accepted + b.units_accepted,
        units_duplicate: a.units_duplicate + b.units_duplicate,
        units_failed: a.units_failed + b.units_failed,
        credited: a.credited + b.credited,
        refused: a.refused + b.refused,
        stale: a.stale + b.stale,
        needs: a.needs + b.needs,
        blocks_sent: a.blocks_sent + b.blocks_sent,
        bytes_out: a.bytes_out + b.bytes_out,
        bytes_in: a.bytes_in + b.bytes_in,
        strikes: a.strikes + b.strikes,
        bans: a.bans + b.bans,
    }
}

/// The checks every scenario must pass (beyond "Done and exact", checked in run).
fn common(s: &Scenario, r: &Report) {
    let units = s.job.units() as u64;
    // every unit credited exactly once in total; after a crash a unit done but not yet durable is redone, and that
    // second completion is credited again (honest work), so with crashes credit may exceed units by what was lost
    if s.crashes == 0 {
        assert_eq!(r.credited, units, "{}: credit {} for {} units", s.name, r.credited, units);
        assert_eq!(r.stats.units_accepted, units, "{}", s.name);
    } else {
        assert!(r.credited >= units, "{}", s.name);
    }
    assert_eq!(r.credited, r.stats.credited, "{}", s.name);
    for d in &r.struck {
        assert!(r.liars.contains(d), "{}: honest device {} was struck", s.name, d);
    }
    println!(
        "SIM {:<12} units {:>6} devices {:>5} makespan {:>9.1} s ideal {:>8.1} s ratio {:>5.2} | packs {} hedges {} timeouts {} dup {} refused {} stale {} needs {} blocks {} out {:.1} MB in {:.1} MB | struck {} banned {} liars {} | {} ms real",
        s.name, units, s.devices, r.makespan_ms as f64 / 1e3, r.ideal_ms as f64 / 1e3, r.makespan_ms as f64 / r.ideal_ms.max(1) as f64,
        r.stats.packs_sent, r.stats.hedges, r.stats.timeouts, r.stats.units_duplicate, r.stats.refused, r.stats.stale, r.stats.needs, r.stats.blocks_sent,
        r.stats.bytes_out as f64 / 1e6, r.stats.bytes_in as f64 / 1e6, r.struck.len(), r.banned.len(), r.liars.len(), r.real_ms
    );
}

#[test]
fn a_baseline_one_device_and_500() {
    let mut s = Scenario::new("a-one", 1, job(1, 96, 64, 80, 16));
    s.sigma = 0.0;
    let r = run(&s);
    common(&s, &r);
    let s = Scenario::new("a-500", 500, job(2, 2048, 64, 2048, 16));
    let r = run(&s);
    common(&s, &r);
}

#[test]
fn b_devices_vanish_mid_pack() {
    let mut s = Scenario::new("b-leave", 300, job(3, 2048, 64, 2048, 16));
    s.leave_per_hour = 30.0;
    let r = run(&s);
    common(&s, &r);
    assert!(r.stats.timeouts + r.stats.packs_sent > 0);
}

#[test]
fn c_stragglers_hedging_bounds_the_tail() {
    let mut s = Scenario::new("c-hedge", 200, job(4, 512, 64, 512, 16));
    s.stragglers = 0.05;
    let hedged = run(&s);
    common(&s, &hedged);
    let mut s1 = s.clone();
    s1.name = "c-nohedge";
    s1.max_copies = 1;
    let plain = run(&s1);
    common(&s1, &plain);
    assert!(hedged.stats.hedges > 0, "the end game must hedge");
    assert!(hedged.makespan_ms <= plain.makespan_ms, "hedging made it slower: {} vs {}", hedged.makespan_ms, plain.makespan_ms);
}

#[test]
fn d_liars_are_caught_banned_and_the_job_stays_exact() {
    let mut s = Scenario::new("d-liars", 200, job(5, 512, 64, 512, 16));
    s.liars = 0.05;
    let r = run(&s);
    common(&s, &r);
    assert!(!r.liars.is_empty());
    for d in &r.banned {
        assert!(r.liars.contains(d));
    }
    assert!(r.stats.units_failed > 0 && r.stats.bans > 0, "liars were never caught");
}

#[test]
fn e_late_duplicates_are_credited_once() {
    let mut s = Scenario::new("e-dups", 150, job(6, 512, 64, 512, 16));
    s.duplicates = 0.3;
    s.leave_per_hour = 10.0;
    let r = run(&s);
    common(&s, &r);
    assert!(r.stats.units_duplicate > 0);
}

#[test]
fn f_hub_crashes_five_times() {
    let mut s = Scenario::new("f-crash", 200, job(7, 1024, 64, 768, 16));
    s.crashes = 5;
    s.leave_per_hour = 5.0;
    let r = run(&s);
    common(&s, &r);
    assert!(r.stats.stale > 0, "results from before a restart must arrive and be dropped");
}

#[test]
fn g_damaged_messages_are_refused() {
    let mut s = Scenario::new("g-damage", 150, job(8, 512, 64, 512, 16));
    s.damaged = 0.05;
    let r = run(&s);
    common(&s, &r);
    assert!(r.stats.refused + r.stats.stale > 0);
}

#[test]
fn h_tiny_device_caches() {
    let mut s = Scenario::new("h-cache", 100, job(9, 512, 256, 512, 32));
    s.cache_bytes = 2 * 32 * 256; // room for two blocks
    let r = run(&s);
    common(&s, &r);
}

#[test]
fn i_scale_65536_units_2000_devices() {
    let mut s = Scenario::new("i-scale", 2000, job(10, 4096, 32, 4096, 16));
    s.leave_per_hour = 5.0;
    let r = run(&s);
    common(&s, &r);
    assert!(r.real_ms < 60_000, "took {} ms of real time", r.real_ms);
}

#[test]
fn deterministic_replay() {
    let mut s = Scenario::new("replay", 120, job(11, 384, 64, 384, 16));
    s.leave_per_hour = 20.0;
    s.liars = 0.05;
    s.duplicates = 0.1;
    let (a, b) = (run(&s), run(&s));
    assert_eq!(a.trace, b.trace, "same seed, different run");
    assert_eq!(a.stats, b.stats);
}

#[test]
fn j_efficiency_with_real_work_per_device() {
    // 100 devices with ~160 units each (~8 s of work each): the square-root sizing must keep the job near the ideal
    let s = Scenario::new("j-effic", 100, job(12, 2048, 64, 2048, 16));
    let r = run(&s);
    common(&s, &r);
    let ratio = r.makespan_ms as f64 / r.ideal_ms as f64;
    assert!(ratio < 1.35, "makespan {} ms vs ideal {} ms (ratio {ratio:.2})", r.makespan_ms, r.ideal_ms);
    assert!((r.stats.units_duplicate as f64) < 0.05 * s.job.units() as f64, "too much duplicate work: {}", r.stats.units_duplicate);
}

#[test]
fn k_pipelining_on_the_live_shape() {
    // The live job's shape, scaled down: 4 devices, 128 x 128 tiles, a RESULT capped at 1 MiB (15 tiles a pack),
    // ~0.6 ms of work per tile, ~0.2 s each way through the broker, and a device cache that holds about one column of
    // A blocks. One pack in flight per device left each device idle ~98% of the time; the new hub keeps several in
    // flight and reuses the A blocks a device already holds.
    let mut s = Scenario::new("k-inflight1", 4, job(13, 128 * 128, 256, 32 * 128, 128));
    s.sigma = 0.1;
    s.ms_unit = 0.6;
    s.lat_base = 150;
    s.lat_jitter = 100;
    s.max_message = 1 << 20;
    s.cache_bytes = 128 * 128 * 256; // 128 blocks = the 128 A row blocks, so one column's rows plus its BT do not fit (as live)
    s.max_copies = 2;
    let one = run(&s);
    common(&s, &one);
    let mut p = s.clone();
    p.name = "k-inflight16";
    p.inflight = 16;
    let many = run(&p);
    common(&p, &many);
    let units = s.job.units() as f64;
    let (b1, b16) = (one.stats.blocks_sent as f64 / units, many.stats.blocks_sent as f64 / units);
    println!("SIM k: makespan {} -> {} ms ({:.1}x); blocks per unit {:.3} -> {:.3}", one.makespan_ms, many.makespan_ms, one.makespan_ms as f64 / many.makespan_ms as f64, b1, b16);
    assert!(many.makespan_ms * 4 <= one.makespan_ms, "16 packs in flight should be at least 4x faster: {} vs {} ms", many.makespan_ms, one.makespan_ms);
    // at least 4 x 128 A blocks + 32 BT blocks must travel for 4,096 units (0.13 a unit)
    // (the old hub, which took a column's rows from the top every time, sent about one block per unit on this shape)
    assert!(b1 < 0.4 && b16 < 0.4, "block reuse: {b1:.3} and {b16:.3} blocks sent per unit");
}

#[test]
fn l_pipelining_keeps_every_guarantee() {
    // the trouble scenarios again with 8 packs in flight: liars, departures, duplicates, damage, crashes, tiny caches
    let mut s = Scenario::new("l-liars8", 200, job(14, 512, 64, 512, 16));
    s.liars = 0.05;
    s.inflight = 8;
    let r = run(&s);
    common(&s, &r);
    assert!(r.stats.bans > 0, "liars were never caught");
    let mut s = Scenario::new("l-leave8", 300, job(15, 2048, 64, 2048, 16));
    s.leave_per_hour = 30.0;
    s.duplicates = 0.1;
    s.damaged = 0.02;
    s.inflight = 8;
    let r = run(&s);
    common(&s, &r);
    let mut s = Scenario::new("l-crash8", 200, job(16, 1024, 64, 768, 16));
    s.crashes = 5;
    s.leave_per_hour = 5.0;
    s.inflight = 8;
    let r = run(&s);
    common(&s, &r);
    let mut s = Scenario::new("l-cache8", 100, job(17, 512, 256, 512, 32));
    s.cache_bytes = 2 * 32 * 256;
    s.inflight = 8;
    let r = run(&s);
    common(&s, &r);
    let mut s = Scenario::new("l-stragg8", 200, job(18, 512, 64, 512, 16));
    s.stragglers = 0.05;
    s.inflight = 8;
    let r = run(&s);
    common(&s, &r);
}
