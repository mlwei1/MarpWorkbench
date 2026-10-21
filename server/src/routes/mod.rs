pub mod decks;
pub mod export;
pub mod lifecycle;
pub mod proxy;
#[path = "../remote_image.rs"]
pub(crate) mod remote_image;
pub mod settings;
pub mod themes;

use std::sync::Arc;

use axum::{
    extract::{DefaultBodyLimit, Request, State},
    http::{header, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    Router,
};

use crate::{assets, error::ApiError, state::AppState, util};

/// 组装完整路由：`/api/*`（鉴权+JSON 限制）+ 其余路径走内嵌静态资源/SPA fallback。
/// 说明：除 `GET /api/health` 外所有 `/api` 请求都要 `X-MWB-Token`（见 API_CONTRACT §0.3）。
pub fn build_router(state: Arc<AppState>) -> Router {
    // M3：启动时后台清理过期网络图片缓存（>7 天 / 残留临时文件），不阻塞启动
    std::thread::spawn(remote_image::cleanup_cache_startup);

    let api = Router::new()
        .merge(lifecycle::router())
        .merge(settings::router())
        .merge(decks::router())
        .merge(themes::router())
        .merge(export::router())
        .merge(proxy::router())
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), auth_middleware));

    Router::new()
        .nest("/api", api)
        .fallback(static_handler)
        .layer(tower_http::compression::CompressionLayer::new())
        .with_state(state)
}

/// 鉴权 + 同源校验中间件。
async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Response {
    let raw_path = req.uri().path().to_string();
    // axum nest 在不同场景下中间件看到的 path 可能是 "/api/health" 或去前缀后的 "/health"，
    // 两种形式都兼容判断（避免健康检查/图片代理被鉴权中间件误拦）。
    let path = raw_path.clone();
    let stripped = raw_path.strip_prefix("/api").unwrap_or(&raw_path).to_string();

    // 健康检查用于单实例探测，不鉴权
    if path == "/api/health" || stripped == "/health" {
        return next.run(req).await;
    }
    // M3 网络图片代理：iframe 内 <img> 无法带请求头，仅该路由允许 query token
    //（token 由 proxy handler 内校验；其余路由仍强制 X-MWB-Token 请求头）
    if path == "/api/proxy/image" || stripped == "/proxy/image" {
        return next.run(req).await;
    }

    // Origin / Referer：若存在必须是本服务（防本机其他网页跨站调用）
    for name in [header::ORIGIN, header::REFERER] {
        if let Some(value) = req.headers().get(name) {
            let ok = value
                .to_str()
                .map(|v| origin_allowed(v, state.port))
                .unwrap_or(false);
            if !ok {
                return ApiError::new(StatusCode::FORBIDDEN, "BAD_REQUEST", "来源校验失败")
                    .into_response();
            }
        }
    }

    let token_ok = req
        .headers()
        .get("x-mwb-token")
        .and_then(|v| v.to_str().ok())
        == Some(state.token.as_str());
    if !token_ok {
        return ApiError::new(
            StatusCode::UNAUTHORIZED,
            "BAD_REQUEST",
            "缺少或无效的 X-MWB-Token",
        )
        .into_response();
    }
    next.run(req).await
}

fn origin_allowed(value: &str, port: u16) -> bool {
    let v = value.trim().trim_end_matches('/').to_ascii_lowercase();
    let allowed = [
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}"),
    ];
    allowed.iter().any(|a| &v == a) || v.starts_with(&format!("http://127.0.0.1:{port}"))
        || v.starts_with(&format!("http://localhost:{port}"))
}

/// 静态资源：前端构建产物 + 内置主题 CSS + SPA fallback。
async fn static_handler(State(_state): State<Arc<AppState>>, req: Request) -> Response {
    let method = req.method();
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let path = req.uri().path().to_string();

    if path.starts_with("/api") {
        return ApiError::not_found("接口不存在").into_response();
    }

    // 内置主题 CSS：GET /themes/<file>.css
    if let Some(name) = path.strip_prefix("/themes/") {
        if !name.contains('/') {
            if let Some(css) = assets::builtin_theme_css(name) {
                return css_response(css);
            }
        }
    }

    let rel = path.trim_start_matches('/');
    let rel = if rel.is_empty() {
        "index.html".to_string()
    } else {
        rel.to_string()
    };

    if let Some((bytes, ext)) = assets::read_web(&rel) {
        return bytes_response(bytes, util::mime_for_ext(&ext));
    }

    // SPA fallback：`/`、`/edit/:id`、`/settings` 等前端路由返回 index.html。
    // 注意：不能用“整条路径不含 `.`”判断 —— deck id 可能包含点号（如 "M3.1-滚动-全屏"、"方案 v1.2"），
    // 否则直接深链/刷新该页面会误判为静态资源而返回 404。
    let last_segment = rel.rsplit('/').next().unwrap_or("");
    let is_frontend_route = path == "/"
        || path.starts_with("/edit/")
        || path == "/settings"
        || path.starts_with("/settings/");
    if is_frontend_route || !last_segment.contains('.') {
        if let Some(index) = assets::read_web_index() {
            return bytes_response(index, "text/html; charset=utf-8");
        }
    }

    ApiError::not_found(format!("资源不存在: {path}")).into_response()
}

fn bytes_response(bytes: Vec<u8>, content_type: &str) -> Response {
    let value = HeaderValue::from_str(content_type)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
    ([(header::CONTENT_TYPE, value)], bytes).into_response()
}

fn css_response(css: String) -> Response {
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/css; charset=utf-8"),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
        ],
        css,
    )
        .into_response()
}
