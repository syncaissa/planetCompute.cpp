// Harness images and videos on this computer: stable-diffusion.cpp's sd-cli (an engine like llama.cpp, for image models, on
// the same ggml library). The program carries it (build.rs, cfg has_sd); on first use it is written to
// <data>/planetCompute/bin/sd-cli-<sha>(.exe) and run as a separate process: its ggml cannot share a program with
// llama.cpp's, and a crash in an image job never takes the app down. One job at a time (it uses the whole GPU or
// every core). Routes (server.rs):
//   GET  /local/image/info            engine in this build, job running
//   POST /local/image                 {model, prompt, negative?, width?, height?, steps?, seed?, frames?} -> {id}
//                                     (a video model makes a .webm clip; frames 5-81, 4n+1, at 16 frames a second)
//   GET  /local/image/job/<id>        {state: loading|sampling|decoding|done|error|cancelled, step, steps, seconds, error}
//   GET  /local/image/file/<id>       the PNG (or the WebM clip)
//   POST /local/image/cancel          {id}
//   POST /v1/images/generations       OpenAI-style: {model, prompt, size "WxH", n 1} -> {data: [{b64_json}]}
// If the engine fails on the GPU (seen on a small virtual Mac GPU: its automatic memory fitting splits the work and
// fails), the same picture is tried again with --auto-fit off, then on the CPU alone; the way that worked is kept
// for the next pictures while the program runs.
// Queue: every request is written to <data>/planetCompute/queue.json the moment it arrives and made one at a time, oldest
// first; a request still waiting or being made when the program stops is made again (from the start) when it starts.
// Models (models.rs, kind "image"): family "sd1" = one file; "flux" = the diffusion model plus its parts (role vae,
// clip_l, t5xxl), each a library entry of its own (kind "image-part"); "zimage" = Z-Image Turbo with FLUX's VAE and the
// chat model Qwen3 4B as its text encoder (role llm, named by the model's "roles"); kind "video", family "wan" = Wan 2.1 text to
// video: the diffusion model plus its VAE and umt5-xxl text encoder (kind "video-part").

use crate::models;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[cfg(has_sd)]
static SD_CLI: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/sd-cli.bin"));
#[cfg(not(has_sd))]
static SD_CLI: &[u8] = &[];

/// The ways to run the engine, tried in order after a failure. Which one worked (or that the GPU failed, and why) is
/// kept per model in <data>/planetCompute/gpu_results.json: the checks before a request use it, and the next request
/// of that model starts with the way that worked instead of failing on the GPU again.
const MODES: [(&str, &[&str]); 3] = [("GPU", &[]), ("GPU, no memory fitting", &["--auto-fit", "off"]), ("CPU", &["--backend", "cpu"])];

fn results_file() -> PathBuf {
    data().join("gpu_results.json")
}

fn results() -> Value {
    std::fs::read(results_file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}))
}

/// Remember for a model: the way that worked (index in MODES) and the GPU's errors on the way.
fn remember(model: &str, mode: usize, errors: &[String]) {
    let mut r = results();
    r[model] = json!({"mode": mode, "way": MODES[mode].0, "errors": errors, "at": now_ms(), "version": env!("CARGO_PKG_VERSION")});
    let _ = std::fs::create_dir_all(data());
    let _ = std::fs::write(results_file(), r.to_string());
}

/// "Try the GPU again" (e.g. after a new graphics driver): forget what happened with a model.
pub fn forget(model: &str) {
    let mut r = results();
    if let Some(o) = r.as_object_mut() {
        o.remove(model);
    }
    let _ = std::fs::write(results_file(), r.to_string());
}

/// The way to start with for a model: the one that worked last time with this version of the program, else the GPU
/// (the processor at once on a Windows PC without a graphics driver, vkloader.rs).
fn first_mode(model: &str) -> usize {
    if crate::vkloader::no_gpu() {
        return MODES.len() - 1;
    }
    let r = &results()[model];
    if r["version"].as_str() != Some(env!("CARGO_PKG_VERSION")) {
        return 0;
    }
    (r["mode"].as_u64().unwrap_or(0) as usize).min(MODES.len() - 1)
}

const GB: f64 = 1024.0 * 1024.0 * 1024.0;

/// Threads for the picture engine: the cores the owner shares (headless programs: Contribute's cores), 0 = all.
static THREADS: AtomicUsize = AtomicUsize::new(0);
pub fn set_threads(n: usize) {
    THREADS.store(n, Ordering::SeqCst);
}

pub fn available() -> bool {
    !SD_CLI.is_empty()
}

#[derive(Clone, Default)]
pub struct Job {
    pub state: String,
    pub step: u32,
    pub steps: u32,
    pub error: String,
    pub started: Option<Instant>,
    pub seconds: f64,
    pub file: PathBuf,
    /// the sampling steps asked for: other progress counters are the preparation or the decoding
    pub want: u32,
    pub mode: String,
    pub tries: Vec<String>,
    /// the request as sent (kept in the queue file), when it was queued (ms since 1970), and whether it came back
    /// from the queue file after a restart
    pub req: Value,
    pub at: u64,
    pub resumed: bool,
    pub video: bool,
    /// taken off the Queue tab's list (Delete / Remove from list)
    pub hidden: bool,
}

#[derive(Clone, Default)]
pub struct Images {
    jobs: Arc<Mutex<HashMap<String, Job>>>,
    child: Arc<Mutex<Option<(String, crate::sandbox::Proc)>>>,
    /// true while the queue's worker thread runs
    worker: Arc<AtomicBool>,
    /// Pictures and videos just made here, waiting to be registered on planetcompute.ai (server.rs register_made):
    /// only what is registered can be saved to the cloud (user 2026-10-30: "this image or video was not made here").
    /// Kept in memory only: a file put in the folder by hand, or a .json written beside it, is never registered.
    pub made: Arc<Mutex<Vec<(PathBuf, Value)>>>,
}

const WAITING: [&str; 4] = ["queued", "loading", "sampling", "decoding"];

/// Set when this copy is ending (a newer copy replaced it, or it quits): the engine is stopped on purpose, so the picture
/// being made is NOT a failure and the queue file on disk must stay as it is, for the next copy to take back. Without
/// this, the worker could see the stopped engine, mark the picture "error" and rewrite queue.json without it before
/// the process ended (a race; found by test_local_server.sh on macOS, 2026-11-01).
static QUITTING: AtomicBool = AtomicBool::new(false);

fn queue_file() -> PathBuf {
    data().join("queue.json")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

pub(crate) fn data() -> PathBuf {
    // an engine in its sandbox (sandbox.rs) is told where this is: an AppContainer may see other folders by that name
    if let Some(d) = std::env::var_os("PC_ENGINE_DATA") {
        return PathBuf::from(d);
    }
    dirs::data_dir().unwrap_or_else(std::env::temp_dir).join("planetCompute")
}

/// Where every picture and video made on this computer is kept (Open pictures folder shows it).
pub fn folder() -> PathBuf {
    data().join("images")
}

/// Write the engine next to the models once (a new build has a new name), executable.
fn engine_path() -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    if !available() {
        return Err("this build of planetCompute has no image engine".into());
    }
    let tag = format!("{:x}", Sha256::digest(SD_CLI));
    let name = format!("sd-cli-{}{}", &tag[..12], std::env::consts::EXE_SUFFIX);
    let dir = data().join("bin");
    let p = dir.join(&name);
    if std::fs::metadata(&p).map(|m| m.len() == SD_CLI.len() as u64).unwrap_or(false) {
        return Ok(p);
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // older copies of the engine are no longer needed
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            if e.file_name().to_string_lossy().starts_with("sd-cli-") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let tmp = dir.join(format!("{name}.tmp"));
    std::fs::write(&tmp, SD_CLI).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    Ok(p)
}

fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or("").to_string()
}

/// The engine's arguments for a model and a request (checked: sizes multiples of 8, 128-2048; 1-100 steps). The
/// engine needs multiples of 16 (Z-Image, Wan) or 64: a size between them (1920 x 1080, 1080 x 1350) is made a little
/// larger (1920 x 1088, 1088 x 1408) and cut to the size asked for when it is done (crop_png).
fn args(m: &Value, req: &Value, out: &PathBuf) -> Result<Vec<String>, String> {
    let fam = s(m, "family");
    let prompt = s(req, "prompt").trim().chars().take(2000).collect::<String>();
    if prompt.is_empty() {
        return Err("describe the image first".into());
    }
    let step = if fam == "wan" || fam == "zimage" { 16 } else { 64 };
    let dim = |k: &str, d: u64| -> Result<u64, String> {
        let v = req[k].as_u64().unwrap_or(d);
        if v < 128 || v > 2048 || v % 2 != 0 { Err(format!("{k} must be 128-2048, an even number")) } else { Ok(v.div_ceil(step) * step) }
    };
    let size = m["size"].as_u64().unwrap_or(512);
    let (w, h) = (dim("width", m["width"].as_u64().unwrap_or(size))?, dim("height", m["height"].as_u64().unwrap_or(size))?);
    let steps = req["steps"].as_u64().unwrap_or(m["steps"].as_u64().unwrap_or(20)).clamp(1, 100);
    let seed = req["seed"].as_i64().unwrap_or(-1);
    let all = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let threads = match THREADS.load(Ordering::SeqCst) { 0 => all, n => n.min(all) }.min(32);
    let mut a: Vec<String> = Vec::new();
    let main = models::path_of(m).to_string_lossy().to_string();
    match fam.as_str() {
        "flux" => {
            a.extend(["--diffusion-model".into(), main]);
            for (role, path) in models::parts_of(m)? {
                a.extend([format!("--{role}"), path.to_string_lossy().to_string()]);
            }
            a.extend(["--cfg-scale".into(), "1.0".into(), "--sampling-method".into(), "euler".into(), "--vae-tiling".into()]);
        }
        "zimage" => {
            a.extend(["--diffusion-model".into(), main]);
            for (role, path) in models::parts_of(m)? {
                a.extend([format!("--{role}"), path.to_string_lossy().to_string()]);
            }
            a.extend(["--cfg-scale".into(), "1.0".into(), "--diffusion-fa".into()]);
        }
        "wan" => {
            let frames = req["frames"].as_u64().unwrap_or(33);
            if !(5..=81).contains(&frames) || frames % 4 != 1 {
                return Err("frames must be 5-81 and one more than a multiple of 4 (17, 33, 49 ...)".into());
            }
            a.extend(["-M".into(), "vid_gen".into(), "--diffusion-model".into(), main]);
            for (role, path) in models::parts_of(m)? {
                a.extend([format!("--{role}"), path.to_string_lossy().to_string()]);
            }
            let neg = s(req, "negative");
            // Wan's own standard negative prompt (from its authors) unless one is given
            let neg = if neg.trim().is_empty() { WAN_NEGATIVE.to_string() } else { neg.chars().take(1000).collect() };
            a.extend(["--cfg-scale".into(), "6.0".into(), "--sampling-method".into(), "euler".into(), "--flow-shift".into(), "3.0".into(),
                "--video-frames".into(), frames.to_string(), "--fps".into(), "16".into(), "--diffusion-fa".into(), "-n".into(), neg]);
        }
        "sd1" | "sdxl" | "" => {
            a.extend(["-m".into(), main, "--cfg-scale".into(), m["cfg"].as_f64().unwrap_or(7.0).to_string()]);
            let neg = s(req, "negative");
            if !neg.trim().is_empty() {
                a.extend(["-n".into(), neg.chars().take(1000).collect()]);
            }
        }
        f => return Err(format!("image models of the {f} family are not supported yet")),
    }
    a.extend([
        "-p".into(), prompt, "-W".into(), w.to_string(), "-H".into(), h.to_string(), "--steps".into(), steps.to_string(),
        "--seed".into(), seed.to_string(), "-t".into(), threads.to_string(), "-o".into(), out.to_string_lossy().to_string(),
        // the engine would write the prompt into the file (PNG "parameters", WebM COMMENT): a shared picture or video would
        // show it to anyone with the link. The prompt is only for its creator (user 2026-10-30): it stays in <id>.json here.
        "--disable-image-metadata".into(),
    ]);
    Ok(a)
}

/// Content safety (user 2026-10-30, issue 4): pictures and videos made with planetCompute can be shared under its name, so
/// sexual content is not made at all (which also rules out anything sexual involving minors). Only the prompt is checked,
/// never what to leave out (people write "nude, nsfw" there to avoid it). The same words are checked on planetcompute.ai
/// for the pool and before a file is registered (website worker.js REFUSED_WORDS).
pub(crate) const REFUSED_WORDS: &[&str] = &["nude", "nudes", "naked", "nudity", "topless", "bottomless", "sex", "sexual", "sexy", "porn", "porno",
    "pornographic", "nsfw", "explicit", "erotic", "erotica", "hentai", "lingerie", "undress", "undressed", "undressing", "genitals", "genital",
    "nipple", "nipples", "breasts", "xxx", "orgasm", "masturbating", "masturbation", "fetish", "bdsm", "onlyfans", "deepfake", "loli", "lolita", "shota"];
pub(crate) fn refused(prompt: &str) -> Option<&'static str> {
    let words: Vec<String> = prompt.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_string).collect();
    if words.iter().any(|w| REFUSED_WORDS.contains(&w.as_str())) {
        return Some("planetCompute does not make sexual or explicit pictures or videos: please change the prompt.");
    }
    None
}

/// Cut a PNG to w x h around its centre (the engine made it a little larger: sizes are multiples of 16 or 64 there);
/// nothing to do when it is that size already or smaller.
fn crop_png(path: &std::path::Path, w: u32, h: u32) -> Result<(), String> {
    let f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut r = png::Decoder::new(std::io::BufReader::new(f)).read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0; r.output_buffer_size().ok_or("image too large")?];
    let info = r.next_frame(&mut buf).map_err(|e| e.to_string())?;
    if (info.width == w && info.height == h) || info.width < w || info.height < h || (info.bit_depth as u8) < 8 {
        return Ok(());
    }
    let bpp = info.line_size / info.width as usize;
    let (x0, y0) = (((info.width - w) / 2) as usize, ((info.height - h) / 2) as usize);
    let mut out = Vec::with_capacity(w as usize * h as usize * bpp);
    for y in y0..y0 + h as usize {
        let at = y * info.line_size + x0 * bpp;
        out.extend_from_slice(&buf[at..at + w as usize * bpp]);
    }
    let tmp = path.with_extension("cut.png");
    let f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut e = png::Encoder::new(std::io::BufWriter::new(f), w, h);
    e.set_color(info.color_type);
    e.set_depth(info.bit_depth);
    let mut wr = e.write_header().map_err(|e| e.to_string())?;
    wr.write_image_data(&out).map_err(|e| e.to_string())?;
    wr.finish().map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

const WAN_NEGATIVE: &str = "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走";

/// The step counter in sd.cpp's progress line: "|=====>   | 3/20 - 1.23s/it".
fn progress(line: &str) -> Option<(u32, u32)> {
    let i = line.rfind('|')?;
    let rest = line[i + 1..].trim_start();
    let (a, b) = rest.split_once('/')?;
    let n: u32 = a.trim().parse().ok()?;
    let d: u32 = b.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()?;
    (d > 0 && n <= d).then_some((n, d))
}

/// The checks made before a request is queued (and shown under the Inference controls): the engine, the model and
/// its parts, the request, the graphics card and its free memory, the computer's memory, the disk, and what happened
/// with this model before. {ok, way, checks: [{name, state "pass"|"warn"|"fail", text}]}; ok false = not started.
pub fn check(req: &Value) -> Value {
    let mut checks: Vec<Value> = Vec::new();
    let mut add = |name: &str, state: &str, text: String| checks.push(json!({"name": name, "state": state, "text": text}));
    let mut way = "GPU".to_string();
    if !available() {
        add("Engine", "fail", "this build of planetCompute has no image engine".into());
    } else {
        add("Engine", "pass", "the image engine is in this program".into());
    }
    let Some(m) = models::find(&s(req, "model")) else {
        add("Model", "fail", "download an image or video model first".into());
        return json!({"ok": false, "way": "", "checks": checks});
    };
    let name = s(&m, "name");
    let kind = s(&m, "kind");
    if kind != "image" && kind != "video" {
        add("Model", "fail", format!("{name} is not an image or video model"));
        return json!({"ok": false, "way": "", "checks": checks});
    }
    let mut weights = 0u64;
    if !models::installed(&m) {
        add("Model", "fail", format!("{name} has not finished downloading"));
    } else {
        weights += std::fs::metadata(models::path_of(&m)).map_or(0, |x| x.len());
        match models::parts_of(&m) {
            Ok(parts) => {
                weights += parts.iter().map(|(_, p)| std::fs::metadata(p).map_or(0, |x| x.len())).sum::<u64>();
                let n = parts.len();
                add("Model", "pass", format!("{name}{} downloaded ({:.1} GB)", if n > 0 { format!(" and its {n} parts") } else { String::new() }, weights as f64 / GB));
            }
            Err(e) => add("Model", "fail", e),
        }
    }
    let mut probe = req.clone();
    if s(&probe, "prompt").trim().is_empty() {
        probe["prompt"] = json!("x");
    }
    match args(&m, &probe, &folder().join("check.png")) {
        Ok(_) => add("Request", "pass", "size, steps and frames are right for this model".into()),
        Err(e) => add("Request", "fail", e),
    }
    let px = req["width"].as_u64().unwrap_or(0) * req["height"].as_u64().unwrap_or(0);
    if kind == "video" && px > 832 * 480 * 2 {
        add("Size", "warn", format!("{} x {} is {:.0} times the pixels of 832 x 480, the size this video model was made for: it takes many times longer, needs much more memory, and may look worse",
            req["width"], req["height"], px as f64 / (832.0 * 480.0)));
    }
    // the graphics card with the most free memory, and the computer's memory
    let devs = crate::engine::devices();
    let gpu = devs.iter().filter(|d| d.1 == "GPU" || d.1 == "iGPU").max_by_key(|d| d.3);
    let ram = devs.iter().find(|d| d.1 == "CPU").map_or(0, |d| d.2);
    let need = m["minRamGB"].as_f64().unwrap_or(weights as f64 / GB * 1.3);
    match gpu {
        None => {
            way = "CPU".into();
            let why = if cfg!(any(target_os = "macos", feature = "vulkan", feature = "cuda")) {
                "no graphics card found (or its driver has no Vulkan): made on the processor, much slower"
            } else {
                "this is the processor-only planetCompute: made on the processor, much slower (the graphics card version uses a GPU)"
            };
            add("Graphics card", "warn", why.into());
        }
        Some((gname, gkind, total, free)) => {
            let (total, free) = (*total as f64 / GB, *free as f64 / GB);
            let fits = (weights as f64 / GB) * 1.15 + 1.0 <= free;
            add("Graphics card", "pass", format!("{gname}{}: {free:.1} GB free of {total:.1} GB", if gkind == "iGPU" { " (built-in)" } else { "" }));
            if fits {
                add("GPU memory", "pass", format!("the model ({:.1} GB) fits in the graphics card", weights as f64 / GB));
            } else {
                add("GPU memory", "warn", format!("the model ({:.1} GB) does not all fit in the {free:.1} GB free: part of it stays in the computer's memory (slower). Closing other programs that use the GPU frees some", weights as f64 / GB));
            }
        }
    }
    if ram > 0 {
        let ram_gb = ram as f64 / GB;
        if ram_gb + 0.5 < need {
            add("Memory", "warn", format!("{name} needs about {need:.0} GB of memory; this computer has {ram_gb:.1} GB: it may fail or be very slow"));
        } else {
            add("Memory", "pass", format!("{ram_gb:.1} GB, the model needs about {need:.0} GB"));
        }
    }
    match fs2::available_space(data()) {
        Ok(b) if b < 200 * 1024 * 1024 => add("Disk", "fail", format!("only {} MB free on the disk", b / 1024 / 1024)),
        Ok(b) => add("Disk", "pass", format!("{:.1} GB free", b as f64 / GB)),
        Err(_) => {}
    }
    // this model on this computer before
    let id = s(&m, "id");
    let r = &results()[id.as_str()];
    if r.is_object() && r["version"].as_str() == Some(env!("CARGO_PKG_VERSION")) {
        let mode = (r["mode"].as_u64().unwrap_or(0) as usize).min(MODES.len() - 1);
        let errs: Vec<String> = r["errors"].as_array().map(|a| a.iter().filter_map(|e| e.as_str().map(String::from)).collect()).unwrap_or_default();
        if mode == MODES.len() - 1 && gpu.is_some() {
            way = "CPU".into();
            add("Before", "warn", format!("the graphics card failed with this model last time, so it is made on the processor ({})", errs.join("; ")));
        } else if mode > 0 {
            add("Before", "pass", format!("worked last time on the GPU without memory fitting ({})", errs.join("; ")));
        } else {
            add("Before", "pass", "worked last time on the GPU".into());
        }
    }
    let ok = !checks.iter().any(|c| c["state"] == "fail");
    json!({"ok": ok, "way": way, "checks": checks})
}

/// The most pictures and videos that may wait in the queue.
const QUEUE_MAX: usize = 50;

/// Pictures or videos being made right now (the engine is running): the WorkPack threads of contribute.rs step aside
/// meanwhile, as they do for a chat job, so the picture has the cores shared here to itself (user 2026-10-31: a
/// 512 x 512 pool picture took 38 minutes instead of about 20 while the same copy kept computing WorkPacks).
static MAKING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
pub fn making() -> bool {
    MAKING.load(std::sync::atomic::Ordering::SeqCst) > 0
}
struct Making;
impl Making {
    fn start() -> Making {
        MAKING.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Making
    }
}
impl Drop for Making {
    fn drop(&mut self) {
        MAKING.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// The engine's arguments without "-p <prompt>" and "-n <leave out>", and those two as PC_PROMPT / PC_NEGATIVE.
pub(crate) fn private_prompt(a: &[String]) -> (Vec<String>, Vec<(String, String)>) {
    let (mut out, mut envs, mut i) = (Vec::with_capacity(a.len()), Vec::new(), 0);
    while i < a.len() {
        match (a[i].as_str(), a.get(i + 1)) {
            ("-p", Some(v)) => { envs.push(("PC_PROMPT".to_string(), v.clone())); i += 2; }
            ("-n", Some(v)) => { envs.push(("PC_NEGATIVE".to_string(), v.clone())); i += 2; }
            _ => { out.push(a[i].clone()); i += 1; }
        }
    }
    (out, envs)
}

impl Images {
    pub fn busy(&self) -> Option<String> {
        self.child.lock().unwrap().as_ref().map(|(id, _)| id.clone())
    }

    pub fn job(&self, id: &str) -> Option<Value> {
        let j = self.jobs.lock().unwrap().get(id).cloned()?;
        let secs = j.started.map(|t| t.elapsed().as_secs_f64()).filter(|_| j.seconds == 0.0).unwrap_or(j.seconds);
        let ahead = if j.state == "queued" {
            let g = self.jobs.lock().unwrap();
            g.values().filter(|o| o.state != "queued" && WAITING.contains(&o.state.as_str())).count()
                + g.values().filter(|o| o.state == "queued" && o.at < j.at).count()
        } else {
            0
        };
        let video = j.video;
        Some(json!({"id": id, "state": j.state, "step": j.step, "steps": j.steps, "seconds": (secs * 10.0).round() / 10.0, "error": j.error,
                    "ran_on": j.mode, "retried": j.tries, "ahead": ahead, "at": j.at, "resumed": j.resumed, "video": video,
                    "prompt": j.req["prompt"], "model": j.req["model"], "width": j.req["width"], "height": j.req["height"], "frames": j.req["frames"],
                    "seed": j.req["seed"], "negative": j.req["negative"], "file": j.file.file_name().map(|f| f.to_string_lossy().to_string())}))
    }

    /// The requests waiting or being made, oldest first (the Inference tab shows them again after a restart).
    /// all = also the ones finished, stopped or failed since the program started (the Queue tab), not removed from it.
    pub fn queue(&self, all: bool) -> Vec<Value> {
        let mut ids: Vec<(u64, String)> = self.jobs.lock().unwrap().iter()
            .filter(|(_, j)| !j.hidden && (all || WAITING.contains(&j.state.as_str())))
            .map(|(id, j)| (j.at, id.clone()))
            .collect();
        ids.sort();
        ids.into_iter().filter_map(|(_, id)| self.job(&id)).collect()
    }

    /// Queue tab, Delete / Remove from list: a request still waiting or being made is stopped; it then leaves the
    /// list (a picture already made stays in the pictures folder, Local Content).
    pub fn remove(&self, id: &str) -> bool {
        if !self.jobs.lock().unwrap().contains_key(id) {
            return false;
        }
        self.cancel(id);
        if let Some(j) = self.jobs.lock().unwrap().get_mut(id) {
            j.hidden = true;
        }
        true
    }

    /// Write the waiting requests to the queue file (a new file, then renamed over the old one).
    fn save_queue(&self) {
        if QUITTING.load(Ordering::SeqCst) {
            return; // ending: keep queue.json as it was
        }
        // a picture a SherpaHub asked for ("sherpa": true) is not taken back after a restart: the hub gives it again
        let mut list: Vec<(u64, Value)> = self.jobs.lock().unwrap().iter()
            .filter(|(_, j)| WAITING.contains(&j.state.as_str()) && j.req["sherpa"] != true)
            .map(|(id, j)| (j.at, json!({"id": id, "req": j.req, "at": j.at})))
            .collect();
        list.sort_by_key(|x| x.0);
        let body = Value::Array(list.into_iter().map(|x| x.1).collect()).to_string();
        let (f, tmp) = (queue_file(), data().join("queue.json.tmp"));
        let _ = std::fs::create_dir_all(data());
        if std::fs::write(&tmp, body).is_ok() {
            let _ = std::fs::rename(&tmp, &f);
        }
    }

    /// At start, before the first request is answered: take back the requests of the queue file and make them. An engine left running by the program's
    /// last copy (it was closed or replaced while making one) is stopped first.
    pub fn resume(&self) {
        let list: Vec<Value> = std::fs::read(queue_file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        if list.is_empty() {
            return;
        }
        {
            let mut g = self.jobs.lock().unwrap();
            for q in list {
                let id: String = s(&q, "id").chars().filter(|c| c.is_ascii_hexdigit()).collect();
                if id.is_empty() || g.contains_key(&id) {
                    continue;
                }
                let video = models::find(&s(&q["req"], "model")).is_some_and(|m| s(&m, "kind") == "video");
                g.insert(id, Job { state: "queued".into(), req: q["req"].clone(), at: q["at"].as_u64().unwrap_or(0), resumed: true, video, ..Default::default() });
            }
        }
        // the requests are listed at once; the engine starts once a leftover one is gone
        let me = self.clone();
        std::thread::spawn(move || {
            stop_leftover_engines();
            me.kick();
        });
    }

    /// Make sure the worker runs: it makes the oldest waiting request, then the next, until none is left.
    fn kick(&self) {
        if self.worker.swap(true, Ordering::SeqCst) {
            return;
        }
        let me = self.clone();
        std::thread::spawn(move || loop {
            if QUITTING.load(Ordering::SeqCst) {
                me.worker.store(false, Ordering::SeqCst);
                return; // ending: start nothing new
            }
            let next = {
                let g = me.jobs.lock().unwrap();
                g.iter().filter(|(_, j)| j.state == "queued").min_by_key(|(_, j)| j.at).map(|(id, _)| id.clone())
            };
            match next {
                Some(id) => me.run(&id),
                None => {
                    me.worker.store(false, Ordering::SeqCst);
                    // a request may have come in just now: carry on unless another worker took it
                    if !me.jobs.lock().unwrap().values().any(|j| j.state == "queued") || me.worker.swap(true, Ordering::SeqCst) {
                        return;
                    }
                }
            }
        });
    }

    pub fn file(&self, id: &str) -> Option<PathBuf> {
        self.jobs.lock().unwrap().get(id).filter(|j| j.state == "done").map(|j| j.file.clone())
    }

    pub fn cancel(&self, id: &str) {
        self.stop(id);
        self.save_queue();
    }

    fn stop(&self, id: &str) {
        if let Some((cur, child)) = self.child.lock().unwrap().as_mut() {
            if cur == id {
                child.kill();
            }
        }
        if let Some(j) = self.jobs.lock().unwrap().get_mut(id) {
            if j.state != "done" && j.state != "error" {
                j.state = "cancelled".into();
            }
        }
    }

    /// Queue a request: it is checked, written to the queue file, and made when the ones before it are done; the
    /// state is polled with job().
    pub fn start(&self, req: &Value) -> Result<String, String> {
        if let Some(why) = refused(&s(req, "prompt")) {
            return Err(why.into());
        }
        // security review E6: at most QUEUE_MAX pictures and videos waiting
        if self.jobs.lock().unwrap().values().filter(|j| j.state == "queued").count() >= QUEUE_MAX {
            return Err(format!("the queue is full ({QUEUE_MAX} waiting): wait for some to finish"));
        }
        let m = models::find(&s(req, "model")).ok_or("download an image model first")?;
        let video = s(&m, "kind") == "video";
        if s(&m, "kind") != "image" && !video {
            return Err("that is not an image or video model".into());
        }
        if !models::installed(&m) {
            return Err("that model has not finished downloading".into());
        }
        let c = check(req);
        if c["ok"] != true {
            let fails: Vec<String> = c["checks"].as_array().into_iter().flatten().filter(|x| x["state"] == "fail")
                .map(|x| format!("{}: {}", s(x, "name"), s(x, "text"))).collect();
            return Err(fails.join("; "));
        }
        let id = format!("{:x}", uuid::Uuid::new_v4().as_u128() & 0xffff_ffff_ffff);
        let out = folder().join(format!("{id}.{}", if video { "webm" } else { "png" }));
        // no seed given: pick one here, so the picture can be made again exactly ("Use these settings")
        let mut req = req.clone();
        if req["seed"].as_i64().map_or(true, |x| x < 0) {
            req["seed"] = json!((uuid::Uuid::new_v4().as_u128() & 0x7fff_ffff) as i64);
        }
        let req = &req;
        args(&m, req, &out)?;
        let mut at = now_ms();
        {
            let mut g = self.jobs.lock().unwrap();
            // keep the order even for two requests in the same millisecond
            if let Some(last) = g.values().map(|j| j.at).max() {
                at = at.max(last + 1);
            }
            g.insert(id.clone(), Job { state: "queued".into(), file: out, req: req.clone(), at, video, ..Default::default() });
        }
        self.save_queue();
        self.kick();
        Ok(id)
    }

    /// Make one request of the queue: the engine, tried the ways of MODES after a failure.
    fn run(&self, id: &str) {
        let fail = |e: String| {
            if let Some(j) = self.jobs.lock().unwrap().get_mut(id) {
                j.state = "error".into();
                j.error = e;
            }
            self.save_queue();
        };
        let req = match self.jobs.lock().unwrap().get(id) {
            Some(j) => j.req.clone(),
            None => return,
        };
        let Some(m) = models::find(&s(&req, "model")).filter(|m| models::installed(m)) else {
            return fail("the model is no longer downloaded".into());
        };
        let video = s(&m, "kind") == "video";
        let exe = match engine_path() {
            Ok(e) => e,
            Err(e) => return fail(e),
        };
        let dir = folder();
        if let Err(e) = std::fs::create_dir_all(&dir) {
            return fail(e.to_string());
        }
        let out = dir.join(format!("{id}.{}", if video { "webm" } else { "png" }));
        let _ = std::fs::remove_file(&out); // half a file from a copy that was stopped
        // a shared server: the copies of one folder make ONE picture at a time (PLANETCOMPUTE_IMAGE_LOCK, set by the
        // server's agent); the request stays queued until the engine is free, the lock goes with this function
        let _turn = match std::env::var("PLANETCOMPUTE_IMAGE_LOCK").ok().filter(|p| !p.is_empty()) {
            Some(p) => match std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(&p) {
                Ok(f) => {
                    use fs2::FileExt;
                    if f.lock_exclusive().is_err() {
                        return fail("could not wait for the picture engine".into());
                    }
                    if self.jobs.lock().unwrap().get(id).is_none_or(|j| j.state == "cancelled") {
                        return;
                    }
                    Some(f)
                }
                Err(_) => None,
            },
            None => None,
        };
        let a = match args(&m, &req, &out) {
            Ok(a) => a,
            Err(e) => return fail(e),
        };
        let want = a.iter().position(|x| x == "--steps").and_then(|i| a.get(i + 1)).and_then(|x| x.parse().ok()).unwrap_or(0);
        {
            let mut g = self.jobs.lock().unwrap();
            let Some(j) = g.get_mut(id) else { return };
            if j.state != "queued" {
                return; // stopped while it waited
            }
            j.state = "loading".into();
            j.started = Some(Instant::now());
            j.file = out;
            j.want = want;
        }
        let model = s(&req, "model");
        let first = first_mode(&model);
        for mode in first..MODES.len() {
            let (label, extra) = MODES[mode];
            let mut full = a.clone();
            full.extend(extra.iter().map(|x| x.to_string()));
            let r = self.attempt(&exe, &full, id);
            if QUITTING.load(Ordering::SeqCst) {
                return; // the engine was stopped because this copy is ending: not a failure, no retry
            }
            let mut g = self.jobs.lock().unwrap();
            let Some(j) = g.get_mut(id) else { return };
            if j.state == "cancelled" {
                j.seconds = j.started.map(|t| t.elapsed().as_secs_f64()).unwrap_or(0.0);
                let _ = std::fs::remove_file(&j.file);
                break;
            }
            match r {
                Ok(()) => {
                    remember(&model, mode, &j.tries);
                    if let (false, Some(w), Some(h)) = (video, req["width"].as_u64(), req["height"].as_u64()) {
                        if let Err(e) = crop_png(&j.file, w as u32, h as u32) {
                            eprintln!("image {id}: could not cut it to {w} x {h}: {e}");
                        }
                    }
                    j.state = "done".into();
                    // the first way is the build's own engine: the GPU in the Metal and Vulkan builds, else the CPU
                    let gpu_build = cfg!(any(target_os = "macos", feature = "vulkan", feature = "cuda"));
                    j.mode = if mode == 0 && !gpu_build { "CPU".into() } else { label.into() };
                    j.seconds = j.started.map(|t| t.elapsed().as_secs_f64()).unwrap_or(0.0);
                    // how it was made, next to the file (<id>.json): the Inference pages show it and "Use these
                    // settings" makes it again; listed with the file by /local/content
                    let meta = json!({"kind": if video { "video" } else { "image" }, "prompt": req["prompt"], "negative": req["negative"],
                        "model": model, "model_name": m["name"], "width": req["width"], "height": req["height"], "steps": want,
                        "seed": req["seed"], "frames": req["frames"], "seconds": (j.seconds * 10.0).round() / 10.0, "ran_on": j.mode,
                        "retried": j.tries.len(), "made_at": now_ms(), "app": env!("CARGO_PKG_VERSION")});
                    let _ = std::fs::write(j.file.with_extension("json"), meta.to_string());
                    self.made.lock().unwrap().push((j.file.clone(), meta));
                    break;
                }
                Err(e) if mode + 1 < MODES.len() => {
                    j.tries.push(format!("{label}: {e}"));
                    j.state = "loading".into();
                    j.step = 0;
                    j.steps = 0;
                }
                Err(e) => {
                    j.state = "error".into();
                    j.error = e;
                    j.seconds = j.started.map(|t| t.elapsed().as_secs_f64()).unwrap_or(0.0);
                }
            }
        }
        self.save_queue();
    }

    /// Run the engine once; Ok when it made the picture.
    fn attempt(&self, exe: &PathBuf, a: &[String], id: &str) -> Result<(), String> {
        let mut envs: Vec<(String, String)> = Vec::new();
        // a size the engine had to make larger (1920 x 1080 -> 1088): its patched sd-cli cuts every picture or video
        // frame to the size asked for (scripts/patch_sd_cli.py); crop_png is the fallback for pictures
        let asked = self.jobs.lock().unwrap().get(id).map(|j| (j.req["width"].as_u64(), j.req["height"].as_u64()));
        let arg = |k: &str| a.iter().position(|x| x == k).and_then(|i| a.get(i + 1)).and_then(|v| v.parse::<u64>().ok());
        if let (Some((Some(w), Some(h))), Some(rw), Some(rh)) = (asked, arg("-W"), arg("-H")) {
            if (w, h) != (rw, rh) {
                envs.push(("PC_CROP".into(), format!("{w}x{h}")));
            }
        }
        // the prompt and "leave out" text go in the engine's environment, never on its command line: any user of the
        // computer can list command lines (ps), only the engine's own user can read its environment (user 2026-10-31,
        // a shared server; the patched sd-cli reads PC_PROMPT / PC_NEGATIVE, scripts/patch_sd_cli.py)
        let (a, private) = private_prompt(a);
        envs.extend(private);
        let _making = Making::start(); // until this attempt ends (made, failed or stopped)
        // in the operating system's sandbox (sandbox.rs): the models to read, the pictures folder to write, no network
        let io = crate::sandbox::Io { stdin: false, stdout: true, stderr: true };
        let mut child = crate::sandbox::spawn(exe, &a, &envs, &crate::sandbox::Rules::image(), io)
            .map_err(|e| format!("could not start the image engine: {e}"))?;
        let (so, se) = (child.stdout.take(), child.stderr.take());
        *self.child.lock().unwrap() = Some((id.to_string(), child));
        if self.jobs.lock().unwrap().get(id).is_some_and(|j| j.state == "cancelled") {
            self.stop(id); // Stop was pressed between two tries
        }
        let tail = Arc::new(Mutex::new(String::new()));
        let mut readers = Vec::new();
        for pipe in [so, se].into_iter().flatten() {
            let (me, id, tail) = (self.clone(), id.to_string(), tail.clone());
            readers.push(std::thread::spawn(move || me.read(pipe, &id, &tail)));
        }
        for r in readers {
            let _ = r.join();
        }
        let status = self.child.lock().unwrap().take().map(|(_, mut c)| c.wait());
        let file = self.jobs.lock().unwrap().get(id).map(|j| j.file.clone()).unwrap_or_default();
        if matches!(status, Some(Ok(ref s)) if s.ok) && file.exists() {
            return Ok(());
        }
        // the engine's own error lines ("[E] ...", or naming an error / failure), the last few; else its last lines
        let t = tail.lock().unwrap();
        let bad = |l: &&str| {
            let x = l.to_ascii_lowercase();
            l.trim_start().starts_with("[E]") || l.contains("ERROR") || x.contains("error") || x.contains("failed") || x.contains("out of memory") || x.contains("is nil")
        };
        let mut lines: Vec<&str> = t.lines().rev().filter(bad).take(3).collect();
        if lines.is_empty() {
            lines = t.lines().rev().filter(|l| !l.trim().is_empty()).take(2).collect();
        }
        lines.reverse();
        let why = lines.iter().map(|l| l.trim()).collect::<Vec<_>>().join(" | ");
        let code = match status {
            Some(Ok(s)) if !s.ok => format!(" (exit {})", s.code.map_or("signal".to_string(), |c| c.to_string())),
            _ => String::new(),
        };
        Err(if why.is_empty() { format!("the image engine stopped{code}") } else { format!("{}{code}", why.chars().take(600).collect::<String>()) })
    }

    /// Follow one of the engine's outputs: progress lines end in \r, the rest in \n.
    fn read(&self, mut pipe: Box<dyn Read + Send>, id: &str, tail: &Mutex<String>) {
        let (mut buf, mut line) = ([0u8; 4096], Vec::new());
        loop {
            let n = match pipe.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            for &b in &buf[..n] {
                if b != b'\r' && b != b'\n' {
                    line.push(b);
                    continue;
                }
                let l = String::from_utf8_lossy(&line).to_string();
                line.clear();
                if l.trim().is_empty() {
                    continue;
                }
                if let Some((n, d)) = progress(&l) {
                    if let Some(j) = self.jobs.lock().unwrap().get_mut(id) {
                        if j.state == "cancelled" {
                            continue;
                        }
                        // the counter with the steps asked for is the drawing; one before it is the preparation,
                        // one after it the picture being decoded in tiles
                        if d == j.want && j.state != "decoding" {
                            j.state = "sampling".into();
                            j.step = n;
                            j.steps = d;
                        } else if j.state == "sampling" && j.step == j.steps {
                            j.state = "decoding".into();
                        }
                    }
                } else {
                    let mut t = tail.lock().unwrap();
                    t.push_str(&l);
                    t.push('\n');
                    if t.len() > 8000 {
                        let cut = t.len() - 4000;
                        let cut = (cut..t.len()).find(|&i| t.is_char_boundary(i)).unwrap_or(t.len());
                        *t = t[cut..].to_string();
                    }
                }
            }
        }
    }
}

/// Stop the image engine when the program ends (it is started again from the queue next time).
pub(crate) fn stop_engines() {
    QUITTING.store(true, Ordering::SeqCst); // first, so the worker does not take the stop for a failure
    stop_leftover_engines();
}

/// Stop an image engine left running by an earlier copy of the program (its parent was closed or replaced).
fn stop_leftover_engines() {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill").args(["/F", "/IM", "sd-cli-*"]).creation_flags(0x0800_0000).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    #[cfg(not(windows))]
    {
        let prefix = data().join("bin").join("sd-cli-");
        let _ = Command::new("pkill").args(["-f", &prefix.to_string_lossy()]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
}

#[cfg(test)]
mod tests {
    use super::{args, crop_png, progress, refused};
    use serde_json::json;
    // WorkPacks step aside while a picture is being made here, and come back when it ends (even if it failed)
    #[test]
    fn workpacks_wait_while_a_picture_is_made() {
        assert!(!super::making());
        {
            let _m = super::Making::start();
            assert!(super::making());
        }
        assert!(!super::making());
    }

    // the prompt never on the engine's command line (user 2026-10-31: a shared server shows command lines to every user)
    #[test]
    fn prompt_goes_in_the_environment_not_the_command_line() {
        let a: Vec<String> = ["--diffusion-model", "m.gguf", "-p", "a fox -n in snow", "-W", "512", "-n", "blurry", "--steps", "8"].iter().map(|x| x.to_string()).collect();
        let (out, envs) = super::private_prompt(&a);
        assert_eq!(out, ["--diffusion-model", "m.gguf", "-W", "512", "--steps", "8"]);
        assert_eq!(envs, vec![("PC_PROMPT".to_string(), "a fox -n in snow".to_string()), ("PC_NEGATIVE".to_string(), "blurry".to_string())]);
        assert!(!out.iter().any(|x| x.contains("fox") || x == "-p"));
        // the arguments the program really builds for a Z-Image picture
        let m = serde_json::json!({"id": "zimage-turbo-q4k", "kind": "image", "engine": "sd", "file": "z.gguf"});
        if let Ok(full) = super::args(&m, &serde_json::json!({"prompt": "a secret lighthouse", "width": 512, "height": 512}), &std::path::PathBuf::from("o.png")) {
            let (out, envs) = super::private_prompt(&full);
            assert!(!out.iter().any(|x| x.contains("secret")));
            assert!(envs.iter().any(|(k, v)| k == "PC_PROMPT" && v == "a secret lighthouse"));
        }
    }

    #[test]
    fn refuses_sexual_prompts_only() {
        assert!(refused("A NUDE woman on a beach").is_some());
        assert!(refused("portrait, nsfw").is_some());
        assert!(refused("A red fox in fresh snow, morning light").is_none());
        assert!(refused("Essex countryside, a sextant on a table").is_none());   // whole words only
    }
    #[test]
    fn sizes_between_multiples_are_made_larger() {
        let m = json!({"family": "sd1", "id": "s", "file": "s.gguf"});
        let a = |w: u64, h: u64| args(&m, &json!({"prompt": "x", "width": w, "height": h}), &std::path::PathBuf::from("o.png"));
        let at = |v: &Vec<String>, k: &str| v[v.iter().position(|x| x == k).unwrap() + 1].clone();
        let v = a(1920, 1080).unwrap();
        assert_eq!((at(&v, "-W"), at(&v, "-H")), ("1920".to_string(), "1088".to_string()));
        let v = a(1024, 1024).unwrap();
        assert_eq!((at(&v, "-W"), at(&v, "-H")), ("1024".to_string(), "1024".to_string()));
        let v = a(1080, 1350).unwrap();
        assert_eq!((at(&v, "-W"), at(&v, "-H")), ("1088".to_string(), "1408".to_string()));
        let z = json!({"family": "zimage", "id": "z", "file": "z.gguf"});
        let v = args(&z, &json!({"prompt": "x", "width": 1080, "height": 1350}), &std::path::PathBuf::from("o.png")).unwrap();
        assert_eq!((at(&v, "-W"), at(&v, "-H")), ("1088".to_string(), "1360".to_string()));
        assert!(a(1920, 1081).is_err());
    }
    #[test]
    fn cuts_png_to_the_size_asked_for() {
        let p = std::env::temp_dir().join(format!("pc-crop-{}.png", std::process::id()));
        let (w, h) = (64u32, 40u32);
        let mut px = vec![0u8; (w * h * 3) as usize];
        for y in 0..h {
            for x in 0..w {
                px[((y * w + x) * 3) as usize] = y as u8; // red = the row
            }
        }
        {
            let mut e = png::Encoder::new(std::io::BufWriter::new(std::fs::File::create(&p).unwrap()), w, h);
            e.set_color(png::ColorType::Rgb);
            e.set_depth(png::BitDepth::Eight);
            let mut wr = e.write_header().unwrap();
            wr.write_image_data(&px).unwrap();
            wr.finish().unwrap();
        }
        crop_png(&p, 64, 32).unwrap();
        let mut r = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(&p).unwrap())).read_info().unwrap();
        let mut buf = vec![0; r.output_buffer_size().unwrap()];
        let info = r.next_frame(&mut buf).unwrap();
        assert_eq!((info.width, info.height), (64, 32));
        assert_eq!(buf[0], 4); // the first row kept is row 4: 4 rows cut from the top, 4 from the bottom
        let _ = std::fs::remove_file(&p);
    }
    #[test]
    fn reads_progress() {
        assert_eq!(progress("  |=========>     | 3/20 - 1.23s/it\u{1b}[K"), Some((3, 20)));
        assert_eq!(progress("|==================================================| 20/20 - 7.95it/s"), Some((20, 20)));
        assert_eq!(progress("[INFO ] loading model from 'x.gguf'"), None);
        assert_eq!(progress("| 5/0 -"), None);
    }
}
