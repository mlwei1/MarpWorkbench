use std::sync::Arc;

use axum::{extract::State, routing::get, Json, Router};
use serde::{Deserialize, Serialize};

use crate::error::ApiResult;
use crate::state::AppState;
use crate::util;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub workspace_root: String,
    pub default_theme: String,
    pub autosave_ms: u64,
    pub idle_exit_minutes: u64,
    pub locale: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SettingsPatch {
    #[serde(default)]
    workspace_root: Option<String>,
    #[serde(default)]
    default_theme: Option<String>,
    #[serde(default)]
    autosave_ms: Option<u64>,
    #[serde(default)]
    idle_exit_minutes: Option<u64>,
    #[serde(default)]
    locale: Option<String>,
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/settings", get(get_settings).put(put_settings))
}

fn defaults(workspace_root: String) -> Settings {
    Settings {
        workspace_root,
        default_theme: "business-blue".to_string(),
        autosave_ms: 800,
        idle_exit_minutes: 10,
        locale: "zh-CN".to_string(),
    }
}

async fn load_settings(state: &AppState) -> Settings {
    let mut settings = match tokio::fs::read_to_string(state.settings_path()).await {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| {
            defaults(state.data_dir.to_string_lossy().to_string())
        }),
        Err(_) => defaults(state.data_dir.to_string_lossy().to_string()),
    };
    // M1：工作区根固定为数据目录（移动工作区留到后续版本）
    settings.workspace_root = state.data_dir.to_string_lossy().to_string();
    settings
}

async fn save_settings(state: &AppState, settings: &Settings) -> ApiResult<()> {
    let bytes = serde_json::to_vec_pretty(settings)?;
    util::atomic_write(&state.settings_path(), &bytes).await
}

/// GET /api/settings
async fn get_settings(State(state): State<Arc<AppState>>) -> ApiResult<Json<Settings>> {
    Ok(Json(load_settings(&state).await))
}

/// PUT /api/settings：部分字段更新
async fn put_settings(
    State(state): State<Arc<AppState>>,
    Json(patch): Json<SettingsPatch>,
) -> ApiResult<Json<Settings>> {
    let mut settings = load_settings(&state).await;
    if let Some(v) = patch.default_theme {
        if !v.trim().is_empty() {
            settings.default_theme = v.trim().to_string();
        }
    }
    if let Some(v) = patch.autosave_ms {
        settings.autosave_ms = v.clamp(200, 10_000);
    }
    if let Some(v) = patch.idle_exit_minutes {
        settings.idle_exit_minutes = v.min(120);
    }
    if let Some(v) = patch.locale {
        if !v.trim().is_empty() {
            settings.locale = v.trim().to_string();
        }
    }
    if let Some(v) = patch.workspace_root {
        // M1 只记录展示值，实际工作区仍固定为数据目录
        let _ = v;
    }
    save_settings(&state, &settings).await?;
    Ok(Json(settings))
}
