//! 最小「便携单文件 HTTP 服务」demo（用于实测 release 单文件体积与启动时间）。
//! - 静态资源通过 rust-embed 编译进 exe（无需释放临时文件、天然绿色版）
//! - 监听 127.0.0.1:0 由系统分配空闲端口，避免端口占用
//! - 启动后调用系统默认浏览器打开
//!
//! 生产版再加：#![windows_subsystem = "windows"] 隐藏控制台窗口（对体积无影响）。
//! 本 demo 保留控制台以便实测输出，用 --no-open 避免测试时弹浏览器。
use axum::{response::Html, routing::get, Router};
use rust_embed::RustEmbed;
use std::io::Write;

#[derive(RustEmbed)]
#[folder = "assets/"]
struct Assets;

async fn index() -> Html<String> {
    match Assets::get("index.html") {
        Some(file) => Html(String::from_utf8_lossy(&file.data).to_string()),
        None => Html("<h1>index.html missing</h1>".into()),
    }
}

async fn health() -> &'static str {
    "ok"
}

fn open_browser(url: &str) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn();
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let no_open = args.iter().any(|a| a == "--no-open");
    let mut port: u16 = 0;
    if let Some(i) = args.iter().position(|a| a == "--port") {
        if let Some(p) = args.get(i + 1).and_then(|v| v.parse().ok()) {
            port = p;
        }
    }

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .expect("bind 127.0.0.1 failed");
    let addr = listener.local_addr().unwrap();
    let url = format!("http://127.0.0.1:{}/", addr.port());
    // 给外部脚本一个稳定的握手信号（真实产品不需要）
    println!("LISTENING {url}");
    let _ = std::io::stdout().flush();
    if !no_open {
        open_browser(&url);
    }

    let app = Router::new()
        .route("/", get(index))
        .route("/healthz", get(health));
    axum::serve(listener, app).await.unwrap();
}
