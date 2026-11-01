// planetCompute heartbeat server (CostOfComputeCFetc.txt, admin page tab Servers).
//
// Volunteers (the website's console and the planetCompute program) send their heartbeat here first, behind
// Cloudflare's proxy (https://hbN.planetcompute.ai); when no server answers they report to the website as before.
// This server keeps, per device and session, only the newest beat (a beat carries the session's running totals),
// writes it to a journal on disk (a restart loses nothing), and hands the beats to planetcompute.ai in signed batches
// (POST /api/hb/ingest) at least every HB_INGEST_S seconds, and at once when a device pauses or stops. The website
// checks and credits them exactly like a direct report. No database and no AWS keys here.
//
//   GET  /health   {ok, version, pending}                       (the website's health check)
//   POST /beat     Authorization: Bearer <pass from /api/hb/config>; body = the volunteer's report (<= 4 KB)
//
// Configuration (environment; the install script writes /etc/hbserver/hbserver.env):
//   HB_SERVER_SECRET  shared with the website (Worker secret of the same name)      required
//   HB_SERVER_ID      this server's row in planetcompute-ai-HeartbeatEtcEC2TypeServers
//   HB_SITE           https://planetcompute.ai
//   HB_LISTEN         0.0.0.0:443
//   HB_TLS_CERT / HB_TLS_KEY   PEM files (self-signed is fine: Cloudflare's SSL mode is "Full")
//   HB_DATA           /var/lib/hbserver (the journal)
//   HB_INGEST_S       600 (the website accepts up to 900)
use axum::{
    body::Bytes,
    extract::State,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const BATCH: usize = 100; // the website takes at most 100 beats per request (HB_BATCH)
const MAX_PENDING: usize = 3_000_000;
const MIN_BEAT_GAP_S: u64 = 5; // security review P2
const SESSIONS_PER_DEVICE: usize = 3; // security review P2

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
struct Beat {
    at: u64,         // when this server received it (unix seconds)
    first: u64,      // when the oldest beat not yet handed in for this device+session arrived
    urgent: bool,    // paused / stopped: hand in at once
    ip: String,      // the volunteer's address (CF-Connecting-IP: only Cloudflare reaches this server)
    country: String, // CF-IPCountry
    token: String,
    body: Value,
}

struct App {
    secret: String,
    server_id: String,
    site: String,
    ingest_s: u64,
    data: std::path::PathBuf,
    pending: Mutex<HashMap<(String, String), Beat>>, // (device, session) -> newest beat
    /// device -> its sessions held now, oldest first, and when it last sent a beat (security review P2: one pass cannot
    /// create sessions without end or flood the server)
    per_dev: Mutex<HashMap<String, (Vec<String>, u64)>>,
    journal: Mutex<Option<std::fs::File>>,
    http: reqwest::Client,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn hmac_hex(secret: &str, text: &str) -> String {
    let mut m = HmacSha256::new_from_slice(secret.as_bytes()).expect("any key length");
    m.update(text.as_bytes());
    hex::encode(m.finalize().into_bytes())
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

/// "<user>.<device>.<until>.<hmac>" from the website: Some(device) when it is genuine and not expired.
fn check_pass(secret: &str, token: &str) -> Option<String> {
    let p: Vec<&str> = token.split('.').collect();
    if p.len() != 4 || p[0].len() != 12 || p[1].len() != 12 || !p[..2].iter().all(|x| x.bytes().all(|c| c.is_ascii_hexdigit())) {
        return None;
    }
    let until: u64 = p[2].parse().ok()?;
    if until < now() || !same(p[3], &hmac_hex(secret, &format!("hb|{}.{}.{}", p[0], p[1], p[2]))) {
        return None;
    }
    Some(p[1].to_string())
}

fn cors(h: &HeaderMap, mut r: Response) -> Response {
    // the website's console calls this from https://planetcompute.ai (the program is not a browser: no CORS)
    if let Some(o) = h.get(header::ORIGIN).and_then(|o| o.to_str().ok()) {
        if o == "https://planetcompute.ai" || o.ends_with(".planetcompute.ai") && o.starts_with("https://") {
            let hs = r.headers_mut();
            hs.insert("access-control-allow-origin", HeaderValue::from_str(o).unwrap());
            hs.insert("access-control-allow-methods", HeaderValue::from_static("POST, OPTIONS"));
            hs.insert("access-control-allow-headers", HeaderValue::from_static("authorization, content-type"));
            hs.insert("access-control-max-age", HeaderValue::from_static("86400"));
            hs.insert("vary", HeaderValue::from_static("origin"));
        }
    }
    r
}

fn reply(code: StatusCode, v: Value) -> Response {
    (code, [(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-store")], v.to_string()).into_response()
}

async fn health(State(app): State<Arc<App>>) -> Response {
    let n = app.pending.lock().unwrap().len();
    reply(StatusCode::OK, json!({"ok": true, "version": VERSION, "pending": n}))
}

async fn preflight(h: HeaderMap) -> Response {
    cors(&h, StatusCode::NO_CONTENT.into_response())
}

async fn beat(State(app): State<Arc<App>>, h: HeaderMap, body: Bytes) -> Response {
    let r = take_beat(&app, &h, &body);
    cors(&h, r)
}

fn take_beat(app: &App, h: &HeaderMap, body: &Bytes) -> Response {
    if body.len() > 4096 {
        return reply(StatusCode::PAYLOAD_TOO_LARGE, json!({"error": "too large"}));
    }
    let token = h.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).unwrap_or("");
    let Some(device) = check_pass(&app.secret, token) else {
        return reply(StatusCode::UNAUTHORIZED, json!({"error": "bad or expired pass"}));
    };
    let Ok(b) = serde_json::from_slice::<Value>(body) else {
        return reply(StatusCode::BAD_REQUEST, json!({"error": "bad JSON"}));
    };
    if b["device_id"].as_str() != Some(device.as_str()) {
        return reply(StatusCode::FORBIDDEN, json!({"error": "device does not match the pass"}));
    }
    let session = b["session_id"].as_str().unwrap_or("legacy").chars().take(32).collect::<String>();
    let state = b["state"].as_str().unwrap_or("");
    let hv = |k: &str| h.get(k).and_then(|v| v.to_str().ok()).unwrap_or("").chars().take(45).collect::<String>();
    let t = now();
    // security review P2: at most one beat per device every MIN_BEAT_GAP_S (a volunteer sends one every few minutes),
    // and at most SESSIONS_PER_DEVICE sessions held per device (a new one replaces the device's oldest)
    let mut drop_session: Option<String> = None;
    {
        let mut pd = app.per_dev.lock().unwrap();
        let e = pd.entry(device.clone()).or_insert_with(|| (Vec::new(), 0));
        if e.1 > 0 && t.saturating_sub(e.1) < MIN_BEAT_GAP_S {
            return reply(StatusCode::TOO_MANY_REQUESTS, json!({"error": "too often"}));
        }
        e.1 = t;
        if !e.0.contains(&session) {
            e.0.push(session.clone());
            if e.0.len() > SESSIONS_PER_DEVICE {
                drop_session = Some(e.0.remove(0));
            }
        }
    }
    let mut beat = Beat { at: t, first: t, urgent: state == "paused" || state == "stopped", ip: hv("cf-connecting-ip"),
                          country: hv("cf-ipcountry").chars().take(4).collect(), token: token.to_string(), body: b };
    {
        let mut p = app.pending.lock().unwrap();
        if p.len() >= MAX_PENDING && !p.contains_key(&(device.clone(), session.clone())) {
            return reply(StatusCode::SERVICE_UNAVAILABLE, json!({"error": "busy"}));   // the volunteer falls back to the website
        }
        if let Some(old_s) = drop_session {
            p.remove(&(device.clone(), old_s));
        }
        if let Some(old) = p.get(&(device.clone(), session.clone())) {
            beat.first = old.first;
            beat.urgent |= old.urgent;
        }
        journal_write(app, &device, &session, &beat);
        p.insert((device, session), beat);
    }
    reply(StatusCode::OK, json!({"ok": true, "via": "server"}))
}

fn journal_line(device: &str, session: &str, b: &Beat) -> String {
    json!({"d": device, "s": session, "at": b.at, "first": b.first, "urgent": b.urgent, "ip": b.ip, "country": b.country,
           "token": b.token, "body": b.body}).to_string()
}

fn journal_write(app: &App, device: &str, session: &str, b: &Beat) {
    let mut j = app.journal.lock().unwrap();
    if let Some(f) = j.as_mut() {
        let _ = writeln!(f, "{}", journal_line(device, session, b));
    }
}

/// Rewrite the journal with what is still pending (after a successful hand-in).
fn journal_compact(app: &App) {
    let p = app.pending.lock().unwrap();
    let tmp = app.data.join("journal.tmp");
    if let Ok(mut f) = std::fs::File::create(&tmp) {
        for ((d, s), b) in p.iter() {
            let _ = writeln!(f, "{}", journal_line(d, s, b));
        }
        let _ = f.sync_all();
        let _ = std::fs::rename(&tmp, app.data.join("journal.jsonl"));
    }
    let mut j = app.journal.lock().unwrap();
    *j = std::fs::OpenOptions::new().create(true).append(true).open(app.data.join("journal.jsonl")).ok();
}

fn journal_replay(app: &App) -> usize {
    let Ok(f) = std::fs::File::open(app.data.join("journal.jsonl")) else { return 0 };
    let mut p = app.pending.lock().unwrap();
    for line in std::io::BufReader::new(f).lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let (Some(d), Some(s)) = (v["d"].as_str(), v["s"].as_str()) else { continue };
        let b = Beat { at: v["at"].as_u64().unwrap_or(0), first: v["first"].as_u64().unwrap_or(0), urgent: v["urgent"].as_bool().unwrap_or(false),
                       ip: v["ip"].as_str().unwrap_or("").into(), country: v["country"].as_str().unwrap_or("").into(),
                       token: v["token"].as_str().unwrap_or("").into(), body: v["body"].clone() };
        let k = (d.to_string(), s.to_string());
        if p.get(&k).map_or(true, |o| o.at <= b.at) {
            p.insert(k, b);
        }
    }
    p.len()
}

/// Hand due beats to the website, oldest first, in signed batches. A beat replaced while its batch was on the way
/// stays pending (the newer one goes next time).
async fn ingest_once(app: &App) -> Result<usize, String> {
    let t = now();
    let mut due: Vec<((String, String), Beat)> = {
        let p = app.pending.lock().unwrap();
        p.iter().filter(|(_, b)| b.urgent || t.saturating_sub(b.first) >= app.ingest_s).map(|(k, b)| (k.clone(), b.clone())).collect()
    };
    if due.is_empty() {
        return Ok(0);
    }
    due.sort_by_key(|(_, b)| b.at);
    let mut sent = 0;
    for chunk in due.chunks(BATCH) {
        let beats: Vec<Value> = chunk.iter().map(|(_, b)| json!({"token": b.token, "at": b.at, "ip": b.ip, "country": b.country, "beat": b.body})).collect();
        let raw = json!({"server_id": app.server_id, "beats": beats}).to_string();
        let ts = now().to_string();
        let sig = format!("{ts}.{}", hmac_hex(&app.secret, &format!("ingest|{ts}|{raw}")));
        let r = app.http.post(format!("{}/api/hb/ingest", app.site)).header("x-hb-sig", sig).header("content-type", "application/json")
            .body(raw).send().await.map_err(|e| format!("ingest: {e}"))?;
        if !r.status().is_success() {
            return Err(format!("ingest: HTTP {}", r.status()));
        }
        // the website answered for every beat (accepted, skipped as old, or refused for good): none is resent
        let mut p = app.pending.lock().unwrap();
        for (k, b) in chunk {
            if p.get(k).map_or(false, |cur| cur.at == b.at) {
                p.remove(k);
                if let Some(e) = app.per_dev.lock().unwrap().get_mut(&k.0) {
                    e.0.retain(|x| x != &k.1);
                }
            }
        }
        sent += chunk.len();
    }
    journal_compact(app);
    Ok(sent)
}

async fn ingest_loop(app: Arc<App>) {
    let mut pause = 10u64;
    loop {
        tokio::time::sleep(Duration::from_secs(pause)).await;
        match ingest_once(&app).await {
            Ok(n) => {
                if n > 0 {
                    eprintln!("handed in {n} beats");
                }
                pause = 10;
            }
            Err(e) => {
                eprintln!("{e}; trying again later");
                pause = (pause * 2).min(120);
            }
        }
    }
}

fn env(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.to_string())
}

#[tokio::main]
async fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    if std::env::args().any(|a| a == "--version") {
        println!("hbserver {VERSION}");
        return;
    }
    let secret = env("HB_SERVER_SECRET", "");
    if secret.len() < 32 {
        eprintln!("HB_SERVER_SECRET is missing or too short");
        std::process::exit(2);
    }
    let data = std::path::PathBuf::from(env("HB_DATA", "/var/lib/hbserver"));
    let _ = std::fs::create_dir_all(&data);
    let app = Arc::new(App {
        secret,
        server_id: env("HB_SERVER_ID", ""),
        site: env("HB_SITE", "https://planetcompute.ai").trim_end_matches('/').to_string(),
        ingest_s: env("HB_INGEST_S", "600").parse().unwrap_or(600).clamp(30, 900),
        data: data.clone(),
        pending: Mutex::new(HashMap::new()),
        per_dev: Mutex::new(HashMap::new()),
        journal: Mutex::new(None),
        http: reqwest::Client::builder().timeout(Duration::from_secs(60)).user_agent(concat!("hbserver/", env!("CARGO_PKG_VERSION"))).build().unwrap(),
    });
    let n = journal_replay(&app);
    journal_compact(&app);
    eprintln!("hbserver {VERSION}: {n} beats from the journal; hand-in every {} s to {}", app.ingest_s, app.site);
    tokio::spawn(ingest_loop(app.clone()));

    let router = Router::new()
        .route("/health", get(health))
        .route("/beat", post(beat).options(preflight))
        .with_state(app);
    let listen: std::net::SocketAddr = env("HB_LISTEN", "0.0.0.0:443").parse().expect("HB_LISTEN");
    let (cert, key) = (env("HB_TLS_CERT", ""), env("HB_TLS_KEY", ""));
    if cert.is_empty() {
        eprintln!("plain HTTP on {listen} (no HB_TLS_CERT: for tests only)");
        axum_server::bind(listen).serve(router.into_make_service()).await.unwrap();
    } else {
        let tls = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert, key).await.expect("TLS certificate");
        eprintln!("HTTPS on {listen}");
        axum_server::bind_rustls(listen, tls).serve(router.into_make_service()).await.unwrap();
    }
}
