use std::collections::HashSet;
use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{header, HeaderValue},
    response::{IntoResponse, Response},
    routing::{get, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::assets;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/themes", get(list_themes).post(import_theme))
        .route("/themes/{name}", put(update_theme).delete(delete_theme))
        .route("/themes/{name}/css", get(theme_css))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ThemeMeta {
    pub name: String,
    pub display_name: String,
    /// builtin | user
    pub source: String,
    pub tags: Vec<String>,
    pub author: Option<String>,
    pub size: Option<Vec<String>>,
    pub auto_scaling: Option<bool>,
    /// 契约字段：是否内联 CSS（M1 统一 false，CSS 走 GET /api/themes/:name/css）
    pub css: bool,
}

#[derive(Deserialize)]
struct ThemeImportReq {
    css: String,
    #[serde(default)]
    file_name: Option<String>,
}

#[derive(Deserialize)]
struct ThemeUpdateReq {
    css: String,
}

/// GET /api/themes
async fn list_themes(State(state): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let mut themes: Vec<ThemeMeta> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for file in assets::builtin_theme_files() {
        let Some(css) = assets::builtin_theme_css(&file) else {
            continue;
        };
        let fallback = util::file_stem(&file);
        if let Ok(meta) = parse_theme_meta(&css, "builtin", &fallback) {
            if seen.insert(meta.name.clone()) {
                themes.push(meta);
            }
        }
    }

    if let Ok(mut rd) = tokio::fs::read_dir(state.user_themes_dir()).await {
        while let Ok(Some(entry)) = rd.next_entry().await {
            let path = entry.path();
            if !path
                .extension()
                .map(|e| e.to_string_lossy().eq_ignore_ascii_case("css"))
                .unwrap_or(false)
            {
                continue;
            }
            let fallback = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "theme".to_string());
            let Ok(css) = tokio::fs::read_to_string(&path).await else {
                continue;
            };
            if let Ok(meta) = parse_theme_meta(&css, "user", &fallback) {
                if let Some(pos) = themes.iter().position(|t| t.name == meta.name) {
                    themes[pos] = meta; // 用户主题覆盖同名内置主题
                } else {
                    themes.push(meta);
                }
            }
        }
    }

    Ok(Json(json!({ "themes": themes })))
}

/// GET /api/themes/:name/css
async fn theme_css(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> ApiResult<Response> {
    if let Some(css) = user_theme_css(&state, &name).await {
        return Ok(css_response(css));
    }
    for file in assets::builtin_theme_files() {
        let Some(css) = assets::builtin_theme_css(&file) else {
            continue;
        };
        let fallback = util::file_stem(&file);
        if let Ok(meta) = parse_theme_meta(&css, "builtin", &fallback) {
            if meta.name == name {
                return Ok(css_response(css));
            }
        }
    }
    Err(ApiError::not_found(format!("主题不存在: {name}")))
}

/// POST /api/themes（JSON：{css, fileName?}；multipart 导入留到 M2）
async fn import_theme(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ThemeImportReq>,
) -> ApiResult<Json<ThemeMeta>> {
    let fallback = req
        .file_name
        .as_deref()
        .map(util::file_stem)
        .unwrap_or_else(|| "theme".to_string());
    let meta = parse_theme_meta(&req.css, "user", &fallback)?;
    tokio::fs::create_dir_all(state.user_themes_dir()).await?;
    let path = state.user_themes_dir().join(format!("{}.css", meta.name));
    util::atomic_write(&path, req.css.as_bytes()).await?;
    Ok(Json(meta))
}

/// PUT /api/themes/:name（仅用户主题）
async fn update_theme(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
    Json(req): Json<ThemeUpdateReq>,
) -> ApiResult<Json<ThemeMeta>> {
    validate_theme_name(&name)?;
    let meta = parse_theme_meta(&req.css, "user", &name)?;
    if meta.name != name {
        return Err(ApiError::bad_request(format!(
            "@theme 名称（{}）与 URL 中的主题名（{}）不一致",
            meta.name, name
        )));
    }
    let path = state.user_themes_dir().join(format!("{name}.css"));
    if !path.exists() {
        return Err(ApiError::not_found(format!(
            "用户主题不存在: {name}（内置主题不可修改）"
        )));
    }
    util::atomic_write(&path, req.css.as_bytes()).await?;
    Ok(Json(meta))
}

/// DELETE /api/themes/:name（仅用户主题）
async fn delete_theme(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> ApiResult<Json<Value>> {
    validate_theme_name(&name)?;
    let path = state.user_themes_dir().join(format!("{name}.css"));
    if !path.exists() {
        return Err(ApiError::not_found(format!(
            "用户主题不存在: {name}（内置主题不可删除）"
        )));
    }
    tokio::fs::remove_file(&path).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn user_theme_css(state: &AppState, name: &str) -> Option<String> {
    if validate_theme_name(name).is_err() {
        return None;
    }
    let path = state.user_themes_dir().join(format!("{name}.css"));
    tokio::fs::read_to_string(path).await.ok()
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

fn validate_theme_name(name: &str) -> ApiResult<()> {
    if name.is_empty() || name.len() > 80 {
        return Err(ApiError::bad_request("主题名称为空或过长"));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(ApiError::bad_request(
            "主题名只能包含字母、数字、- 和 _（Marp @theme 限制）",
        ));
    }
    Ok(())
}

/// 解析 Marp 主题 CSS 头部元信息注释：
/// `/* @theme name */`、`/* @name 中文名 */`、`/* @tags 商务,汇报 */`、
/// `/* @size 16:9 1280px 720px */`、`/* @auto-scaling false */`、`/* @author ... */`
fn parse_theme_meta(css: &str, source: &str, fallback_name: &str) -> ApiResult<ThemeMeta> {
    let mut name: Option<String> = None;
    let mut display_name: Option<String> = None;
    let mut tags: Vec<String> = Vec::new();
    let mut author: Option<String> = None;
    let mut size: Option<Vec<String>> = None;
    let mut auto_scaling: Option<bool> = None;
    let mut theme_count = 0usize;

    for raw in css.lines() {
        // 同时兼容两种注释写法：
        //   单行：/* @theme business-blue */
        //   多行块注释：/*\n * @theme business-blue\n * @name 商务蓝\n */
        let mut line = raw.trim();
        if line.is_empty() {
            continue;
        }
        line = line.trim_start_matches("/*").trim_end_matches("*/").trim();
        line = line.trim_start_matches('*').trim();
        line = line.trim_end_matches("*/").trim();
        if line.is_empty() {
            continue;
        }
        let Some(rest) = line.strip_prefix('@') else {
            continue;
        };
        let mut parts = rest.splitn(2, char::is_whitespace);
        let key = parts.next().unwrap_or("").trim();
        let value = parts
            .next()
            .unwrap_or("")
            .trim()
            .trim_start_matches(':')
            .trim();
        match key {
            "theme" => {
                theme_count += 1;
                name = Some(value.to_string());
            }
            "name" => display_name = Some(value.to_string()),
            "tags" => {
                tags = value
                    .split([',', '，', ' ', ';', '|'])
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .collect();
            }
            "author" => author = Some(value.to_string()),
            "size" => {
                size = Some(value.split_whitespace().map(|s| s.to_string()).collect());
            }
            "auto-scaling" => auto_scaling = Some(value.eq_ignore_ascii_case("true")),
            _ => {}
        }
    }

    if theme_count == 0 {
        return Err(ApiError::bad_request(
            "主题 CSS 缺少 /* @theme name */ 声明",
        ));
    }
    if theme_count > 1 {
        return Err(ApiError::bad_request(
            "主题 CSS 中存在多个 /* @theme */ 声明（必须唯一）",
        ));
    }
    let name = name.unwrap_or_else(|| fallback_name.to_string());
    validate_theme_name(&name)?;
    Ok(ThemeMeta {
        display_name: display_name.unwrap_or_else(|| name.clone()),
        name,
        source: source.to_string(),
        tags,
        author,
        size,
        auto_scaling,
        css: false,
    })
}
