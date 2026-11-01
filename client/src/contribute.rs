// The native contributor, for --headless (no browser runs the planetcompute.ai console there). It does what the
// console does, natively:
//   WorkPacks      pc_mc_pi (Monte Carlo pi; = the console's 133-byte WebAssembly module and worker.js
//                  cpuChunkHits) on N threads, under the same duty-cycle cap.
//   heartbeat      every 5 min working / 15 min idle to /api/volunteer/heartbeat, the console's fields, host "app".
//   capacity check /api/police/ws, CPU challenges answered on all cores (no GPU here yet: WebGPU is a browser
//                  feature).
//   work audits    over the same socket: the site leases WorkPacks (its seeds), the threads compute them, the
//                  program commits to all results (a Merkle root), the site picks packs to prove and recomputes
//                  them. Credit comes only from passed audits (worker.js offerLease / onCommit / onProof).
//   grid jobs      also over that socket: the program tells the site its downloaded chat models; the site sends chat
//                  jobs from Receive Compute (POST /v1/jobs, e.g. the hungrywolves), the program runs each on its own
//                  llama.cpp (as its /v1/chat/completions) and answers (worker.js gridFetch).
// Settings (I agree, cores, cap, running) are kept in the config folder, so a restarted server resumes.

use crate::server::Local;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, Message};

const PACK: u32 = 2_000_000; // samples per WorkPack, as in the console

// The kernels live in the workpack crate (client/workpack), shared with the SherpaHub and its tests.
pub use workpack::kernels::{lease_seed, mc_pi};

fn sha(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    let mut o = [0u8; 32];
    o.copy_from_slice(&h.finalize());
    o
}

/// The Merkle tree of a lease's results: leaves sha256(le32 i | le32 hits), padded to a power of two with 32 zero
/// bytes, each node sha256(left | right). levels[0] = leaves, the last level = [root].
pub fn merkle(hits: &[u32]) -> Vec<Vec<[u8; 32]>> {
    let w = hits.len().next_power_of_two();
    let mut lv = vec![(0..w).map(|i| if i < hits.len() { sha(&[&(i as u32).to_le_bytes()[..], &hits[i].to_le_bytes()[..]]) } else { [0u8; 32] }).collect::<Vec<_>>()];
    while lv.last().unwrap().len() > 1 {
        let next = lv.last().unwrap().chunks(2).map(|c| sha(&[&c[0][..], &c[1][..]])).collect();
        lv.push(next);
    }
    lv
}

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Leaf i's siblings, bottom up: its path to the root.
fn merkle_path(lv: &[Vec<[u8; 32]>], i: usize) -> Vec<String> {
    lv[..lv.len() - 1].iter().enumerate().map(|(l, v)| to_hex(&v[(i >> l) ^ 1])).collect()
}

/// A lease from the site: packs 0..count with its seeds, taken by the worker threads in order.
pub struct Lease {
    id: String,
    base: u32,
    n: u32,
    count: u32,
    lease_s: u64,
    got: Instant,
    next: AtomicU32,
    inflight: AtomicU32,
    closing: AtomicBool,
    hits: Vec<AtomicU32>,
}

impl Lease {
    /// The next pack to compute, or None when all are taken or the lease is being committed.
    fn take(&self) -> Option<u32> {
        self.inflight.fetch_add(1, SeqCst);
        if !self.closing.load(SeqCst) {
            let i = self.next.fetch_add(1, SeqCst);
            if i < self.count {
                return Some(i);
            }
        }
        self.inflight.fetch_sub(1, SeqCst);
        None
    }
    fn due(&self) -> bool {
        !self.closing.load(SeqCst) && (self.got.elapsed().as_secs() >= self.lease_s || self.next.load(SeqCst) >= self.count)
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Settings {
    pub agreed: bool,
    pub cores: u32,
    pub cap: u32,
    pub running: bool,
}

pub struct Engine {
    pub settings: Mutex<Settings>,
    gen: AtomicU64,
    packs: AtomicU64,
    hits: AtomicU64,
    n: AtomicU64,
    busy_us: AtomicU64,
    window_n: AtomicU64,
    last_work: Mutex<Instant>,
    window: Mutex<(Instant, f64, f64)>, // (window start, last cpu %, last samples/s)
    session: Mutex<Option<String>>,     // this contributing session's ID (16 hex), once started
    verdict: Mutex<Option<Value>>,
    ratings: Mutex<Option<Value>>,
    lease: Mutex<Option<Arc<Lease>>>,
    audit: Mutex<Option<Value>>, // the last audit result from the site
    jobs: AtomicU32,             // grid jobs running now: the WorkPack threads wait, so llama.cpp has the processor
    /// This program is signed in (user 2026-11-01: signing out halts sharing at once; signing in again resumes it).
    signed_in: AtomicBool,
}

/// See Engine::pack_begin; `done` records the work (core time) for the console's CPU figure.
pub struct PackGuard(Arc<Engine>);
impl PackGuard {
    pub fn done(&self, busy: Duration) {
        self.0.busy_us.fetch_add(busy.as_micros() as u64, SeqCst);
        *self.0.last_work.lock().unwrap() = Instant::now();
    }
}
impl Drop for PackGuard {
    fn drop(&mut self) {
        self.0.jobs.fetch_sub(1, SeqCst);
    }
}

fn hw_cores() -> u32 {
    std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1)
}

fn settings_file() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join("planetCompute").join("contribute.json"))
}

fn random_hex(len: usize) -> String {
    let mut s = String::new();
    while s.len() < len {
        s.push_str(&uuid::Uuid::new_v4().simple().to_string());
    }
    s[..len].to_string()
}

impl Engine {
    /// Saved settings, then the command line: --contribute (agree and start), --cores N, --cap P.
    pub fn new(args: &[String]) -> Arc<Engine> {
        let e = Self::build(args);
        e.save();
        e
    }

    /// The engine without saving its settings (the tests use this: they must not change this computer's settings).
    fn build(args: &[String]) -> Arc<Engine> {
        let mut s = settings_file()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .and_then(|t| serde_json::from_str::<Settings>(&t).ok())
            .unwrap_or(Settings { agreed: false, cores: 1.max(hw_cores() / 2), cap: 50, running: false });
        let val = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).and_then(|v| v.parse::<u32>().ok());
        if let Some(c) = val("--cores") {
            s.cores = c;
        }
        if let Some(c) = val("--cap") {
            s.cap = c;
        }
        if args.iter().any(|a| a == "--contribute") {
            s.agreed = true;
            s.running = true;
        }
        s.cores = s.cores.clamp(1, hw_cores());
        s.cap = s.cap.clamp(10, 100);
        s.running &= s.agreed;
        let e = Arc::new(Engine {
            settings: Mutex::new(s),
            gen: AtomicU64::new(0),
            packs: AtomicU64::new(0),
            hits: AtomicU64::new(0),
            n: AtomicU64::new(0),
            busy_us: AtomicU64::new(0),
            window_n: AtomicU64::new(0),
            last_work: Mutex::new(Instant::now()),
            window: Mutex::new((Instant::now(), 0.0, 0.0)),
            session: Mutex::new(None),
            verdict: Mutex::new(None),
            ratings: Mutex::new(None),
            lease: Mutex::new(None),
            audit: Mutex::new(None),
            jobs: AtomicU32::new(0),
            signed_in: AtomicBool::new(false),
        });
        e
    }

    fn save(&self) {
        let s = self.settings.lock().unwrap().clone();
        if let Some(f) = settings_file() {
            if let Some(d) = f.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            let _ = std::fs::write(f, serde_json::to_string_pretty(&s).unwrap_or_default());
        }
    }

    fn running(&self) -> bool {
        self.settings.lock().unwrap().running && self.signed_in.load(SeqCst)
    }

    /// The sign-in changed (server.rs set_session): sharing stops at once when signed out, and starts again (if it
    /// was switched on) when signed in.
    pub(crate) fn set_signed_in(self: &Arc<Self>, on: bool) {
        if self.signed_in.swap(on, SeqCst) != on {
            self.apply();
        }
    }

    /// (Re)start the worker threads for the current settings, or stop them.
    fn apply(self: &Arc<Self>) {
        let gen = self.gen.fetch_add(1, SeqCst) + 1;
        let s = self.settings.lock().unwrap().clone();
        crate::image::set_threads(s.cores as usize); // pictures use the cores shared here too, not the whole machine
        if !s.running || !self.signed_in.load(SeqCst) {
            return;
        }
        self.session.lock().unwrap().get_or_insert_with(|| random_hex(16));
        for _ in 0..s.cores {
            let e = self.clone();
            let mut seed = u32::from_str_radix(&random_hex(8), 16).unwrap_or(1);
            std::thread::spawn(move || {
                while e.gen.load(SeqCst) == gen {
                    if e.jobs.load(SeqCst) > 0 || crate::image::making() {
                        // a grid job (someone's Receive Compute) or a picture being made here comes first
                        std::thread::sleep(Duration::from_millis(50));
                        continue;
                    }
                    // a pack of the site's lease when there is one (audited, credited), else one of our own
                    let lease = e.lease.lock().unwrap().clone();
                    let slot = lease.as_ref().and_then(|l| l.take().map(|i| (l.clone(), i)));
                    let (s, n) = match &slot {
                        Some((l, i)) => (lease_seed(l.base, *i), l.n),
                        None => {
                            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345).max(1);
                            (seed, PACK)
                        }
                    };
                    let t0 = Instant::now();
                    let hits = mc_pi(s, n);
                    let took = t0.elapsed();
                    if let Some((l, i)) = slot {
                        l.hits[i as usize].store(hits, SeqCst);
                        l.inflight.fetch_sub(1, SeqCst);
                    }
                    e.packs.fetch_add(1, SeqCst);
                    e.hits.fetch_add(hits as u64, SeqCst);
                    e.n.fetch_add(n as u64, SeqCst);
                    e.window_n.fetch_add(n as u64, SeqCst);
                    e.busy_us.fetch_add(took.as_micros() as u64, SeqCst);
                    *e.last_work.lock().unwrap() = Instant::now();
                    let cap = e.settings.lock().unwrap().cap.clamp(10, 100) as f64 / 100.0;
                    std::thread::sleep(took.mul_f64((1.0 - cap) / cap));
                }
            });
        }
    }

    /// Contributing is switched on (sherpa.rs takes SherpaHub packs only then).
    pub(crate) fn is_running(&self) -> bool {
        self.running()
    }
    pub(crate) fn cores_cap(&self) -> (u32, u32) {
        let s = self.settings.lock().unwrap();
        (s.cores, s.cap)
    }
    /// A SherpaHub pack is being computed: the pi WorkPack threads wait until the guard is dropped.
    pub(crate) fn pack_begin(self: &Arc<Self>) -> PackGuard {
        self.jobs.fetch_add(1, SeqCst);
        PackGuard(self.clone())
    }

    /// The console's states: off, running, idle, paused, stopped.
    fn state(&self) -> &'static str {
        let started = self.session.lock().unwrap().is_some();
        if !started {
            return "off";
        }
        if !self.running() {
            return "paused";
        }
        if self.last_work.lock().unwrap().elapsed() > Duration::from_secs(3) { "idle" } else { "running" }
    }

    fn samples_per_wu(&self) -> f64 {
        self.ratings.lock().unwrap().as_ref().and_then(|r| r["samples_per_wu"].as_f64()).unwrap_or(1e9)
    }

    /// CPU use and speed over the last window (at least a second).
    fn usage(&self) -> (f64, f64) {
        let mut w = self.window.lock().unwrap();
        let dt = w.0.elapsed().as_secs_f64();
        if dt >= 1.0 {
            let busy = self.busy_us.swap(0, SeqCst) as f64 / 1e6;
            let n = self.window_n.swap(0, SeqCst) as f64;
            let on = self.running();
            *w = (Instant::now(), if on { (100.0 * busy / (dt * hw_cores() as f64)).min(100.0) } else { 0.0 }, if on { n / dt } else { 0.0 });
        }
        (w.1, w.2)
    }

    pub fn status(&self) -> Value {
        let s = self.settings.lock().unwrap().clone();
        let (cpu, rate) = self.usage();
        let n = self.n.load(SeqCst) as f64;
        json!({
            "engine": "native", "agreed": s.agreed, "cores": s.cores, "cap": s.cap, "running": s.running, "signed_in": self.signed_in.load(SeqCst),
            "hw_cores": hw_cores(), "state": self.state(), "cpu_pct": cpu, "samples_per_s": rate,
            "packs": self.packs.load(SeqCst), "wu": n / self.samples_per_wu(),
            "pi": if n > 0.0 { 4.0 * self.hits.load(SeqCst) as f64 / n } else { 0.0 },
            "verdict": self.verdict.lock().unwrap().clone(),
            "audit": self.audit.lock().unwrap().clone(),
        })
    }

    /// From the device page: {agree, cores, cap, run}. Starting needs I agree.
    pub fn update(self: &Arc<Self>, v: &Value) -> Result<(), String> {
        {
            let mut s = self.settings.lock().unwrap();
            if let Some(a) = v["agree"].as_bool() {
                s.agreed = a;
            }
            if let Some(c) = v["cores"].as_u64() {
                s.cores = (c as u32).clamp(1, hw_cores());
            }
            if let Some(c) = v["cap"].as_u64() {
                s.cap = (c as u32).clamp(10, 100);
            }
            if let Some(r) = v["run"].as_bool() {
                if r && !s.agreed {
                    return Err("Switch on I agree first.".into());
                }
                s.running = r;
            }
            if !s.agreed {
                s.running = false;
            }
        }
        self.save();
        self.apply();
        Ok(())
    }
}

/// Start the engine and its loops: ratings, heartbeat, capacity check.
pub async fn run(st: Arc<Local>, e: Arc<Engine>) {
    e.apply();
    tokio::spawn(ratings_loop(st.clone(), e.clone()));
    tokio::spawn(police_loop(st.clone(), e.clone()));
    tokio::spawn(crate::sherpa::device_loop(st.clone(), e.clone()));
    let mut last = String::new();
    let mut sent: Option<std::time::Instant> = None;
    loop {
        let state = e.state();
        // a report every 5 minutes while working, every 15 while idle (the site's BEAT_S / IDLE_BEAT_S: at a million
        // volunteers a report a minute cost ~$62,000 a month), at once when the state changes, once more on pause/stop
        let every = Duration::from_secs(if state == "running" { 300 } else { 900 });
        let due = sent.map_or(true, |t| t.elapsed() + Duration::from_secs(5) >= every) || state != last;
        if state != "off" && (state != "paused" || last != "paused") && due {
            heartbeat(&st, &e, state).await;
            last = state.to_string();
            sent = Some(std::time::Instant::now());
        }
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}

async fn ratings_loop(st: Arc<Local>, e: Arc<Engine>) {
    loop {
        if let Ok(r) = st.http.get(format!("{}/api/machine-ratings", crate::api::SITE)).send().await {
            if let Some(v) = r.bytes().await.ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
                *e.ratings.lock().unwrap() = Some(v);
            }
        }
        tokio::time::sleep(Duration::from_secs(600)).await;
    }
}

fn platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "Windows",
        "macos" => "macOS",
        "linux" => "Linux",
        other => other,
    }
}

async fn heartbeat(st: &Local, e: &Engine, state: &str) {
    let token = st.session.lock().unwrap().clone();
    let Some(token) = token else { return };
    let sid = e.session.lock().unwrap().clone().unwrap_or_default();
    let s = e.settings.lock().unwrap().clone();
    let (cpu, _) = e.usage();
    let n = e.n.load(SeqCst) as f64;
    let body = json!({
        "device_id": st.device, "session_id": sid, "state": state, "cores": if s.running { s.cores } else { 0 },
        "cpu_cap": s.cap, "cpu_pct": cpu, "gpu_on": false, "gpu_name": "", "gpu_cap": 0, "gpu_pct": 0, "mem_mb": 0,
        "packs": e.packs.load(SeqCst), "wu": n / e.samples_per_wu(), "credit": 0,
        "browser": concat!("planetCompute ", env!("CARGO_PKG_VERSION"), "+", env!("PC_COMMIT")), "platform": platform(), "host": "app",
        "build": crate::BUILD, "build_time": crate::build_time(),
        "hw_cores": hw_cores(), "device_mem_gb": 0,
    });
    // our heartbeat servers first (admin tab Servers), the website when none answers
    let cfg = hb_config(st, &token).await;
    for u in &cfg.servers {
        let r = st.http.post(format!("{u}/beat")).header("content-type", "application/json")
            .header("authorization", format!("Bearer {}", cfg.token)).timeout(Duration::from_secs(5))
            .body(body.to_string()).send().await;
        match r {
            Ok(r) if r.status().is_success() => return,
            Ok(r) if r.status().as_u16() == 401 => hb_forget(),
            _ => {}
        }
    }
    let _ = st
        .http
        .post(format!("{}/api/volunteer/heartbeat", crate::api::SITE))
        .header("content-type", "application/json")
        .header("cookie", format!("{}={token}", crate::api::COOKIE))
        .body(body.to_string())
        .send()
        .await;
}

/// The heartbeat servers to try and this device's pass (GET /api/hb/config), asked again every 30 minutes, or soon
/// after a refused pass. Only https addresses under planetcompute.ai.
#[derive(Clone, Default)]
struct HbCfg {
    servers: Vec<String>,
    token: String,
    until: u64,
    asked: Option<Instant>,
}
static HB: std::sync::OnceLock<Mutex<HbCfg>> = std::sync::OnceLock::new();

fn hb_forget() {
    if let Some(m) = HB.get() {
        m.lock().unwrap().asked = None;
    }
}

async fn hb_config(st: &Local, token: &str) -> HbCfg {
    let m = HB.get_or_init(|| Mutex::new(HbCfg::default()));
    let cur = m.lock().unwrap().clone();
    let unix = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if cur.asked.is_some_and(|a| a.elapsed() < Duration::from_secs(1800)) && (cur.servers.is_empty() || cur.until > unix + 3600) {
        return cur;
    }
    let mut c = HbCfg { asked: Some(Instant::now()), ..Default::default() };
    let r = st.http.get(format!("{}/api/hb/config?device={}", crate::api::SITE, st.device))
        .header("cookie", format!("{}={token}", crate::api::COOKIE)).timeout(Duration::from_secs(10)).send().await;
    if let Ok(r) = r {
        if r.status().is_success() {
            let v: Value = serde_json::from_slice(&r.bytes().await.unwrap_or_default()).unwrap_or_default();
            c.servers = v["servers"].as_array().cloned().unwrap_or_default().iter().filter_map(|x| x.as_str())
                .filter(|u| u.starts_with("https://") && u.ends_with(".planetcompute.ai") && !u[8..].contains('/')
                    // security review P7: the real host must be ours (not https://evil.com?.planetcompute.ai)
                    && reqwest::Url::parse(u).ok().is_some_and(|x| x.host_str().is_some_and(|h| h.ends_with(".planetcompute.ai"))
                        && x.username().is_empty() && x.password().is_none() && x.query().is_none() && x.fragment().is_none() && x.port().is_none()))
                .map(String::from).collect();
            c.token = v["token"].as_str().unwrap_or("").to_string();
            c.until = v["until"].as_u64().unwrap_or(0);
        }
    }
    *m.lock().unwrap() = c.clone();
    c
}

/// Keep the capacity-check socket open while contributing, signed in, and the site has the check switched on.
async fn police_loop(st: Arc<Local>, e: Arc<Engine>) {
    let mut last_ask: Option<Instant> = None;
    loop {
        let token = st.session.lock().unwrap().clone();
        let on = e.ratings.lock().unwrap().as_ref().is_some_and(|r| r["police"].as_bool() == Some(true));
        if let (Some(token), true, true) = (token, on, e.running()) {
            let _ = police_once(&st, &e, &token).await;
            // the site closes this socket when the sign-in ends (signed out on the website or another device): ask it
            if last_ask.is_none_or(|t: Instant| t.elapsed() > Duration::from_secs(60)) {
                last_ask = Some(Instant::now());
                crate::server::check_signed_in(&st, &token).await;
            }
        }
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
}

/// A grid job: run it like a local /v1/chat/completions request (temperature 0, the site's seed), the answer as the
/// site expects it.
/// A grid job, on the cores this computer shares (llama.cpp with more threads than free cores is many times slower).
pub(crate) async fn run_job(st: Arc<Local>, v: Value, cores: u32) -> Value {
    let t0 = Instant::now();
    let body = json!({"model": v["model"], "messages": v["messages"], "max_tokens": v["max_tokens"], "temperature": 0, "seed": v["seed"], "stream": false,
                      "threads": cores.max(1)});
    let r = crate::openai::chat(axum::extract::State(st), axum::Json(body)).await;
    let ok = r.status().is_success();
    let bytes = axum::body::to_bytes(r.into_body(), 4 << 20).await.unwrap_or_default();
    let a: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let ms = t0.elapsed().as_millis() as u64;
    if !ok {
        return json!({"type": "job_result", "id": v["id"], "ok": false, "error": a["error"]["message"].as_str().unwrap_or("the model did not run"), "ms": ms});
    }
    json!({"type": "job_result", "id": v["id"], "ok": true, "content": a["choices"][0]["message"]["content"], "finish": a["choices"][0]["finish_reason"],
           "prompt_tokens": a["usage"]["prompt_tokens"], "completion_tokens": a["usage"]["completion_tokens"], "ms": ms})
}

/// The chat models this computer has downloaded (offered to the grid).
fn job_models() -> Vec<String> {
    crate::models::downloaded().into_iter().filter(crate::models::installed).filter(|m| crate::models::kind_of(m) == "text")
        .filter_map(|m| m["id"].as_str().map(String::from)).collect()
}

async fn police_once(st: &Arc<Local>, e: &Arc<Engine>, token: &str) -> Result<(), String> {
    let host = crate::api::SITE.trim_start_matches("https://");
    let mut req = format!("wss://{host}/api/police/ws?device={}", st.device).into_client_request().map_err(|x| x.to_string())?;
    let h = req.headers_mut();
    h.insert("cookie", HeaderValue::from_str(&format!("{}={token}", crate::api::COOKIE)).map_err(|x| x.to_string())?);
    h.insert("user-agent", HeaderValue::from_static(crate::UA));
    let (ws, _) = tokio_tungstenite::connect_async(req).await.map_err(|x| x.to_string())?;
    let (mut tx, mut rx) = ws.split();
    let cores = e.settings.lock().unwrap().cores;
    *e.lease.lock().unwrap() = None; // a new connection: the site voids any old lease and sends a new one
    let models = job_models();
    tx.send(Message::text(json!({"type": "hello", "cores": cores, "gpu": false, "leases": true, "jobs": !models.is_empty(), "models": models, "build": crate::BUILD, "build_time": crate::build_time()}).to_string()))
        .await.map_err(|x| x.to_string())?;
    let (job_tx, mut job_rx) = tokio::sync::mpsc::unbounded_channel::<Value>(); // answers of grid jobs, sent from the loop
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    let mut committed: Option<(String, Vec<u32>, Vec<Vec<[u8; 32]>>)> = None; // (lease, results, tree) until audited
    loop {
        let m = tokio::select! {
            m = rx.next() => m,
            Some(a) = job_rx.recv() => {
                tx.send(Message::text(a.to_string())).await.map_err(|x| x.to_string())?;
                continue;
            }
            _ = tick.tick() => {
                let same = st.session.lock().unwrap().as_deref() == Some(token);
                let lease = e.lease.lock().unwrap().clone();
                // paused or stopped: first commit what the lease has done and answer its audit (or give up after
                // the lease's time + 3 minutes), then close
                let settled = lease.as_ref().is_none_or(|l| (l.closing.load(SeqCst) && committed.is_none()) || l.got.elapsed().as_secs() > l.lease_s + 180);
                if !same || (!e.running() && settled) {
                    let _ = tx.close().await;
                    return Ok(());
                }
                // the lease's time is up, or every pack is taken (or we are pausing): wait for the packs in hand, commit
                let due = lease.filter(|l| l.due() || (!e.running() && !l.closing.load(SeqCst)));
                if let Some(l) = due {
                    l.closing.store(true, SeqCst);
                    while l.inflight.load(SeqCst) > 0 {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                    let done = l.next.load(SeqCst).min(l.count) as usize;
                    if done == 0 {
                        continue; // nothing computed: the site voids it when it runs out
                    }
                    let hits: Vec<u32> = l.hits[..done].iter().map(|h| h.load(SeqCst)).collect();
                    let h2 = hits.clone();
                    let lv = tokio::task::spawn_blocking(move || merkle(&h2)).await.map_err(|x| x.to_string())?;
                    let root = to_hex(&lv.last().unwrap()[0]);
                    tx.send(Message::text(json!({"type": "commit", "id": l.id, "done": done, "root": root}).to_string())).await.map_err(|x| x.to_string())?;
                    committed = Some((l.id.clone(), hits, lv));
                }
                continue;
            }
        };
        let Some(Ok(m)) = m else { return Err("closed".into()) };
        let Ok(v) = serde_json::from_str::<Value>(m.to_text().unwrap_or("")) else { continue };
        match v["type"].as_str() {
            Some("challenge") => {
                let seeds: Vec<u32> = v["cpu"]["seeds"].as_array().map(|a| a.iter().map(|s| s.as_i64().unwrap_or(0) as u32).collect()).unwrap_or_default();
                let n = v["cpu"]["n"].as_u64().unwrap_or(0) as u32;
                let k = e.settings.lock().unwrap().cores.max(1) as usize;
                let out = tokio::task::spawn_blocking(move || answer_cpu(&seeds, n, k)).await.unwrap_or_default();
                let answer = json!({"type": "answer", "id": v["id"], "cpu": out, "gpu": Value::Null});
                tx.send(Message::text(answer.to_string())).await.map_err(|x| x.to_string())?;
            }
            Some("verdict") => *e.verdict.lock().unwrap() = Some(v),
            Some("job") => {
                let (st2, jt, e2) = (st.clone(), job_tx.clone(), e.clone());
                let cores = e.settings.lock().unwrap().cores;
                e2.jobs.fetch_add(1, SeqCst);
                tokio::spawn(async move {
                    let a = run_job(st2, v, cores).await;
                    e2.jobs.fetch_sub(1, SeqCst);
                    let _ = jt.send(a);
                });
            }
            Some("lease") => {
                let count = v["count"].as_u64().unwrap_or(0).min(1 << 20) as u32;
                let n = v["n"].as_u64().unwrap_or(0).min(1 << 30) as u32;
                if count > 0 && n > 0 {
                    *e.lease.lock().unwrap() = Some(Arc::new(Lease {
                        id: v["id"].as_str().unwrap_or("").to_string(), base: v["base"].as_u64().unwrap_or(0) as u32, n, count,
                        lease_s: v["lease_s"].as_u64().unwrap_or(600), got: Instant::now(), next: AtomicU32::new(0),
                        inflight: AtomicU32::new(0), closing: AtomicBool::new(false), hits: (0..count).map(|_| AtomicU32::new(0)).collect(),
                    }));
                }
            }
            Some("audit") => {
                if let Some((id, hits, lv)) = committed.as_ref().filter(|c| v["id"].as_str() == Some(c.0.as_str())) {
                    let items: Vec<Value> = v["idx"].as_array().map(|a| a.iter().filter_map(|i| i.as_u64()).map(|i| i as usize)
                        .filter(|i| *i < hits.len()).map(|i| json!({"i": i, "hits": hits[i], "path": merkle_path(lv, i)})).collect()).unwrap_or_default();
                    tx.send(Message::text(json!({"type": "proof", "id": id, "items": items}).to_string())).await.map_err(|x| x.to_string())?;
                }
            }
            Some("audit_result") => {
                {
                    let mut l = e.lease.lock().unwrap();
                    if l.as_ref().is_some_and(|x| v["id"].as_str() == Some(x.id.as_str())) {
                        *l = None;
                    }
                }
                committed = None;
                *e.audit.lock().unwrap() = Some(v);
            }
            _ => {}
        }
    }
}

/// The CPU part of a capacity check: pc_mc_pi for every seed, on k threads, answers in seed order.
fn answer_cpu(seeds: &[u32], n: u32, k: usize) -> Vec<u32> {
    let mut out = vec![0u32; seeds.len()];
    std::thread::scope(|sc| {
        for (chunk_out, chunk_in) in out.chunks_mut(seeds.len().div_ceil(k).max(1)).zip(seeds.chunks(seeds.len().div_ceil(k).max(1))) {
            sc.spawn(move || {
                for (o, s) in chunk_out.iter_mut().zip(chunk_in) {
                    *o = mc_pi(*s, n);
                }
            });
        }
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    // docs/TESTING.md test 106 (user 2026-11-01): sharing runs only while signed in; signing out halts it at once and
    // signing in again resumes it (when it was switched on)
    #[test]
    fn sharing_only_while_signed_in() {
        let args: Vec<String> = ["--contribute", "--cores", "1"].iter().map(|x| x.to_string()).collect();
        let e = Engine::build(&args); // not new(): that would save "I agree" into this computer's settings
        e.apply();
        std::thread::sleep(Duration::from_millis(800));
        assert!(!e.running() && e.packs.load(SeqCst) == 0, "signed out: nothing is computed");
        e.set_signed_in(true);
        let t = Instant::now();
        while e.packs.load(SeqCst) == 0 && t.elapsed() < Duration::from_secs(30) {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(e.running() && e.packs.load(SeqCst) > 0, "signed in: it computes");
        e.set_signed_in(false);
        assert!(!e.running(), "signed out: stopped at once");
        std::thread::sleep(Duration::from_secs(3)); // a pack already started may finish
        let p1 = e.packs.load(SeqCst);
        std::thread::sleep(Duration::from_secs(3));
        assert_eq!(e.packs.load(SeqCst), p1, "signed out: no more packs");
        assert_eq!(e.status()["signed_in"].as_bool(), Some(false));
        e.set_signed_in(true);
        let t = Instant::now();
        while e.packs.load(SeqCst) == p1 && t.elapsed() < Duration::from_secs(30) {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(e.packs.load(SeqCst) > p1, "signed in again: it resumes");
        e.set_signed_in(false);
    }
    // Values from worker.js cpuChunkHits (the server's own check), computed in Node.
    #[test]
    fn matches_the_server() {
        for (seed, n, hits) in TEST_VECTORS {
            assert_eq!(mc_pi(*seed, *n), *hits, "seed {seed}");
        }
    }
    include!("mc_pi_vectors.rs");
    // Values from worker.js leaseSeed / cpuChunkHits and the tree of scripts/test_work_audit.mjs, computed in Node.
    #[test]
    fn leases_match_the_server() {
        let want = [3816608188u32, 74866922, 1618129884, 2594944647, 3577737318];
        for (k, i) in [0u32, 1, 2, 1000, 262143].iter().enumerate() {
            assert_eq!(lease_seed(0x1234_5678, *i), want[k], "pack {i}");
        }
        let hits: Vec<u32> = (0..3).map(|i| mc_pi(lease_seed(0x1234_5678, i), 100_000)).collect();
        assert_eq!(hits, vec![78640, 78452, 78504]);
        let lv = merkle(&hits);
        assert_eq!(to_hex(&lv.last().unwrap()[0]), "c0ff01b939127ed9860ba714d28e3c53ef6c770c694fce6d3455c747b6684fed");
        assert_eq!(merkle_path(&lv, 2).len(), 2);
        assert_eq!(merkle(&[7]).len(), 1); // one pack: the root is its leaf
    }
}
