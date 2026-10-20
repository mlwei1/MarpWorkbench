use std::sync::Arc;

use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};

use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/health", get(health))
        .route("/shutdown", post(shutdown))
        .route("/browser", get(browser_info))
}

/// GET /api/health（不鉴权，供单实例探测/冒烟）
async fn health(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({
        "ok": true,
        "app": "MarpWorkbench",
        "version": state.app_version,
        "pid": state.pid,
        "port": state.port,
        "workspaceRoot": state.data_dir.to_string_lossy(),
        "startedAt": state.started_at,
    }))
}

/// POST /api/shutdown：返回响应后由 main 优雅停机（进程退出码 0）
async fn shutdown(State(state): State<Arc<AppState>>) -> Json<Value> {
    let _ = state.shutdown_tx.send(true);
    Json(json!({ "ok": true }))
}

/// GET /api/browser：本机 Chrome/Edge 探测结果（导出/设置页用）
async fn browser_info(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(serde_json::to_value(&state.browser).unwrap_or_else(|_| {
        json!({"chrome": null, "edge": null, "usable": false, "preferred": null})
    }))
}
