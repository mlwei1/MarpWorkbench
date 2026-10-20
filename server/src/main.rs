#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assets;
mod browser;
mod error;
mod routes;
mod state;
mod util;

use std::sync::Arc;

use tokio::sync::watch;

/// 单实例锁：按「数据目录」派生固定本地端口（同一数据目录=同一实例；不同数据目录/便携副本可并行，
/// 便于多数据目录并行测试）。进程异常退出时由操作系统自动释放，无需清理陈旧锁文件。
fn instance_lock_port(data_dir: &std::path::Path) -> u16 {
    use sha2::{Digest, Sha256};

    const BASE: u16 = 46327;
    const RANGE: u16 = 1000;
    let mut hasher = Sha256::new();
    hasher.update(data_dir.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let mut n: u32 = 0;
    for b in digest.iter().take(4) {
        n = (n << 8) | u32::from(*b);
    }
    BASE + (n % u32::from(RANGE)) as u16
}

/// 安全写 stdout：release（windows_subsystem=windows）下若没有 stdout 句柄也不能 panic。
/// 契约 §0.2 要求 `MWB_NO_OPEN` 场景打印 `MWB_LISTEN_URL=` / `MWB_TOKEN=` 供 smoke/CI 读取。
fn emit_stdout(text: &str) {
    use std::io::Write;
    let mut out = std::io::stdout();
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        emit_stdout(&format!("MarpWorkbench {}\n", env!("CARGO_PKG_VERSION")));
        std::process::exit(0);
    }
    let no_open = args.iter().any(|a| a == "--no-open") || std::env::var_os("MWB_NO_OPEN").is_some();

    let data_dir = util::resolve_data_dir();
    if let Err(err) = util::ensure_dirs(&data_dir).await {
        util::log_line(&data_dir, &format!("初始化数据目录失败: {err}"));
        std::process::exit(1);
    }

    // ---- 单实例（按数据目录派生锁端口，多数据目录可并行测试）----
    let lock_port = instance_lock_port(&data_dir);
    let instance_lock = match std::net::TcpListener::bind(("127.0.0.1", lock_port)) {
        Ok(listener) => Some(listener),
        Err(_) => {
            // 已有实例在跑：等它把 instance.json 落盘（最多 3s），然后打开已有页面并退出
            let mut existing_url = None;
            for _ in 0..30 {
                if let Some(url) = util::probe_existing_instance(&data_dir) {
                    existing_url = Some(url);
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            if let Some(url) = existing_url {
                if !no_open {
                    util::open_browser(&url);
                }
            }
            std::process::exit(0);
        }
    };

    // ---- 监听 127.0.0.1（默认随机端口；MWB_PORT 可固定，被占用时回退随机端口）----
    let requested_port: u16 = std::env::var("MWB_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut candidates = vec![requested_port];
    if requested_port != 0 {
        candidates.push(0);
    }
    let mut listener = None;
    for candidate in candidates {
        match tokio::net::TcpListener::bind(("127.0.0.1", candidate)).await {
            Ok(l) => {
                listener = Some(l);
                break;
            }
            Err(err) if candidate != 0 => {
                util::log_line(
                    &data_dir,
                    &format!("端口 {candidate} 监听失败（{err}），回退到系统随机端口"),
                );
            }
            Err(err) => {
                util::log_line(&data_dir, &format!("监听 127.0.0.1 失败: {err}"));
                std::process::exit(1);
            }
        }
    }
    let Some(listener) = listener else {
        util::log_line(&data_dir, "没有可用监听端口");
        std::process::exit(1);
    };
    let port = listener.local_addr().expect("local_addr").port();

    let token = state::gen_token();
    let (shutdown_tx, _shutdown_rx) = watch::channel(false);
    let app_state = Arc::new(state::AppState {
        app_version: env!("CARGO_PKG_VERSION"),
        pid: std::process::id(),
        port,
        token: token.clone(),
        started_at: util::now_iso(),
        data_dir: data_dir.clone(),
        shutdown_tx: shutdown_tx.clone(),
        browser: browser::detect(),
    });

    // instance.json：供二次启动探测 / 冒烟测试读取 port+token
    let instance = serde_json::json!({
        "pid": app_state.pid,
        "port": port,
        "token": token,
        "startedAt": app_state.started_at,
        "url": app_state.url_with_token(),
    });
    if let Ok(bytes) = serde_json::to_vec_pretty(&instance) {
        let _ = util::atomic_write(&app_state.instance_path(), &bytes).await;
    }

    util::log_line(
        &data_dir,
        &format!(
            "MarpWorkbench listening on {}{}",
            app_state.url(),
            if no_open { " (no-open)" } else { "" }
        ),
    );
    // 契约 §0.2：向 stdout 打印两行，供 scripts/smoke.mjs / CI 读取（无 stdout 句柄时静默忽略）
    emit_stdout(&format!("MWB_LISTEN_URL=http://127.0.0.1:{port}\n"));
    emit_stdout(&format!("MWB_TOKEN={token}\n"));
    if !no_open {
        util::open_browser(&app_state.url_with_token());
    }

    // ---- 启动服务 ----
    let router = routes::build_router(app_state.clone());
    let mut shutdown_rx = shutdown_tx.subscribe();
    let server = axum::serve(listener, router).with_graceful_shutdown(async move {
        let _ = shutdown_rx.changed().await;
    });
    if let Err(err) = server.await {
        util::log_line(&data_dir, &format!("HTTP 服务异常退出: {err}"));
    }

    // ---- 退出清理 ----
    let _ = tokio::fs::remove_file(app_state.instance_path()).await;
    drop(instance_lock);
    std::process::exit(0);
}
