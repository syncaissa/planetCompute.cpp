// The local web server on 127.0.0.1:7526, for the window, any browser on this computer, and --headless (open
// http://localhost:7526, or from another computer through `ssh -L 7526:localhost:7526 <server>`).
//   /local/    this program's own page (device, tunnel link, sign-in); /local/info, /local/quit and its other controls.
//   /v1/       Harness: the OpenAI-style API.   /api/   passed to planetcompute.ai with this program's session.
// Security review (2026-10-28): every request must show this program's secret (E1: a cookie the window and the
// printed link set, or "Authorization: Bearer <secret>" for tools); pages are never framed by other sites (E3).
// The website's own pages (the console, pages opened in the window) are passed through on ANOTHER port, port +
// 10000 (E4): a page of the site has another origin there, so it can never call this program's local controls.
// The session token stays in this program (saved in the config folder), never in the browser. The tunnel link
// (tunnel.rs) reaches /local/ and /api/ only.

use crate::{api, engine};
use axum::{
    body::Bytes,
    extract::{ws::WebSocketUpgrade, Query, Request, State},
    http::{header, HeaderMap, Method, StatusCode, Uri},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::get,
    Json, Router,
};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const UI: &str = include_str!("../ui/index.html");
/// Example prompts for pictures (🎲 Random on Images), one per line; built into the program.
const IMAGE_PROMPTS: &str = include_str!("../ui/image_prompts.txt");
const VIDEO_PROMPTS: &str = include_str!("../ui/video_prompts.txt");

pub struct Local {
    pub port: u16,
    pub http: reqwest::Client,
    pub session: Mutex<Option<String>>,
    /// This computer's planetCompute ID (12 hex digits, kept in the config folder); names its tunnel link.
    pub device: String,
    /// The ID in this computer's planetcompute.ai/device/<id>/ link: at first the device ID (so links made before
    /// stay the same), a new random one after "Make a new link" or after the site said the link was deleted. Kept
    /// apart from the device ID, which Contribute's credit and capacity check use.
    pub link: Mutex<String>,
    /// Wakes the tunnel to reconnect at once with a new link ID.
    pub relink: tokio::sync::Notify,
    tunnel: Mutex<String>,
    /// The native contributor (--headless only; in the window the site's console contributes).
    pub engine: Option<Arc<crate::contribute::Engine>>,
    /// Harness: model downloads, the llama.cpp runner, and an HTTP client without an overall time limit (models
    /// are many GB) for the downloads.
    pub downloads: crate::models::Downloads,
    pub llm: crate::llm::Llm,
    /// Harness images on this computer (stable-diffusion.cpp, image.rs).
    pub images: crate::image::Images,
    pub dl_http: reqwest::Client,
    /// The port that passes the website's pages (their own origin, security review E4); 0 if none could be opened.
    pub site_port: u16,
    /// A newer build on planetcompute.ai/download (update_loop; plan_old_programs #3): {} until one is seen.
    pub update: Mutex<serde_json::Value>,
}

impl Local {
    pub fn set_tunnel(&self, status: &str) {
        *self.tunnel.lock().unwrap() = status.to_string();
    }

    pub fn link_id(&self) -> String {
        self.link.lock().unwrap().clone()
    }

    /// A new link ID (12 hex digits), kept in the config folder; the tunnel reconnects with it at once. Returns it.
    pub fn new_link(&self) -> String {
        let id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
        if let Some(f) = config_file("link_id") {
            if let Some(dir) = f.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&f, &id);
        }
        *self.link.lock().unwrap() = id.clone();
        self.relink.notify_waiters();
        id
    }
}

/// Bind before anything else starts, so a busy port is reported at once.
pub fn bind(port: u16) -> std::io::Result<std::net::TcpListener> {
    let l = std::net::TcpListener::bind(("127.0.0.1", port))?;
    l.set_nonblocking(true)?;
    Ok(l)
}

/// This program's secret (security review E1): made once per installation and kept in the config folder (600), so an
/// editor's API key (the same secret) survives restarts. The window opens /local/?t=<secret>; --headless prints that
/// link; tools send "Authorization: Bearer <secret>".
pub fn local_token() -> &'static str {
    static T: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    T.get_or_init(|| {
        let f = config_file("local_token");
        if let Some(t) = f.as_ref().and_then(|f| std::fs::read_to_string(f).ok()) {
            let t = t.trim().to_string();
            if t.len() >= 32 && t.chars().all(|c| c.is_ascii_hexdigit()) {
                return t;
            }
        }
        let t = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        if let Some(f) = f {
            write_private(&f, &t);
        }
        t
    })
}

/// This installation's key for its tunnel link (security review T2): the site binds the link to it at first connect, so
/// a stolen sign-in alone cannot take the link over.
pub fn tunnel_key() -> String {
    let f = config_file("tunnel_key");
    if let Some(t) = f.as_ref().and_then(|f| std::fs::read_to_string(f).ok()) {
        let t = t.trim().to_string();
        if t.len() >= 32 {
            return t;
        }
    }
    let t = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    if let Some(f) = f {
        write_private(&f, &t);
    }
    t
}

fn write_private(f: &std::path::Path, text: &str) {
    if let Some(dir) = f.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(f, text);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(f, std::fs::Permissions::from_mode(0o600));
    }
}

pub async fn serve(listener: std::net::TcpListener, port: u16, engine: Option<Arc<crate::contribute::Engine>>) -> std::io::Result<()> {
    // the website's pages: their own port, port + 10000 (the first free of ten)
    let site = (10000u16..10010).find_map(|d| port.checked_add(d).and_then(|p| bind(p).ok().map(|l| (p, l))));
    let http = reqwest::Client::builder()
        .user_agent(crate::UA)
        .timeout(Duration::from_secs(30))
        .build()
        .expect("HTTP client");
    let st = Arc::new(Local {
        port,
        http,
        session: Mutex::new(load_session()),
        device: device_id(),
        link: Mutex::new(link_id()),
        relink: tokio::sync::Notify::new(),
        tunnel: Mutex::new("starting".into()),
        engine: engine.clone(),
        downloads: crate::models::Downloads::default(),
        llm: crate::llm::Llm::start(),
        images: crate::image::Images::default(),
        dl_http: reqwest::Client::builder()
            .user_agent(crate::UA)
            .connect_timeout(Duration::from_secs(20))
            .build()
            .expect("HTTP client"),
        site_port: site.as_ref().map(|x| x.0).unwrap_or(0),
        update: Mutex::new(serde_json::json!({})),
    });
    if let Some((_, l)) = site {
        let site_app = Router::new()
            .route("/api/police/ws", get(police_ws))
            .route("/api/sherpa/device", get(police_ws)) // the console's SherpaHub packs (same relay, binary too)
            .fallback(proxy_site)
            .layer(middleware::from_fn_with_state(st.clone(), site_guard))
            .with_state(st.clone());
        tokio::spawn(async move {
            if let Ok(l) = tokio::net::TcpListener::from_std(l) {
                let _ = axum::serve(l, site_app).await;
            }
        });
    }
    // pictures and videos asked for before the program last stopped (listed before the first request is answered)
    st.images.resume();
    // each picture or video made here is registered on planetcompute.ai as soon as the program is signed in
    let reg = st.clone();
    tokio::spawn(async move {
        loop {
            register_made(&reg, None).await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
    tokio::spawn(crate::tunnel::run(st.clone()));
    tokio::spawn(update_loop(st.clone()));
    // --sherpahub (headless): lead a BatchMode job on its own thread (sherpa.rs); headless.rs checked the options
    if engine.is_some() {
        if let Ok(Some(o)) = crate::sherpa::hub_opts(&std::env::args().skip(1).collect::<Vec<_>>()) {
            crate::sherpa::start_hub(st.clone(), o);
        }
    }
    let mut app = Router::new();
    if let Some(e) = engine {
        tokio::spawn(crate::contribute::run(st.clone(), e));
    }
    // / is this program's own page (the site's console is on the site port, inside the window)
    app = app.route("/", get(|| async { axum::response::Redirect::temporary("/local/") }));
    let app = app
        .route("/local", get(|| async { axum::response::Redirect::permanent("/local/") }))
        .route("/local/", get(|| async { Html(UI) }))
        .route("/local/info", get(info))
        .route("/local/quit", axum::routing::post(quit))
        .route("/local/close", axum::routing::post(close_answer))
        .route("/local/open", axum::routing::post(open_browser))
        .route("/local/link/new", axum::routing::post(link_new))
        .route("/local/contribute", get(contribute_status).post(contribute_update))
        .route("/local/models", get(models_list))
        .route("/local/models/download", axum::routing::post(models_download))
        .route("/local/models/accept", axum::routing::post(models_accept))
        .route("/local/models/delete", axum::routing::post(models_delete))
        .route("/local/models/add", axum::routing::post(models_add))
        .route("/local/models/hf", get(models_hf))
        .route("/local/models/resolve", get(models_resolve))
        .route("/local/image", axum::routing::post(image_start))
        .route("/local/image/info", get(image_info))
        .route("/local/image/queue", get(image_queue))
        .route("/local/image/remove", axum::routing::post(image_remove))
        .route("/local/image/check", axum::routing::post(image_check))
        .route("/local/image/examples", get(|| async { Json(serde_json::json!({"image": IMAGE_PROMPTS.lines().filter(|l| !l.trim().is_empty()).collect::<Vec<_>>(), "video": VIDEO_PROMPTS.lines().filter(|l| !l.trim().is_empty()).collect::<Vec<_>>()})) }))
        .route("/local/image/forget", axum::routing::post(image_forget))
        .route("/local/image/job/{id}", get(image_job))
        .route("/local/image/file/{id}", get(image_file))
        .route("/local/image/cancel", axum::routing::post(image_cancel))
        .route("/local/image/save", axum::routing::post(image_save))
        .route("/local/image/cloud", axum::routing::post(image_cloud))
        .route("/local/image/folder", axum::routing::post(image_folder))
        .route("/local/storage", get(storage))
        .route("/local/storage/open", axum::routing::post(storage_open))
        .route("/local/content", get(content_list))
        .route("/local/content/file/{name}", get(content_file))
        .route("/local/content/save", axum::routing::post(content_save))
        .route("/local/content/cloud", axum::routing::post(content_cloud))
        .route("/local/content/delete", axum::routing::post(content_delete))
        .route("/local/pool/save", axum::routing::post(pool_save))
        .route("/v1/images/generations", axum::routing::post(crate::openai::images))
        .route("/v1/models", get(crate::openai::list))
        .route("/v1/chat/completions", axum::routing::post(crate::openai::chat))
        .route("/local/models/allow", axum::routing::post(models_allow))
        .route("/api/police/ws", get(police_ws))
        .fallback(proxy_main)
        .layer(middleware::from_fn_with_state(st.clone(), guard))
        .with_state(st);
    axum::serve(tokio::net::TcpListener::from_std(listener)?, app).await
}

/// Only our own host names (stops DNS rebinding), no posts from other web sites, and (security review E1) only with this
/// program's secret: the pc_local cookie (set when the window or the printed link opens /local/?t=<secret>) or
/// "Authorization: Bearer <secret>". Every answer may be framed only by this program's own page (E3).
async fn guard(State(st): State<Arc<Local>>, req: Request, next: Next) -> Response {
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("").to_string();
    if host != format!("localhost:{}", st.port) && host != format!("127.0.0.1:{}", st.port) {
        return (StatusCode::FORBIDDEN, "Wrong host.").into_response();
    }
    if let Some(r) = cross_site(&req, &host) {
        return r;
    }
    // the window / the printed link: /local/?t=<secret> sets the cookie, then the same page without the secret
    let path = req.uri().path().to_string();
    if req.method() == Method::GET && (path == "/local/" || path == "/local") {
        let q = req.uri().query().unwrap_or("");
        if q.split('&').any(|kv| kv == format!("t={}", local_token())) {
            let rest: Vec<&str> = q.split('&').filter(|kv| !kv.starts_with("t=") && !kv.is_empty()).collect();
            let to = if rest.is_empty() { "/local/".to_string() } else { format!("/local/?{}", rest.join("&")) };
            let mut r = axum::response::Redirect::temporary(&to).into_response();
            if let Ok(v) = format!("pc_local={}; Path=/; HttpOnly; SameSite=Strict", local_token()).parse() {
                r.headers_mut().insert(header::SET_COOKIE, v);
            }
            return r;
        }
    }
    if !has_secret(req.headers()) {
        return refused(&path);
    }
    let mut resp = next.run(req).await;
    let h = resp.headers_mut();
    if !h.contains_key(header::X_FRAME_OPTIONS) {
        h.insert(header::X_FRAME_OPTIONS, header::HeaderValue::from_static("SAMEORIGIN"));
    }
    if !h.contains_key(header::CONTENT_SECURITY_POLICY) {
        h.insert(header::CONTENT_SECURITY_POLICY, header::HeaderValue::from_static("frame-ancestors 'self'"));
    }
    resp
}

/// The website's pages on the site port (security review E4): our host names there, no posts from other origins, and
/// the same secret (the cookie is per host, so the frames inside the window carry it).
async fn site_guard(State(st): State<Arc<Local>>, req: Request, next: Next) -> Response {
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("").to_string();
    if host != format!("localhost:{}", st.site_port) && host != format!("127.0.0.1:{}", st.site_port) {
        return (StatusCode::FORBIDDEN, "Wrong host.").into_response();
    }
    if let Some(r) = cross_site(&req, &host) {
        return r;
    }
    if !has_secret(req.headers()) {
        return refused(req.uri().path());
    }
    next.run(req).await
}

fn cross_site(req: &Request, host: &str) -> Option<Response> {
    let upgrade = req.headers().contains_key(header::UPGRADE);
    if upgrade || (req.method() != Method::GET && req.method() != Method::HEAD) {
        let origin = req.headers().get(header::ORIGIN).and_then(|o| o.to_str().ok());
        if origin.is_some_and(|o| o != format!("http://{host}")) {
            return Some((StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Cross-site request refused."}))).into_response());
        }
    }
    None
}

fn has_secret(h: &HeaderMap) -> bool {
    let t = local_token();
    let bearer = h.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).is_some_and(|v| v == format!("Bearer {t}"));
    let cookie = h.get_all(header::COOKIE).iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(';'))
        .any(|kv| kv.trim() == format!("pc_local={t}"));
    bearer || cookie
}

fn refused(path: &str) -> Response {
    if path == "/local/" || path == "/local" || path == "/" {
        return (StatusCode::UNAUTHORIZED, Html("<!doctype html><meta charset=utf-8><title>planetCompute</title><body style=\"font:16px system-ui;margin:40px\">\
            <h2>Open planetCompute from its window</h2><p>For your safety this page opens only from the planetCompute window, or with the \
            link the program printed when it started (it ends in <code>?t=…</code>).</p></body>")).into_response();
    }
    (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Not allowed: open planetCompute from its window, or send the program's key (Authorization: Bearer <key>, shown on Receive Compute, Connect)."}))).into_response()
}

async fn info(State(st): State<Arc<Local>>) -> Json<serde_json::Value> {
    let engine = tokio::task::spawn_blocking(engine::info).await.unwrap_or_default();
    Json(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"), "build": crate::BUILD, "build_time": crate::build_time(),
        "built": if crate::build_time() > 0 { crate::utc_text(crate::build_time()) } else { String::new() },
        "update": st.update.lock().unwrap().clone(), "port": st.port, "pid": std::process::id(),
        "device": st.device, "link": crate::tunnel::link(&st.link_id()), "link_id": st.link_id(), "tunnel": st.tunnel.lock().unwrap().clone(),
        "os": std::env::consts::OS, "arch": std::env::consts::ARCH, "engine": engine,
        "site_port": st.site_port, "sandbox": crate::sandbox::describe(), "api_key": local_token(), "open_url": format!("http://localhost:{}/local/?t={}", st.port, local_token()),
        // regular: shares and receives compute; sherpahub: also leads jobs (servers: --headless --sherpahub)
        "mode": if st.engine.is_some() && matches!(crate::sherpa::hub_opts(&std::env::args().skip(1).collect::<Vec<_>>()), Ok(Some(_))) { "sherpahub" } else { "regular" },
    }))
}

/// Is there a newer build? (plan_old_programs #3) 30 s after the start, then once a day: planetcompute.ai/download/latest.json,
/// this build's entry (DOWNLOAD_KEY) against BUILD_TIME. Nothing waits on it: no internet, an error or an older list
/// (no build_time yet) = no notice. `too_old_to_earn` when this build is below the site's minimum for earning.
async fn update_loop(st: Arc<Local>) {
    tokio::time::sleep(Duration::from_secs(30)).await;
    let mut said = 0u64;
    loop {
        if let Some(u) = update_check(&st.http).await {
            let t = u["build_time"].as_u64().unwrap_or(0);
            if u["available"].as_bool() == Some(true) && t != said && st.engine.is_some() {
                said = t; // headless: one line per new build
                println!("A newer planetCompute is ready (built {}): {}", crate::utc_text(t), u["url"].as_str().unwrap_or(""));
            }
            *st.update.lock().unwrap() = u;
        }
        tokio::time::sleep(Duration::from_secs(24 * 3600)).await;
    }
}

pub(crate) async fn update_check(http: &reqwest::Client) -> Option<serde_json::Value> {
    let r = http.get(format!("{}/download/latest.json", api::SITE)).timeout(Duration::from_secs(20)).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    let j: serde_json::Value = serde_json::from_slice(&r.bytes().await.ok()?).ok()?;
    Some(update_view(&j, crate::DOWNLOAD_KEY, crate::build_time()))
}

/// What the window shows, from latest.json: a newer build of this kind, and whether this one may still earn.
pub(crate) fn update_view(j: &serde_json::Value, key: &str, mine: u64) -> serde_json::Value {
    let b = &j["builds"][key];
    let t = b["build_time"].as_u64().unwrap_or(0);
    let min = j["min_earn_build"].as_u64().unwrap_or(0);
    serde_json::json!({
        "available": mine > 0 && t > mine, "build_time": t, "built": if t > 0 { crate::utc_text(t) } else { String::new() },
        "commit": b["commit"].as_str().unwrap_or(""), "url": format!("{}/download", api::SITE),
        "too_old_to_earn": min > 0 && mine < min, "earn_mode": j["min_earn_mode"].as_str().unwrap_or(""),
    })
}

/// The native contributor's status, or {"engine": "page"} when the site's console contributes (the window).
async fn contribute_status(State(st): State<Arc<Local>>) -> Json<serde_json::Value> {
    Json(match &st.engine {
        Some(e) => e.status(),
        None => serde_json::json!({"engine": "page"}),
    })
}

/// {agree, cores, cap, run} from the device page (also through the tunnel link: start or pause from anywhere).
async fn contribute_update(State(st): State<Arc<Local>>, Json(v): Json<serde_json::Value>) -> Response {
    let Some(e) = &st.engine else {
        return (StatusCode::CONFLICT, Json(serde_json::json!({"error": "In the window, contribute on the Contribute console."}))).into_response();
    };
    match e.update(&v) {
        Ok(()) => Json(e.status()).into_response(),
        Err(msg) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": msg}))).into_response(),
    }
}

/// Harness: the PlanetCompute library, the downloaded models (with disk use), total disk use and free space.
async fn models_list(State(st): State<Arc<Local>>) -> Json<serde_json::Value> {
    Json(st.downloads.list(&st.http).await)
}

/// Connect a Browser, "Make a new link": the old planetcompute.ai/device/<id>/ link is deleted on the site (it never
/// works again) and this computer connects with a new one. Not over the tunnel (it would cut the visitor off).
async fn link_new(State(st): State<Arc<Local>>) -> Response {
    let old = st.link_id();
    let token = st.session.lock().unwrap().clone();
    if let Some(t) = token {
        let r = st.http.post(format!("{}/api/tunnel/devices/delete", api::SITE))
            .header(header::COOKIE, format!("{}={t}", api::COOKIE))
            .header(header::CONTENT_TYPE, "application/json")
            .body(serde_json::json!({"device": old}).to_string())
            .send().await;
        if let Err(e) = r {
            return (StatusCode::BAD_GATEWAY, Json(serde_json::json!({"error": format!("Cannot reach planetcompute.ai ({e}): the old link was not deleted.")}))).into_response();
        }
    }
    let id = st.new_link();
    Json(serde_json::json!({"ok": true, "link": crate::tunnel::link(&id), "old": crate::tunnel::link(&old)})).into_response()
}

/// {url}: open a planetcompute.ai or Stripe Checkout page in the normal browser (payments do not run in the app's
/// window). Any other address is refused; the tunnel link never reaches this.
async fn open_browser(Json(v): Json<serde_json::Value>) -> Response {
    let url = v["url"].as_str().unwrap_or("");
    // this program's own page in the browser (Account: "On this computer") is allowed too
    let local = url.strip_prefix("http://localhost:").map_or(false, |r| r.split('/').next().map_or(false, |p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())));
    // and the licences the licence agreement links to (LICENCE_AGREEMENTS on the site)
    const LICENCES: [&str; 5] = ["https://www.llama.com/", "https://github.com/Lightricks/", "https://static.lightricks.com/legal/",
                                 "https://stability.ai/", "https://huggingface.co/stabilityai/"];
    // and a wallet or a transfer on the public Solana explorers (My Balance: View on Solscan, See the transaction)
    const EXPLORERS: [&str; 5] = ["https://solscan.io/account/", "https://solscan.io/tx/", "https://solscan.io/token/", "https://explorer.solana.com/tx/", "https://explorer.solana.com/address/"];
    // shared pictures and videos live on my.planetcompute.ai (2026-10-29): their links open too
    let ok = (url.starts_with("https://planetcompute.ai/") || url.starts_with("https://my.planetcompute.ai/") || url.starts_with("https://checkout.stripe.com/") || local
              || LICENCES.iter().any(|p| url.starts_with(p)) || EXPLORERS.iter().any(|p| url.starts_with(p)))
        && !url.chars().any(|c| c.is_whitespace() || c == '"' || c == '\'');
    if !ok {
        return bad("only planetcompute.ai (and my.planetcompute.ai), Stripe Checkout, model licences, the Solana explorers and this program's own pages can be opened");
    }
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(url).spawn();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(url).spawn();
    match r {
        Ok(_) => Json(serde_json::json!({"ok": true})).into_response(),
        Err(e) => bad(format!("could not open the browser: {e}")),
    }
}

/// Harness images (image.rs): start a job, follow it, get the picture, stop it.
async fn image_info(State(st): State<Arc<Local>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({"engine": crate::image::available(), "busy": st.images.busy()}))
}

/// The checks before a request (image.rs check): shown under the Inference controls, and made again when it is sent.
async fn image_check(Json(v): Json<serde_json::Value>) -> Json<serde_json::Value> {
    Json(tokio::task::spawn_blocking(move || crate::image::check(&v)).await.unwrap_or_default())
}

async fn image_forget(Json(v): Json<serde_json::Value>) -> Json<serde_json::Value> {
    crate::image::forget(v["model"].as_str().unwrap_or(""));
    Json(serde_json::json!({"ok": true}))
}

/// The requests waiting or being made (?all=1: also those finished since the program started: the Queue tab).
async fn image_queue(State(st): State<Arc<Local>>, uri: Uri) -> Json<serde_json::Value> {
    let all = uri.query().is_some_and(|q| q.split('&').any(|x| x == "all=1"));
    Json(serde_json::json!({"jobs": st.images.queue(all)}))
}

/// {id}: Queue tab, Delete (stops it when it waits or is being made) / Remove from list.
async fn image_remove(State(st): State<Arc<Local>>, Json(v): Json<serde_json::Value>) -> Response {
    if st.images.remove(v["id"].as_str().unwrap_or("")) {
        Json(serde_json::json!({"ok": true})).into_response()
    } else {
        (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "no such request"}))).into_response()
    }
}

async fn image_start(State(st): State<Arc<Local>>, Json(v): Json<serde_json::Value>) -> Response {
    let r = tokio::task::spawn_blocking({
        let st = st.clone();
        move || st.images.start(&v)
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()));
    match r {
        Ok(id) => Json(serde_json::json!({"id": id})).into_response(),
        Err(e) => bad(e),
    }
}

async fn image_job(State(st): State<Arc<Local>>, axum::extract::Path(id): axum::extract::Path<String>) -> Response {
    match st.images.job(&id) {
        Some(j) => Json(j).into_response(),
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "no such image"}))).into_response(),
    }
}

async fn image_file(State(st): State<Arc<Local>>, axum::extract::Path(id): axum::extract::Path<String>) -> Response {
    let Some(p) = st.images.file(id.trim_end_matches(".png").trim_end_matches(".webm")) else {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "no such image"}))).into_response();
    };
    match tokio::fs::read(&p).await {
        Ok(b) => {
            let ct = if p.extension().is_some_and(|e| e == "webm") { "video/webm" } else { "image/png" };
            ([(header::CONTENT_TYPE, ct), (header::CACHE_CONTROL, "no-store")], b).into_response()
        }
        Err(e) => bad(e),
    }
}

/// {id}: Save picture / Save video. A link with `download` saves nothing inside the program's window (WebView2,
/// WebKitGTK), so the program writes the file into the Downloads folder itself and says where.
async fn image_save(State(st): State<Arc<Local>>, Json(v): Json<serde_json::Value>) -> Response {
    let id = v["id"].as_str().unwrap_or("");
    let Some(p) = st.images.file(id) else {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "no such image"}))).into_response();
    };
    save_copy(&p).await
}

/// Copy a picture, video or song into the Downloads folder as planetCompute-<name> and say where.
async fn save_copy(p: &std::path::Path) -> Response {
    let stem = p.file_stem().and_then(|e| e.to_str()).unwrap_or("file").to_string();
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("png").to_string();
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(std::path::PathBuf::from).unwrap_or_default();
    let dir = if home.join("Downloads").is_dir() { home.join("Downloads") } else { home };
    let mut dest = dir.join(format!("planetCompute-{stem}.{ext}"));
    for n in 2.. {
        if !dest.exists() {
            break;
        }
        dest = dir.join(format!("planetCompute-{stem}-{n}.{ext}"));
    }
    match tokio::fs::copy(p, &dest).await {
        Ok(_) => Json(serde_json::json!({"ok": true, "path": dest.display().to_string()})).into_response(),
        Err(e) => bad(format!("Could not save it in {}: {e}", dir.display())),
    }
}

/// Open pictures folder: shows the folder where every picture and video made here is kept, in the file manager
/// (Explorer, Finder). Never over the tunnel (it would open on the device, not for the visitor).
async fn image_folder() -> Response {
    open_folder(&crate::image::folder())
}

/// Show a folder in the file manager (Explorer, Finder, the desktop's own); made first when it is not there yet.
fn open_folder(dir: &std::path::Path) -> Response {
    if let Err(e) = std::fs::create_dir_all(dir) {
        return bad(format!("Could not make {}: {e}", dir.display()));
    }
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("explorer").arg(dir).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(dir).spawn();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(dir).spawn();
    match r {
        Ok(_) => Json(serde_json::json!({"ok": true, "path": dir.display().to_string()})).into_response(),
        Err(e) => bad(format!("Could not open {}: {e}", dir.display())),
    }
}

/// Disk space tab: what the program takes on this computer, part by part, each with its folder.
///   program  the planetCompute program itself (its folder: where it was installed or downloaded)
///   models   the downloaded models
///   media    the pictures, videos and songs made here
///   data     everything else of the program: the image engine, the queue, settings, sign-in, device ID
fn storage_parts() -> Vec<(&'static str, &'static str, std::path::PathBuf)> {
    let data = dirs::data_dir().unwrap_or_else(std::env::temp_dir).join("planetCompute");
    let exe = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())).unwrap_or_default();
    vec![
        ("program", "The planetCompute program", exe),
        ("models", "Models", crate::models::dir()),
        ("media", "Pictures, videos and songs", crate::image::folder()),
        ("data", "App data (image engine, queue, settings)", data),
    ]
}

/// Bytes and files under a folder (not following links); `skip` = folders counted elsewhere.
fn folder_size(dir: &std::path::Path, skip: &[std::path::PathBuf]) -> (u64, u64) {
    let (mut bytes, mut files) = (0u64, 0u64);
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(md) = std::fs::symlink_metadata(&p) else { continue };
            if md.is_dir() {
                if !skip.contains(&p) {
                    stack.push(p);
                }
            } else if md.is_file() {
                bytes += md.len();
                files += 1;
            }
        }
    }
    (bytes, files)
}

async fn storage() -> Json<serde_json::Value> {
    Json(tokio::task::spawn_blocking(|| {
        let parts = storage_parts();
        let (models, media) = (crate::models::dir(), crate::image::folder());
        let mut out = Vec::new();
        let mut total = 0u64;
        for (key, name, dir) in &parts {
            let (bytes, files) = match *key {
                // the program: only its own file (its folder may be Downloads, full of other things)
                "program" => (std::env::current_exe().ok().and_then(|e| std::fs::metadata(e).ok()).map_or(0, |m| m.len()), 1),
                "data" => {
                    let (mut b, mut f) = folder_size(dir, &[models.clone(), media.clone()]);
                    // settings, sign-in and device ID (the same folder on Windows; their own on macOS and Linux)
                    if let Some(c) = dirs::config_dir().map(|c| c.join("planetCompute")).filter(|c| c != dir) {
                        let (cb, cf) = folder_size(&c, &[]);
                        b += cb;
                        f += cf;
                    }
                    (b, f)
                }
                _ => folder_size(dir, &[]),
            };
            total += bytes;
            out.push(serde_json::json!({"key": key, "name": name, "path": dir.display().to_string(), "bytes": bytes, "files": files}));
        }
        let data = &parts[3].2;
        let _ = std::fs::create_dir_all(data);
        serde_json::json!({"parts": out, "total": total, "free": fs2::available_space(data).unwrap_or(0), "disk": fs2::total_space(data).unwrap_or(0)})
    })
    .await
    .unwrap_or_default())
}

/// {key}: Open folder for one part of the Disk space tab. Not over the tunnel (it would open on this computer).
async fn storage_open(Json(v): Json<serde_json::Value>) -> Response {
    let key = v["key"].as_str().unwrap_or("");
    match storage_parts().into_iter().find(|p| p.0 == key) {
        Some((_, _, dir)) => open_folder(&dir),
        None => bad("no such folder"),
    }
}

/// {id}: Save to cloud. Sends the file to planetcompute.ai with this program's session (POST /api/uploads); the
/// site keeps it at public/users_uploads/<user id>/<name> and answers its link (my.planetcompute.ai/<token>).
async fn image_cloud(State(st): State<Arc<Local>>, Json(v): Json<serde_json::Value>) -> Response {
    let id = v["id"].as_str().unwrap_or("");
    let Some(p) = st.images.file(id) else {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "no such image"}))).into_response();
    };
    upload(&st, &p).await
}

/// Register the pictures and videos made here (image.rs `made`) on planetcompute.ai: POST /api/media/made with the
/// file's SHA-512 and how it was made. The site keeps them per account and Save to cloud accepts only a file whose
/// SHA-512 it has for that account (a photo copied into the folder is refused: "not made here"). With `only`, just
/// that file (Save to cloud right after making it). Waits while signed out; a network error or a 5xx keeps it for
/// the next round (as does 429, the per-minute limit); any other answer drops it.
async fn register_made(st: &Local, only: Option<&std::path::Path>) {
    use sha2::{Digest, Sha512};
    let Some(token) = st.session.lock().unwrap().clone() else { return };
    let todo: Vec<(std::path::PathBuf, serde_json::Value)> = {
        let mut g = st.images.made.lock().unwrap();
        let (now, keep): (Vec<_>, Vec<_>) = g.drain(..).partition(|(p, _)| only.map_or(true, |o| o == p.as_path()));
        *g = keep;
        now
    };
    for (p, meta) in todo {
        let Ok(data) = tokio::fs::read(&p).await else { continue };   // deleted before it was registered
        let sha = format!("{:x}", Sha512::digest(&data));
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        let body = serde_json::json!({"sha512": sha, "bytes": data.len(), "name": name, "kind": meta["kind"], "device": st.device, "meta": meta});
        let r = st.http.post(format!("{}/api/media/made", api::SITE))
            .header(header::COOKIE, format!("{}={token}", api::COOKIE))
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.to_string()).send().await;
        // busy (5xx) or over the per-minute limit (429): kept and tried again in the next round
        let retry = match r { Ok(r) => r.status().is_server_error() || r.status().as_u16() == 429, Err(_) => true };
        if retry {
            st.images.made.lock().unwrap().push((p, meta));
        }
    }
}

/// Send a file to planetcompute.ai as planetCompute-<name> with this program's session; answers the site's {url}.
async fn upload(st: &Local, p: &std::path::Path) -> Response {
    let Some(token) = st.session.lock().unwrap().clone() else {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Sign in first (tab Account) to save to the cloud."}))).into_response();
    };
    register_made(st, Some(p)).await;   // made a moment ago and not registered yet: now, before the upload
    let data = match tokio::fs::read(p).await {
        Ok(b) => b,
        Err(e) => return bad(e),
    };
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("png").to_ascii_lowercase();
    let stem: String = p.file_stem().and_then(|e| e.to_str()).unwrap_or("file").chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(80).collect();
    let name = format!("planetCompute-{stem}.{ext}");
    // a picture goes with its three WebP versions and its size and model (webshare.rs): the shared page shows the small
    // WebP, not the original; anything else (videos, songs, a PNG that cannot be read) goes alone, as before
    let mut ctype = media_type(&ext).to_string();
    let mut body = data;
    if ext == "png" {
        let png = body.clone();
        if let Ok(Ok((f, small, tagged, w, h))) = tokio::task::spawn_blocking(move || crate::webshare::versions(&png)).await {
            let model = std::fs::read(p.with_extension("json")).ok()
                .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
                .and_then(|m| m["model_name"].as_str().map(str::to_string)).unwrap_or_default();
            let meta = serde_json::json!({"width": w, "height": h, "model_name": model}).to_string();
            let (ct, mp) = crate::webshare::multipart(&[("file", &name, "image/png", &body), ("f", "f.webp", "image/webp", &f),
                ("p", "p.webp", "image/webp", &small), ("pt", "pt.webp", "image/webp", &tagged), ("meta", "", "application/json", meta.as_bytes())]);
            ctype = ct;
            body = mp;
        }
    }
    let r = st.http.post(format!("{}/api/uploads?name={name}", api::SITE))
        .header(header::COOKIE, format!("{}={token}", api::COOKIE))
        .header(header::CONTENT_TYPE, ctype)
        .body(body).send().await;
    match r {
        Ok(r) => {
            let code = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let body = r.bytes().await.unwrap_or_default();
            let j: serde_json::Value = serde_json::from_slice(&body).unwrap_or(serde_json::json!({"error": "Unexpected answer from planetcompute.ai."}));
            // remember its link beside the file (<name>.cloud.json): the UI then offers Copy Cloud URL instead of Save to cloud
            if code.is_success() {
                if let Some(url) = j["url"].as_str() {
                    let _ = tokio::fs::write(cloud_note(p), serde_json::json!({"url": url}).to_string()).await;
                }
            }
            (code, Json(j)).into_response()
        }
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({"error": format!("Cannot reach planetcompute.ai ({e}).")}))).into_response(),
    }
}

/// Where the cloud link of a file is kept: <name>.cloud.json beside it (not listed: content_list skips .json).
fn cloud_note(p: &std::path::Path) -> std::path::PathBuf {
    let mut n = p.as_os_str().to_owned();
    n.push(".cloud.json");
    std::path::PathBuf::from(n)
}

/// The cloud link saved for a file, if it was saved to the cloud.
fn cloud_url(p: &std::path::Path) -> Option<String> {
    let b = std::fs::read(cloud_note(p)).ok()?;
    let j: serde_json::Value = serde_json::from_slice(&b).ok()?;
    j["url"].as_str().map(str::to_string)
}

/// The media type of a picture, video or song by its extension (the ones planetcompute.ai keeps).
fn media_type(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "webm" => "video/webm",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        _ => "application/octet-stream",
    }
}

/// Local content tab: the files in the pictures folder (every picture, video and song made here), newest first.
async fn content_list() -> Json<serde_json::Value> {
    let dir = crate::image::folder();
    let mut files = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let Ok(md) = e.metadata() else { continue };
            let name = e.file_name().to_string_lossy().to_string();
            // <id>.json beside a picture or video is how it was made (image.rs): sent with the file, not listed alone
            if !md.is_file() || name.starts_with('.') || name.ends_with(".tmp") || name.ends_with(".json") {
                continue;
            }
            let at = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
            let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
            let meta: serde_json::Value = std::fs::read(e.path().with_extension("json")).ok()
                .and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(serde_json::Value::Null);
            let mut f = serde_json::json!({"name": name, "bytes": md.len(), "at": at, "type": media_type(&ext), "meta": meta});
            if let Some(url) = cloud_url(&e.path()) {
                f["cloud_url"] = url.into();
            }
            files.push(f);
        }
    }
    files.sort_by_key(|f| std::cmp::Reverse(f["at"].as_u64().unwrap_or(0)));
    Json(serde_json::json!({"folder": dir.display().to_string(), "files": files}))
}

/// A file of the pictures folder by its plain name (no folders, nothing outside it).
fn content_path(name: &str) -> Option<std::path::PathBuf> {
    let ok = !name.is_empty() && !name.starts_with('.') && !name.contains(['/', '\\', ':']) && !name.contains("..");
    let p = crate::image::folder().join(name);
    // a real file only, never a link (the image engine writes this folder: a link there must not point Save or Save to
    // cloud at another file, security review P10)
    (ok && std::fs::symlink_metadata(&p).is_ok_and(|m| m.file_type().is_file())).then_some(p)
}

async fn content_file(axum::extract::Path(name): axum::extract::Path<String>) -> Response {
    let Some(p) = content_path(&name) else {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "no such file"}))).into_response();
    };
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match tokio::fs::read(&p).await {
        Ok(b) => ([(header::CONTENT_TYPE, media_type(&ext)), (header::CACHE_CONTROL, "no-store")], b).into_response(),
        Err(e) => bad(e),
    }
}

/// {name}: Save (into Downloads), Save to cloud, Delete for a file of the Local content tab.
async fn content_save(Json(v): Json<serde_json::Value>) -> Response {
    match content_path(v["name"].as_str().unwrap_or("")) {
        Some(p) => save_copy(&p).await,
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "no such file"}))).into_response(),
    }
}

async fn content_cloud(State(st): State<Arc<Local>>, Json(v): Json<serde_json::Value>) -> Response {
    match content_path(v["name"].as_str().unwrap_or("")) {
        Some(p) => upload(&st, &p).await,
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "no such file"}))).into_response(),
    }
}

/// A picture or video the PlanetCompute pool made for this account (a one-prompt SherpaHub job, planetcompute.ai
/// /api/pool/media): fetched with this program's sign-in and kept in the pictures folder like one made here (My
/// Content and the gallery), with how it was made beside it ("ran_on": "PlanetCompute pool"). Once per job.
async fn pool_save(State(st): State<Arc<Local>>, Json(v): Json<serde_json::Value>) -> Response {
    let (hub, job) = (v["hub"].as_str().unwrap_or(""), v["job"].as_str().unwrap_or(""));
    let hub_ok = hub.starts_with("sherpa:hub:") && hub.len() <= 100 && hub.chars().all(|c| c.is_ascii_alphanumeric() || c == ':' || c == '_' || c == '-');
    if !hub_ok || job.len() != 16 || !job.chars().all(|c| c.is_ascii_hexdigit()) {
        return bad("bad request");
    }
    let video = v["task"] == "video";
    let dir = crate::image::folder();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return bad(e);
    }
    let name = format!("pool-{job}.{}", if video { "webm" } else { "png" });
    let path = dir.join(&name);
    if path.exists() {
        return Json(serde_json::json!({"ok": true, "name": name, "already": true})).into_response();
    }
    let Some(token) = st.session.lock().unwrap().clone() else {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Not signed in."}))).into_response();
    };
    let url = format!("{}/api/pool/media/file?hub={hub}&job={job}", api::SITE);
    let r = match st.dl_http.get(url).header("cookie", format!("{}={token}", api::COOKIE)).send().await {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => return bad(format!("planetcompute.ai answered {}", r.status())),
        Err(e) => return bad(e),
    };
    let bytes = match r.bytes().await {
        Ok(b) if !b.is_empty() && b.len() < 500 << 20 => b,
        Ok(_) => return bad("empty or too large"),
        Err(e) => return bad(e),
    };
    let tmp = dir.join(format!(".{name}.tmp"));
    if let Err(e) = std::fs::write(&tmp, &bytes).and_then(|_| std::fs::rename(&tmp, &path)) {
        return bad(e);
    }
    let meta = serde_json::json!({"kind": if video { "video" } else { "image" }, "prompt": v["prompt"], "model": v["model"], "model_name": v["model_name"],
        "width": v["width"], "height": v["height"], "seconds": v["seconds"], "ran_on": "PlanetCompute pool", "made_by": v["made_by"],
        "made_at": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64), "app": env!("CARGO_PKG_VERSION")});
    let _ = std::fs::write(path.with_extension("json"), meta.to_string());
    Json(serde_json::json!({"ok": true, "name": name})).into_response()
}

async fn content_delete(Json(v): Json<serde_json::Value>) -> Response {
    let Some(p) = content_path(v["name"].as_str().unwrap_or("")) else {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "no such file"}))).into_response();
    };
    match tokio::fs::remove_file(&p).await {
        Ok(()) => {
            let _ = tokio::fs::remove_file(p.with_extension("json")).await;   // how it was made goes with it
            let _ = tokio::fs::remove_file(cloud_note(&p)).await;             // and its cloud link (the cloud copy stays)
            Json(serde_json::json!({"ok": true})).into_response()
        }
        Err(e) => bad(format!("Could not delete it: {e}")),
    }
}

async fn image_cancel(State(st): State<Arc<Local>>, Json(v): Json<serde_json::Value>) -> Response {
    st.images.cancel(v["id"].as_str().unwrap_or(""));
    Json(serde_json::json!({"ok": true})).into_response()
}

fn bad(e: impl ToString) -> Response {
    (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e.to_string()}))).into_response()
}

/// {id}: download a model of the PlanetCompute library: through planetcompute.ai when signed in (the site serves
/// the library's files), else from the model's publisher. Checked by SHA-256 either way.
async fn models_download(State(st): State<Arc<Local>>, Json(v): Json<serde_json::Value>) -> Response {
    let id = v["id"].as_str().unwrap_or("");
    let lib = st.downloads.library(&st.http).await;
    let Some(m) = lib.iter().find(|m| m["id"] == id).cloned() else { return bad("not in the PlanetCompute library") };
    // a licence that passes its use rules on to each user (LTX, Llama, Stability, OpenRAIL++): the user accepts it first
    // (the UI shows it from the 403 answer, then calls /local/models/accept); planetcompute.ai keeps the acceptance
    if !m["agreement"].is_null() {
        if let Some(r) = licence_check(&st, id).await {
            return r;
        }
    }
    // an image model comes with the files it needs (its VAE and text encoders), each a library entry of its own
    let mut todo = vec![m.clone()];
    for need in m["needs"].as_array().cloned().unwrap_or_default() {
        match lib.iter().find(|x| x["id"] == need) {
            Some(p) => todo.push(p.clone()),
            None => return bad(format!("{id} needs {need}, which is not in the library")),
        }
    }
    for mut m in todo {
        let id = m["id"].as_str().unwrap_or("").to_string();
        m["from"] = serde_json::json!("PlanetCompute library");
        m["verified"] = serde_json::json!(true);
        let mut sources = Vec::new();
        let token = st.session.lock().unwrap().clone();
        if let Some(t) = token {
            let cookie = vec![("cookie".to_string(), format!("{}={t}", api::COOKIE))];
            sources.push(crate::models::Source("PlanetCompute".into(), format!("{}/api/models/file/{id}", api::SITE), cookie));
        }
        sources.push(crate::models::Source("the publisher".into(), crate::models::publisher_url(&m), vec![]));
        if let Err(e) = st.downloads.start(m, sources, st.dl_http.clone()) {
            return bad(e);
        }
    }
    Json(st.downloads.list(&st.http).await).into_response()
}

/// None when the signed-in user has accepted the model's licence; otherwise the answer for the UI: 401 (sign in),
/// 403 {needs_agreement, agreement} (show the agreement), or 502 (planetcompute.ai cannot be reached).
async fn licence_check(st: &Local, id: &str) -> Option<Response> {
    let Some(token) = st.session.lock().unwrap().clone() else {
        return Some((StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "This model's licence needs your agreement: sign in first (tab Account)."}))).into_response());
    };
    let r = st.http.get(format!("{}/api/models/agreement?id={id}", api::SITE))
        .header(header::COOKIE, format!("{}={token}", api::COOKIE)).send().await;
    let j: serde_json::Value = match r {
        Ok(r) if r.status().is_success() => serde_json::from_slice(&r.bytes().await.unwrap_or_default()).unwrap_or_default(),
        Ok(r) => return Some((StatusCode::BAD_GATEWAY, Json(serde_json::json!({"error": format!("planetcompute.ai answered {} when checking the licence agreement.", r.status())}))).into_response()),
        Err(e) => return Some((StatusCode::BAD_GATEWAY, Json(serde_json::json!({"error": format!("Cannot reach planetcompute.ai to check the licence agreement ({e}).")}))).into_response()),
    };
    if j["accepted"].as_bool() == Some(true) {
        return None;
    }
    Some((StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "This model's licence needs your agreement first.", "needs_agreement": true, "id": id, "agreement": j["agreement"]}))).into_response())
}

/// {id}: the user accepts the model's licence; sent to planetcompute.ai with this program's session (POST
/// /api/models/accept), which keeps it (user, model, licence version, time, IP address) and emails the user a copy.
async fn models_accept(State(st): State<Arc<Local>>, Json(v): Json<serde_json::Value>) -> Response {
    let id = v["id"].as_str().unwrap_or("");
    let Some(token) = st.session.lock().unwrap().clone() else {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Sign in first (tab Account)."}))).into_response();
    };
    let r = st.http.post(format!("{}/api/models/accept", api::SITE))
        .header(header::COOKIE, format!("{}={token}", api::COOKIE))
        .header(header::CONTENT_TYPE, "application/json")
        .body(serde_json::json!({"model_id": id, "via": concat!("planetCompute ", env!("CARGO_PKG_VERSION"))}).to_string())
        .send().await;
    match r {
        Ok(r) => {
            let code = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let body = r.bytes().await.unwrap_or_default();
            let j: serde_json::Value = serde_json::from_slice(&body).unwrap_or(serde_json::json!({"error": "Unexpected answer from planetcompute.ai."}));
            (code, Json(j)).into_response()
        }
        Err(e) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({"error": format!("Cannot reach planetcompute.ai ({e}).")}))).into_response(),
    }
}

/// {source: "huggingface", repo, file} | {source: "ollama", model} | {source: "url", url, sha256?, name?}
async fn models_add(State(st): State<Arc<Local>>, Json(v): Json<serde_json::Value>) -> Response {
    let g = |k: &str| v[k].as_str().unwrap_or("").to_string();
    let made = match g("source").as_str() {
        "huggingface" => crate::models::from_hf(&st.dl_http, &g("repo"), &g("file")).await,
        "ollama" => crate::models::from_ollama(&st.dl_http, &g("model")).await,
        "url" => crate::models::from_url(&g("url"), &g("sha256"), &g("name")),
        _ => Err("source must be huggingface, ollama or url".to_string()),
    };
    match made.and_then(|(m, sources)| st.downloads.start(m, sources, st.dl_http.clone())) {
        Ok(()) => Json(st.downloads.list(&st.http).await).into_response(),
        Err(e) => bad(e),
    }
}

/// ?repo=owner/name: the .gguf files of a Hugging Face repo, to pick one.
async fn models_hf(State(st): State<Arc<Local>>, Query(q): Query<HashMap<String, String>>) -> Response {
    match crate::models::hf_files(&st.dl_http, q.get("repo").map(String::as_str).unwrap_or("")).await {
        Ok(l) => Json(l).into_response(),
        Err(e) => bad(e),
    }
}

/// ?q=<anything pasted>: what can be downloaded from it (see models::resolve).
async fn models_resolve(State(st): State<Arc<Local>>, Query(q): Query<HashMap<String, String>>) -> Response {
    match crate::models::resolve(&st.dl_http, q.get("q").map(String::as_str).unwrap_or("")).await {
        Ok(l) => Json(l).into_response(),
        Err(e) => bad(e),
    }
}

async fn models_delete(State(st): State<Arc<Local>>, Json(v): Json<serde_json::Value>) -> Response {
    let id = v["id"].as_str().unwrap_or("");
    // the parts only this model needed go with it; a file that is a model of its own (e.g. the chat model Qwen3 4B,
    // which Z-Image uses as its text encoder) stays
    if let Some(m) = crate::models::find(id) {
        let others: Vec<serde_json::Value> = crate::models::downloaded().into_iter().filter(|x| x["id"] != id).collect();
        for need in m["needs"].as_array().cloned().unwrap_or_default() {
            let used = others.iter().any(|x| x["needs"].as_array().is_some_and(|n| n.contains(&need)));
            let part = others.iter().find(|x| x["id"] == need).is_some_and(|x| crate::models::kind_of(x).ends_with("-part"));
            if !used && part {
                let _ = st.downloads.delete(need.as_str().unwrap_or(""));
            }
        }
    }
    match st.downloads.delete(id) {
        Ok(()) => Json(st.downloads.list(&st.http).await).into_response(),
        Err(e) => bad(e),
    }
}

/// {allow: true|false}: use chat model files from outside the PlanetCompute library (security review E5).
async fn models_allow(State(st): State<Arc<Local>>, Json(v): Json<serde_json::Value>) -> Response {
    match crate::models::set_allow_outside(v["allow"].as_bool() == Some(true)) {
        Ok(()) => Json(st.downloads.list(&st.http).await).into_response(),
        Err(e) => bad(e),
    }
}

/// A newly started planetCompute asks this one to make way (instance.rs). The custom header cannot be sent
/// by another web site without a CORS preflight, which this server never grants.
async fn quit(headers: HeaderMap) -> Response {
    if headers.get("x-planetcompute").and_then(|v| v.to_str().ok()) != Some("quit") {
        return (StatusCode::FORBIDDEN, "Missing header.").into_response();
    }
    // a newer copy is starting: the queue is on disk already (queue.json); stop the engine, leave the tray, end
    tokio::spawn(async {
        tokio::time::sleep(Duration::from_millis(150)).await;
        crate::tray::quit();
    });
    (StatusCode::OK, "bye").into_response()
}

/// The window's "keeps running in the background" question answered: {"hide": true} = OK or the 10 seconds ran out.
async fn close_answer(Json(v): Json<serde_json::Value>) -> Response {
    crate::tray::close_answer(v["hide"].as_bool().unwrap_or(true));
    (StatusCode::OK, "ok").into_response()
}

/// The bar the program adds to the site's pages (top window only), and this device's ID for the page's console.
fn app_bar(device: &str, main_port: u16) -> (String, String) {
    let head = format!(r#"<script>try{{localStorage.setItem("pc-device-id","{device}")}}catch(e){{}}</script>"#);
    // A website page opened on its own in the program's window is shown inside the program's page instead (Contribute
    // Compute, Compute), so the program's header stays on top; inside that frame nothing changes.
    // (in the head, so the page is not drawn first). The program's page is on the main port (this page: the site port).
    let jump = format!(r#"<script>if(window.top===window)location.replace(location.protocol+"//"+location.hostname+":{main_port}/local/#site="+encodeURIComponent(location.pathname+location.search+location.hash));</script>"#);
    (format!("{jump}{head}"), String::new())
}

/// The capacity check's WebSocket, passed to planetcompute.ai with this program's session.
async fn police_ws(State(st): State<Arc<Local>>, uri: Uri, ws: WebSocketUpgrade) -> Response {
    let token = st.session.lock().unwrap().clone();
    let Some(token) = token else {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Not signed in."}))).into_response();
    };
    let host = api::SITE.trim_start_matches("https://");
    let url = format!("wss://{host}{}", uri.path_and_query().map(|p| p.as_str()).unwrap_or("/api/police/ws"));
    ws.on_upgrade(move |socket| crate::wsrelay::relay(socket, url, token))
}

/// The main port passes only /api/ (JSON for this program's page and the tunnel link): no website page shares the
/// origin of the local controls (security review E4).
async fn proxy_main(State(st): State<Arc<Local>>, method: Method, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
    if !uri.path().starts_with("/api/") {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Not here: this program's own page is /local/."}))).into_response();
    }
    pass(st, method, uri, headers, body, false).await
}

/// The site port: every page of the website, with its own security headers (framed only by this program's page).
async fn proxy_site(State(st): State<Arc<Local>>, method: Method, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
    pass(st, method, uri, headers, body, true).await
}

/// Pass a request to planetcompute.ai with this program's session, and keep the session the site sets or clears.
/// HTML pages get this device's ID, and open inside the program's page when they are not in its frame already.
async fn pass(st: Arc<Local>, method: Method, uri: Uri, headers: HeaderMap, body: Bytes, site: bool) -> Response {
    let url = format!("{}{}", api::SITE, uri.path_and_query().map(|p| p.as_str()).unwrap_or("/"));
    let mut rq = st.http.request(method, &url).body(body);
    if let Some(ct) = headers.get(header::CONTENT_TYPE) {
        rq = rq.header(header::CONTENT_TYPE, ct.clone());
    }
    let token = st.session.lock().unwrap().clone();
    if let Some(t) = token {
        rq = rq.header(header::COOKIE, format!("{}={t}", api::COOKIE));
    }
    let r = match rq.send().await {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("Cannot reach planetcompute.ai ({e}).");
            return (StatusCode::BAD_GATEWAY, Json(serde_json::json!({"error": msg}))).into_response();
        }
    };
    let prefix = format!("{}=", api::COOKIE);
    for sc in r.headers().get_all(header::SET_COOKIE) {
        if let Some(v) = sc.to_str().ok().and_then(|s| s.strip_prefix(prefix.as_str())) {
            let t = v.split(';').next().unwrap_or("").trim();
            set_session(&st, (!t.is_empty()).then(|| t.to_string()));
        }
    }
    let status = r.status();
    let ct = r.headers().get(header::CONTENT_TYPE).cloned();
    // security review E4: keep the site's own protection (CSP, nosniff, how files download, referrer); its pages may be
    // framed only by this program's page (the site forbids frames elsewhere)
    let keep: Vec<(header::HeaderName, header::HeaderValue)> = [header::CONTENT_SECURITY_POLICY, header::X_CONTENT_TYPE_OPTIONS,
        header::CONTENT_DISPOSITION, header::REFERRER_POLICY, header::CACHE_CONTROL]
        .into_iter().filter_map(|n| r.headers().get(&n).cloned().map(|v| (n, v))).collect();
    let mut bytes = r.bytes().await.unwrap_or_default();
    if site && ct.as_ref().and_then(|c| c.to_str().ok()).is_some_and(|c| c.starts_with("text/html")) {
        let (head, bar) = app_bar(&st.device, st.port);
        let page = String::from_utf8_lossy(&bytes).replacen("<head>", &format!("<head>{head}"), 1).replacen("</body>", &format!("{bar}</body>"), 1);
        bytes = Bytes::from(page);
    }
    let mut resp = (status, bytes).into_response();
    if let Some(ct) = ct {
        resp.headers_mut().insert(header::CONTENT_TYPE, ct);
    }
    let me = format!("http://127.0.0.1:{p} http://localhost:{p}", p = st.port);
    for (n, v) in keep {
        let v = if n == header::CONTENT_SECURITY_POLICY {
            let csp = v.to_str().unwrap_or("").replace("frame-ancestors 'none'", &format!("frame-ancestors {me}")).replace("frame-ancestors 'self'", &format!("frame-ancestors {me}"));
            match csp.parse() { Ok(x) => x, Err(_) => continue }
        } else { v };
        resp.headers_mut().insert(n, v);
    }
    if !site {
        resp.headers_mut().insert(header::X_FRAME_OPTIONS, header::HeaderValue::from_static("DENY"));
    }
    resp
}

pub(crate) fn config_file(name: &str) -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join("planetCompute").join(name))
}

fn session_file() -> Option<std::path::PathBuf> {
    config_file("session")
}

/// The device ID: made once (12 hex digits, the website console's format) and kept.
fn device_id() -> String {
    let f = config_file("device_id");
    if let Some(id) = f.as_ref().and_then(|f| std::fs::read_to_string(f).ok()) {
        let id = id.trim().to_string();
        if id.len() == 12 && id.chars().all(|c| c.is_ascii_hexdigit()) {
            return id.to_ascii_lowercase();
        }
    }
    let id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
    if let Some(f) = f {
        if let Some(dir) = f.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&f, &id);
    }
    id
}

/// The link ID kept by "Make a new link"; else the device ID (the link every copy had before).
fn link_id() -> String {
    let id = config_file("link_id").and_then(|f| std::fs::read_to_string(f).ok()).unwrap_or_default().trim().to_ascii_lowercase();
    if id.len() == 12 && id.chars().all(|c| c.is_ascii_hexdigit()) { id } else { device_id() }
}

fn load_session() -> Option<String> {
    let t = std::fs::read_to_string(session_file()?).ok()?;
    let t = t.trim();
    (!t.is_empty()).then(|| t.to_string())
}

fn set_session(st: &Local, token: Option<String>) {
    *st.session.lock().unwrap() = token.clone();
    let Some(f) = session_file() else { return };
    match token {
        Some(t) => {
            if let Some(dir) = f.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&f, t);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600));
            }
        }
        None => {
            let _ = std::fs::remove_file(&f);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::update_view;
    use serde_json::json;

    // plan_old_programs #1/#3: dates, the build in the User-Agent, and the update notice from latest.json
    #[test]
    fn build_identity_and_update_notice() {
        assert_eq!(crate::utc_text(0), "1970-01-01 00:00 UTC");
        assert_eq!(crate::utc_text(1761908400), "2025-10-31 11:00 UTC");
        assert_eq!(crate::utc_text(1951649999), "2031-11-05 12:59 UTC");
        assert_eq!(crate::utc_text(951782400), "2000-02-29 00:00 UTC");
        assert!(crate::UA.starts_with("planetCompute/0.1.0+"));
        assert!(crate::UA.ends_with(&format!("{}.{}", crate::BUILD, crate::BUILD_TIME_S)));
        let j = json!({"builds": {"linux": {"build_time": 2000, "commit": "abc1234"}}, "min_earn_build": 1500, "min_earn_mode": "warn"});
        let v = update_view(&j, "linux", 1000);
        assert_eq!((v["available"].as_bool(), v["too_old_to_earn"].as_bool(), v["commit"].as_str()), (Some(true), Some(true), Some("abc1234")));
        let v = update_view(&j, "linux", 2000);
        assert_eq!((v["available"].as_bool(), v["too_old_to_earn"].as_bool()), (Some(false), Some(false)));
        // an older list (no build_time), another platform, a dev build: no notice
        assert_eq!(update_view(&json!({"builds": {"linux": {"sha256": "x"}}}), "linux", 1000)["available"].as_bool(), Some(false));
        assert_eq!(update_view(&j, "mac", 1000)["available"].as_bool(), Some(false));
        assert_eq!(update_view(&j, "linux", 0)["available"].as_bool(), Some(false));
    }
}
