// Pass one WebSocket (the page's capacity check, /api/police/ws) to planetcompute.ai with this program's session.
// No Origin header goes upstream, as the site expects from the program.

use axum::extract::ws::{Message as Local, WebSocket};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, Message as Up};

pub async fn relay(mut local: WebSocket, url: String, token: String) {
    let Ok(mut req) = url.into_client_request() else { return };
    let h = req.headers_mut();
    let (Ok(cookie), Ok(agent)) = (
        HeaderValue::from_str(&format!("{}={token}", crate::api::COOKIE)),
        HeaderValue::from_str(crate::UA),
    ) else {
        return;
    };
    h.insert("cookie", cookie);
    h.insert("user-agent", agent);
    let Ok((up, _)) = tokio_tungstenite::connect_async(req).await else {
        let _ = local.close().await;
        return;
    };
    let (mut up_tx, mut up_rx) = up.split();
    let (mut lo_tx, mut lo_rx) = local.split();
    let to_site = async {
        while let Some(Ok(m)) = lo_rx.next().await {
            let m = match m {
                Local::Text(t) => Up::text(t.as_str().to_string()),
                Local::Binary(b) => Up::binary(b.to_vec()),
                Local::Close(_) => break,
                _ => continue,
            };
            if up_tx.send(m).await.is_err() {
                break;
            }
        }
        let _ = up_tx.close().await;
    };
    let to_page = async {
        while let Some(Ok(m)) = up_rx.next().await {
            let m = match m {
                Up::Text(t) => Local::Text(t.as_str().to_string().into()),
                Up::Binary(b) => Local::Binary(b.to_vec().into()),
                Up::Close(_) => break,
                _ => continue,
            };
            if lo_tx.send(m).await.is_err() {
                break;
            }
        }
        let _ = lo_tx.close().await;
    };
    tokio::select! {
        _ = to_site => {}
        _ = to_page => {}
    }
}
