//! 导出路由（export-eng）：契约 docs/API_CONTRACT.md §1.6/§1.7。
//!
//! 本文件替换 server-core 搭的 501 stub，并由它通过
//! `#[path = "../export/mod.rs"]` 挂载 `server/src/export/**`（无需改 main.rs）。
//!
//! | 方法 | 路径 | 说明 |
//! |---|---|---|
//! | POST | `/api/export/pdf` | 打印页 → 无头 Chrome/Edge `--print-to-pdf` |
//! | POST | `/api/export/capture` | CDP 逐页原生截图（PPTX/PNG 用） |
//! | POST | `/api/export/html` | 单文件 HTML（离线可播） |
//! | GET | `/api/export/file/{name}` | 下载导出文件（attachment + 中文名） |
//! | GET | `/api/export/tmp/{token}/{file}` | 读取 capture 临时截图（TTL 10 分钟） |
//!
//! 说明：契约 §1.7 的 `GET /api/export/print/:token` 未启用 —— 浏览器 CLI 导航无法
//! 携带 `X-MWB-Token` 头，打印页改为 `%TEMP%\MarpWorkbench\pdf-*/print.html` + `file://`
//! 打开（实测与本地 HTTP 打印质量/字节一致）。临时目录在成功/失败/超时路径都会清理。
//!
//! 鉴权：所有 `/api` 路由已由 `routes/mod.rs` 的 auth_middleware 统一校验
//! `X-MWB-Token` / Origin，本模块不重复校验（前端 `fetch` 带 header 下载文件）。

use std::{
    sync::{Arc, OnceLock},
};

use axum::{
    extract::{Path as AxumPath, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};

use crate::{
    error::ApiError,
    state::AppState,
    util,
};

#[path = "../export/mod.rs"]
mod imp;

use imp::{
    capture, html_export, pdf, CapturePayload, ExpError, RenderPayload,
};

/// 导出并发锁：无头浏览器吃内存，串行执行避免同时起多个实例。
fn export_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/export/pdf", post(export_pdf_handler))
        .route("/export/capture", post(export_capture_handler))
        .route("/export/html", post(export_html_handler))
        .route("/export/file/{name}", get(export_file_handler))
        .route("/export/tmp/{token}/{file}", get(export_tmp_handler))
}

// ---------------------------------------------------------------------------
// 请求/响应结构
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HtmlExportPayload {
    html: String,
    #[serde(default)]
    css: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    height: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfResponse {
    file_url: String,
    bytes: u64,
    pages: usize,
    ms: u64,
    browser: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HtmlResponse {
    file_url: String,
    bytes: u64,
    ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureImageResponse {
    index: usize,
    url: String,
    w: u32,
    h: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureResponse {
    images: Vec<CaptureImageResponse>,
    ms: u64,
    /// CDP 不可用时为 true：前端改用 html-to-image 快速版并标注
    fallback: bool,
    /// `cdp` | `fallback`
    mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

// ---------------------------------------------------------------------------
// 处理器
// ---------------------------------------------------------------------------

async fn export_pdf_handler(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<RenderPayload>,
) -> Result<Json<PdfResponse>, ApiError> {
    let _guard = export_lock().lock().await;
    let exports_dir = state.exports_dir();
    let result = pdf::export_pdf(&state.data_dir, &exports_dir, &payload)
        .await
        .map_err(map_export_error)?;
    Ok(Json(PdfResponse {
        file_url: format!("/api/export/file/{}", util::url_seg(&result.file_name)),
        bytes: result.bytes,
        pages: result.pages,
        ms: result.ms,
        browser: result.browser,
    }))
}

async fn export_capture_handler(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CapturePayload>,
) -> Result<Json<CaptureResponse>, ApiError> {
    let _guard = export_lock().lock().await;
    let data_dir = state.data_dir.clone();
    let outcome = tokio::task::spawn_blocking(move || capture::capture_slides(&data_dir, &payload))
        .await
        .map_err(|e| ApiError::internal("截图任务异常终止").with_detail(e.to_string()))?
        .map_err(map_export_error)?;

    Ok(Json(CaptureResponse {
        images: outcome
            .images
            .into_iter()
            .map(|img| CaptureImageResponse {
                index: img.index,
                url: img.url,
                w: img.w,
                h: img.h,
            })
            .collect(),
        ms: outcome.ms,
        fallback: outcome.fallback,
        mode: outcome.mode,
        reason: outcome.fallback_reason,
    }))
}

async fn export_html_handler(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<HtmlExportPayload>,
) -> Result<Json<HtmlResponse>, ApiError> {
    if payload.html.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "BAD_REQUEST",
            "导出内容为空：前端没有渲染出 HTML",
        ));
    }
    if payload.html.len() + payload.css.len() > 32 * 1024 * 1024 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "BAD_REQUEST",
            "导出内容过大（超过 32MB）",
        ));
    }
    let render = RenderPayload {
        html: payload.html,
        css: payload.css,
        title: payload.title,
        width: payload.width,
        height: payload.height,
        comments: Vec::new(),
    };
    let exports_dir = state.exports_dir();
    let result = html_export::export_html(&exports_dir, &render)
        .await
        .map_err(map_export_error)?;
    Ok(Json(HtmlResponse {
        file_url: format!("/api/export/file/{}", util::url_seg(&result.file_name)),
        bytes: result.bytes,
        ms: result.ms,
    }))
}

async fn export_file_handler(
    State(state): State<Arc<AppState>>,
    AxumPath(name): AxumPath<String>,
) -> Result<Response, ApiError> {
    let name = decode_file_name(&name)?;
    let path = state.exports_dir().join(&name);
    let bytes = tokio::fs::read(&path).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ApiError::not_found(format!("导出文件不存在: {name}"))
        } else {
            ApiError::internal("读取导出文件失败").with_detail(e.to_string())
        }
    })?;
    Ok(file_response(bytes, &name))
}

async fn export_tmp_handler(
    AxumPath((token, file)): AxumPath<(String, String)>,
) -> Result<Response, ApiError> {
    if !is_hex_token(&token) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "BAD_REQUEST",
            "非法的截图 token",
        ));
    }
    let file = decode_file_name(&file)?;
    if !is_capture_image_name(&file) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "BAD_REQUEST",
            "非法的截图文件名",
        ));
    }
    let path = capture::capture_dir(&token).join(&file);
    let bytes = tokio::fs::read(&path).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ApiError::not_found("截图已过期或不存在（TTL 10 分钟）")
        } else {
            ApiError::internal("读取截图失败").with_detail(e.to_string())
        }
    })?;
    let ext = util::ext_of(&file);
    let mime = util::mime_for_ext(&ext);
    let value = HeaderValue::from_str(mime)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
    Ok((
        [
            (header::CONTENT_TYPE, value),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
        bytes,
    )
        .into_response())
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

fn map_export_error(err: ExpError) -> ApiError {
    if err.bad_request {
        let mut api = ApiError::new(StatusCode::BAD_REQUEST, "BAD_REQUEST", err.message);
        if let Some(detail) = err.detail {
            api = api.with_detail(detail);
        }
        api
    } else {
        let mut api = ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "EXPORT_FAILED", err.message);
        if let Some(detail) = err.detail {
            api = api.with_detail(detail);
        }
        api
    }
}

/// URL 解码文件名并做安全校验（单段、无路径分隔符、扩展名白名单）
fn decode_file_name(raw: &str) -> Result<String, ApiError> {
    let decoded = percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "BAD_REQUEST", "文件名编码非法"))?
        .to_string();
    if decoded.is_empty()
        || decoded == "."
        || decoded == ".."
        || decoded.contains(['/', '\\', ':', '\0'])
        || decoded.contains("..")
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "BAD_REQUEST",
            "非法的文件名",
        ));
    }
    let ext = util::ext_of(&decoded);
    if !matches!(ext.as_str(), "pdf" | "html" | "htm" | "pptx" | "png" | "jpg" | "jpeg") {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "BAD_REQUEST",
            "不支持的导出文件类型",
        ));
    }
    Ok(decoded)
}

fn file_response(bytes: Vec<u8>, name: &str) -> Response {
    let ext = util::ext_of(name);
    let mime = util::mime_for_ext(&ext);
    let content_type = HeaderValue::from_str(mime)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
    let disposition = HeaderValue::from_str(&util::content_disposition(name))
        .unwrap_or_else(|_| HeaderValue::from_static("attachment"));
    (
        [
            (header::CONTENT_TYPE, content_type),
            (header::CONTENT_DISPOSITION, disposition),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
        bytes,
    )
        .into_response()
}

fn is_hex_token(token: &str) -> bool {
    (16..=64).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `slide-<n>.(png|jpg)` —— capture 产物的文件名规则
fn is_capture_image_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("slide-") else {
        return false;
    };
    let Some((num, ext)) = rest.rsplit_once('.') else {
        return false;
    };
    !num.is_empty()
        && num.len() <= 4
        && num.bytes().all(|b| b.is_ascii_digit())
        && matches!(ext, "png" | "jpg" | "jpeg")
}
