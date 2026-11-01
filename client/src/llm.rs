// Harness on this computer: llama.cpp runs the chat models (until the PlanetCompute grid takes the requests).
// One model is loaded at a time; requests wait their turn (at most QUEUE of them). Tokens stream back as text pieces
// (whole UTF-8 characters only). The GPU is used when the build has one (Metal on macOS, the Vulkan builds).
//
// Security review E5: model files come from many places, and llama.cpp's file reader has had memory bugs. So a model
// is never opened inside this program: a second copy of it, started with --llm-worker, does all llama.cpp work. It
// holds no sign-in and serves nothing; it reads one job per line on its input and writes JSON lines on its output.
// A damaged or hostile file can crash only that copy: the request fails, and the next one starts a new copy.

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{LlamaChatMessage, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::num::NonZeroU32;
use std::path::PathBuf;
use tokio::sync::mpsc::UnboundedSender;

const CHUNK: usize = 512; // prompt tokens per decode call
const QUEUE: usize = 16; // requests that may wait for the model (security review E6: no unlimited queue)
pub const WORKER_FLAG: &str = "--llm-worker";

pub struct Job {
    pub model_id: String,
    pub path: PathBuf,
    pub messages: Vec<(String, String)>, // (role, content)
    pub max_tokens: usize,
    pub temperature: f32,
    pub top_p: f32,
    pub seed: u32,
    pub threads: i32, // 0 = every core; a grid job: the cores this computer shares (two copies on one server do not fight)
    pub out: UnboundedSender<Event>,
}

pub enum Event {
    Text(String),
    Done { prompt_tokens: usize, completion_tokens: usize, finish: &'static str },
    Error(String),
}

pub struct Llm {
    jobs: std::sync::mpsc::SyncSender<Job>,
}

impl Llm {
    pub fn start() -> Llm {
        let (jobs, rx) = std::sync::mpsc::sync_channel::<Job>(QUEUE);
        std::thread::spawn(move || {
            let mut worker: Option<Worker> = None;
            for job in rx {
                if !worker.as_mut().is_some_and(|w| w.alive()) {
                    worker = match Worker::spawn() {
                        Ok(w) => Some(w),
                        Err(e) => {
                            let _ = job.out.send(Event::Error(e));
                            continue;
                        }
                    };
                }
                let w = worker.as_mut().expect("worker");
                if let Err(e) = w.run(&job) {
                    let _ = job.out.send(Event::Error(e));
                    if let Some(mut w) = worker.take() {
                        w.child.kill(); // a new copy for the next request
                        let _ = w.child.wait();
                    }
                }
            }
        });
        Llm { jobs }
    }

    pub fn submit(&self, job: Job) {
        match self.jobs.try_send(job) {
            Ok(()) => {}
            Err(std::sync::mpsc::TrySendError::Full(j)) => {
                let _ = j.out.send(Event::Error(format!("the model is busy: {QUEUE} requests are already waiting, try again shortly")));
            }
            Err(std::sync::mpsc::TrySendError::Disconnected(j)) => {
                let _ = j.out.send(Event::Error("the model runner stopped".into()));
            }
        }
    }
}

/// The second copy of this program that runs llama.cpp (see the top of this file).
struct Worker {
    child: crate::sandbox::Proc,
    input: Box<dyn Write + Send>,
    output: BufReader<Box<dyn Read + Send>>,
    /// the engine's last error lines (shown when it stops)
    errors: std::sync::Arc<std::sync::Mutex<String>>,
}

impl Worker {
    fn spawn() -> Result<Worker, String> {
        let exe = std::env::current_exe().map_err(|e| format!("cannot start the model engine: {e}"))?;
        // in the operating system's sandbox (sandbox.rs): the models to read, nothing to write, no network
        let io = crate::sandbox::Io { stdin: true, stdout: true, stderr: true };
        let mut child = crate::sandbox::spawn(&exe, &[WORKER_FLAG.to_string()], &[], &crate::sandbox::Rules::llm(), io)
            .map_err(|e| format!("cannot start the model engine: {e}"))?;
        let input = child.stdin.take().ok_or("the model engine has no input")?;
        let output = BufReader::new(child.stdout.take().ok_or("the model engine has no output")?);
        // its error output: the last few kilobytes are kept, to say why it stopped
        let errors = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        if let Some(e) = child.stderr.take() {
            let keep = errors.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(e).lines() {
                    let Ok(line) = line else { break };
                    let mut k = keep.lock().unwrap();
                    k.push_str(&line);
                    k.push('\n');
                    if k.len() > 4096 {
                        let cut = k.len() - 2048;
                        let cut = (cut..k.len()).find(|&i| k.is_char_boundary(i)).unwrap_or(0);
                        k.drain(..cut);
                    }
                }
            });
        }
        Ok(Worker { child, input, output, errors })
    }

    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// One job: sent as one line; the answer comes back as "text" lines, then "done" or "error". Err only when the
    /// engine itself failed (it is then replaced).
    fn run(&mut self, job: &Job) -> Result<(), String> {
        let msgs: Vec<Value> = job.messages.iter().map(|(r, c)| json!([r, c])).collect();
        let line = json!({"model_id": job.model_id, "path": job.path, "messages": msgs, "max_tokens": job.max_tokens,
            "temperature": job.temperature, "top_p": job.top_p, "seed": job.seed, "threads": job.threads});
        writeln!(self.input, "{line}").and_then(|_| self.input.flush()).map_err(|_| "the model engine stopped".to_string())?;
        let mut buf = String::new();
        loop {
            buf.clear();
            if self.output.read_line(&mut buf).map_err(|e| e.to_string())? == 0 {
                std::thread::sleep(std::time::Duration::from_millis(200)); // its last error lines
                let k = self.errors.lock().unwrap();
                let last: Vec<&str> = k.lines().rev().filter(|l| !l.trim().is_empty()).take(3).collect();
                let why = last.into_iter().rev().collect::<Vec<_>>().join(" | ");
                return Err(if why.is_empty() {
                    "the model engine stopped while answering (the model file may be damaged)".into()
                } else {
                    format!("the model engine stopped while answering: {}", why.chars().take(500).collect::<String>())
                });
            }
            let Ok(v) = serde_json::from_str::<Value>(buf.trim()) else { continue }; // anything else on the output: not ours
            match v["t"].as_str().unwrap_or("") {
                "text" => {
                    let _ = job.out.send(Event::Text(v["s"].as_str().unwrap_or("").to_string()));
                }
                "done" => {
                    let finish = match v["finish"].as_str().unwrap_or("") {
                        "stop" => "stop",
                        "cancelled" => "cancelled",
                        _ => "length",
                    };
                    let n = |k: &str| v[k].as_u64().unwrap_or(0) as usize;
                    let _ = job.out.send(Event::Done { prompt_tokens: n("prompt_tokens"), completion_tokens: n("completion_tokens"), finish });
                    return Ok(());
                }
                "error" => {
                    let _ = job.out.send(Event::Error(v["e"].as_str().unwrap_or("error").to_string()));
                    return Ok(());
                }
                _ => {}
            }
        }
    }
}

/// `planetCompute --llm-worker`: the model engine copy. Jobs on its input, answers on its output, until the input ends.
pub fn worker_main() -> i32 {
    // its own extra lock, before anything else runs in it: it may not start programs (sandbox.rs)
    if let Err(e) = crate::sandbox::worker_lock() {
        eprintln!("planetCompute: the model engine could not lock itself in: {e}");
        return 97;
    }
    let mut out = std::io::stdout();
    let mut say = |v: Value| -> bool { writeln!(out, "{v}").and_then(|_| out.flush()).is_ok() };
    let mut loaded: Option<(String, LlamaModel)> = None;
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let job = Spec {
            model_id: v["model_id"].as_str().unwrap_or("").to_string(),
            path: PathBuf::from(v["path"].as_str().unwrap_or("")),
            messages: v["messages"].as_array().into_iter().flatten()
                .map(|m| (m[0].as_str().unwrap_or("user").to_string(), m[1].as_str().unwrap_or("").to_string())).collect(),
            max_tokens: v["max_tokens"].as_u64().unwrap_or(256) as usize,
            temperature: v["temperature"].as_f64().unwrap_or(0.8) as f32,
            top_p: v["top_p"].as_f64().unwrap_or(0.95) as f32,
            seed: v["seed"].as_u64().unwrap_or(0) as u32,
            threads: v["threads"].as_i64().unwrap_or(0) as i32,
        };
        if !matches!(&loaded, Some((id, _)) if *id == job.model_id) {
            loaded = None; // free the previous model first
            match load(&job.path) {
                Ok(m) => loaded = Some((job.model_id.clone(), m)),
                Err(e) => {
                    say(json!({"t": "error", "e": e}));
                    continue;
                }
            }
        }
        let model = &loaded.as_ref().expect("loaded").1;
        let r = generate(model, &job, &mut |text: String| say(json!({"t": "text", "s": text})));
        if !say(match r {
            Ok((p, c, finish)) => json!({"t": "done", "prompt_tokens": p, "completion_tokens": c, "finish": finish}),
            Err(e) => json!({"t": "error", "e": e}),
        }) {
            break; // the program went away
        }
    }
    0
}

/// A job as the engine copy reads it.
struct Spec {
    model_id: String,
    path: PathBuf,
    messages: Vec<(String, String)>,
    max_tokens: usize,
    temperature: f32,
    top_p: f32,
    seed: u32,
    threads: i32,
}

fn load(path: &std::path::Path) -> Result<LlamaModel, String> {
    let backend = crate::engine::backend()?;
    LlamaModel::load_from_file(backend, path, &LlamaModelParams::default()).map_err(|e| format!("cannot load the model: {e}"))
}

fn threads(asked: i32) -> i32 {
    let all = std::thread::available_parallelism().map(|n| n.get() as i32).unwrap_or(4);
    if asked > 0 { asked.min(all) } else { all }
}

/// emit(text) returns false when nobody is listening any more (the program went away).
fn generate(model: &LlamaModel, job: &Spec, emit: &mut dyn FnMut(String) -> bool) -> Result<(usize, usize, &'static str), String> {
    let backend = crate::engine::backend()?;
    let tmpl = model.chat_template(None).map_err(|e| format!("the model has no chat template: {e}"))?;
    let msgs = job
        .messages
        .iter()
        .map(|(r, c)| LlamaChatMessage::new(r.clone(), c.clone()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let prompt = model.apply_chat_template(&tmpl, &msgs, true).map_err(|e| e.to_string())?;
    let vocab = model.vocab();
    // the chat template already writes the begin-of-text token where a model needs one
    let tokens = vocab.tokenize(prompt.as_bytes(), false, true);
    if tokens.is_empty() {
        return Err("empty prompt".into());
    }
    let n_ctx = (tokens.len() + job.max_tokens + 8).clamp(512, model.n_ctx_train().max(512) as usize);
    if tokens.len() + 1 >= n_ctx {
        return Err(format!("the conversation is too long for this model ({} tokens, at most {n_ctx})", tokens.len()));
    }
    let params = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(n_ctx as u32))
        .with_n_batch(CHUNK as u32)
        .with_n_threads(threads(job.threads))
        .with_n_threads_batch(threads(job.threads));
    let mut ctx = model.new_context(backend, params).map_err(|e| format!("cannot start the model: {e}"))?;

    let mut batch = LlamaBatch::new(CHUNK, 1);
    for (i, chunk) in tokens.chunks(CHUNK).enumerate() {
        batch.clear();
        for (j, t) in chunk.iter().enumerate() {
            let pos = i * CHUNK + j;
            batch.add(*t, pos as i32, &[0], pos + 1 == tokens.len()).map_err(|e| e.to_string())?;
        }
        ctx.decode(&mut batch).map_err(|e| format!("decode: {e}"))?;
    }

    let mut sampler = if job.temperature <= 0.0 {
        LlamaSampler::greedy()
    } else {
        LlamaSampler::chain_simple([LlamaSampler::top_p(job.top_p.clamp(0.01, 1.0), 1), LlamaSampler::temp(job.temperature), LlamaSampler::dist(job.seed)])
    };
    let (mut pos, mut produced, mut pending) = (tokens.len(), 0usize, Vec::<u8>::new());
    let finish = loop {
        let tok = sampler.sample(&ctx, batch.n_tokens() - 1); // samples and accepts
        if vocab.is_eog(tok) {
            break "stop";
        }
        pending.extend(vocab.token_to_piece(tok, false, None));
        let whole = match std::str::from_utf8(&pending) {
            Ok(s) => s.len(),
            Err(e) => e.valid_up_to(),
        };
        if whole > 0 {
            let text = String::from_utf8(pending.drain(..whole).collect()).unwrap_or_default();
            if !emit(text) {
                break "cancelled"; // the caller went away
            }
        }
        produced += 1;
        if produced >= job.max_tokens || pos + 1 >= n_ctx {
            break "length";
        }
        batch.clear();
        batch.add(tok, pos as i32, &[0], true).map_err(|e| e.to_string())?;
        pos += 1;
        ctx.decode(&mut batch).map_err(|e| format!("decode: {e}"))?;
    };
    Ok((tokens.len(), produced, finish))
}
