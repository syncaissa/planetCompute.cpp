// Harness's API, the one llama.cpp's server and OpenAI speak, at http://localhost:7526/v1 :
//   GET  /v1/models              the downloaded models
//   POST /v1/chat/completions    {model, messages, stream, max_tokens, temperature, top_p, seed}
// Tools that talk to llama.cpp or OpenAI work unchanged. For now the models run on this computer; when the
// PlanetCompute grid opens, the same requests go to it.

use crate::llm::{Event, Job};
use crate::models;
use crate::server::Local;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::sse::{Event as Sse, Sse as SseBody};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::sync::Arc;
use tokio::sync::mpsc::UnboundedReceiver;

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({"error": {"message": msg, "type": "invalid_request_error"}}))).into_response()
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub async fn list(State(_st): State<Arc<Local>>) -> Json<Value> {
    let data: Vec<Value> = models::downloaded()
        .into_iter()
        .filter(models::installed)
        .filter(|m| models::kind_of(m) == "text")
        .map(|m| json!({"id": m["id"], "object": "model", "created": 0, "owned_by": "planetCompute", "name": m["name"]}))
        .collect();
    Json(json!({"object": "list", "data": data}))
}

/// "content" may be a string or a list of parts ({type: "text", text}).
fn text_of(c: &Value) -> String {
    match c {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join(""),
        _ => String::new(),
    }
}

pub async fn chat(State(st): State<Arc<Local>>, Json(v): Json<Value>) -> Response {
    let installed: Vec<Value> = models::downloaded().into_iter().filter(models::installed).filter(|m| models::kind_of(m) == "text").collect();
    let m = match v["model"].as_str().filter(|s| !s.is_empty()) {
        Some(id) => match models::find(id) {
            Some(m) => m,
            None => return err(StatusCode::NOT_FOUND, &format!("model {id} is not downloaded; GET /v1/models lists the downloaded ones")),
        },
        None => match installed.first() {
            Some(m) => m.clone(),
            None => return err(StatusCode::NOT_FOUND, "no model downloaded yet: download one on the Receive Compute tab"),
        },
    };
    if !models::installed(&m) {
        return err(StatusCode::NOT_FOUND, "this model is not downloaded yet: download it on the Receive Compute tab");
    }
    if models::kind_of(&m) != "text" {
        return err(StatusCode::BAD_REQUEST, "that is an image model: use /v1/images/generations");
    }
    if models::outside_library(&m) && !models::allow_outside() {   // security review E5
        return err(StatusCode::FORBIDDEN, "this model file was added from outside the PlanetCompute library and is not checked by us: to use it, switch on 'Allow model files from outside the library' on the Models page");
    }
    let messages: Vec<(String, String)> = v["messages"]
        .as_array()
        .map(|a| a.iter().map(|x| (x["role"].as_str().unwrap_or("user").to_string(), text_of(&x["content"]))).collect())
        .unwrap_or_default();
    if messages.is_empty() {
        return err(StatusCode::BAD_REQUEST, "messages is empty");
    }
    let max_tokens = v["max_tokens"].as_u64().or(v["max_completion_tokens"].as_u64()).unwrap_or(1024).clamp(1, 16384) as usize;
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let model_id = m["id"].as_str().unwrap_or("").to_string();
    st.llm.submit(Job {
        model_id: model_id.clone(),
        path: models::path_of(&m),
        messages,
        max_tokens,
        temperature: v["temperature"].as_f64().unwrap_or(0.8) as f32,
        top_p: v["top_p"].as_f64().unwrap_or(0.95) as f32,
        seed: v["seed"].as_u64().map(|s| s as u32).unwrap_or_else(|| uuid::Uuid::new_v4().as_u128() as u32),
        threads: v["threads"].as_u64().unwrap_or(0).min(256) as i32,
        out: tx,
    });
    let id = format!("chatcmpl-{}", &uuid::Uuid::new_v4().simple().to_string()[..24]);
    if v["stream"].as_bool() == Some(true) {
        stream(rx, id, model_id).into_response()
    } else {
        whole(rx, id, model_id).await
    }
}

async fn whole(mut rx: UnboundedReceiver<Event>, id: String, model: String) -> Response {
    let mut text = String::new();
    while let Some(e) = rx.recv().await {
        match e {
            Event::Text(t) => text.push_str(&t),
            Event::Done { prompt_tokens, completion_tokens, finish } => {
                return Json(json!({
                    "id": id, "object": "chat.completion", "created": now(), "model": model,
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": finish}],
                    "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens, "total_tokens": prompt_tokens + completion_tokens},
                }))
                .into_response()
            }
            Event::Error(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, &e),
        }
    }
    err(StatusCode::INTERNAL_SERVER_ERROR, "the model runner stopped")
}

fn chunk(id: &str, model: &str, delta: Value, finish: Value) -> Sse {
    Sse::default().data(
        json!({"id": id, "object": "chat.completion.chunk", "created": now(), "model": model,
               "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})
        .to_string(),
    )
}

/// Server-sent events: a first chunk with the role, one per text piece, a last one with the reason, then [DONE].
fn stream(rx: UnboundedReceiver<Event>, id: String, model: String) -> SseBody<impl futures_util::Stream<Item = Result<Sse, Infallible>>> {
    let s = futures_util::stream::unfold((rx, 0u8), move |(mut rx, phase)| {
        let (id, model) = (id.clone(), model.clone());
        async move {
            match phase {
                0 => Some((Ok(chunk(&id, &model, json!({"role": "assistant", "content": ""}), Value::Null)), (rx, 1))),
                1 => match rx.recv().await {
                    Some(Event::Text(t)) => Some((Ok(chunk(&id, &model, json!({"content": t}), Value::Null)), (rx, 1))),
                    Some(Event::Done { finish, .. }) => Some((Ok(chunk(&id, &model, json!({}), json!(finish))), (rx, 2))),
                    Some(Event::Error(e)) => Some((Ok(Sse::default().data(json!({"error": {"message": e}}).to_string())), (rx, 2))),
                    None => Some((Ok(Sse::default().data(json!({"error": {"message": "the model runner stopped"}}).to_string())), (rx, 2))),
                },
                2 => Some((Ok(Sse::default().data("[DONE]")), (rx, 3))),
                _ => None,
            }
        }
    });
    SseBody::new(s)
}

/// POST /v1/images/generations {model?, prompt, size "WxH", n 1, seed?, steps?}: made on this computer by the image
/// engine (image.rs), answered when the picture is ready, as base64 PNG.
pub async fn images(State(st): State<Arc<Local>>, Json(v): Json<Value>) -> Response {
    let model = match v["model"].as_str().filter(|s| !s.is_empty()) {
        Some(id) => id.to_string(),
        None => match models::downloaded().into_iter().find(|m| models::kind_of(m) == "image" && models::installed(m)) {
            Some(m) => m["id"].as_str().unwrap_or("").to_string(),
            None => return err(StatusCode::NOT_FOUND, "no image model downloaded yet: download one on the Receive Compute tab"),
        },
    };
    let (w, h) = v["size"].as_str().and_then(|x| x.split_once('x')).and_then(|(a, b)| Some((a.parse::<u64>().ok()?, b.parse::<u64>().ok()?))).unzip();
    let mut req = json!({"model": model, "prompt": v["prompt"], "seed": v["seed"], "steps": v["steps"]});
    if let (Some(w), Some(h)) = (w, h) {
        req["width"] = json!(w);
        req["height"] = json!(h);
    }
    let id = match st.images.start(&req) {
        Ok(id) => id,
        Err(e) => return err(StatusCode::BAD_REQUEST, &e),
    };
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        // security review E6: a request removed meanwhile ends here (it used to loop forever)
        let Some(j) = st.images.job(&id) else { return err(StatusCode::GONE, "the picture request was removed") };
        match j["state"].as_str().unwrap_or("") {
            "done" => {
                let Some(p) = st.images.file(&id) else { return err(StatusCode::INTERNAL_SERVER_ERROR, "the picture is missing") };
                let bytes = tokio::fs::read(&p).await.unwrap_or_default();
                use base64::Engine as _;
                return Json(json!({"created": now(), "data": [{"b64_json": base64::engine::general_purpose::STANDARD.encode(bytes)}]})).into_response();
            }
            "error" | "cancelled" => return err(StatusCode::INTERNAL_SERVER_ERROR, j["error"].as_str().filter(|e| !e.is_empty()).unwrap_or("stopped")),
            _ => {}
        }
    }
}
