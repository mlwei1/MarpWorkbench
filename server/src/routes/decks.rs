use std::sync::Arc;

use axum::{
    extract::{Multipart, Path, State},
    http::{header, HeaderValue},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/workspace", get(workspace))
        .route("/decks", post(create_deck))
        .route(
            "/decks/{id}",
            get(get_deck).put(save_deck).delete(delete_deck),
        )
        .route("/decks/{id}/rename", post(rename_deck))
        .route("/decks/{id}/assets", post(upload_asset))
        .route("/decks/{id}/assets/{name}", get(get_asset))
        .route("/recent", get(recent))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeckSummary {
    id: String,
    name: String,
    updated_at: String,
    created_at: String,
    bytes: u64,
    pages: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeckDetail {
    id: String,
    name: String,
    content: String,
    rev: String,
    updated_at: String,
    assets: Vec<AssetRef>,
}

#[derive(Serialize)]
struct AssetRef {
    path: String,
    url: String,
}

#[derive(Deserialize)]
struct CreateDeckReq {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    template: Option<String>,
}

#[derive(Deserialize)]
struct SaveDeckReq {
    content: String,
    #[serde(rename = "ifRev", default)]
    if_rev: Option<String>,
}

#[derive(Deserialize)]
struct RenameReq {
    name: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RecentEntry {
    id: String,
    name: String,
    updated_at: String,
}

// ---------------------------------------------------------------------------
// 工作区
// ---------------------------------------------------------------------------

/// GET /api/workspace
async fn workspace(State(state): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let decks = list_decks(&state).await?;
    Ok(Json(json!({
        "root": state.data_dir.to_string_lossy(),
        "decks": decks,
    })))
}

async fn list_decks(state: &AppState) -> ApiResult<Vec<DeckSummary>> {
    let mut out = Vec::new();
    let mut rd = tokio::fs::read_dir(&state.data_dir).await?;
    while let Some(entry) = rd.next_entry().await? {
        let file_type = entry.file_type().await?;
        if !file_type.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if id.starts_with('.') || util::validate_deck_id(&id).is_err() {
            continue;
        }
        let slides = state.deck_slides_path(&id);
        let Ok(meta) = tokio::fs::metadata(&slides).await else {
            continue;
        };
        let updated = meta.modified().unwrap_or(std::time::SystemTime::now());
        let created = meta.created().unwrap_or(updated);
        out.push(DeckSummary {
            name: id.clone(),
            id,
            updated_at: util::fmt_system_time(updated),
            created_at: util::fmt_system_time(created),
            bytes: meta.len(),
            pages: None,
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

// ---------------------------------------------------------------------------
// deck CRUD
// ---------------------------------------------------------------------------

/// POST /api/decks
async fn create_deck(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateDeckReq>,
) -> ApiResult<Json<Value>> {
    let requested = req.name.as_deref().unwrap_or("");
    let base = util::sanitize_deck_name(requested);
    let template = req.template.as_deref().unwrap_or("blank");
    let content = template_content(template);

    let mut id = base.clone();
    let mut n = 1;
    while state.deck_dir(&id).exists() {
        id = format!("{base}-{n}");
        n += 1;
        if n > 1000 {
            return Err(ApiError::bad_request("同名 deck 过多"));
        }
    }
    util::validate_deck_id(&id).map_err(|e| {
        ApiError::bad_request("deck 名称不合法").with_detail(e.message)
    })?;

    tokio::fs::create_dir_all(state.deck_assets_dir(&id)).await?;
    util::atomic_write(&state.deck_slides_path(&id), content.as_bytes()).await?;
    touch_recent(&state, &id).await?;

    let rev = util::sha256_16(&content);
    Ok(Json(json!({
        "id": id,
        "name": id,
        "content": content,
        "rev": rev,
    })))
}

/// GET /api/decks/:id
async fn get_deck(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<DeckDetail>> {
    let id = util::validate_deck_id(&id)?;
    let path = state.deck_slides_path(&id);
    let content = match tokio::fs::read_to_string(&path).await {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(ApiError::not_found(format!("deck 不存在: {id}")));
        }
        Err(err) => return Err(err.into()),
    };
    let rev = util::sha256_16(&content);
    let assets = list_assets(&state, &id).await;
    Ok(Json(DeckDetail {
        name: id.clone(),
        id,
        content,
        rev,
        updated_at: util::file_updated_at(&path),
        assets,
    }))
}

/// PUT /api/decks/:id
async fn save_deck(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<SaveDeckReq>,
) -> ApiResult<Json<Value>> {
    let id = util::validate_deck_id(&id)?;
    let path = state.deck_slides_path(&id);
    let current = match tokio::fs::read_to_string(&path).await {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(ApiError::not_found(format!("deck 不存在: {id}")));
        }
        Err(err) => return Err(err.into()),
    };
    let current_rev = util::sha256_16(&current);
    if let Some(if_rev) = req.if_rev.as_deref() {
        if !if_rev.is_empty() && if_rev != current_rev {
            return Err(ApiError::conflict("内容已在别处修改，请刷新后再保存")
                .with_detail(format!("ifRev={if_rev}, current={current_rev}")));
        }
    }
    util::atomic_write(&path, req.content.as_bytes()).await?;
    touch_recent(&state, &id).await?;
    let rev = util::sha256_16(&req.content);
    Ok(Json(json!({ "rev": rev, "savedAt": util::now_iso() })))
}

/// POST /api/decks/:id/rename
async fn rename_deck(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<RenameReq>,
) -> ApiResult<Json<Value>> {
    let old_id = util::validate_deck_id(&id)?;
    if !state.deck_dir(&old_id).exists() {
        return Err(ApiError::not_found(format!("deck 不存在: {old_id}")));
    }
    let new_id = util::sanitize_deck_name(&req.name);
    util::validate_deck_id(&new_id)
        .map_err(|e| ApiError::bad_request("新名称不合法").with_detail(e.message))?;
    if new_id != old_id {
        if state.deck_dir(&new_id).exists() {
            return Err(ApiError::conflict(format!("已存在同名 deck: {new_id}")));
        }
        tokio::fs::rename(state.deck_dir(&old_id), state.deck_dir(&new_id)).await?;
        rename_recent(&state, &old_id, &new_id).await?;
    }
    Ok(Json(json!({ "id": new_id, "name": new_id })))
}

/// DELETE /api/decks/:id（移到 .trash，不物理删除）
async fn delete_deck(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let id = util::validate_deck_id(&id)?;
    let dir = state.deck_dir(&id);
    if !dir.exists() {
        return Err(ApiError::not_found(format!("deck 不存在: {id}")));
    }
    tokio::fs::create_dir_all(state.trash_dir()).await?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let mut dest = state.trash_dir().join(format!("{id}-{stamp}"));
    let mut n = 1;
    while dest.exists() {
        dest = state.trash_dir().join(format!("{id}-{stamp}-{n}"));
        n += 1;
    }
    tokio::fs::rename(&dir, &dest).await?;
    remove_recent(&state, &id).await?;
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// 最近文件
// ---------------------------------------------------------------------------

/// GET /api/recent
async fn recent(State(state): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let entries = read_recent(&state).await;
    let mut out = Vec::new();
    for entry in entries.into_iter().take(20) {
        if state.deck_slides_path(&entry.id).exists() {
            out.push(json!({
                "id": entry.id,
                "name": entry.name,
                "updatedAt": entry.updated_at,
            }));
        }
    }
    Ok(Json(json!(out)))
}

async fn read_recent(state: &AppState) -> Vec<RecentEntry> {
    match tokio::fs::read_to_string(state.recent_path()).await {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

async fn write_recent(state: &AppState, entries: &[RecentEntry]) -> ApiResult<()> {
    let bytes = serde_json::to_vec_pretty(entries)?;
    util::atomic_write(&state.recent_path(), &bytes).await
}

async fn touch_recent(state: &AppState, id: &str) -> ApiResult<()> {
    let mut entries = read_recent(state).await;
    entries.retain(|e| e.id != id);
    entries.insert(
        0,
        RecentEntry {
            id: id.to_string(),
            name: id.to_string(),
            updated_at: util::now_iso(),
        },
    );
    entries.truncate(30);
    write_recent(state, &entries).await
}

async fn remove_recent(state: &AppState, id: &str) -> ApiResult<()> {
    let mut entries = read_recent(state).await;
    entries.retain(|e| e.id != id);
    write_recent(state, &entries).await
}

async fn rename_recent(state: &AppState, old_id: &str, new_id: &str) -> ApiResult<()> {
    let mut entries = read_recent(state).await;
    for entry in entries.iter_mut() {
        if entry.id == old_id {
            entry.id = new_id.to_string();
            entry.name = new_id.to_string();
        }
    }
    write_recent(state, &entries).await
}

// ---------------------------------------------------------------------------
// 资源（图片/附件）
// ---------------------------------------------------------------------------

const ALLOWED_ASSET_EXT: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];
const MAX_ASSET_BYTES: usize = 32 * 1024 * 1024;

/// POST /api/decks/:id/assets（multipart，字段名 `file`）
async fn upload_asset(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    mut multipart: Multipart,
) -> ApiResult<Json<Value>> {
    let id = util::validate_deck_id(&id)?;
    if !state.deck_slides_path(&id).exists() {
        return Err(ApiError::not_found(format!("deck 不存在: {id}")));
    }
    tokio::fs::create_dir_all(state.deck_assets_dir(&id)).await?;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::bad_request("multipart 解析失败").with_detail(e.to_string()))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let Some(filename) = field.file_name().map(|s| s.to_string()) else {
            continue;
        };
        let ext = util::ext_of(&filename);
        if !ALLOWED_ASSET_EXT.contains(&ext.as_str()) {
            return Err(ApiError::bad_request(format!(
                "不支持的文件类型: {ext}（允许 png/jpg/jpeg/gif/webp/svg/bmp）"
            )));
        }
        let bytes = field
            .bytes()
            .await
            .map_err(|e| ApiError::bad_request("读取上传内容失败").with_detail(e.to_string()))?;
        if bytes.is_empty() {
            return Err(ApiError::bad_request("上传文件为空"));
        }
        if bytes.len() > MAX_ASSET_BYTES {
            return Err(ApiError::bad_request("文件过大（上限 32MB）"));
        }

        let base = util::sanitize_filename(&filename);
        let stem = util::file_stem(&base);
        let mut candidate = base.clone();
        let mut n = 1;
        while state.deck_assets_dir(&id).join(&candidate).exists() {
            candidate = format!("{stem}-{n}.{ext}");
            n += 1;
        }
        let dest = state.deck_assets_dir(&id).join(&candidate);
        tokio::fs::write(&dest, &bytes).await?;

        let url = format!(
            "/api/decks/{}/assets/{}",
            util::url_seg(&id),
            util::url_seg(&candidate)
        );
        return Ok(Json(json!({
            "path": format!("assets/{candidate}"),
            "url": url,
            "bytes": bytes.len(),
        })));
    }
    Err(ApiError::bad_request("缺少 file 字段"))
}

/// GET /api/decks/:id/assets/:name
async fn get_asset(
    State(state): State<Arc<AppState>>,
    Path((id, name)): Path<(String, String)>,
) -> ApiResult<Response> {
    let id = util::validate_deck_id(&id)?;
    if !state.deck_slides_path(&id).exists() {
        return Err(ApiError::not_found(format!("deck 不存在: {id}")));
    }
    let safe = util::sanitize_filename(&name);
    if safe != name {
        return Err(ApiError::bad_request("非法资源文件名"));
    }
    let path = state.deck_assets_dir(&id).join(&safe);
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(ApiError::not_found(format!("资源不存在: {safe}")));
        }
        Err(err) => return Err(err.into()),
    };
    let mime = util::mime_for_ext(&util::ext_of(&safe));
    Ok(([(header::CONTENT_TYPE, HeaderValue::from_static(mime))], bytes).into_response())
}

async fn list_assets(state: &AppState, id: &str) -> Vec<AssetRef> {
    let mut out = Vec::new();
    let dir = state.deck_assets_dir(id);
    if let Ok(mut rd) = tokio::fs::read_dir(&dir).await {
        while let Ok(Some(entry)) = rd.next_entry().await {
            let is_file = entry.file_type().await.map(|t| t.is_file()).unwrap_or(false);
            if !is_file {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            out.push(AssetRef {
                path: format!("assets/{name}"),
                url: format!(
                    "/api/decks/{}/assets/{}",
                    util::url_seg(id),
                    util::url_seg(&name)
                ),
            });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

// ---------------------------------------------------------------------------
// 模板
// ---------------------------------------------------------------------------

fn template_content(template: &str) -> String {
    match template {
        "title" => r#"---
marp: true
theme: business-blue
paginate: true
size: 16:9
---

<!-- _class: lead -->

# 我的演示文稿

## 副标题 / 演讲人

---

## 目录

1. 背景与目标
2. 方案与取舍
3. 计划与下一步
"#
        .to_string(),
        "sample" => r#"---
marp: true
theme: business-blue
paginate: true
size: 16:9
---

<!-- _class: lead -->

# MarpWorkbench 示例

## 用 Markdown 写幻灯片

---

## 为什么用 Markdown？

- 内容与样式分离，专注写作
- 纯文本，版本可控、方便协作
- 标准 Marp 语法，可随时拷回 VS Code

---

## 代码示例

```rust
fn main() {
    println!("Hello, MarpWorkbench!");
}
```

---

## 公式与表格

$$
E = mc^2
$$

| 方案 | 体积 | 启动 |
| --- | --- | --- |
| Rust 单文件 | 0.5 MB | 快 |
| Electron | 100 MB+ | 慢 |
"#
        .to_string(),
        _ => r#"---
marp: true
theme: business-blue
paginate: true
size: 16:9
---

# 新演示文稿

从这里开始写你的第一页。

---

## 第二页

- 要点一
- 要点二
"#
        .to_string(),
    }
}
