//! M3 网络图片路由：预览代理 + 一键本地化。
//!
//! - `GET /api/proxy/image?url=<encoded>&token=<mwb-token>`：仅此路由允许 query token 鉴权
//!   （iframe 内 `<img>` 无法携带 `X-MWB-Token` 请求头）。鉴权在 handler 内完成，
//!   `routes/mod.rs` 的 auth 中间件对该路径放行。
//! - `POST /api/decks/:id/localize-images`：下载远程图片到 deck `assets/`，返回 url→path 映射；
//!   两个接口共用 `crate::routes::remote_image` 的下载/缓存/安全管线。
use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tokio::sync::Semaphore;

use super::remote_image::{self, DownloadedImage, ImageError, ImageErrorKind};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/proxy/image", get(proxy_image))
        .route("/decks/{id}/localize-images", post(localize_images))
}

/// GET /api/proxy/image?url=<encoded>&token=<mwb-token>
async fn proxy_image(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(token) = query.get("token") else {
        return ApiError::new(
            StatusCode::UNAUTHORIZED,
            "BAD_REQUEST",
            "缺少或无效的图片代理 token",
        )
        .into_response();
    };
    if !token_eq(token, &state.token) {
        return ApiError::new(
            StatusCode::UNAUTHORIZED,
            "BAD_REQUEST",
            "缺少或无效的图片代理 token",
        )
        .into_response();
    }
    let Some(url) = query.get("url") else {
        return ApiError::bad_request("缺少 url 参数").into_response();
    };
    if url.trim().is_empty() {
        return ApiError::bad_request("缺少 url 参数").into_response();
    }

    match remote_image::fetch_image(url.clone(), remote_image::allow_private_env()).await {
        Ok(image) => image_response(image),
        Err(err) => image_error_response(err),
    }
}

#[derive(Deserialize)]
struct LocalizeReq {
    #[serde(default)]
    urls: Vec<String>,
}

/// POST /api/decks/:id/localize-images
/// body `{urls:[…]}`（0-50）→ `{mapping:{url:path}, failed:[{url,reason}]}`
async fn localize_images(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<LocalizeReq>,
) -> ApiResult<Json<Value>> {
    let id = util::validate_deck_id(&id)?;
    if !state.deck_slides_path(&id).exists() {
        return Err(ApiError::not_found(format!("deck 不存在: {id}")));
    }
    if req.urls.len() > 50 {
        return Err(ApiError::bad_request("一次最多本地化 50 张图片"));
    }
    if req.urls.is_empty() {
        return Ok(Json(json!({ "mapping": {}, "failed": [] })));
    }

    let allow_private = remote_image::allow_private_env();
    let assets_dir = state.deck_assets_dir(&id);
    tokio::fs::create_dir_all(&assets_dir).await?;

    // 并发 ≤ 4（契约要求），单张失败不影响其它
    let semaphore = Arc::new(Semaphore::new(4));
    let mut tasks = tokio::task::JoinSet::new();
    for url in req.urls.iter().cloned() {
        let sem = semaphore.clone();
        tasks.spawn(async move {
            let _permit = match sem.acquire_owned().await {
                Ok(permit) => permit,
                Err(_) => return (url, Err(remote_image_err("图片下载任务取消"))),
            };
            let result = remote_image::fetch_image(url.clone(), allow_private).await;
            (url, result)
        });
    }

    let mut mapping: Map<String, Value> = Map::new();
    let mut failed: Vec<Value> = Vec::new();
    while let Some(joined) = tasks.join_next().await {
        let (url, result) = match joined {
            Ok(pair) => pair,
            Err(err) => {
                failed.push(json!({ "url": "", "reason": format!("图片下载任务失败：{err}") }));
                continue;
            }
        };
        match result {
            Ok(image) => {
                let hash = remote_image::sha256_hex(&url);
                let file_name = format!("remote-{}.{}", &hash[..8], image.ext);
                let path = assets_dir.join(&file_name);
                if let Err(err) = tokio::fs::write(&path, &image.bytes).await {
                    failed.push(json!({
                        "url": url,
                        "reason": format!("保存图片失败：{err}")
                    }));
                    continue;
                }
                mapping.insert(url, json!(format!("assets/{file_name}")));
            }
            Err(err) => failed.push(json!({ "url": url, "reason": err.message })),
        }
    }

    Ok(Json(json!({ "mapping": mapping, "failed": failed })))
}

fn remote_image_err(message: impl Into<String>) -> ImageError {
    ImageError {
        kind: ImageErrorKind::Upstream,
        message: message.into(),
    }
}

fn image_response(image: DownloadedImage) -> Response {
    let content_type = HeaderValue::from_str(&image.content_type)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
    (
        [
            (header::CONTENT_TYPE, content_type),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, max-age=86400"),
            ),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
        ],
        image.bytes,
    )
        .into_response()
}

fn image_error_response(err: ImageError) -> Response {
    match err.kind {
        ImageErrorKind::BadRequest => ApiError::bad_request(err.message).into_response(),
        ImageErrorKind::NotFound => ApiError::not_found(err.message).into_response(),
        ImageErrorKind::Upstream => {
            ApiError::new(StatusCode::BAD_GATEWAY, "EXPORT_FAILED", err.message).into_response()
        }
    }
}

fn token_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}
