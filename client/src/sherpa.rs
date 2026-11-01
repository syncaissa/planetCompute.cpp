// SherpaHub over planetcompute.ai (docs/SHERPAHUB.md section 10, stage 3). Two roles of this program:
//
// * SherpaHub (--sherpahub): ORGANISES a BatchMode job. Runs workpack::hub (cut, size, send, check every unit,
//   checkpoint, hedge, strike, assemble) and keeps ONE outbound WebSocket to the site's broker (/api/sherpa/hub,
//   worker.js SherpaBroker). Frames are [device id u32 LE][PCWP message] both ways; the broker introduces devices
//   ({"t":"hello"}) and says when they leave ({"t":"gone"}). The job lives in a checkpoint directory, so a restart
//   continues where it stopped (a new epoch; packs from before are refused).
// * Device (--headless with contributing on): DOES the work. While a SherpaHub runs, connects to /api/sherpa/device,
//   keeps the hub's blocks (workpack::device), computes packs on the chosen cores under the cap, answers.
//
// The hub's state machine is pure and synchronous (Freivalds checks, checkpoint fsync): it runs on its own thread
// with its own small runtime, so it never holds up the local web server.

use crate::contribute::Engine;
use crate::server::Local;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use crate::sherpa_prompts::{self as prompts, Act, PromptRun};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
use workpack::hub::{Config, DevId, Hub, Out};
use workpack::store::JobSpec;
use workpack::wire::{encode, Msg};

/// What the SherpaHub prints also goes to its room on the site (the admin tab shows the last 300 lines live).
static HUBLOG: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
macro_rules! hsay {
    ($($t:tt)*) => {{
        let line = format!($($t)*);
        println!("{line}");
        let mut g = HUBLOG.lock().unwrap();
        if g.len() < 300 {
            g.push(line);
        }
    }};
}

/// Largest message the site's broker carries (worker.js SHERPA_MAX_MSG).
pub const MAX_MESSAGE: usize = 1 << 20;
/// Whole prompts outlive a connection (a site deploy drops every WebSocket): each runs in a task of its own, its
/// answer waits in the outbox until a connection sends it, and a new connection's hello lists the prompts still being
/// made (the hub keeps them for this device instead of giving them away).
#[derive(Default)]
struct PromptWork {
    /// "job:n:copy" -> the TASK's JSON header (its task_id is updated when a new connection gives it again)
    running: HashMap<String, Value>,
    /// whole answers (all their parts): one that was half sent when a connection dropped is sent again from part 0
    outbox: VecDeque<Vec<Vec<u8>>>,
}
static PROMPTS: std::sync::LazyLock<std::sync::Mutex<PromptWork>> = std::sync::LazyLock::new(Default::default);
static OUTBOX: std::sync::LazyLock<tokio::sync::Notify> = std::sync::LazyLock::new(tokio::sync::Notify::new);

/// Blocks a device keeps (weight-stationary cache).
const DEVICE_CACHE: usize = 256 << 20;

/// planetcompute.ai, or PLANETCOMPUTE_SITE for tests (docs/TESTING.md test 66: the broker in `wrangler dev`).
fn site() -> String {
    std::env::var("PLANETCOMPUTE_SITE").ok().filter(|s| s.starts_with("http://") || s.starts_with("https://")).unwrap_or_else(|| crate::api::SITE.into())
}
fn real_site() -> bool {
    site() == crate::api::SITE
}

/// The WebSocket request for a broker path: the session and this installation's key go to planetcompute.ai only.
fn ws_request(st: &Local, path: &str, query: &str) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, String> {
    let s = site();
    let ws = match s.strip_prefix("https://") {
        Some(h) => format!("wss://{h}"),
        None => format!("ws://{}", s.trim_start_matches("http://")),
    };
    let mut req = format!("{ws}{path}?device={}{query}", st.device).into_client_request().map_err(|e| e.to_string())?;
    let h = req.headers_mut();
    h.insert("user-agent", crate::UA.parse().unwrap());
    if real_site() {
        let token = st.session.lock().unwrap().clone().ok_or("not signed in")?;
        h.insert("cookie", format!("{}={token}", crate::api::COOKIE).parse().map_err(|_| "bad session".to_string())?);
        h.insert("x-pc-device-key", crate::server::tunnel_key().parse().map_err(|_| "bad device key".to_string())?);
    }
    Ok(req)
}

/// Signed in (or testing against another site), so the broker will let us in.
fn may_connect(st: &Local) -> bool {
    !real_site() || st.session.lock().unwrap().is_some()
}

fn http_err(e: tokio_tungstenite::tungstenite::Error) -> String {
    match e {
        tokio_tungstenite::tungstenite::Error::Http(r) => {
            let body = r.body().as_ref().map(|b| String::from_utf8_lossy(b).to_string()).unwrap_or_default();
            format!("HTTP {} {}", r.status().as_u16(), body.chars().take(200).collect::<String>())
        }
        e => e.to_string(),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// SherpaHub role

/// --sherpahub [--sherpa-job MxKxN [--sherpa-tile T] [--sherpa-repeat]]. Without --sherpa-job the SherpaHub waits for
/// the jobs given on the admin tab SherpaHubs (its room on the site sends them); with it, it also runs that matrix
/// job of its own (tests, docs/TESTING.md test 68).
#[derive(Clone, Debug)]
pub struct HubOpts {
    pub job: Option<(usize, usize, usize, usize)>,
    /// When the job of the command line is done, start another one.
    pub repeat: bool,
}

fn matmul_ok(m: usize, k: usize, n: usize, tile: usize) -> Result<(), String> {
    let units = m.div_ceil(tile.max(1)) * n.div_ceil(tile.max(1));
    if tile == 0 || tile > 1024 || k == 0 || k > workpack::kernels::FREIVALDS_MAX || m == 0 || n == 0 || m > 1 << 20 || n > 1 << 20 || units > 1 << 26 {
        return Err("SherpaHub job out of limits: K 1-4096, M and N 1-1048576, tile 1-1024, at most 2^26 units (docs/SHERPAHUB.md section 7)".into());
    }
    // a block (tile x K bytes) and a one-unit RESULT must each fit in one broker message
    if tile * k + 64 > MAX_MESSAGE || tile * tile * 4 + 64 > MAX_MESSAGE {
        return Err(format!("tile {tile} x K {k} does not fit the site's 1 MiB messages: use a smaller tile"));
    }
    Ok(())
}

pub fn hub_opts(args: &[String]) -> Result<Option<HubOpts>, String> {
    if !args.iter().any(|a| a == "--sherpahub") {
        return Ok(None);
    }
    let val = |f: &str| args.iter().position(|a| a == f).and_then(|i| args.get(i + 1)).cloned();
    let mut o = HubOpts { job: None, repeat: args.iter().any(|a| a == "--sherpa-repeat") };
    if let Some(j) = val("--sherpa-job") {
        let v: Vec<usize> = j.split('x').filter_map(|x| x.parse().ok()).collect();
        if v.len() != 3 {
            return Err(format!("--sherpa-job {j}: expected MxKxN, e.g. 2048x4096x2048"));
        }
        let tile = match val("--sherpa-tile") {
            Some(t) => t.parse().map_err(|_| format!("--sherpa-tile {t}: not a number"))?,
            None => 64,
        };
        matmul_ok(v[0], v[1], v[2], tile)?;
        o.job = Some((v[0], v[1], v[2], tile));
    }
    Ok(Some(o))
}

fn hub_dir() -> PathBuf {
    dirs::data_dir().unwrap_or_else(std::env::temp_dir).join("planetCompute").join("sherpahub")
}

fn hub_config() -> Config {
    let mut seed = [0u8; 8];
    seed.copy_from_slice(&uuid::Uuid::new_v4().as_bytes()[..8]);
    // several packs in flight per device (the live 65536 x 4096 x 65536 job ran at 1.5% of the kernel's speed with one:
    // each pack is ~9 ms of work and a round trip through the broker); PC_SHERPA_INFLIGHT overrides (1 = the old way)
    let inflight = std::env::var("PC_SHERPA_INFLIGHT").ok().and_then(|v| v.trim().parse::<usize>().ok()).unwrap_or(16).clamp(1, 64);
    Config { max_message: MAX_MESSAGE, seed: u64::from_le_bytes(seed), max_inflight: inflight, hub_block_bytes: 1 << 30, ..Config::default() }
}

/// A matrix job: the one of the command line ("local", folder sherpahub/current) or one of the tab (folder jobs/<id>).
fn open_matmul(id: &str, m: usize, k: usize, n: usize, tile: usize) -> Result<Hub, String> {
    let local = id == "local";
    let dir = if local { hub_dir().join("current") } else { hub_dir().join("jobs").join(id) };
    if dir.join("job.hdr").exists() {
        match Hub::resume(&dir, hub_config()) {
            // every unit done = the job ended (its final check ran before the stop): a local job starts again
            Ok(h) if !h.is_finished() && h.done_units() < h.job().units() => {
                hsay!("SherpaHub: continuing job {:016x} ({} of {} units already done, epoch {})", h.job().id, h.done_units(), h.job().units(), h.epoch());
                return Ok(h);
            }
            Ok(h) if !local => return Ok(h), // a job of the tab whose units are all done: its final check runs again
            Ok(_) => {}
            Err(e) => hsay!("SherpaHub: the job in {} cannot be continued ({e}); starting it again", dir.display()),
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
    let r = uuid::Uuid::new_v4();
    let b = r.as_bytes();
    let jid = if local { u64::from_le_bytes(b[..8].try_into().unwrap()) } else { u64::from_str_radix(id, 16).map_err(|_| "bad job id".to_string())? };
    let job = JobSpec {
        id: jid,
        m,
        k,
        n,
        tm: tile,
        tn: tile,
        seed_a: u32::from_le_bytes(b[8..12].try_into().unwrap()) | 1,
        seed_b: u32::from_le_bytes(b[12..16].try_into().unwrap()) | 1,
    };
    let h = Hub::create(&dir, job, hub_config())?;
    hsay!("SherpaHub: new job {:016x}: {m}x{k}x{n} int8 matrix product, {} units of {tile}x{tile}", h.job().id, h.job().units());
    Ok(h)
}

/// Start the SherpaHub on its own thread (it reconnects on its own, for as long as the program runs).
pub fn start_hub(st: Arc<Local>, o: HubOpts) {
    std::thread::Builder::new()
        .name("sherpahub".into())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("SherpaHub runtime");
            rt.block_on(hub_main(st, o));
        })
        .expect("SherpaHub thread");
}

struct DevInfo {
    cache: usize,
    models: Vec<String>,
    /// Introduced to the matrix job (else kept for whole prompts, or idle).
    in_mm: bool,
    /// Processor cores it computes with (from its hello): prompts go to the free device with the most first.
    cores: u64,
}

struct MmRun {
    /// "local" (the command line) or the tab's job ID (16 hex digits).
    id: String,
    hub: Hub,
    credited: u64,
    strikes: u64,
    t0: Instant,
}

struct HubRun {
    t0: Instant,
    devs: HashMap<DevId, DevInfo>,
    mm: Option<MmRun>,
    pr: Option<PromptRun>,
    /// Jobs of the tab not started yet, oldest first (the room sends them again after every reconnect).
    queue: VecDeque<Value>,
    /// Job IDs the room sent since this connection began (a running job it did not send again was cancelled).
    resent: HashSet<String>,
    opts: HubOpts,
    /// Drain (admin tab): finish the jobs running, start no new ones.
    draining: bool,
}

impl HubRun {
    fn now(&self) -> u64 {
        self.t0.elapsed().as_millis() as u64
    }
    fn wants(&self) -> Vec<&'static str> {
        let mut w = Vec::new();
        if self.mm.is_some() {
            w.push("packs");
        }
        if self.pr.as_ref().is_some_and(|p| p.wants_devices()) {
            w.push("prompts");
        }
        w
    }
}

/// What to send: binary frames ([device id][message]) and text lines.
#[derive(Default)]
struct Outq(Vec<Message>);
impl Outq {
    fn to_dev(&mut self, dev: DevId, bytes: &[u8]) {
        let mut f = Vec::with_capacity(bytes.len() + 4);
        f.extend_from_slice(&dev.to_le_bytes());
        f.extend_from_slice(bytes);
        self.0.push(Message::binary(f));
    }
    fn line(&mut self, v: Value) {
        self.0.push(Message::text(v.to_string()));
    }
}

async fn hub_main(st: Arc<Local>, o: HubOpts) {
    let mut run = HubRun { t0: Instant::now(), devs: HashMap::new(), mm: None, pr: None, queue: VecDeque::new(), resent: HashSet::new(), opts: o.clone(), draining: false };
    if let Some((m, k, n, tile)) = o.job {
        run.queue.push_back(json!({"id": "local", "kind": "matmul", "m": m, "k": k, "n": n, "tile": tile}));
    }
    let mut wait = 2;
    let mut said = String::new();
    loop {
        if !may_connect(&st) {
            if said != "signin" {
                hsay!("SherpaHub: sign in (with an admin account) to start leading jobs");
                said = "signin".into();
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
            continue;
        }
        if let Err(e) = hub_once(&st, &mut run).await {
            if said != e {
                hsay!("SherpaHub: offline, retrying ({e})");
                said = e;
            }
            wait = (wait * 2).min(60);
        } else {
            wait = 2;
        }
        tokio::time::sleep(Duration::from_secs(wait)).await;
    }
}

/// Start what can start: the next matrix job, the next batch of prompts.
fn start_next(run: &mut HubRun, out: &mut Outq) {
    if run.draining {
        return;
    }
    if run.mm.is_none() {
        if let Some(i) = run.queue.iter().position(|j| j["kind"] == "matmul") {
            let j = run.queue.remove(i).unwrap();
            let id = j["id"].as_str().unwrap_or("local").to_string();
            let g = |k: &str| j[k].as_u64().unwrap_or(0) as usize;
            let r = matmul_ok(g("m"), g("k"), g("n"), g("tile")).and_then(|_| open_matmul(&id, g("m"), g("k"), g("n"), g("tile")));
            match r {
                Ok(hub) => {
                    if id != "local" {
                        out.line(json!({"t": "jstate", "job": id, "state": "running", "note": format!("started: {} units", hub.job().units())}));
                    }
                    run.mm = Some(MmRun { id, hub, credited: 0, strikes: 0, t0: Instant::now() });
                    let now = run.now();
                    let keep = run.pr.as_ref().map(|p| p.model.clone());
                    let devs: Vec<(DevId, usize)> = run.devs.iter().filter(|(_, d)| !d.in_mm && !keep.as_ref().is_some_and(|m| d.models.contains(m))).map(|(k, d)| (*k, d.cache)).collect();
                    for (d, cache) in devs {
                        run.devs.get_mut(&d).unwrap().in_mm = true;
                        let outs = run.mm.as_mut().unwrap().hub.on_hello(now, d, cache);
                        mm_outs(run, outs, out);
                    }
                }
                Err(e) => {
                    hsay!("SherpaHub: job {id} cannot start: {e}");
                    if id != "local" {
                        out.line(json!({"t": "jstate", "job": id, "state": "failed", "note": format!("could not start: {e}")}));
                    }
                }
            }
        }
    }
    if run.pr.is_none() {
        if let Some(i) = next_prompts(&run.queue) {
            let j = run.queue.remove(i).unwrap();
            match PromptRun::new(&j) {
                Some(p) => {
                    hsay!("SherpaHub: prompts job {}: {} {} prompts, model {}", p.id, p.total(), p.task, p.model);
                    out.line(json!({"t": "jstate", "job": p.id, "state": "running", "note": format!("started: {} of {} prompts to do", p.total() - p.done(), p.total())}));
                    // the programs that have the model work on prompts now (not on matrix packs)
                    let now = run.now();
                    let take: Vec<DevId> = run.devs.iter().filter(|(_, d)| d.in_mm && d.models.contains(&p.model)).map(|(k, _)| *k).collect();
                    for d in take {
                        run.devs.get_mut(&d).unwrap().in_mm = false;
                        if let Some(mm) = run.mm.as_mut() {
                            let outs = mm.hub.on_gone(now, d);
                            mm_outs(run, outs, out);
                        }
                    }
                    run.pr = Some(p);
                }
                None => out.line(json!({"t": "jstate", "job": j["id"], "state": "failed", "note": "the job could not be read"})),
            }
        }
    }
}

/// The matrix job's outputs: frames to devices, credit / strike / ban lines, and its end.
fn mm_outs(run: &mut HubRun, outs: Vec<Out>, out: &mut Outq) {
    for o in outs {
        let Some(mm) = run.mm.as_mut() else { return };
        let job = if mm.id == "local" { Value::Null } else { json!(mm.id) };
        match o {
            Out::Send(dev, bytes) => out.to_dev(dev, &bytes),
            Out::Credit(dev, units) => {
                mm.credited += units as u64;
                out.line(json!({"t": "credit", "dev": dev, "units": units, "job": job}));
            }
            Out::Strike(dev) => {
                mm.strikes += 1;
                out.line(json!({"t": "strike", "dev": dev, "job": job}));
            }
            Out::Ban(dev) => {
                hsay!("SherpaHub: device {dev} banned for this job (3 wrong answers)");
                out.line(json!({"t": "ban", "dev": dev}));
            }
            Out::Done | Out::Corrupt => {
                let ok = o == Out::Done;
                let j = mm.hub.job().clone();
                let secs = mm.t0.elapsed().as_secs_f64();
                let gop = 2.0 * (j.m * j.k * j.n) as f64 / 1e9;
                println!(
                    "SherpaHub: job {:016x} {} ({} units, {gop:.1} GOP; credited {} units; {} strikes)",
                    j.id,
                    if ok { "DONE: every unit checked, and the whole product passed the final check" } else { "FAILED the final whole-product check (not reported)" },
                    j.units(),
                    mm.credited,
                    mm.strikes
                );
                let line = format!("{} job {:016x} {}x{}x{} tile {} units {} {} after {secs:.0} s of this run\n", if ok { "DONE" } else { "CORRUPT" }, j.id, j.m, j.k, j.n, j.tm, j.units(), if ok { "ok" } else { "final check failed" });
                let _ = std::fs::OpenOptions::new().create(true).append(true).open(hub_dir().join("jobs.log")).and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
                let id = mm.id.clone();
                if id != "local" {
                    let note = if ok { format!("DONE in {secs:.0} s: all {} pieces checked and the whole product passed the final check ({gop:.1} GOP)", j.units()) } else { "FAILED the final whole-product check".into() };
                    out.line(json!({"t": "jstate", "job": id, "state": if ok { "done" } else { "failed" }, "note": note}));
                    let _ = std::fs::remove_dir_all(hub_dir().join("jobs").join(&id)); // the product is not kept (a test job)
                } else if run.opts.repeat {
                    let (m, k, n, tile) = run.opts.job.unwrap();
                    run.queue.push_back(json!({"id": "local", "kind": "matmul", "m": m, "k": k, "n": n, "tile": tile}));
                }
                run.mm = None;
                for d in run.devs.values_mut() {
                    d.in_mm = false;
                }
                start_next(run, out);
                return;
            }
        }
    }
}

/// A batch of prompts: give tasks to idle programs with the model; at its end, hand the devices back.
fn pr_step(run: &mut HubRun, acts: Vec<Act>, out: &mut Outq) {
    for a in acts {
        match a {
            Act::Dev(d, b) => out.to_dev(d, &b),
            Act::Room(v) => out.line(v),
            Act::File(f) => out.to_dev(0, &f),
        }
    }
    let now = run.now();
    let Some(p) = run.pr.as_mut() else { return };
    if p.finished() {
        hsay!("SherpaHub: prompts job {} done ({} prompts)", p.id, p.total());
        out.line(json!({"t": "jstate", "job": p.id, "state": "done", "note": format!("DONE: {} prompts", p.total())}));
        run.pr = None;
        start_next(run, out);
        // devices kept for prompts go to the matrix job, if any
        if run.mm.is_some() {
            let now = run.now();
            let free: Vec<(DevId, usize)> = run.devs.iter().filter(|(_, d)| !d.in_mm).map(|(k, d)| (*k, d.cache)).collect();
            for (d, cache) in free {
                if run.pr.as_ref().is_some_and(|p| run.devs[&d].models.contains(&p.model)) {
                    continue;
                }
                run.devs.get_mut(&d).unwrap().in_mm = true;
                let outs = run.mm.as_mut().unwrap().hub.on_hello(now, d, cache);
                mm_outs(run, outs, out);
            }
        }
        return;
    }
    let model = p.model.clone();
    // the free devices with the model, the most cores first (a picture on 4 cores, not on 2, when both are free)
    let idle = fastest_first(run.devs.iter().filter(|(k, d)| !d.in_mm && d.models.contains(&model) && !p.busy(**k)).map(|(k, d)| (*k, d.cores)).collect());
    if !idle.is_empty() {
        let acts = p.assign(now, &idle);
        if !acts.is_empty() {
            pr_step(run, acts, out);
        }
    }
}

fn cancel(run: &mut HubRun, id: &str, why: &str, out: &mut Outq) {
    run.queue.retain(|j| j["id"].as_str() != Some(id));
    if run.mm.as_ref().is_some_and(|m| m.id == id) {
        hsay!("SherpaHub: matrix job {id} stopped ({why})");
        run.mm = None;
        let _ = std::fs::remove_dir_all(hub_dir().join("jobs").join(id));
        for d in run.devs.values_mut() {
            d.in_mm = false;
        }
        start_next(run, out);
    }
    if run.pr.as_ref().is_some_and(|p| p.id == id) {
        hsay!("SherpaHub: prompts job {id} stopped ({why})");
        run.pr = None;
        start_next(run, out);
        pr_step(run, vec![], out);
    }
}

async fn hub_once(st: &Arc<Local>, run: &mut HubRun) -> Result<(), String> {
    let req = ws_request(st, "/api/sherpa/hub", "")?;
    let (ws, _) = tokio_tungstenite::connect_async(req).await.map_err(http_err)?;
    hsay!("SherpaHub: connected to {}", site());
    let (mut sink, mut stream) = ws.split();
    // devices of the last connection are unknown now: the broker introduces the ones still there again; the room
    // sends the jobs still to do again (then "jobs_end")
    let now = run.now();
    for (d, info) in std::mem::take(&mut run.devs) {
        if info.in_mm {
            if let Some(mm) = run.mm.as_mut() {
                let _ = mm.hub.on_gone(now, d);
            }
        }
        if let Some(p) = run.pr.as_mut() {
            p.on_gone(now, d);
        }
    }
    run.queue.retain(|j| j["id"] == "local");
    run.resent.clear();
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    let mut report = tokio::time::interval(Duration::from_secs(10));
    let mut ping = tokio::time::interval(Duration::from_secs(25));
    let mut out = Outq::default();
    start_next(run, &mut out); // a job of the command line starts at once
    loop {
        for line in std::mem::take(&mut *HUBLOG.lock().unwrap()) {
            out.line(json!({"t": "log", "line": line}));
        }
        for m in out.0.drain(..) {
            sink.send(m).await.map_err(|e| e.to_string())?;
        }
        tokio::select! {
            m = stream.next() => match m {
                Some(Ok(Message::Binary(b))) if b.len() >= 12 => {
                    let dev = u32::from_le_bytes(b[..4].try_into().unwrap());
                    let msg = &b[4..];
                    if msg[4] == prompts::KIND_TASK_RESULT {
                        let now = run.now();
                        if let (Some(p), Some((_, meta, bytes))) = (run.pr.as_mut(), prompts::parse(msg)) {
                            let acts = p.on_result(now, dev, &meta, bytes);
                            pr_step(run, acts, &mut out);
                        }
                    } else if msg[4] == prompts::KIND_PROGRESS {
                        let now = run.now();
                        if let (Some(p), Some((_, meta, _))) = (run.pr.as_mut(), prompts::parse(msg)) {
                            p.on_progress(now, dev, &meta);
                        }
                    } else if run.devs.get(&dev).is_some_and(|d| d.in_mm) {
                        let now = run.now();
                        if let Some(mm) = run.mm.as_mut() {
                            let outs = mm.hub.on_message(now, dev, msg);
                            mm_outs(run, outs, &mut out);
                        }
                    }
                }
                Some(Ok(Message::Text(t))) => {
                    let v: Value = serde_json::from_str(t.as_str()).unwrap_or_default();
                    let dev = v["dev"].as_u64().unwrap_or(0) as DevId;
                    let now = run.now();
                    let kind = v["t"].as_str().unwrap_or("").to_string();
                    match Some(kind.as_str()) {
                        Some("hello") if dev > 0 => {
                            let cache = (v["cache"].as_u64().unwrap_or(0) as usize).max(1 << 20);
                            let models: Vec<String> = v["models"].as_array().map(|a| a.iter().filter_map(|m| m["id"].as_str().map(String::from)).collect()).unwrap_or_default();
                            let for_prompts = run.pr.as_ref().is_some_and(|p| models.contains(&p.model));
                            let in_mm = run.mm.is_some() && !for_prompts;
                            let cores = v["cores"].as_u64().unwrap_or(1).max(1);
                            run.devs.insert(dev, DevInfo { cache, models, in_mm, cores });
                            // prompts it is still making from before its connection dropped stay its own
                            let busy: Vec<(String, usize, u8)> = v["busy"].as_array().map(|a| a.iter().filter_map(|b|
                                Some((b["job"].as_str()?.to_string(), b["n"].as_u64()? as usize, b["copy"].as_u64().unwrap_or(0) as u8))).collect()).unwrap_or_default();
                            if let Some(p) = run.pr.as_mut() {
                                p.adopt(now, dev, &busy);
                            }
                            if in_mm {
                                let outs = run.mm.as_mut().unwrap().hub.on_hello(now, dev, cache);
                                mm_outs(run, outs, &mut out);
                            }
                            pr_step(run, vec![], &mut out);
                        }
                        Some("gone") if dev > 0 => {
                            if let Some(info) = run.devs.remove(&dev) {
                                if info.in_mm {
                                    if let Some(mm) = run.mm.as_mut() {
                                        let outs = mm.hub.on_gone(now, dev);
                                        mm_outs(run, outs, &mut out);
                                    }
                                }
                            }
                            if let Some(p) = run.pr.as_mut() {
                                p.on_gone(now, dev);
                            }
                            pr_step(run, vec![], &mut out);
                        }
                        Some("job") => {
                            let id = v["id"].as_str().unwrap_or("").to_string();
                            if !id.is_empty() {
                                run.resent.insert(id.clone());
                                let known = run.mm.as_ref().is_some_and(|m| m.id == id) || run.pr.as_ref().is_some_and(|p| p.id == id) || run.queue.iter().any(|j| j["id"].as_str() == Some(id.as_str()));
                                if !known {
                                    hsay!("SherpaHub: job {id} received ({})", v["kind"].as_str().unwrap_or(""));
                                    run.queue.push_back(v);
                                    start_next(run, &mut out);
                                    pr_step(run, vec![], &mut out);
                                }
                            }
                        }
                        Some("jobs_end") => {
                            // a job running here that the room did not send again was cancelled meanwhile
                            let gone: Vec<String> = [run.mm.as_ref().map(|m| m.id.clone()), run.pr.as_ref().map(|p| p.id.clone())]
                                .into_iter().flatten().filter(|id| id != "local" && !run.resent.contains(id)).collect();
                            for id in gone {
                                cancel(run, &id, "no longer on the tab", &mut out);
                            }
                        }
                        Some("drain") => {
                            run.draining = v["on"].as_bool() == Some(true);
                            if run.draining {
                                hsay!("SherpaHub: draining: the jobs running finish, no new ones start ({} waiting)", run.queue.len());
                            } else {
                                hsay!("SherpaHub: drain off: taking jobs again");
                                start_next(run, &mut out);
                                pr_step(run, vec![], &mut out);
                            }
                        }
                        Some("cancel") => {
                            let id = v["job"].as_str().unwrap_or("").to_string();
                            cancel(run, &id, "cancelled on the tab", &mut out);
                        }
                        _ => {}
                    }
                }
                Some(Ok(Message::Close(f))) => return Err(format!("closed by the site{}", f.map(|f| format!(": {}", f.reason.as_str())).unwrap_or_default())),
                None => return Err("connection lost".into()),
                Some(Err(e)) => return Err(e.to_string()),
                _ => {}
            },
            _ = tick.tick() => {
                let now = run.now();
                if let Some(mm) = run.mm.as_mut() {
                    let outs = mm.hub.tick(now);
                    mm_outs(run, outs, &mut out);
                }
                if let Some(p) = run.pr.as_mut() {
                    let acts = p.tick(now);
                    pr_step(run, acts, &mut out);
                }
            }
            _ = report.tick() => {
                let (job, done, total) = match (&run.mm, &run.pr) {
                    (Some(m), _) => (if m.id == "local" { format!("{:016x}", m.hub.job().id) } else { m.id.clone() }, m.hub.done_units(), m.hub.job().units()),
                    (None, Some(p)) => (p.id.clone(), p.done(), p.total()),
                    _ => (String::new(), 0, 0),
                };
                let wants = run.wants();
                match &run.mm {
                    Some(m) => {
                        let s = &m.hub.stats;
                        hsay!("SherpaHub: job {job}: {done} of {total} units, {} devices, {} packs sent, {} hedges, {} timeouts, {} failed units, {} strikes",
                            run.devs.len(), s.packs_sent, s.hedges, s.timeouts, s.units_failed, m.strikes);
                    }
                    None if run.pr.is_some() => hsay!("SherpaHub: prompts job {job}: {done} of {total} done, {} devices", run.devs.len()),
                    None => {}
                }
                out.line(json!({"t": "status", "job": job, "done": done, "total": total, "open": !wants.is_empty(), "wants": wants, "queued": run.queue.len(),
                    "draining": run.draining, "idle": run.mm.is_none() && run.pr.is_none()}));
            }
            _ = ping.tick() => out.line(json!({"t": "ping"})),
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Device role (the regular program, --headless, while contributing is on)

/// While contributing, take SherpaHub packs whenever a hub is running (the pi WorkPacks wait meanwhile).
pub async fn device_loop(st: Arc<Local>, e: Arc<Engine>) {
    let mut said = String::new();
    loop {
        if !e.is_running() || !may_connect(&st) {
            tokio::time::sleep(Duration::from_secs(10)).await;
            continue;
        }
        let hubs = match st.http.get(format!("{}/api/sherpa/status", site())).send().await {
            Ok(r) => r.bytes().await.ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v["hubs"].as_u64()).unwrap_or(0),
            Err(_) => 0,
        };
        if hubs == 0 {
            // the site answers from a 15 s cache: a hub that restarts is found again within about 20 s
            tokio::time::sleep(Duration::from_secs(20)).await;
            continue;
        }
        let r = device_once(&st, &e).await;
        let msg = match &r {
            Ok(()) => String::new(),
            Err(x) => x.clone(),
        };
        if msg != said && !msg.is_empty() {
            eprintln!("SherpaHub packs: {msg}");
        }
        said = msg;
        tokio::time::sleep(Duration::from_secs(if r.is_ok() { 2 } else { 20 })).await;
    }
}

/// The chat and picture models this program has downloaded (it can take whole prompts for them).
fn my_models() -> Vec<Value> {
    crate::models::downloaded()
        .into_iter()
        .filter(crate::models::installed)
        .filter_map(|m| {
            let k = crate::models::kind_of(&m);
            (k == "text" || k == "image" || k == "video").then(|| json!({"id": m["id"], "kind": k}))
        })
        .collect()
}

/// One whole prompt (a TASK from the hub): chat through llama.cpp (as a grid job), a picture through the picture
/// engine. (JSON header of the TASK_RESULT, bytes of the picture.)
/// The next prompts job to run: a real user's first; test traffic (DemandSimulation, "low") only when no real one waits
/// (paper sec:inhouse: simulated demand is always the lowest priority).
fn next_prompts(queue: &VecDeque<Value>) -> Option<usize> {
    queue.iter().position(|j| j["kind"] == "prompts" && j["low"] != true).or_else(|| queue.iter().position(|j| j["kind"] == "prompts"))
}

/// Device IDs, the most cores first (equal cores: the lower ID first, so the order is stable).
fn fastest_first(mut devs: Vec<(DevId, u64)>) -> Vec<DevId> {
    devs.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    devs.into_iter().map(|(d, _)| d).collect()
}

async fn run_task(st: &Arc<Local>, meta: &Value, cores: u32) -> (Value, Vec<u8>) {
    let t0 = Instant::now();
    let p = &meta["params"];
    let video = meta["task"] == "video";
    let res: Result<(String, Vec<u8>), String> = if meta["task"] == "image" || video {
        image_task(st, meta).await.map(|b| (String::new(), b))
    } else {
        let v = crate::contribute::run_job(
            st.clone(),
            json!({"id": meta["task_id"], "model": meta["model"], "messages": [{"role": "user", "content": meta["prompt"]}], "max_tokens": p["max_tokens"], "seed": p["seed"]}),
            cores,
        )
        .await;
        if v["ok"] == true { Ok((v["content"].as_str().unwrap_or("").to_string(), vec![])) } else { Err(v["error"].as_str().unwrap_or("the model did not run").to_string()) }
    };
    let ms = t0.elapsed().as_millis() as u64;
    match res {
        Ok((text, file)) => (json!({"task_id": meta["task_id"], "ok": true, "ms": ms, "text": text, "ext": if video { "webm" } else { "png" }}), file),
        Err(e) => (json!({"task_id": meta["task_id"], "ok": false, "ms": ms, "error": e}), vec![]),
    }
}

/// A picture asked for by a SherpaHub is cancelled when its task ends unfinished (the connection to the hub closed,
/// the program is stopping): otherwise it stays queued here while the hub gives the prompt to someone else.
struct PictureGuard<'a> {
    st: &'a Local,
    id: String,
    done: bool,
}
impl Drop for PictureGuard<'_> {
    fn drop(&mut self) {
        if !self.done {
            self.st.images.remove(&self.id);
        }
    }
}

async fn image_task(st: &Arc<Local>, meta: &Value) -> Result<Vec<u8>, String> {
    let p = &meta["params"];
    let mut req = json!({"model": meta["model"], "prompt": meta["prompt"], "width": p["width"], "height": p["height"], "seed": p["seed"], "sherpa": true});
    if p["steps"].is_number() {
        req["steps"] = p["steps"].clone();
    }
    if p["frames"].is_number() {
        req["frames"] = p["frames"].clone(); // a video (the model's kind decides)
    }
    let task = meta["task"].as_str().unwrap_or("image");
    let id = st.images.start(&req)?;
    let mut guard = PictureGuard { st, id: id.clone(), done: false };
    let key = task_key(meta);
    if let Some(m) = PROMPTS.lock().unwrap().running.get_mut(&key) {
        m["image"] = json!(id); // a CANCEL from the hub stops this picture
    }
    let t0 = Instant::now();
    // the same time rule as the hub's (sherpa_prompts::Watch): given up when its steps stop coming, not after a fixed time
    let mut watch = prompts::Watch::new(0);
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let j = st.images.job(&id).ok_or("the picture job vanished")?;
        let now = t0.elapsed().as_millis() as u64;
        watch.see(now, j["state"].as_str().unwrap_or(""), j["step"].as_u64().unwrap_or(0));
        if let Some(m) = PROMPTS.lock().unwrap().running.get_mut(&key) {
            m["progress"] = json!({"state": j["state"], "step": j["step"], "steps": j["steps"]}); // sent to the hub every 30 s
        }
        match j["state"].as_str() {
            Some("done") => {
                let f = st.images.file(&id).ok_or("the picture has no file")?;
                let b = tokio::fs::read(&f).await.map_err(|e| e.to_string())?;
                guard.done = true;
                st.images.remove(&id);
                let _ = std::fs::remove_file(&f); // kept by the hub's room (B2), not on this computer
                return Ok(b);
            }
            Some("error") | Some("cancelled") => {
                guard.done = true;
                return Err(j["error"].as_str().unwrap_or("the picture failed").to_string());
            }
            _ => {}
        }
        if let Some(why) = watch.overdue(task, now) {
            st.images.cancel(&id);
            return Err(why);
        }
    }
}

/// "job:n:copy": a whole prompt this device makes (PromptWork.running).
fn task_key(meta: &Value) -> String {
    format!("{}:{}:{}", meta["job"].as_str().unwrap_or(""), meta["n"], meta["copy"])
}

/// PROGRESS messages for the pictures being made here (the hub's time limit follows their steps).
fn progress_frames() -> Vec<Vec<u8>> {
    PROMPTS.lock().unwrap().running.values().filter(|m| m["progress"].is_object()).map(|m| {
        let mut h = m["progress"].clone();
        for k in ["task_id", "job", "n", "copy"] {
            h[k] = m[k].clone();
        }
        prompts::frame(prompts::KIND_PROGRESS, &h, &[])
    }).collect()
}

async fn device_once(st: &Arc<Local>, e: &Arc<Engine>) -> Result<(), String> {
    let models = my_models();
    // with models it also takes whole prompts (the directory prefers it for hubs with prompts waiting)
    let req = ws_request(st, "/api/sherpa/device", if models.is_empty() { "&kinds=packs" } else { "&kinds=packs,prompts" })?;
    let (ws, _) = tokio_tungstenite::connect_async(req).await.map_err(http_err)?;
    let (mut sink, mut stream) = ws.split();
    let (cores, _) = e.cores_cap();
    sink.send(Message::text(
        json!({"t": "hello", "cache": DEVICE_CACHE, "cores": cores, "kernels": [workpack::kernels::KERNEL_MATMUL_I8], "name": crate::tunnel::device_name(), "models": models,
               "busy": PROMPTS.lock().unwrap().running.values().map(|m| json!({"job": m["job"], "n": m["n"], "copy": m["copy"]})).collect::<Vec<_>>()}).to_string(),
    ))
    .await
    .map_err(|x| x.to_string())?;
    println!("SherpaHub packs: connected, computing on {cores} core{}{}", if cores == 1 { "" } else { "s" }, if models.is_empty() { String::new() } else { format!("; whole prompts for {} models", models.len()) });
    // messages are handled in order by one worker (a BLOCK must be stored before the PACK that uses it)
    let (in_tx, mut in_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(256);
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(8);
    let eng = e.clone();
    let st2 = st.clone();
    let worker = tokio::spawn(async move {
        let mut dev = Some(workpack::device::Device::new(DEVICE_CACHE));
        while let Some(msg) = in_rx.recv().await {
            let (cores, cap) = eng.cores_cap();
            if msg.len() > 4 && msg[4] == prompts::KIND_CANCEL {
                // another computer delivered this prompt first: stop the picture (its error answer is dropped by the hub)
                let Some((_, meta, _)) = prompts::parse(&msg) else { continue };
                let image = PROMPTS.lock().unwrap().running.get(&task_key(&meta)).and_then(|m| m["image"].as_str().map(String::from));
                if let Some(id) = image {
                    println!("SherpaHub prompts: #{} stopped (another computer delivered it first)", meta["n"].as_u64().unwrap_or(0) + 1);
                    st2.images.cancel(&id);
                }
                continue;
            }
            if msg.len() > 4 && msg[4] == prompts::KIND_TASK {
                // a whole prompt, in a task of its own (it goes on if this connection drops); the pi WorkPacks wait;
                // the answer goes to the outbox in parts of at most 900 KB
                let Some((_, meta, _)) = prompts::parse(&msg) else { continue };
                let key = task_key(&meta);
                {
                    let mut g = PROMPTS.lock().unwrap();
                    if let Some(m) = g.running.get_mut(&key) {
                        m["task_id"] = meta["task_id"].clone(); // already being made: answer under the new number
                        continue;
                    }
                    g.running.insert(key.clone(), meta.clone());
                }
                let (st3, eng3) = (st2.clone(), eng.clone());
                tokio::spawn(async move {
                    let _g = eng3.pack_begin();
                    println!("SherpaHub prompts: {} #{} ({})", meta["task"].as_str().unwrap_or(""), meta["n"].as_u64().unwrap_or(0) + 1, meta["model"].as_str().unwrap_or(""));
                    let (cores, _) = eng3.cores_cap();
                    let (mut rmeta, file) = run_task(&st3, &meta, cores).await;
                    let mut g = PROMPTS.lock().unwrap();
                    let cur = g.running.remove(&key).unwrap_or(meta);
                    for k in ["task_id", "job", "n", "copy"] {
                        rmeta[k] = cur[k].clone();
                    }
                    g.outbox.push_back(prompts::parts(prompts::KIND_TASK_RESULT, &rmeta, &file));
                    drop(g);
                    OUTBOX.notify_one();
                });
                continue;
            }
            let is_pack = msg.len() > 4 && msg[4] == workpack::wire::KIND_PACK;
            let guard = is_pack.then(|| eng.pack_begin());
            let d = dev.take().unwrap();
            let (d, reply, took) = tokio::task::spawn_blocking(move || {
                let mut d = d;
                let t = Instant::now();
                let r = d.handle_on(&msg, cores as usize);
                (d, r, t.elapsed())
            })
            .await
            .expect("pack worker");
            dev = Some(d);
            if let Some(g) = guard {
                g.done(took * cores);
            }
            let out = match reply {
                workpack::device::Reply::Result(mut r) => {
                    r.compute_ms = took.as_millis().min(u32::MAX as u128) as u32;
                    Some(encode(&Msg::Result(r)))
                }
                workpack::device::Reply::Need(n) => Some(encode(&Msg::Need(n))),
                workpack::device::Reply::None => None,
            };
            let computed = out.is_some() && is_pack;
            if let Some(o) = out {
                if out_tx.send(o).await.is_err() {
                    return;
                }
            }
            if computed && cap < 100 {
                // the cap: rest in proportion to the work (as the pi WorkPacks do)
                let c = cap.clamp(10, 100) as f64 / 100.0;
                tokio::time::sleep(took.mul_f64((1.0 - c) / c)).await;
            }
        }
    });
    let mut ping = tokio::time::interval(Duration::from_secs(25));
    let mut check = tokio::time::interval(Duration::from_secs(5));
    let mut prog = tokio::time::interval(Duration::from_secs(30));
    OUTBOX.notify_one(); // answers finished while there was no connection go out now
    let r = loop {
        tokio::select! {
            _ = prog.tick() => {
                let mut lost = None;
                for f in progress_frames() {
                    if let Err(x) = sink.send(Message::binary(f)).await {
                        lost = Some(x.to_string());
                        break;
                    }
                }
                if let Some(x) = lost { break Err(x); }
            }
            _ = OUTBOX.notified() => {
                let mut lost = None;
                'answers: loop {
                    let Some(ans) = PROMPTS.lock().unwrap().outbox.pop_front() else { break };
                    for f in &ans {
                        if let Err(x) = sink.send(Message::binary(f.clone())).await {
                            PROMPTS.lock().unwrap().outbox.push_front(ans); // the whole answer again on the next connection
                            lost = Some(x.to_string());
                            break 'answers;
                        }
                    }
                }
                if let Some(x) = lost { break Err(x); }
            }
            m = stream.next() => match m {
                Some(Ok(Message::Binary(b))) => { if in_tx.send(b.to_vec()).await.is_err() { break Err("worker stopped".to_string()); } }
                Some(Ok(Message::Close(f))) => break match f.as_ref().map(|f| u16::from(f.code)) {
                    Some(4010) => Ok(()),                                    // the hub left: look for another
                    Some(4008) => Err("banned by this SherpaHub for its job".into()),
                    _ => Err(format!("closed{}", f.map(|f| format!(": {}", f.reason.as_str())).unwrap_or_default())),
                },
                None => break Err("connection lost".into()),
                Some(Err(x)) => break Err(x.to_string()),
                _ => {}
            },
            o = out_rx.recv() => match o {
                Some(o) => { if let Err(x) = sink.send(Message::binary(o)).await { break Err(x.to_string()); } }
                None => break Err("worker stopped".into()),
            },
            _ = ping.tick() => { if let Err(x) = sink.send(Message::text(r#"{"t":"ping"}"#.to_string())).await { break Err(x.to_string()); } }
            _ = check.tick() => {
                if !e.is_running() || !may_connect(st) {
                    let _ = sink.close().await;
                    break Ok(());
                }
            }
        }
    };
    worker.abort();
    r
}

#[cfg(test)]
mod fastest_tests {
    #[test]
    fn a_real_users_prompts_go_before_test_traffic() {
        use serde_json::json;
        let q: std::collections::VecDeque<serde_json::Value> = vec![json!({"kind": "matmul"}), json!({"kind": "prompts", "id": "t", "low": true}),
            json!({"kind": "prompts", "id": "u", "low": false})].into();
        assert_eq!(super::next_prompts(&q), Some(2));                  // the user's, though the test job came first
        let only_test: std::collections::VecDeque<serde_json::Value> = vec![json!({"kind": "prompts", "id": "t", "low": true})].into();
        assert_eq!(super::next_prompts(&only_test), Some(0));          // test traffic runs when nothing else waits
        assert_eq!(super::next_prompts(&std::collections::VecDeque::new()), None);
    }
    #[test]
    fn prompts_go_to_the_device_with_the_most_cores_first() {
        // generouscows copies have 2 cores, workhorse copies 4: a picture goes to a 4-core one when both are free
        assert_eq!(super::fastest_first(vec![(3, 2), (7, 4), (5, 2), (9, 4)]), vec![7, 9, 3, 5]);
        assert_eq!(super::fastest_first(vec![]), Vec::<workpack::hub::DevId>::new());
    }
}
