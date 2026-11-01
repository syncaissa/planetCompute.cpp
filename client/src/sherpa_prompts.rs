// Batches of WHOLE prompts led by a SherpaHub (docs/SHERPAHUB.md section 11; admin tab SherpaHubs). Each prompt goes
// whole to a program that has the model (chat: llama.cpp, image: the picture engine); a share of them (check_pct) is
// also run on a SECOND computer with the same seed and the two answers are compared (chat: same text; picture: mean
// difference of a 32 x 32 grey thumbnail). The SherpaHub tells its room on the site every step, so the admin tab
// shows where each prompt went. Like workpack::hub this is a pure state machine: time is passed in (ms).
//
// Wire (PCWP kinds 5-7, after the 8-byte header: u32 length of a JSON header, the JSON, then bytes):
//   5 TASK         hub -> device   {task_id, job, n, task, model, prompt, params}
//   6 TASK_RESULT  device -> hub   {task_id, ok, error, ms, text, part, parts, ext} + bytes of the picture (in parts)
//   7 STORE        hub -> room     {job, n, copy, part, parts, ext} + bytes (a result file for the job log, kept in B2)
//   8 PROGRESS     device -> hub   {task_id, job, n, copy, state, step, steps} every 30 s while a picture is made
//   9 CANCEL       hub -> device   {job, n, copy}: another computer delivered it first, stop making it
// Older programs ignore kinds 8 and 9 (a hub without PROGRESS keeps the fixed limits; a device without CANCEL
// finishes the picture and its late answer is dropped).
//
// Time limits (Watch, the same rule on the hub and on the device; incident 2026-10-30: a 1920 x 1088 picture on 4 busy
// cores needed ~3 h, was cut at the fixed 3 h twice and restarted from zero on the same computer): a picture is given
// up only when its progress stops (no new step for max(30 min, 3 x its slowest step)), or after 12 h (video 24 h).
// Before its first step is reported (an older device, or the model still loading) the old fixed limits hold.
// A prompt given up this way stays with its computer (a late answer still counts) while it goes to ANOTHER computer.

use serde_json::{json, Value};
use std::collections::HashMap;
use workpack::hub::DevId;

pub const KIND_TASK: u8 = 5;
pub const KIND_TASK_RESULT: u8 = 6;
pub const KIND_STORE: u8 = 7;
pub const KIND_PROGRESS: u8 = 8;
pub const KIND_CANCEL: u8 = 9;
/// Bytes of a file per message (the broker carries 1 MiB).
pub const PART: usize = 900 * 1024;
const MAGIC: u32 = 0x5057_4350;
/// Tries per prompt (each on another computer where possible), and per check copy.
const TRIES: u8 = 3;
const CHECK_TRIES: u8 = 2;
/// A check that no second computer can make (only one has the model) is given up after this long (ms).
const LONELY_MS: u64 = 120_000;
/// A device whose connection dropped (a site deploy drops every WebSocket) keeps its prompt this long: when it
/// connects again it says what it is still making, and the hub does not give that prompt to anyone else (ms).
const ORPHAN_MS: u64 = 120_000;
/// Mean grey difference (of 255) up to which two pictures of the same prompt and seed count as the same.
pub const IMAGE_AGREE: f64 = 8.0;
/// A picture whose steps are coming is given up when no new step came for max(STALL_MS, 3 x its slowest step) (ms).
const STALL_MS: u64 = 30 * 60_000;
/// A prompt that went to another computer after its first one stopped answering goes back to that first one only when
/// no other computer took it for this long (ms): otherwise a job whose model only one computer has would wait forever.
const SAME_AGAIN_MS: u64 = 10 * 60_000;

/// How long a task may take: fixed until it reports its first step, then as long as its steps keep coming.
#[derive(Clone, Debug)]
pub struct Watch {
    pub issued: u64,
    /// the last time the reported (state, step) changed
    seen: u64,
    /// the longest wait between two changes since the first step (the first one includes the model loading)
    gap: u64,
    moved: bool,
    mark: (String, u64),
}

impl Watch {
    pub fn new(now: u64) -> Watch {
        Watch { issued: now, seen: now, gap: 0, moved: false, mark: (String::new(), 0) }
    }
    /// A progress report: the engine's state (loading, sampling, decoding) and the sampling step reached.
    pub fn see(&mut self, now: u64, state: &str, step: u64) {
        if self.mark.0 == state && self.mark.1 == step {
            return;
        }
        self.mark = (state.to_string(), step);
        if self.moved {
            self.gap = self.gap.max(now.saturating_sub(self.seen));
        } else if step >= 1 {
            self.moved = true;
            self.gap = now.saturating_sub(self.issued);
        }
        self.seen = now;
    }
    /// The hard limit: past it a task is given up whatever its progress (chat: twice its fixed limit).
    pub fn past_cap(&self, task: &str, now: u64) -> Option<String> {
        let (cap, what) = match task {
            "image" => (12 * 3_600_000, "12 hours"),
            "video" => (24 * 3_600_000, "24 hours"),
            _ => (30 * 60_000, "30 minutes"),
        };
        (now.saturating_sub(self.issued) > cap).then(|| format!("not done after {what}"))
    }
    /// Why a task of this kind (chat, image, video) is given up now, if it is.
    pub fn overdue(&self, task: &str, now: u64) -> Option<String> {
        if let Some(why) = self.past_cap(task, now) {
            return Some(why);
        }
        // the fixed limits: a picture on a few shared cores can take most of an hour (17 min on 9 cores of the
        // interserver); chat reports no steps, so its fixed limit is all
        let base = match task { "image" => 180 * 60_000, "video" => 360 * 60_000, _ => 15 * 60_000 };
        let allowed = if self.moved { STALL_MS.max(3 * self.gap) } else { base };
        (now.saturating_sub(self.seen) > allowed).then(|| {
            if self.moved { format!("no progress for {} minutes", allowed / 60_000) } else { "no answer in time".to_string() }
        })
    }
}

pub fn frame(kind: u8, meta: &Value, bytes: &[u8]) -> Vec<u8> {
    let j = meta.to_string().into_bytes();
    let mut v = Vec::with_capacity(12 + j.len() + bytes.len());
    v.extend_from_slice(&MAGIC.to_le_bytes());
    v.extend_from_slice(&[kind, 1, 0, 0]);
    v.extend_from_slice(&(j.len() as u32).to_le_bytes());
    v.extend_from_slice(&j);
    v.extend_from_slice(bytes);
    v
}

/// (kind, JSON header, bytes) of a kind 5-7 message; None if it does not add up.
pub fn parse(b: &[u8]) -> Option<(u8, Value, &[u8])> {
    if b.len() < 12 || u32::from_le_bytes(b[..4].try_into().ok()?) != MAGIC || b[5] != 1 || !(KIND_TASK..=KIND_CANCEL).contains(&b[4]) {
        return None;
    }
    let jl = u32::from_le_bytes(b[8..12].try_into().ok()?) as usize;
    if jl > 64 * 1024 || 12 + jl > b.len() {
        return None;
    }
    let v: Value = serde_json::from_slice(&b[12..12 + jl]).ok()?;
    Some((b[4], v, &b[12 + jl..]))
}

/// A file cut into messages of at most PART bytes, each with `meta` + part / parts.
pub fn parts(kind: u8, meta: &Value, bytes: &[u8]) -> Vec<Vec<u8>> {
    let chunks: Vec<&[u8]> = if bytes.is_empty() { vec![&[][..]] } else { bytes.chunks(PART).collect() };
    let n = chunks.len();
    chunks
        .into_iter()
        .enumerate()
        .map(|(i, c)| {
            let mut m = meta.clone();
            m["part"] = json!(i);
            m["parts"] = json!(n);
            frame(kind, &m, c)
        })
        .collect()
}

/// What the SherpaHub must do after a call.
#[derive(Debug, Clone, PartialEq)]
pub enum Act {
    /// To a device (a TASK).
    Dev(DevId, Vec<u8>),
    /// A JSON line for the room (the job log).
    Room(Value),
    /// A STORE message for the room (send as a frame to device 0).
    File(Vec<u8>),
}

#[derive(Clone)]
struct Res {
    dev: DevId,
    text: String,
    file: Vec<u8>,
    /// Who made it (account:device from the broker): a check copy never comes from the same owner (security review P1).
    owner: String,
}

struct Item {
    prompt: String,
    check: bool,
    main: Option<Res>,
    chk: Option<Res>,
    chk_done: bool,
    fails: u8,
    chk_fails: u8,
    failed: bool,
    tried: Vec<DevId>,
    /// Devices that ran out of time on this prompt: it goes to them again only after SAME_AGAIN_MS with nobody else.
    slow: Vec<DevId>,
    /// Since when this prompt waits with no computer making it (after a computer ran out of time).
    waiting: Option<u64>,
}

struct Task {
    n: usize,
    dev: DevId,
    copy: u8,
    watch: Watch,
    /// The device left at this time (it may come back with the prompt still being made).
    orphan: Option<u64>,
    /// It ran out of time and the prompt went to another computer, but this one may still deliver it (late answers
    /// count; the first answer wins and the other computer is told to stop).
    late: bool,
    /// The account:device it was given to (from the broker, which knows the device's sign-in): after a reconnect only
    /// the same owner may take it back or answer it (security review P1).
    owner: String,
}

impl Task {
    fn new(n: usize, dev: DevId, copy: u8, now: u64, owner: String) -> Task {
        Task { n, dev, copy, watch: Watch::new(now), orphan: None, late: false, owner }
    }
}

/// After the hub (re)starts, devices may say what they were already making for this many ms; later, a prompt is
/// answered only by the device it was given to (security review P1).
const ADOPT_GRACE_MS: u64 = 5 * 60 * 1000;
/// Answer parts held at once for all tasks, bytes (security review P1: a device cannot fill the hub's memory).
const GOT_MAX_BYTES: usize = 256 << 20;

pub struct PromptRun {
    pub id: String,
    pub task: String,
    pub model: String,
    params: Value,
    items: Vec<Item>,
    tasks: HashMap<u64, Task>,
    next: u64,
    got: HashMap<u64, (Value, Vec<Option<Vec<u8>>>)>,
    lonely_since: Option<u64>,
    /// account:device of each connected device, from the broker's hello
    owners: HashMap<DevId, String>,
    /// when this run first saw the clock (the start of the adopt grace)
    started: Option<u64>,
}

impl PromptRun {
    /// From the room's job message: {id, task, model, params, check_pct, prompts, done}.
    pub fn new(v: &Value) -> Option<PromptRun> {
        let id = v["id"].as_str()?.to_string();
        let prompts: Vec<String> = v["prompts"].as_array()?.iter().filter_map(|p| p.as_str().map(String::from)).collect();
        if prompts.is_empty() {
            return None;
        }
        let pct = v["check_pct"].as_u64().unwrap_or(0).min(100);
        let done: Vec<u64> = v["done"].as_array().map(|a| a.iter().filter_map(|x| x.as_u64()).collect()).unwrap_or_default();
        let total = prompts.len();
        let mut items: Vec<Item> = prompts
            .into_iter()
            .enumerate()
            .map(|(n, prompt)| Item {
                prompt,
                // the same prompts are checked after a restart: chosen from the job ID and the position
                check: pct > 0 && (fnv(&format!("{id}:{n}")) % 100) < pct,
                main: None,
                chk: None,
                chk_done: false,
                fails: 0,
                chk_fails: 0,
                failed: false,
                tried: vec![],
                slow: vec![],
                waiting: None,
            })
            .collect();
        if pct > 0 && !items.iter().any(|i| i.check) && total > 0 {
            items[0].check = true; // a check was asked for: at least one
        }
        for n in done {
            if let Some(it) = items.get_mut(n as usize) {
                // done before a restart (its result is in the room's log already): nothing more to do for it
                it.main = Some(Res { dev: 0, text: String::new(), file: vec![], owner: String::new() });
                it.chk_done = true;
            }
        }
        Some(PromptRun {
            id,
            task: v["task"].as_str().unwrap_or("chat").to_string(),
            model: v["model"].as_str().unwrap_or("").to_string(),
            params: v["params"].clone(),
            items,
            tasks: HashMap::new(),
            next: 1,
            got: HashMap::new(),
            lonely_since: None,
            owners: HashMap::new(),
            started: None,
        })
    }

    pub fn total(&self) -> usize {
        self.items.len()
    }
    /// The broker's account:device for this connection (empty from an old broker: the connection is its own owner).
    pub fn set_owner(&mut self, dev: DevId, owner: &str) {
        if !owner.is_empty() {
            self.owners.insert(dev, owner.to_string());
        }
    }
    fn owner(&self, dev: DevId) -> String {
        self.owners.get(&dev).cloned().unwrap_or_else(|| format!("dev:{dev}"))
    }
    fn main_owner(&self, n: usize) -> Option<String> {
        self.items[n].main.as_ref().map(|r| r.owner.clone()).or_else(|| self.tasks.values().find(|t| t.n == n && t.copy == 0).map(|t| t.owner.clone()))
    }
    pub fn done(&self) -> usize {
        self.items.iter().filter(|i| i.main.is_some() || i.failed).count()
    }
    pub fn busy(&self, dev: DevId) -> bool {
        self.tasks.values().any(|t| t.dev == dev && t.orphan.is_none())
    }
    /// Every prompt done or failed, and every check made or given up.
    pub fn finished(&self) -> bool {
        self.items.iter().all(|i| (i.main.is_some() || i.failed) && (!i.check || i.chk_done || i.failed))
    }
    /// Prompts (or checks) still wait for a computer.
    pub fn wants_devices(&self) -> bool {
        !self.finished()
    }

    fn main_dev(&self, n: usize) -> Option<DevId> {
        self.items[n].main.as_ref().map(|r| r.dev).or_else(|| self.tasks.values().find(|t| t.n == n && t.copy == 0).map(|t| t.dev))
    }
    /// A computer is making this copy in time (a late one does not count: the copy may go to another computer).
    fn out(&self, n: usize, copy: u8) -> bool {
        self.tasks.values().any(|t| t.n == n && t.copy == copy && !t.late)
    }
    /// The prompt still needs its main answer and may be given to `dev` now.
    fn may_give(&self, now: u64, n: usize, dev: DevId) -> bool {
        let it = &self.items[n];
        it.main.is_none() && !it.failed && it.fails < TRIES && !self.out(n, 0)
            && (!it.slow.contains(&dev) || it.waiting.is_some_and(|w| now.saturating_sub(w) > SAME_AGAIN_MS))
    }

    /// Give every idle device (it has the model, no task) a prompt or a check copy.
    pub fn assign(&mut self, now: u64, idle: &[DevId]) -> Vec<Act> {
        let mut acts = Vec::new();
        for &dev in idle {
            if self.busy(dev) {
                continue;
            }
            // first a prompt nobody has (preferring one this device has not failed), then a check copy
            let mut pick: Option<(usize, u8)> = None;
            for n in 0..self.items.len() {
                if self.may_give(now, n, dev) && !self.items[n].tried.contains(&dev) {
                    pick = Some((n, 0));
                    break;
                }
            }
            if pick.is_none() {
                for n in 0..self.items.len() {
                    if self.may_give(now, n, dev) {
                        pick = Some((n, 0));
                        break;
                    }
                }
            }
            if pick.is_none() {
                for n in 0..self.items.len() {
                    let it = &self.items[n];
                    if it.check && !it.chk_done && !it.failed && it.chk.is_none() && it.chk_fails < CHECK_TRIES && !self.out(n, 1) && self.main_dev(n).is_some_and(|d| d != dev && d != 0)
                        && self.main_owner(n).is_none_or(|o| o != self.owner(dev)) {
                        pick = Some((n, 1));
                        break;
                    }
                }
            }
            let Some((n, copy)) = pick else { continue };
            let tid = self.next;
            self.next += 1;
            let mut params = self.params.clone();
            // each prompt its own seed (seed + position); both copies of one prompt the same seed, to compare them
            let seed = params["seed"].as_i64().unwrap_or(0) + n as i64;
            params["seed"] = json!(seed);
            let meta = json!({"task_id": tid, "job": self.id, "n": n, "copy": copy, "task": self.task, "model": self.model, "prompt": self.items[n].prompt, "params": params});
            let owner = self.owner(dev);
            self.tasks.insert(tid, Task::new(n, dev, copy, now, owner));
            if copy == 0 {
                self.items[n].tried.push(dev);
                self.items[n].waiting = None;
            }
            acts.push(Act::Dev(dev, frame(KIND_TASK, &meta, &[])));
            acts.push(Act::Room(json!({"t": "tsent", "job": self.id, "n": n, "dev": dev, "copy": copy})));
        }
        acts
    }

    /// The device left: its task is kept ORPHAN_MS for it to come back (then it goes back; not a failure).
    pub fn on_gone(&mut self, now: u64, dev: DevId) {
        let gone: Vec<u64> = self.tasks.iter().filter(|(_, t)| t.dev == dev && t.orphan.is_none()).map(|(k, _)| *k).collect();
        for k in gone {
            self.tasks.get_mut(&k).unwrap().orphan = Some(now);
            self.got.remove(&k); // a part-sent answer is sent again whole
        }
    }

    /// A device (re)connected and says what it is still making ([(job, n, copy)]): those prompts stay its own.
    pub fn adopt(&mut self, now: u64, dev: DevId, busy: &[(String, usize, u8)]) {
        let started = *self.started.get_or_insert(now);
        let me = self.owner(dev);
        for (job, n, copy) in busy {
            if *job != self.id || *n >= self.items.len() || *copy > 1 {
                continue;
            }
            // the task of the connection that dropped (two may be out for one prompt when one ran late): only the same
            // owner (account and device) takes it back, never another computer (security review P1)
            let mine = self.tasks.iter().filter(|(_, t)| t.n == *n && t.copy == *copy && t.owner == me && (t.orphan.is_some() || t.dev == dev))
                .min_by_key(|(_, t)| t.orphan.is_none()).map(|(k, _)| *k);
            if let Some(k) = mine {
                let t = self.tasks.get_mut(&k).unwrap();
                t.dev = dev;
                t.orphan = None;
                continue;
            }
            // a prompt this hub does not know as given (the hub restarted): accepted only just after the start, only if
            // nobody has it, and a check copy never by the owner of the main answer
            let it = &self.items[*n];
            let needed = if *copy == 0 { it.main.is_none() && !it.failed } else { it.check && !it.chk_done && it.chk.is_none() };
            let other = self.tasks.values().any(|t| t.n == *n && t.copy == *copy);
            let same_owner_check = *copy == 1 && self.main_owner(*n).is_some_and(|o| o == me);
            if needed && !other && !same_owner_check && now.saturating_sub(started) < ADOPT_GRACE_MS {
                let tid = self.next;
                self.next += 1;
                self.tasks.insert(tid, Task::new(*n, dev, *copy, now, me.clone()));
            }
        }
    }

    /// A TASK_RESULT message (one part of it).
    pub fn on_result(&mut self, _now: u64, dev: DevId, meta: &Value, bytes: &[u8]) -> Vec<Act> {
        let mut tid = meta["task_id"].as_u64().unwrap_or(0);
        // an answer from a device that reconnected (new device ID, maybe an older task number): found by its prompt
        if self.tasks.get(&tid).is_none_or(|t| t.dev != dev) {
            let (job, n, copy) = (meta["job"].as_str().unwrap_or(""), meta["n"].as_u64().unwrap_or(u64::MAX) as usize, meta["copy"].as_u64().unwrap_or(0).min(1) as u8);
            if job != self.id || n >= self.items.len() {
                return vec![];
            }
            // its own task (under another number) or the task of its own connection that dropped (same owner: account
            // and device); never another computer's, and never a prompt nobody gave it (security review P1)
            let me = self.owner(dev);
            let mine = self.tasks.iter().filter(|(_, t)| t.n == n && t.copy == copy && (t.dev == dev || (t.orphan.is_some() && t.owner == me)))
                .min_by_key(|(_, t)| t.dev != dev).map(|(k, _)| *k);
            match mine {
                Some(k) => tid = k,
                None => return vec![],
            }
            let t = self.tasks.get_mut(&tid).unwrap();
            if t.dev != dev {
                self.got.remove(&tid);
            }
            t.dev = dev;
            t.orphan = None;
        }
        let parts = meta["parts"].as_u64().unwrap_or(1).clamp(1, 64) as usize;
        let part = meta["part"].as_u64().unwrap_or(0) as usize;
        if part >= parts {
            return vec![];
        }
        // all answer parts held at once stay under GOT_MAX_BYTES (security review P1)
        let held: usize = self.got.values().map(|(_, ps)| ps.iter().flatten().map(|p| p.len()).sum::<usize>()).sum();
        if held + bytes.len() > GOT_MAX_BYTES {
            self.got.remove(&tid);
            return vec![];
        }
        let e = self.got.entry(tid).or_insert_with(|| (meta.clone(), vec![None; parts]));
        if e.1.len() != parts {
            return vec![];
        }
        e.1[part] = Some(bytes.to_vec());
        if e.1.iter().any(|p| p.is_none()) {
            return vec![];
        }
        let (meta, ps) = self.got.remove(&tid).unwrap();
        let file: Vec<u8> = ps.into_iter().flatten().flatten().collect();
        let t = self.tasks.remove(&tid).unwrap();
        self.finish(t, &meta, file)
    }

    /// A progress report (PROGRESS) of a picture being made: its time limit follows its steps (Watch).
    pub fn on_progress(&mut self, now: u64, dev: DevId, meta: &Value) {
        if meta["job"].as_str() != Some(self.id.as_str()) {
            return;
        }
        let tid = meta["task_id"].as_u64().unwrap_or(0);
        let (n, copy) = (meta["n"].as_u64().unwrap_or(u64::MAX) as usize, meta["copy"].as_u64().unwrap_or(0).min(1) as u8);
        let k = if self.tasks.get(&tid).is_some_and(|t| t.dev == dev) {
            Some(tid)
        } else {
            self.tasks.iter().find(|(_, t)| t.n == n && t.copy == copy && t.dev == dev).map(|(k, _)| *k)
        };
        if let Some(t) = k.and_then(|k| self.tasks.get_mut(&k)) {
            t.watch.see(now, meta["state"].as_str().unwrap_or(""), meta["step"].as_u64().unwrap_or(0));
        }
    }

    fn finish(&mut self, t: Task, meta: &Value, file: Vec<u8>) -> Vec<Act> {
        let (n, copy) = (t.n, t.copy);
        let media = self.task == "image" || self.task == "video";
        let ok = meta["ok"].as_bool() == Some(true) && (!media || !file.is_empty());
        let ms = meta["ms"].as_u64().unwrap_or(0);
        let text: String = meta["text"].as_str().unwrap_or("").chars().take(8000).collect();
        let error: String = if ok { String::new() } else { meta["error"].as_str().unwrap_or("no result").chars().take(300).collect() };
        let mut acts = Vec::new();
        // another computer still making this copy (t itself is out of the table already)
        let others = self.tasks.values().any(|x| x.n == n && x.copy == copy);
        let it = &mut self.items[n];
        // a late task's failure was counted when it ran out of time
        if !ok && !t.late {
            if copy == 0 {
                it.fails += 1;
            } else {
                it.chk_fails += 1;
            }
        }
        if !ok && copy == 0 && timed_out(&error) && !it.slow.contains(&t.dev) {
            it.slow.push(t.dev);
        }
        let fin = !ok && !others && (if copy == 0 { it.fails >= TRIES } else { it.chk_fails >= CHECK_TRIES });
        if !ok && copy == 0 && fin {
            it.failed = true;
        }
        if !ok && copy == 1 && fin {
            it.chk_done = true;
        }
        // a late answer for a prompt already done (a copy that timed out but still came): kept out of the log
        if ok && ((copy == 0 && it.main.is_some()) || (copy == 1 && it.chk.is_some())) {
            return acts;
        }
        let mut line = json!({"t": "tresult", "job": self.id, "n": n, "dev": t.dev, "copy": copy, "ok": ok, "ms": ms, "final": fin});
        if !text.is_empty() {
            line["text"] = json!(text);
        }
        if !ok {
            line["error"] = json!(error);
        }
        acts.push(Act::Room(line));
        if ok {
            if !file.is_empty() {
                let ext = if meta["ext"].as_str() == Some("webm") { "webm" } else { "png" };
                for f in parts(KIND_STORE, &json!({"job": self.id, "n": n, "copy": copy, "ext": ext}), &file) {
                    acts.push(Act::File(f));
                }
            }
            let r = Res { dev: t.dev, text, file, owner: t.owner.clone() };
            if copy == 0 {
                it.main = Some(r);
            } else {
                it.chk = Some(r);
            }
            if let (Some(a), Some(b)) = (&it.main, &it.chk) {
                let (agree, diff, note) = compare(&self.task, a, b);
                it.chk_done = true;
                // the pictures are not needed any more (they are in B2 through the room)
                it.main.as_mut().unwrap().file = vec![];
                it.chk.as_mut().unwrap().file = vec![];
                acts.push(Act::Room(json!({"t": "tcheck", "job": self.id, "n": n, "agree": agree, "diff": diff, "note": note})));
            } else if copy == 0 && !it.check {
                it.main.as_mut().unwrap().file = vec![];
            }
            // another computer making the same copy (one ran late, the prompt went to both): told to stop
            let rest: Vec<u64> = self.tasks.iter().filter(|(_, x)| x.n == n && x.copy == copy).map(|(k, _)| *k).collect();
            for k in rest {
                let x = self.tasks.remove(&k).unwrap();
                self.got.remove(&k);
                if x.orphan.is_none() {
                    acts.push(Act::Dev(x.dev, frame(KIND_CANCEL, &json!({"job": self.id, "n": n, "copy": copy}), &[])));
                }
            }
        }
        acts
    }

    /// Time passes: tasks out of time go to another computer too (Watch); checks no second computer can make are given up.
    pub fn tick(&mut self, now: u64) -> Vec<Act> {
        let mut acts = Vec::new();
        // devices that did not come back for their prompt: it goes back to waiting (not a failure)
        let lost: Vec<u64> = self.tasks.iter().filter(|(_, t)| t.orphan.is_some_and(|o| now.saturating_sub(o) > ORPHAN_MS)).map(|(k, _)| *k).collect();
        for k in lost {
            self.tasks.remove(&k);
            self.got.remove(&k);
        }
        // out of time: the first time it stays with its computer (late) and the prompt is free for another one; a late
        // task past the hard limit is let go
        let due: Vec<(u64, String, bool)> = self.tasks.iter().filter_map(|(k, t)| {
            let cap = t.watch.past_cap(&self.task, now);
            if t.late { cap.map(|why| (*k, why, true)) } else { t.watch.overdue(&self.task, now).map(|why| (*k, why, cap.is_some())) }
        }).collect();
        for (k, why, end) in due {
            if end {
                let t = self.tasks.remove(&k).unwrap();
                self.got.remove(&k);
                acts.extend(self.finish(t, &json!({"ok": false, "error": why}), vec![]));
                continue;
            }
            let t = self.tasks.get_mut(&k).unwrap();
            t.late = true;
            let (n, copy, dev) = (t.n, t.copy, t.dev);
            let it = &mut self.items[n];
            if copy == 0 {
                it.fails += 1;
                if !it.slow.contains(&dev) {
                    it.slow.push(dev);
                }
            } else {
                it.chk_fails += 1;
            }
            acts.push(Act::Room(json!({"t": "tresult", "job": self.id, "n": n, "dev": dev, "copy": copy, "ok": false, "final": false,
                "error": format!("{why}: also given to another computer (this one may still finish it)")})));
        }
        // a prompt whose tries are used up, with no computer making it any more, has failed (its last computer left)
        for n in 0..self.items.len() {
            let (main_out, chk_out) = (self.tasks.values().any(|t| t.n == n && t.copy == 0), self.tasks.values().any(|t| t.n == n && t.copy == 1));
            let it = &mut self.items[n];
            if it.main.is_none() && !it.failed && !main_out && it.fails >= TRIES {
                it.failed = true;
                acts.push(Act::Room(json!({"t": "tresult", "job": self.id, "n": n, "dev": 0, "copy": 0, "ok": false, "final": true, "error": "no computer finished it"})));
            }
            if it.check && !it.chk_done && !it.failed && it.chk.is_none() && !chk_out && it.chk_fails >= CHECK_TRIES {
                it.chk_done = true;
                acts.push(Act::Room(json!({"t": "tresult", "job": self.id, "n": n, "dev": 0, "copy": 1, "ok": false, "final": true, "error": "no computer finished the check"})));
            }
            // waiting for a computer after one ran out of time (SAME_AGAIN_MS)
            let free = it.main.is_none() && !it.failed && !self.tasks.values().any(|t| t.n == n && t.copy == 0 && !t.late);
            if !free || it.slow.is_empty() {
                it.waiting = None;
            } else if it.waiting.is_none() {
                it.waiting = Some(now);
            }
        }
        let only_checks = self.items.iter().all(|i| i.main.is_some() || i.failed) && !self.finished() && self.tasks.is_empty();
        if only_checks {
            let since = *self.lonely_since.get_or_insert(now);
            if now.saturating_sub(since) > LONELY_MS {
                for n in 0..self.items.len() {
                    let it = &mut self.items[n];
                    if it.check && !it.chk_done && !it.failed {
                        it.chk_done = true;
                        acts.push(Act::Room(json!({"t": "tresult", "job": self.id, "n": n, "dev": 0, "copy": 1, "ok": false, "final": true,
                            "error": "no second computer with this model to check it"})));
                    }
                }
            }
        } else {
            self.lonely_since = None;
        }
        acts
    }
}

/// An error that means "too slow" (from Watch, on the hub or the device; "it took more than" from older programs).
fn timed_out(error: &str) -> bool {
    ["no answer in time", "no progress for", "not done after", "it took more than"].iter().any(|p| error.starts_with(p))
}

fn fnv(s: &str) -> u64 {
    s.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100_0000_01b3))
}

/// (agree, difference, note) of two answers to the same prompt with the same seed.
fn compare(task: &str, a: &Res, b: &Res) -> (bool, f64, String) {
    if task == "video" {
        return (a.file.len() == b.file.len(), 0.0, "videos are not compared yet (sizes only)".into());
    }
    if task != "image" {
        let same = a.text == b.text;
        return (same, if same { 0.0 } else { 1.0 }, if same { "same text".into() } else { format!("different text ({} and {} characters)", a.text.chars().count(), b.text.chars().count()) });
    }
    match (grey32(&a.file), grey32(&b.file)) {
        (Some(x), Some(y)) => {
            let d = x.iter().zip(&y).map(|(p, q)| (*p as f64 - *q as f64).abs()).sum::<f64>() / x.len() as f64;
            let d = (d * 10.0).round() / 10.0;
            (d <= IMAGE_AGREE, d, format!("mean difference {d} of 255 (same up to {IMAGE_AGREE})"))
        }
        _ => (false, 255.0, "a picture could not be read".into()),
    }
}

/// A 32 x 32 grey thumbnail of a PNG (8-bit grey, grey + alpha, RGB or RGBA), by averaging blocks.
pub fn grey32(png_bytes: &[u8]) -> Option<Vec<u8>> {
    let mut r = png::Decoder::new(std::io::Cursor::new(png_bytes)).read_info().ok()?;
    let mut buf = vec![0; r.output_buffer_size()?];
    let info = r.next_frame(&mut buf).ok()?;
    if info.bit_depth != png::BitDepth::Eight {
        return None;
    }
    let (w, h) = (info.width as usize, info.height as usize);
    let ch = match info.color_type {
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        _ => return None,
    };
    if w < 32 || h < 32 {
        return None;
    }
    let mut sum = vec![0f64; 32 * 32];
    let mut cnt = vec![0f64; 32 * 32];
    for y in 0..h {
        let row = &buf[y * info.line_size..];
        for x in 0..w {
            let p = &row[x * ch..x * ch + ch];
            let g = if ch >= 3 { 0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64 } else { p[0] as f64 };
            let k = (y * 32 / h) * 32 + x * 32 / w;
            sum[k] += g;
            cnt[k] += 1.0;
        }
    }
    Some(sum.iter().zip(&cnt).map(|(s, c)| (s / c.max(1.0)).round() as u8).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(n: usize, pct: u64) -> Value {
        json!({"id": "00000000000000aa", "task": "chat", "model": "m", "params": {"seed": 5, "max_tokens": 16}, "check_pct": pct,
               "prompts": (0..n).map(|i| format!("p{i}")).collect::<Vec<_>>(), "done": []})
    }
    fn tasks(acts: &[Act]) -> Vec<(DevId, Value)> {
        acts.iter().filter_map(|a| if let Act::Dev(d, b) = a { parse(b).map(|(_, m, _)| (*d, m)) } else { None }).collect()
    }
    fn answer(r: &mut PromptRun, dev: DevId, m: &Value, text: &str) -> Vec<Act> {
        r.on_result(0, dev, &json!({"task_id": m["task_id"], "ok": true, "ms": 10, "text": text, "part": 0, "parts": 1}), &[])
    }

    #[test]
    fn every_prompt_once_and_checks_on_another_device() {
        let mut r = PromptRun::new(&job(10, 30)).unwrap();
        let checks = r.items.iter().filter(|i| i.check).count();
        assert!(checks >= 1);
        let mut now = 0;
        let mut seen = 0;
        while !r.finished() {
            now += 100;
            let acts = r.assign(now, &[1, 2]);
            let ts = tasks(&acts);
            assert!(!ts.is_empty(), "stuck");
            for (d, m) in ts {
                if m["n"].as_u64().unwrap() as usize >= 10 {
                    panic!()
                }
                seen += 1;
                // the same answer from both devices (same seed): the checks agree
                let acts = answer(&mut r, d, &m, &format!("answer {}", m["n"]));
                for a in &acts {
                    if let Act::Room(v) = a {
                        if v["t"] == "tcheck" {
                            assert_eq!(v["agree"], true);
                        }
                    }
                }
            }
        }
        assert_eq!(seen, 10 + checks, "each prompt once, each check once");
        // the check copy never ran on the device that made the main answer
        for it in &r.items {
            if let (Some(a), Some(b)) = (&it.main, &it.chk) {
                assert_ne!(a.dev, b.dev);
            }
        }
    }

    #[test]
    fn failures_retry_elsewhere_then_fail() {
        let mut r = PromptRun::new(&job(1, 0)).unwrap();
        let mut failed = false;
        for round in 0..5 {
            let ts = tasks(&r.assign(round * 10, &[1, 2, 3]));
            for (d, m) in ts {
                let acts = r.on_result(0, d, &json!({"task_id": m["task_id"], "ok": false, "error": "boom", "part": 0, "parts": 1}), &[]);
                failed |= acts.iter().any(|a| matches!(a, Act::Room(v) if v["final"] == true));
            }
        }
        assert!(failed && r.finished() && r.done() == 1, "3 tries then failed");
    }

    #[test]
    fn device_leaving_gives_the_prompt_back_and_lonely_checks_end() {
        let mut r = PromptRun::new(&job(2, 100)).unwrap();
        let ts = tasks(&r.assign(0, &[7]));
        assert_eq!(ts.len(), 1);
        r.on_gone(5, 7);
        // kept for device 7 for ORPHAN_MS: not given to 8 at once (8 gets the other prompt)
        let ts8 = tasks(&r.assign(10, &[8]));
        assert_eq!(ts8[0].1["n"], 1, "the left device's prompt is kept for it a while");
        let (_, m8) = ts8.into_iter().next().unwrap();
        answer(&mut r, 8, &m8, "x");
        r.tick(10 + ORPHAN_MS + 10); // 7 never came back: its prompt goes back
        let ts = tasks(&r.assign(10 + ORPHAN_MS + 20, &[8]));
        assert_eq!(ts[0].1["n"], 0, "after ORPHAN_MS the prompt of the device that left is given again");
        // only device 8 from now on: both prompts done by it, the checks need another computer: given up after LONELY_MS
        let mut now = 10 + ORPHAN_MS + 30;
        for (d, m) in ts {
            answer(&mut r, d, &m, "x");
        }
        while let Some((d, m)) = tasks(&r.assign(now, &[8])).pop() {
            answer(&mut r, d, &m, "x");
            now += 10;
        }
        assert!(!r.finished());
        r.tick(now + 1);
        let acts = r.tick(now + LONELY_MS + 10);
        assert!(acts.iter().any(|a| matches!(a, Act::Room(v) if v["copy"] == 1 && v["final"] == true)));
        assert!(r.finished());
    }

    #[test]
    fn a_device_that_reconnects_keeps_its_prompt_and_delivers_it() {
        let mut r = PromptRun::new(&job(2, 0)).unwrap();
        // the broker names each connection's account and device: device 1 and its later connection 9 are one computer
        r.set_owner(1, "u1:d1");
        r.set_owner(9, "u1:d1");
        r.set_owner(2, "u2:d2");
        r.set_owner(5, "u3:d3");
        let (d, m) = tasks(&r.assign(0, &[1])).pop().unwrap();
        assert_eq!(d, 1);
        r.on_gone(100, 1); // a site deploy: every connection drops
        // another computer cannot answer the dropped prompt (security review P1)
        let stranger = r.on_result(150, 5, &json!({"task_id": m["task_id"], "job": r.id, "n": m["n"], "copy": 0, "ok": true, "ms": 5, "text": "fake", "part": 0, "parts": 1}), &[]);
        assert!(stranger.is_empty(), "a stranger's answer for another computer's prompt is dropped");
        // device 1 comes back as device 9, still making prompt n; device 2 is idle
        r.adopt(200, 9, &[(r.id.clone(), m["n"].as_u64().unwrap() as usize, 0)]);
        let other = tasks(&r.assign(300, &[2]));
        assert!(other.iter().all(|(_, x)| x["n"] != m["n"]), "the prompt is not given to device 2");
        // its answer arrives on the new connection with the OLD task number: accepted for the prompt
        let acts = r.on_result(0, 9, &json!({"task_id": m["task_id"], "job": r.id, "n": m["n"], "copy": 0, "ok": true, "ms": 5, "text": "late", "part": 0, "parts": 1}), &[]);
        assert!(acts.iter().any(|a| matches!(a, Act::Room(v) if v["t"] == "tresult" && v["ok"] == true && v["dev"] == 9)));
        // hub restarted: an answer for a prompt nobody was given is dropped, unless the device said in its hello that it
        // was making it (adopt, just after the start); then it is accepted (security review P1)
        let mut r2 = PromptRun::new(&job(1, 0)).unwrap();
        let none = r2.on_result(0, 4, &json!({"task_id": 77, "job": r2.id, "n": 0, "copy": 0, "ok": true, "ms": 5, "text": "y", "part": 0, "parts": 1}), &[]);
        assert!(none.is_empty() && !r2.finished(), "an answer nobody asked for is dropped");
        r2.set_owner(4, "u4:d4");
        r2.adopt(0, 4, &[(r2.id.clone(), 0, 0)]);
        let acts = r2.on_result(0, 4, &json!({"task_id": 77, "job": r2.id, "n": 0, "copy": 0, "ok": true, "ms": 5, "text": "y", "part": 0, "parts": 1}), &[]);
        assert!(acts.iter().any(|a| matches!(a, Act::Room(v) if v["t"] == "tresult" && v["ok"] == true)) && r2.finished());
        // after the grace a claim of an unknown prompt is not taken
        let mut r3 = PromptRun::new(&job(1, 0)).unwrap();
        r3.adopt(0, 6, &[]);
        r3.adopt(ADOPT_GRACE_MS + 1, 7, &[(r3.id.clone(), 0, 0)]);
        let late = r3.on_result(ADOPT_GRACE_MS + 2, 7, &json!({"task_id": 1, "job": r3.id, "n": 0, "copy": 0, "ok": true, "ms": 5, "text": "z", "part": 0, "parts": 1}), &[]);
        assert!(late.is_empty(), "no adopting unknown prompts after the grace");
    }

    #[test]
    fn pictures_in_parts_and_compared() {
        let png = |shade: u8| {
            let mut out = Vec::new();
            let mut e = png::Encoder::new(&mut out, 64, 64);
            e.set_color(png::ColorType::Rgb);
            e.set_depth(png::BitDepth::Eight);
            let mut w = e.write_header().unwrap();
            let px: Vec<u8> = (0..64 * 64 * 3).map(|i| ((i / 3) % 64) as u8 + shade).collect();
            w.write_image_data(&px).unwrap();
            w.finish().unwrap();
            out
        };
        let a = Res { dev: 1, text: String::new(), file: png(0), owner: String::new() };
        assert_eq!(compare("image", &a, &Res { dev: 2, text: String::new(), file: png(3), owner: String::new() }).0, true);
        assert_eq!(compare("image", &a, &Res { dev: 2, text: String::new(), file: png(60), owner: String::new() }).0, false);
        // a 2 MB result arrives in 3 parts and is stored for the room in 3 parts
        let mut j = job(1, 0);
        j["task"] = json!("image");
        let mut r = PromptRun::new(&j).unwrap();
        let (d, m) = tasks(&r.assign(0, &[4])).pop().unwrap();
        let big = vec![7u8; 2_000_000];
        let msgs = parts(KIND_TASK_RESULT, &json!({"task_id": m["task_id"], "ok": true, "ms": 5, "ext": "png"}), &big);
        assert_eq!(msgs.len(), 3);
        let mut acts = Vec::new();
        for b in &msgs {
            let (k, meta, bytes) = parse(b).unwrap();
            assert_eq!(k, KIND_TASK_RESULT);
            acts.extend(r.on_result(0, d, &meta, bytes));
        }
        let files: Vec<&Vec<u8>> = acts.iter().filter_map(|a| if let Act::File(f) = a { Some(f) } else { None }).collect();
        assert_eq!(files.len(), 3);
        assert!(files.iter().all(|f| f.len() <= PART + 200));
        assert!(r.finished());
    }

    fn image_job() -> Value {
        let mut j = job(1, 0);
        j["task"] = json!("image");
        j
    }
    fn picture(r: &mut PromptRun, now: u64, dev: DevId, m: &Value) -> Vec<Act> {
        r.on_result(now, dev, &json!({"task_id": m["task_id"], "ok": true, "ms": 5, "ext": "png", "part": 0, "parts": 1}), &[1, 2, 3])
    }
    fn progress(r: &mut PromptRun, now: u64, dev: DevId, m: &Value, state: &str, step: u64) {
        r.on_progress(now, dev, &json!({"task_id": m["task_id"], "job": m["job"], "n": m["n"], "copy": m["copy"], "state": state, "step": step, "steps": 8}));
    }
    const MIN: u64 = 60_000;

    #[test]
    fn watch_fixed_limit_until_the_first_step_then_steps_must_keep_coming() {
        let w = Watch::new(0);
        assert!(w.overdue("image", 179 * MIN).is_none());
        assert_eq!(w.overdue("image", 181 * MIN).as_deref(), Some("no answer in time"), "no step: the old 3 hours");
        assert_eq!(w.overdue("chat", 16 * MIN).as_deref(), Some("no answer in time"));
        // the incident of 2026-10-30: 1920 x 1088, 8 steps of ~22 min on 4 busy cores (~3 h): never given up
        let mut w = Watch::new(0);
        w.see(MIN, "loading", 0);
        for s in 1..=8 {
            w.see(MIN + s * 22 * MIN, "sampling", s);
            assert!(w.overdue("image", MIN + s * 22 * MIN + 60 * MIN).is_none(), "step {s}");
        }
        w.see(200 * MIN, "decoding", 8);
        assert!(w.overdue("image", 250 * MIN).is_none(), "3 h 20 min and still going: kept");
        // stalled: no step for 3 x the slowest step (the first one, 23 min with the loading: 69 min)
        assert_eq!(w.overdue("image", 200 * MIN + 70 * MIN).as_deref(), Some("no progress for 69 minutes"));
        // small pictures: at least 30 minutes without a step
        let mut w = Watch::new(0);
        w.see(MIN, "sampling", 1);
        w.see(2 * MIN, "sampling", 2);
        assert!(w.overdue("image", 31 * MIN).is_none());
        assert!(w.overdue("image", 33 * MIN).is_some());
        // the hard limit, whatever the progress
        let mut w = Watch::new(0);
        for s in 1..=100 {
            w.see(s * 8 * MIN, "sampling", s);
        }
        assert_eq!(w.overdue("image", 12 * 60 * MIN + 1).as_deref(), Some("not done after 12 hours"));
    }

    #[test]
    fn progress_keeps_a_slow_picture_with_its_computer() {
        let mut r = PromptRun::new(&image_job()).unwrap();
        let (d, m) = tasks(&r.assign(0, &[1, 2])).pop().unwrap();
        assert_eq!(d, 1);
        for s in 1..=8 {
            progress(&mut r, s * 25 * MIN, 1, &m, "sampling", s);
            let acts = r.tick(s * 25 * MIN + MIN);
            assert!(acts.is_empty(), "no time-out while the steps come");
            assert!(tasks(&r.assign(s * 25 * MIN + MIN, &[2])).is_empty(), "not given to another computer");
        }
        let acts = picture(&mut r, 205 * MIN, 1, &m);
        assert!(acts.iter().any(|a| matches!(a, Act::Room(v) if v["t"] == "tresult" && v["ok"] == true)));
        assert!(r.finished(), "done in 3 h 25 min, past the old 3-hour limit");
    }

    #[test]
    fn out_of_time_goes_to_another_computer_and_the_first_answer_wins() {
        // an older device (no PROGRESS): the old fixed limit, then the prompt goes to device 2 too
        let mut r = PromptRun::new(&image_job()).unwrap();
        let (_, m1) = tasks(&r.assign(0, &[1, 2])).pop().unwrap();
        let acts = r.tick(181 * MIN);
        assert!(acts.iter().any(|a| matches!(a, Act::Room(v) if v["ok"] == false && v["final"] == false && v["dev"] == 1)));
        assert!(r.busy(1), "device 1 still makes it");
        assert!(tasks(&r.assign(181 * MIN, &[1])).is_empty(), "never back to the slow device while it is slow");
        let (d2, m2) = tasks(&r.assign(181 * MIN, &[2])).pop().unwrap();
        assert_eq!((d2, &m2["n"]), (2, &m1["n"]));
        // device 1 finishes after all (a late answer): it counts, and device 2 is told to stop
        let acts = picture(&mut r, 190 * MIN, 1, &m1);
        assert!(acts.iter().any(|a| matches!(a, Act::Room(v) if v["t"] == "tresult" && v["ok"] == true && v["dev"] == 1)));
        let cancels: Vec<DevId> = acts.iter().filter_map(|a| match a { Act::Dev(d, b) if b[4] == KIND_CANCEL => Some(*d), _ => None }).collect();
        assert_eq!(cancels, vec![2]);
        assert!(r.finished() && !r.busy(2));
        // device 2's answer (or its "cancelled" error) is dropped
        assert!(picture(&mut r, 191 * MIN, 2, &m2).is_empty());
        assert!(r.on_result(191 * MIN, 2, &json!({"task_id": m2["task_id"], "job": r.id, "n": 0, "copy": 0, "ok": false, "error": "cancelled", "part": 0, "parts": 1}), &[]).is_empty());
    }

    #[test]
    fn the_retry_wins_and_the_slow_one_is_stopped() {
        let mut r = PromptRun::new(&image_job()).unwrap();
        let (_, m1) = tasks(&r.assign(0, &[1, 2])).pop().unwrap();
        progress(&mut r, 2 * MIN, 1, &m1, "sampling", 1);
        r.tick(40 * MIN); // no step since minute 2 (stall limit 30 min): late
        let (d2, m2) = tasks(&r.assign(40 * MIN, &[2])).pop().unwrap();
        assert_eq!(d2, 2);
        let acts = picture(&mut r, 60 * MIN, 2, &m2);
        let cancels: Vec<DevId> = acts.iter().filter_map(|a| match a { Act::Dev(d, b) if b[4] == KIND_CANCEL => Some(*d), _ => None }).collect();
        assert_eq!(cancels, vec![1]);
        assert!(r.finished() && !r.busy(1));
    }

    #[test]
    fn the_only_computer_gets_it_again_after_a_while() {
        // only device 1 has the model: it ran out of time, its own watch gave up too (error): back to it after SAME_AGAIN_MS
        let mut r = PromptRun::new(&image_job()).unwrap();
        let (_, m) = tasks(&r.assign(0, &[1])).pop().unwrap();
        r.tick(181 * MIN);
        let acts = r.on_result(182 * MIN, 1, &json!({"task_id": m["task_id"], "ok": false, "error": "no answer in time", "part": 0, "parts": 1}), &[]);
        assert!(acts.iter().all(|a| !matches!(a, Act::Room(v) if v["final"] == true)), "1 failure of 3, counted once");
        assert_eq!(r.items[0].fails, 1);
        r.tick(183 * MIN);
        assert!(tasks(&r.assign(184 * MIN, &[1])).is_empty(), "not at once");
        r.tick(183 * MIN + SAME_AGAIN_MS + MIN);
        assert_eq!(tasks(&r.assign(183 * MIN + SAME_AGAIN_MS + MIN, &[1])).len(), 1, "nobody else: device 1 again");
    }

    #[test]
    fn tries_used_up_while_late_fails_only_when_the_last_computer_ends() {
        let mut r = PromptRun::new(&image_job()).unwrap();
        let mut now = 0;
        let mut out = vec![];
        for dev in 1..=3 {
            let (d, m) = tasks(&r.assign(now, &[dev])).pop().unwrap();
            out.push((d, m));
            now += 181 * MIN;
            let acts = r.tick(now);
            assert!(acts.iter().all(|a| !matches!(a, Act::Room(v) if v["final"] == true)));
        }
        assert!(tasks(&r.assign(now, &[4])).is_empty(), "3 tries used");
        assert!(!r.finished(), "three computers may still deliver");
        for (i, (d, m)) in out.iter().enumerate() {
            let acts = r.on_result(now, *d, &json!({"task_id": m["task_id"], "ok": false, "error": "no answer in time", "part": 0, "parts": 1}), &[]);
            let fin = acts.iter().any(|a| matches!(a, Act::Room(v) if v["final"] == true));
            assert_eq!(fin, i == 2, "final only with the last one");
        }
        assert!(r.finished() && r.done() == 1);
    }

    #[test]
    fn progress_and_cancel_frames_parse() {
        let f = frame(KIND_PROGRESS, &json!({"task_id": 3, "job": "j", "n": 0, "copy": 0, "state": "sampling", "step": 2, "steps": 8}), &[]);
        assert_eq!(parse(&f).unwrap().0, KIND_PROGRESS);
        assert_eq!(parse(&frame(KIND_CANCEL, &json!({}), &[])).unwrap().0, KIND_CANCEL);
        assert!(timed_out("no progress for 30 minutes") && timed_out("it took more than 175 minutes") && !timed_out("boom"));
    }
}
