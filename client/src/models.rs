// Harness models. Every model lives in <data>/planetCompute/models/<id>/ : its GGUF file and model.json (name,
// where it came from, SHA-256, verified or not). Sources:
//   the PlanetCompute library   the site's list (GET /api/models; the copy built into the program when the site
//                               cannot be reached); files come through planetcompute.ai (signed in), else from the
//                               model's publisher
//   Hugging Face                a repo and one of its .gguf files (SHA-256 from Hugging Face)
//   Ollama                      a name such as llama3.2:3b (SHA-256 = the blob's name)
//   a link                      GitHub (release files, files in a repo), Dropbox, Google Drive or any web
//                               address; checked against a SHA-256 if one is given (GitHub gives one for release
//                               files), otherwise the computed one is recorded and the model is "not verified"
// resolve() takes whatever was pasted (a name, a repo, any of those web addresses) and lists what can be downloaded.
// Every file must start with the GGUF signature (or be safetensors where the library says so), and must match its
// SHA-256 when one is known, or it is deleted.
// Downloads resume where they stopped.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;

const CATALOG: &str = include_str!("../../models/catalog.json");
const UA: &str = concat!("planetCompute/", env!("CARGO_PKG_VERSION"));

fn builtin() -> Vec<Value> {
    serde_json::from_str::<Value>(CATALOG).ok().and_then(|v| v["models"].as_array().cloned()).unwrap_or_default()
}

pub fn dir() -> PathBuf {
    dirs::data_dir().unwrap_or_else(std::env::temp_dir).join("planetCompute").join("models")
}

fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or("").to_string()
}

pub fn path_of(m: &Value) -> PathBuf {
    dir().join(safe_name(&s(m, "id"))).join(safe_name(&s(m, "file")))
}

/// Security review E2: a model's ID and file name become names inside the models folder, never paths. Only letters,
/// digits, ".", "_" and "-" (no "/", "\\", ":" or "..", so not "C:" or "..\\x" on Windows); anything else becomes "_".
pub fn safe_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or("");
    let mut out: String = last.chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' }).collect();
    while out.starts_with('.') {
        out.remove(0);
    }
    while out.contains("..") {
        out = out.replace("..", ".");
    }
    if out.is_empty() { "model".into() } else { out.chars().take(150).collect() }
}

/// An ID as given (from a request) is accepted only if it already is a safe name.
pub fn id_ok(id: &str) -> bool {
    !id.is_empty() && safe_name(id) == id
}

/// Security review E5: a model added from Hugging Face, Ollama or a link (not the PlanetCompute library, whose files
/// are checked by SHA-256 against the publisher's) is used only when the person allows such files (Models tab).
/// Library models also download from Hugging Face or Ollama, so the test is the built-in catalog: same id, file and SHA-256.
pub fn outside_library(m: &Value) -> bool {
    let sha = s(m, "sha256");
    !builtin().iter().any(|b| b["id"] == m["id"] && b["file"] == m["file"] && !sha.is_empty() && s(b, "sha256") == sha)
}

fn allow_file() -> PathBuf {
    dir().parent().map(|d| d.join("allow_outside_models")).unwrap_or_else(|| dir().join("allow_outside_models"))
}

pub fn allow_outside() -> bool {
    std::fs::read_to_string(allow_file()).map(|s| s.trim() == "1").unwrap_or(false)
}

pub fn set_allow_outside(on: bool) -> Result<(), String> {
    let f = allow_file();
    if let Some(d) = f.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    std::fs::write(f, if on { "1" } else { "0" }).map_err(|e| e.to_string())
}

/// Ready = the file is complete (its size when known; it was checked when it finished downloading).
pub fn installed(m: &Value) -> bool {
    match std::fs::metadata(path_of(m)) {
        Ok(x) => m["bytes"].as_u64().map_or(true, |b| b == 0 || b == x.len()),
        Err(_) => false,
    }
}

fn slug(t: &str) -> String {
    let mut out = String::new();
    for c in t.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() || c == '.' {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').chars().take(80).collect()
}

/// Every model with a folder here (downloaded, downloading or stopped half way), from its model.json.
pub fn downloaded() -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir()) else { return out };
    for e in rd.flatten() {
        let d = e.path();
        let spec = std::fs::read_to_string(d.join("model.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .or_else(|| builtin().into_iter().find(|m| m["id"] == e.file_name().to_string_lossy().as_ref()));
        if let Some(m) = spec {
            out.push(m);
        }
    }
    out.sort_by_key(|m| s(m, "name").to_lowercase());
    out
}

/// A downloaded model by id (for /v1/chat/completions).
pub fn find(id: &str) -> Option<Value> {
    downloaded().into_iter().find(|m| m["id"] == id)
}

/// "text" (llama.cpp), "image" or "video" (stable-diffusion.cpp), or "image-part" / "video-part" (a file such a
/// model needs).
pub fn kind_of(m: &Value) -> String {
    let k = s(m, "kind");
    if k.is_empty() { "text".into() } else { k }
}

/// The files an image or video model needs besides its own, as (role, path), every one downloaded.
pub fn parts_of(m: &Value) -> Result<Vec<(String, PathBuf)>, String> {
    let mut out = Vec::new();
    for id in m["needs"].as_array().cloned().unwrap_or_default() {
        let id = id.as_str().unwrap_or("");
        let p = find(id).filter(installed).ok_or_else(|| format!("{} needs {id}: download it again to finish", s(m, "name")))?;
        // the model may name the part's role itself: a shared file such as the chat model Qwen3 4B, used as a text encoder
        let role = m["roles"][id].as_str().map(str::to_string).unwrap_or_else(|| s(&p, "role"));
        out.push((role, path_of(&p)));
    }
    Ok(out)
}

fn disk_used(m: &Value) -> u64 {
    let p = path_of(m);
    let a = std::fs::metadata(&p).map(|x| x.len()).unwrap_or(0);
    let b = std::fs::metadata(p.with_extension("part")).map(|x| x.len()).unwrap_or(0);
    a + b
}

fn free_space() -> u64 {
    let mut d = dir();
    while !d.exists() {
        if !d.pop() {
            return 0;
        }
    }
    fs2::available_space(&d).unwrap_or(0)
}

#[derive(Clone, Default)]
pub struct Progress {
    pub state: String, // "downloading", "verifying", "error"
    pub done: u64,
    pub error: String,
}

/// One place a file can come from: a label, the address, and extra request headers.
pub struct Source(pub String, pub String, pub Vec<(String, String)>);

#[derive(Clone, Default)]
pub struct Downloads {
    busy: Arc<Mutex<HashMap<String, Progress>>>,
    library: Arc<Mutex<Option<(Vec<Value>, Instant)>>>,
}

impl Downloads {
    fn set(&self, id: &str, p: Progress) {
        self.busy.lock().unwrap().insert(id.to_string(), p);
    }
    fn update(&self, id: &str, f: impl FnOnce(&mut Progress)) {
        if let Some(p) = self.busy.lock().unwrap().get_mut(id) {
            f(p);
        }
    }

    /// The PlanetCompute library: the site's list (refreshed every 10 minutes), else the built-in one.
    pub async fn library(&self, http: &reqwest::Client) -> Vec<Value> {
        let cached = self.library.lock().unwrap().clone();
        if let Some((l, at)) = cached {
            if at.elapsed() < Duration::from_secs(600) {
                return l;
            }
        }
        let fresh = match http.get(format!("{}/api/models", crate::api::SITE)).send().await {
            Ok(r) if r.status().is_success() => r
                .bytes()
                .await
                .ok()
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                .and_then(|v| v["models"].as_array().cloned())
                .filter(|l| !l.is_empty()),
            _ => None,
        };
        // the built-in entries the site does not list (yet) are added: new kinds of model (images) reach this
        // build before the site's catalog, which older builds also read, lists them
        let l = match fresh {
            Some(mut l) => {
                for b in builtin() {
                    if !l.iter().any(|m| m["id"] == b["id"]) {
                        l.push(b);
                    }
                }
                l
            }
            None => builtin(),
        };
        *self.library.lock().unwrap() = Some((l.clone(), Instant::now()));
        l
    }

    fn state_of(&self, m: &Value) -> Value {
        let id = s(m, "id");
        let busy = self.busy.lock().unwrap().get(&id).cloned();
        let (state, done, error) = match busy {
            Some(p) => (p.state, p.done, p.error),
            None if installed(m) => ("ready".to_string(), disk_used(m), String::new()),
            None if disk_used(m) > 0 => ("stopped".to_string(), disk_used(m), String::new()),
            None => ("absent".to_string(), 0, String::new()),
        };
        json!({"state": state, "done": done, "error": error})
    }

    /// The Harness tab: the library, what is downloaded (with disk use), total disk use and free space.
    pub async fn list(&self, http: &reqwest::Client) -> Value {
        let lib: Vec<Value> = self
            .library(http)
            .await
            .into_iter()
            .map(|m| {
                let st = self.state_of(&m);
                json!({"id": m["id"], "name": m["name"], "category": m["category"], "bytes": m["bytes"], "minRamGB": m["minRamGB"],
                       "license": m["license"], "kind": kind_of(&m), "needs": m["needs"], "partOf": m["partOf"], "note": m["note"],
                       "recommended": m["recommended"], "agreement": m["agreement"],
                       "state": st["state"], "done": st["done"], "error": st["error"]})
            })
            .collect();
        let mut used = 0u64;
        let down: Vec<Value> = downloaded()
            .into_iter()
            .map(|m| {
                let st = self.state_of(&m);
                let disk = disk_used(&m);
                used += disk;
                json!({"id": m["id"], "name": m["name"], "bytes": m["bytes"], "disk": disk, "from": m["from"],
                       "verified": m["verified"].as_bool().unwrap_or(true), "outside": outside_library(&m), "sha256": m["sha256"],
                       "kind": kind_of(&m), "family": m["family"], "needs": m["needs"], "partOf": m["partOf"],
                       "size": m["size"], "steps": m["steps"],
                       "state": st["state"], "done": st["done"], "error": st["error"]})
            })
            .collect();
        json!({"library": lib, "downloaded": down, "used": used, "free": free_space(), "dir": dir().to_string_lossy(), "allow_outside": allow_outside()})
    }

    /// Record the model (model.json) and download it from the first source that works.
    pub fn start(&self, mut m: Value, sources: Vec<Source>, http: reqwest::Client) -> Result<(), String> {
        let id = s(&m, "id");
        if !id_ok(&id) || s(&m, "file").is_empty() {
            return Err("bad model description".into());
        }
        m["file"] = json!(safe_name(&s(&m, "file")));
        // security review E6: not a download that cannot fit (with 1 GB to spare)
        let need = m["bytes"].as_u64().unwrap_or(0);
        if need > 0 && free_space() < need + (1 << 30) {
            return Err(format!("not enough free disk space: this model needs {:.1} GB and 1 GB to spare", need as f64 / 1e9));
        }
        if installed(&m) {
            return Ok(());
        }
        {
            let mut g = self.busy.lock().unwrap();
            if g.get(&id).is_some_and(|p| p.state != "error") {
                return Ok(());
            }
            g.insert(id.clone(), Progress { state: "downloading".into(), ..Default::default() });
        }
        if m["verified"].is_null() {
            m["verified"] = json!(!s(&m, "sha256").is_empty());
        }
        let folder = dir().join(&id);
        std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        std::fs::write(folder.join("model.json"), serde_json::to_string_pretty(&m).unwrap_or_default()).map_err(|e| e.to_string())?;
        let me = self.clone();
        tokio::spawn(async move {
            let mut last = String::new();
            for Source(name, url, headers) in sources {
                me.update(&id, |p| p.state = "downloading".into());
                match fetch(&me, &id, &m, &url, &headers, &http).await {
                    Ok(()) => {
                        me.busy.lock().unwrap().remove(&id);
                        return;
                    }
                    Err(e) => last = format!("{name}: {e}"),
                }
            }
            me.set(&id, Progress { state: "error".into(), error: last, ..Default::default() });
        });
        Ok(())
    }

    /// Remove a model from this computer (it can be downloaded again later).
    pub fn delete(&self, id: &str) -> Result<(), String> {
        if !id_ok(id) {                                    // security review E2 ("C:" passed the old check on Windows)
            return Err("bad id".into());
        }
        if self.busy.lock().unwrap().get(id).is_some_and(|p| p.state != "error") {
            return Err("it is downloading".into());
        }
        self.busy.lock().unwrap().remove(id);
        let d = dir().join(id);
        if d.exists() {
            // only ever a folder directly inside the models folder
            let (base, real) = (std::fs::canonicalize(dir()).map_err(|e| e.to_string())?, std::fs::canonicalize(&d).map_err(|e| e.to_string())?);
            if real.parent() != Some(base.as_path()) {
                return Err("bad id".into());
            }
            std::fs::remove_dir_all(&real).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

/// Where the library's file comes from at its publisher.
pub fn publisher_url(m: &Value) -> String {
    let src = &m["source"];
    if src["type"] == "ollama" {
        let name = s(src, "model");
        let name = name.split(':').next().unwrap_or("");
        format!("https://registry.ollama.ai/v2/library/{name}/blobs/sha256:{}", s(m, "sha256"))
    } else {
        format!("https://huggingface.co/{}/resolve/{}/{}", s(src, "repo"), s(src, "revision"), s(src, "file"))
    }
}

async fn get_json(http: &reqwest::Client, url: &str, accept: Option<&str>) -> Result<Value, String> {
    let mut rq = http.get(url).header("user-agent", UA);
    if let Some(a) = accept {
        rq = rq.header("accept", a);
    }
    let r = rq.send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("{} answered HTTP {}", url.split('/').nth(2).unwrap_or(""), r.status().as_u16()));
    }
    let b = r.bytes().await.map_err(|e| e.to_string())?;
    serde_json::from_slice(&b).map_err(|e| e.to_string())
}

/// The .gguf files of a Hugging Face repo, at its current revision.
pub async fn hf_files(http: &reqwest::Client, repo: &str) -> Result<Value, String> {
    let repo = repo.trim().trim_start_matches("https://huggingface.co/").trim_matches('/');
    let info = get_json(http, &format!("https://huggingface.co/api/models/{repo}/revision/main?blobs=true"), None).await?;
    let files: Vec<Value> = info["siblings"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|f| s(f, "rfilename").to_lowercase().ends_with(".gguf"))
        .map(|f| json!({"file": f["rfilename"], "bytes": f["size"], "sha256": f["lfs"]["sha256"]}))
        .collect();
    Ok(json!({"repo": repo, "revision": info["sha"], "files": files}))
}

/// A model from Hugging Face: repo + .gguf file, pinned to the current revision.
pub async fn from_hf(http: &reqwest::Client, repo: &str, file: &str) -> Result<(Value, Vec<Source>), String> {
    let l = hf_files(http, repo).await?;
    let f = l["files"].as_array().and_then(|a| a.iter().find(|x| x["file"] == file).cloned()).ok_or("that file is not in the repo")?;
    let (repo, rev) = (s(&l, "repo"), s(&l, "revision"));
    let m = json!({"id": format!("hf-{}", slug(&format!("{repo}-{}", file.trim_end_matches(".gguf")))), "name": file.trim_end_matches(".gguf"),
        "file": safe_name(file), "bytes": f["bytes"], "sha256": f["sha256"],
        "from": format!("Hugging Face: {repo}"), "source": {"type": "huggingface", "repo": repo, "file": file, "revision": rev}});
    let url = format!("https://huggingface.co/{repo}/resolve/{rev}/{file}");
    Ok((m, vec![Source("Hugging Face".into(), url, vec![])]))
}

/// A model from the Ollama registry: name[:tag] (library models) or user/name[:tag].
pub async fn from_ollama(http: &reqwest::Client, name: &str) -> Result<(Value, Vec<Source>), String> {
    let name = name.trim();
    let (repo, tag) = name.split_once(':').unwrap_or((name, "latest"));
    let path = if repo.contains('/') { repo.to_string() } else { format!("library/{repo}") };
    let man = get_json(http, &format!("https://registry.ollama.ai/v2/{path}/manifests/{tag}"), Some("application/vnd.docker.distribution.manifest.v2+json")).await?;
    let layer = man["layers"]
        .as_array()
        .and_then(|a| a.iter().find(|l| s(l, "mediaType").ends_with(".model")).cloned())
        .ok_or("no model layer in that Ollama manifest")?;
    let sha = s(&layer, "digest").trim_start_matches("sha256:").to_string();
    let m = json!({"id": format!("ollama-{}", slug(&format!("{repo}-{tag}"))), "name": format!("{repo}:{tag}"),
        "file": format!("{}.gguf", slug(&format!("{repo}-{tag}"))), "bytes": layer["size"], "sha256": sha,
        "from": format!("Ollama: {repo}:{tag}"), "source": {"type": "ollama", "model": format!("{repo}:{tag}")}});
    let url = format!("https://registry.ollama.ai/v2/{path}/blobs/sha256:{sha}");
    Ok((m, vec![Source("Ollama".into(), url, vec![])]))
}

/// A model from a link (Dropbox share links become direct downloads).
pub fn from_url(url: &str, sha256: &str, name: &str) -> Result<(Value, Vec<Source>), String> {
    let mut url = url.trim().to_string();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("give a web address (https://...)".into());
    }
    if url.contains("dropbox.com/") {
        url = if url.contains("dl=0") { url.replace("dl=0", "dl=1") } else if url.contains("dl=1") { url } else if url.contains('?') { url + "&dl=1" } else { url + "?dl=1" };
    }
    if let Some(id) = gdrive_id(&url) {
        url = format!("https://drive.usercontent.google.com/download?id={id}&export=download&confirm=t");
    }
    let file = safe_name(url.split('?').next().unwrap_or("").rsplit('/').next().unwrap_or("model"));
    let file = if file == "download" && !name.trim().is_empty() { slug(name) } else { file };
    let file = if file.to_lowercase().ends_with(".gguf") { file } else { format!("{}.gguf", slug(&file)) };
    let sha = sha256.trim().to_lowercase();
    if !sha.is_empty() && (sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_hexdigit())) {
        return Err("the SHA-256 must be 64 hexadecimal digits".into());
    }
    let tag = format!("{:x}", Sha256::digest(url.as_bytes()));
    let title = if name.trim().is_empty() { file.trim_end_matches(".gguf").to_string() } else { name.trim().to_string() };
    let host = url.split('/').nth(2).unwrap_or("").to_string();
    let m = json!({"id": format!("url-{}-{}", slug(&title), &tag[..8]), "name": title, "file": file, "bytes": 0, "sha256": sha,
        "verified": !sha.is_empty(), "from": link_label(&host), "source": {"type": "url", "url": url}});
    Ok((m, vec![Source(host, url, vec![])]))
}

fn link_label(host: &str) -> String {
    match host {
        "github.com" | "objects.githubusercontent.com" | "raw.githubusercontent.com" => "GitHub".into(),
        "drive.usercontent.google.com" | "drive.google.com" => "Google Drive".into(),
        h if h.ends_with("dropbox.com") || h.ends_with("dropboxusercontent.com") => "Dropbox".into(),
        h => format!("Link: {h}"),
    }
}

/// The file ID in a Google Drive share link (drive.google.com/file/d/<id>/... or ...?id=<id>).
fn gdrive_id(url: &str) -> Option<String> {
    if !url.contains("drive.google.com/") {
        return None;
    }
    let id = if let Some(i) = url.find("/file/d/") { url[i + 8..].split(['/', '?']).next() } else { url.split("id=").nth(1).and_then(|x| x.split('&').next()) };
    id.filter(|x| !x.is_empty()).map(str::to_string)
}

fn link_choice(url: &str, name: &str, bytes: Value, sha256: &str) -> Value {
    json!({"name": name, "bytes": bytes, "sha256": sha256, "add": {"source": "url", "url": url, "sha256": sha256, "name": name.trim_end_matches(".gguf")}})
}

/// The .gguf files of a Hugging Face repo (or just `only`) as download choices.
async fn hf_choices(http: &reqwest::Client, repo: &str, only: Option<&str>) -> Result<Value, String> {
    let l = hf_files(http, repo).await?;
    let repo = s(&l, "repo");
    let choices: Vec<Value> = l["files"].as_array().cloned().unwrap_or_default().into_iter()
        .filter(|f| only.map_or(true, |o| s(f, "file") == o))
        .map(|f| json!({"name": f["file"], "bytes": f["bytes"], "sha256": f["sha256"], "add": {"source": "huggingface", "repo": repo, "file": f["file"]}}))
        .collect();
    if choices.is_empty() {
        return Err(if only.is_some() { "that file is not in the repo".into() } else { "no .gguf files in that Hugging Face repo".into() });
    }
    Ok(json!({"kind": "huggingface", "label": format!("Hugging Face: {repo}"), "choices": choices}))
}

async fn ollama_choice(http: &reqwest::Client, name: &str) -> Result<Value, String> {
    let (m, _) = from_ollama(http, name).await?;
    Ok(json!({"kind": "ollama", "label": format!("Ollama: {}", s(&m, "name")),
        "choices": [{"name": m["name"], "bytes": m["bytes"], "sha256": m["sha256"], "add": {"source": "ollama", "model": m["name"]}}]}))
}

/// Whatever was pasted, as a list of files that can be downloaded: {kind, label, choices: [{name, bytes, add}]}.
/// `add` is the body for /local/models/add. Understands a Hugging Face repo (owner/name) or any huggingface.co
/// address, an Ollama name (llama3.2:3b) or ollama.com address, GitHub (a repo = its latest release, a release
/// page, a release file, a file in the repo), Dropbox, Google Drive and any other web address.
pub async fn resolve(http: &reqwest::Client, q: &str) -> Result<Value, String> {
    let q = q.trim().trim_end_matches('/');
    if q.is_empty() {
        return Err("paste a model name or a web address".into());
    }
    let is_url = q.starts_with("https://") || q.starts_with("http://");
    let host = if is_url { q.split('/').nth(2).unwrap_or("").trim_start_matches("www.").to_string() } else { String::new() };
    let path: Vec<&str> = if is_url { q.splitn(4, '/').nth(3).unwrap_or("").split('?').next().unwrap_or("").split('/').filter(|x| !x.is_empty()).collect() } else { vec![] };
    if !is_url {
        if q.contains(' ') {
            return Err("paste a model name (owner/repo, name:tag) or a web address".into());
        }
        // owner/repo is a Hugging Face repo, unless it has a tag (user/name:tag = Ollama)
        if q.matches('/').count() == 1 && !q.contains(':') {
            return match hf_choices(http, q, None).await {
                Ok(v) => Ok(v),
                Err(e) => ollama_choice(http, q).await.map_err(|_| e),
            };
        }
        return ollama_choice(http, q).await;
    }
    match host.as_str() {
        "huggingface.co" | "hf.co" if path.len() >= 2 => {
            let repo = format!("{}/{}", path[0], path[1]);
            // .../blob/<rev>/<file> or .../resolve/<rev>/<file>
            let only = if path.len() >= 5 && (path[2] == "blob" || path[2] == "resolve") { Some(path[4..].join("/")) } else { None };
            hf_choices(http, &repo, only.as_deref()).await
        }
        "ollama.com" if !path.is_empty() => {
            let name = if path[0] == "library" { path[1..].join("/") } else { path.join("/") };
            ollama_choice(http, &name).await
        }
        "github.com" if path.len() >= 2 => {
            let (o, r) = (path[0], path[1]);
            if path.get(2) == Some(&"releases") && path.get(3) == Some(&"download") {
                let name = path.last().unwrap_or(&"model").to_string();
                return Ok(json!({"kind": "github", "label": format!("GitHub: {o}/{r}"), "choices": [link_choice(q, &name, Value::Null, "")]}));
            }
            if path.get(2) == Some(&"blob") || path.get(2) == Some(&"raw") {
                let raw = format!("https://github.com/{o}/{r}/raw/{}", path[3..].join("/"));
                let name = path.last().unwrap_or(&"model").to_string();
                return Ok(json!({"kind": "github", "label": format!("GitHub: {o}/{r}"), "choices": [link_choice(&raw, &name, Value::Null, "")]}));
            }
            // the repo or a release page: the .gguf files of that release (the latest one for the repo)
            let api = match (path.get(2), path.get(3), path.get(4)) {
                (Some(&"releases"), Some(&"tag"), Some(t)) => format!("https://api.github.com/repos/{o}/{r}/releases/tags/{t}"),
                _ => format!("https://api.github.com/repos/{o}/{r}/releases/latest"),
            };
            let rel = get_json(http, &api, Some("application/vnd.github+json")).await.map_err(|_| format!("no release found in GitHub {o}/{r}"))?;
            let choices: Vec<Value> = rel["assets"].as_array().cloned().unwrap_or_default().into_iter()
                .filter(|a| s(a, "name").to_lowercase().ends_with(".gguf"))
                .map(|a| link_choice(&s(&a, "browser_download_url"), &s(&a, "name"), a["size"].clone(), s(&a, "digest").trim_start_matches("sha256:")))
                .collect();
            if choices.is_empty() {
                return Err(format!("the GitHub release {} has no .gguf files", s(&rel, "tag_name")));
            }
            Ok(json!({"kind": "github", "label": format!("GitHub: {o}/{r} {}", s(&rel, "tag_name")), "choices": choices}))
        }
        _ => {
            let (m, _) = from_url(q, "", "")?;
            Ok(json!({"kind": "url", "label": s(&m, "from"), "choices": [link_choice(q, &s(&m, "file"), Value::Null, "")]}))
        }
    }
}

/// Download (resuming a .part file), hash every byte, check the GGUF signature and the SHA-256, keep it only if right.
async fn fetch(dl: &Downloads, id: &str, m: &Value, url: &str, headers: &[(String, String)], http: &reqwest::Client) -> Result<(), String> {
    let total = m["bytes"].as_u64().unwrap_or(0);
    let want = s(m, "sha256");
    let path = path_of(m);
    let part = path.with_extension("part");
    let mut hasher = Sha256::new();
    let mut have = 0u64;
    // resume: re-hash what is already there, 8 MB at a time (models are up to tens of GB)
    let partial = tokio::fs::metadata(&part).await.map(|x| x.len()).unwrap_or(0);
    if partial > 0 && (total == 0 || partial < total) {
        let p = part.clone();
        let (h, n) = tokio::task::spawn_blocking(move || -> std::io::Result<(Sha256, u64)> {
            use std::io::Read;
            let (mut f, mut h, mut buf, mut n) = (std::fs::File::open(&p)?, Sha256::new(), vec![0u8; 8 << 20], 0u64);
            loop {
                let k = f.read(&mut buf)?;
                if k == 0 {
                    return Ok((h, n));
                }
                h.update(&buf[..k]);
                n += k as u64;
            }
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        hasher = h;
        have = n;
    }
    let mut rq = http.get(url).header("user-agent", UA);
    for (k, v) in headers {
        rq = rq.header(k.as_str(), v.as_str());
    }
    if have > 0 {
        rq = rq.header("range", format!("bytes={have}-"));
    }
    let mut r = rq.send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("HTTP {}", r.status().as_u16()));
    }
    if have > 0 && r.status().as_u16() != 206 {
        hasher = Sha256::new(); // the server ignored the range: start over
        have = 0;
    }
    let mut f = if have > 0 { tokio::fs::OpenOptions::new().append(true).open(&part).await } else { tokio::fs::File::create(&part).await }
        .map_err(|e| e.to_string())?;
    dl.update(id, |p| p.done = have);
    // the file must be what it says: GGUF ("GGUF" first), or safetensors (an 8-byte header length, then "{")
    let safetensors = s(m, "format") == "safetensors";
    let need = if safetensors { 9 } else { 4 };
    let mut head = Vec::new();
    loop {
        let chunk = tokio::time::timeout(Duration::from_secs(60), r.chunk()).await.map_err(|_| "stalled for 60 s".to_string())?.map_err(|e| e.to_string())?;
        let Some(chunk) = chunk else { break };
        if have == 0 && head.len() < need {
            head.extend_from_slice(&chunk[..chunk.len().min(need - head.len())]);
            if head.len() == need {
                let ok = if safetensors {
                    let n = u64::from_le_bytes(head[..8].try_into().unwrap_or([0; 8]));
                    n > 1 && n < 100_000_000 && head[8] == b'{'
                } else {
                    head == b"GGUF"
                };
                if !ok {
                    drop(f);
                    let _ = tokio::fs::remove_file(&part).await;
                    return Err(if safetensors { "this is not a safetensors model file".into() } else { "this is not a GGUF model file".into() });
                }
            }
        }
        hasher.update(&chunk);
        f.write_all(&chunk).await.map_err(|e| e.to_string())?;
        have += chunk.len() as u64;
        dl.update(id, |p| p.done = have);
    }
    f.flush().await.map_err(|e| e.to_string())?;
    drop(f);
    dl.update(id, |p| p.state = "verifying".into());
    let got = format!("{:x}", hasher.finalize());
    if (total > 0 && have != total) || (!want.is_empty() && got != want) {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(format!("wrong file ({have} bytes, sha256 {}...)", &got[..12]));
    }
    tokio::fs::rename(&part, &path).await.map_err(|e| e.to_string())?;
    // record what was received (size, and the SHA-256 when nobody gave one: shown as "not verified")
    let mut done = m.clone();
    done["bytes"] = json!(have);
    if want.is_empty() {
        done["sha256"] = json!(got);
        done["verified"] = json!(false);
    }
    let _ = tokio::fs::write(dir().join(id).join("model.json"), serde_json::to_string_pretty(&done).unwrap_or_default()).await;
    Ok(())
}
