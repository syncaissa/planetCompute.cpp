// The planetcompute.ai tunnel link: https://planetcompute.ai/device/<device id>/ shows this program's console
// from anywhere, to its signed-in owner only (worker.js DeviceTunnel). While signed in, the program keeps ONE
// outbound WebSocket to planetcompute.ai (no open ports); the site relays each request to the link over it, the
// program answers it from its own local web server, and the answer goes back.

use crate::server::Local;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

pub fn link(device: &str) -> String {
    format!("{}/device/{device}/", crate::api::SITE)
}

/// Keep the tunnel up while signed in; reconnect with back-off; reconnect when the session changes.
pub async fn run(st: Arc<Local>) {
    let mut wait = 2;
    loop {
        let token = st.session.lock().unwrap().clone();
        match token {
            None => {
                st.set_tunnel("off: sign in to switch on the link");
                wait = 2;
            }
            Some(token) => match once(&st, &token).await {
                Ok(()) => wait = 2,
                // the site deleted this link (Connect a Browser, "Delete" on any device): carry on with a new one
                Err(e) if e == GONE => {
                    st.new_link();
                    wait = 1;
                }
                Err(e) => {
                    st.set_tunnel(&format!("offline, retrying ({e})"));
                    wait = (wait * 2).min(60);
                }
            },
        }
        tokio::time::sleep(Duration::from_secs(wait)).await;
    }
}

pub(crate) fn device_name() -> String {
    let n = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .unwrap_or_default();
    let n: String = n.trim().chars().filter(|c| c.is_ascii_alphanumeric() || "-_.".contains(*c)).take(60).collect();
    if n.is_empty() { "planetCompute".into() } else { n }
}

/// once() ends with this when planetcompute.ai answers that the link was deleted (HTTP 410, or close code 4003).
const GONE: &str = "link deleted";

async fn once(st: &Arc<Local>, token: &str) -> Result<(), String> {
    let host = crate::api::SITE.trim_start_matches("https://");
    let link = st.link_id();
    let url = format!("wss://{host}/api/tunnel/connect?device={link}&name={}", device_name());
    let mut req = url.into_client_request().map_err(|e| e.to_string())?;
    let h = req.headers_mut();
    h.insert("cookie", format!("{}={token}", crate::api::COOKIE).parse().map_err(|_| "bad session".to_string())?);
    h.insert("user-agent", crate::UA.parse().unwrap());
    // this installation's key: the site binds the link to it, so a stolen sign-in cannot take the link over (review T2)
    h.insert("x-pc-device-key", crate::server::tunnel_key().parse().map_err(|_| "bad device key".to_string())?);
    let (ws, _) = match tokio_tungstenite::connect_async(req).await {
        Ok(x) => x,
        Err(tokio_tungstenite::tungstenite::Error::Http(r)) if r.status().as_u16() == 410 => return Err(GONE.into()),
        Err(e) => return Err(e.to_string()),
    };
    st.set_tunnel("on");
    let (mut sink, mut stream) = ws.split();
    // bounded (security review T3): a slow visitor slows the answers down instead of piling them up in memory
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(64);
    let mut tick = tokio::time::interval(Duration::from_secs(25));
    loop {
        tokio::select! {
            m = stream.next() => {
                let m = match m {
                    Some(Ok(m)) => m,
                    Some(Err(e)) => return Err(e.to_string()),
                    None => return Err("closed".into()),
                };
                if let Message::Close(Some(f)) = &m {
                    if u16::from(f.code) == 4003 {
                        return Err(GONE.into());
                    }
                }
                if m.is_close() {
                    return Err("closed by planetcompute.ai".into());
                }
                let Ok(v) = serde_json::from_str::<Value>(m.to_text().unwrap_or("")) else { continue };
                if v["t"] == "req" {
                    let (st, tx) = (st.clone(), tx.clone());
                    tokio::spawn(async move { relay(&st, v, &tx).await });
                }
            }
            // "Make a new link": connect again at once with the new ID
            _ = st.relink.notified() => {
                let _ = sink.close().await;
                return Ok(());
            }
            Some(out) = rx.recv() => {
                sink.send(Message::text(out)).await.map_err(|e| e.to_string())?;
            }
            _ = tick.tick() => {
                let same = st.session.lock().unwrap().as_deref() == Some(token);
                if !same {
                    let _ = sink.close().await;
                    return Ok(());
                }
                sink.send(Message::text(r#"{"t":"ping"}"#.to_string())).await.map_err(|e| e.to_string())?;
            }
        }
    }
}

/// Answer one relayed request from this program's own local web server. Harness answers (/v1/...) go back as they
/// are made: a header {t:"res", stream:true}, then {t:"chunk"} pieces, then {t:"end"} (streamed chat, and no size
/// or 30-second limit); everything else as one message {t:"res", body}, except a big answer (a full-size picture or
/// a video): in pieces of PIECE bytes the same way, so no WebSocket message comes near Cloudflare's size limit.
async fn relay(st: &Local, v: Value, tx: &tokio::sync::mpsc::Sender<String>) {
    let id = v["id"].clone();
    let send = |m: Value| async move {
        let _ = tx.send(m.to_string()).await;
    };
    // The link shows this device's own page (/local/), its API calls and Harness (/v1/); never /local/quit, /local/close, /local/open or
    // /local/image/folder, /local/storage/open or /local/link/ (Make a new link would cut the visitor off), never
    // the site's console (that would compute in the visitor's browser instead of on this device).
    let path = match v["path"].as_str().unwrap_or("/") {
        "/" | "" => "/local/",
        p if p.starts_with("/?") => "/local/",
        p => p,
    };
    let allowed = path.starts_with("/local/") || path.starts_with("/api/") || path.starts_with("/v1/");
    if !allowed || path.starts_with("/local/quit") || path.starts_with("/local/close") || path.starts_with("/local/open") || path.starts_with("/local/image/folder") || path.starts_with("/local/link/") || path.starts_with("/local/storage/open") {
        send(json!({"t": "res", "id": id, "status": 403, "ct": "text/plain", "body": B64.encode(b"Not over the tunnel.")})).await;
        return;
    }
    let harness = path.starts_with("/v1/");
    let method = reqwest::Method::from_bytes(v["method"].as_str().unwrap_or("GET").as_bytes()).unwrap_or(reqwest::Method::GET);
    let body = B64.decode(v["body"].as_str().unwrap_or("")).unwrap_or_default();
    // Harness may take minutes: the client without an overall time limit
    let http = if harness { &st.dl_http } else { &st.http };
    let mut rq = http.request(method, format!("http://127.0.0.1:{}{path}", st.port)).body(body)
        .header("authorization", format!("Bearer {}", crate::server::local_token()));   // this program's secret (review E1)
    if let Some(ct) = v["ct"].as_str().filter(|c| !c.is_empty()) {
        rq = rq.header("content-type", ct);
    }
    let mut r = match rq.send().await {
        Ok(r) => r,
        Err(e) => {
            send(json!({"t": "res", "id": id, "status": 502, "ct": "text/plain", "body": B64.encode(e.to_string())})).await;
            return;
        }
    };
    let status = r.status().as_u16();
    let ct = r.headers().get("content-type").and_then(|h| h.to_str().ok()).unwrap_or("").to_string();
    if harness {
        send(json!({"t": "res", "id": id, "status": status, "ct": ct, "stream": true})).await;
        while let Ok(Some(piece)) = r.chunk().await {
            send(json!({"t": "chunk", "id": id, "body": B64.encode(&piece)})).await;
        }
        send(json!({"t": "end", "id": id})).await;
    } else {
        // read as it comes (security review T3: never a whole video in memory): up to BIG bytes it goes in one message;
        // past that, in pieces of PIECE bytes as they arrive
        let mut buf: Vec<u8> = Vec::new();
        let mut streaming = false;
        loop {
            let piece = match r.chunk().await { Ok(Some(p)) => p, _ => break };
            buf.extend_from_slice(&piece);
            if !streaming && buf.len() > BIG {
                streaming = true;
                send(json!({"t": "res", "id": id, "status": status, "ct": ct, "stream": true})).await;
            }
            if streaming {
                while buf.len() >= PIECE {
                    let rest = buf.split_off(PIECE);
                    send(json!({"t": "chunk", "id": id, "body": B64.encode(&buf)})).await;
                    buf = rest;
                }
            }
        }
        if streaming {
            if !buf.is_empty() {
                send(json!({"t": "chunk", "id": id, "body": B64.encode(&buf)})).await;
            }
            send(json!({"t": "end", "id": id})).await;
        } else {
            send(json!({"t": "res", "id": id, "status": status, "ct": ct, "body": B64.encode(&buf)})).await;
        }
    }
}

/// Answers bigger than this go in pieces of PIECE bytes (each message about 350 KB once Base64-encoded).
const BIG: usize = 384 * 1024;
const PIECE: usize = 256 * 1024;
