//! CDP（Chrome DevTools Protocol）原生截图：PPTX/PNG 的质量主通道。
//!
//! 为什么需要它（docs/research/marp-tech.md §4.6 实测）：浏览器端 html-to-image 会丢失
//! 代码高亮背景 / 自定义主题渐变 / 主题配色（本任务复测同样复现），只有原生截图 100% 保真。
//!
//! 协议序列（与 `spike/export/scripts/capture-cdp.mjs` 验证版逐条一致）：
//!   启动 Chrome `--headless=new --remote-debugging-port=0 --user-data-dir=<临时>` →
//!   轮询 `<profile>/DevToolsActivePort` 第 1 行取端口 →
//!   HTTP GET `/json/list` 找 page target 的 `webSocketDebuggerUrl` →
//!   WebSocket：`Page.enable` / `Runtime.enable` / `Emulation.setDeviceMetricsOverride` /
//!   `Page.navigate(file://…)` → 轮询 `Runtime.evaluate(window.__MWB_READY__)` →
//!   `Runtime.evaluate` 取每页 `div.marpit > svg` 的文档坐标尺寸 →
//!   逐页 `Page.captureScreenshot { clip, captureBeyondViewport: true, scale: 2 }`。
//!
//! 注意：并发发送多个 captureScreenshot 会返回同一帧（spike 实测），必须逐页串行。

use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tungstenite::{
    stream::MaybeTlsStream,
    Message, WebSocket,
};

use super::{util as xutil, ExpError};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

/// 截图格式：PNG 无损（默认） / JPEG q90（PPTX 默认，速度快、体积小；实测目检文字无可见糊化）
#[derive(Debug, Clone, Copy)]
pub enum CaptureFormat {
    Png,
    Jpeg(u8),
}

impl CaptureFormat {
    pub fn name(&self) -> &'static str {
        match self {
            CaptureFormat::Png => "png",
            CaptureFormat::Jpeg(_) => "jpeg",
        }
    }
    pub fn quality(&self) -> Option<u8> {
        match self {
            CaptureFormat::Png => None,
            CaptureFormat::Jpeg(q) => Some(*q),
        }
    }
    pub fn ext(&self) -> &'static str {
        match self {
            CaptureFormat::Png => "png",
            CaptureFormat::Jpeg(_) => "jpg",
        }
    }
}

pub struct Shot {
    pub index: usize,
    pub data: Vec<u8>,
    pub w: u32,
    pub h: u32,
}

#[derive(Debug, Clone, Copy)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// 启动浏览器并逐页截图。同步阻塞实现，调用方必须放在 `spawn_blocking` 中。
pub fn capture_slides(
    exe: &str,
    html_path: &Path,
    width: u32,
    height: u32,
    scale: u32,
    format: CaptureFormat,
) -> Result<Vec<Shot>, ExpError> {
    let profile = xutil::new_dir("cdp-profile")
        .map_err(|e| ExpError::fail("无法创建 CDP 临时 profile").with_detail(e.to_string()))?;
    let guard = match BrowserGuard::spawn(exe, &profile, html_path) {
        Ok(g) => g,
        Err(e) => {
            xutil::cleanup_dir(&profile);
            return Err(e);
        }
    };

    let result = capture_inner(&profile, html_path, width, height, scale, format);
    drop(guard); // 杀浏览器进程树
    xutil::cleanup_dir(&profile);
    result
}

fn capture_inner(
    profile: &Path,
    html_path: &Path,
    width: u32,
    height: u32,
    scale: u32,
    format: CaptureFormat,
) -> Result<Vec<Shot>, ExpError> {
    let port = wait_devtools_port(profile, STARTUP_TIMEOUT)?;
    let ws_url = find_page_ws(port, STARTUP_TIMEOUT)?;
    let mut client = CdpClient::connect(&ws_url)?;

    client.call("Page.enable", json!({}))?;
    client.call("Runtime.enable", json!({}))?;
    client.call(
        "Emulation.setDeviceMetricsOverride",
        json!({
            "width": width,
            "height": height,
            "deviceScaleFactor": 1,
            "mobile": false,
        }),
    )?;
    client.call(
        "Page.navigate",
        json!({ "url": xutil::file_url(html_path) }),
    )?;

    wait_ready(&mut client)?;
    let rects = read_rects(&mut client)?;
    if rects.is_empty() {
        return Err(ExpError::fail("截图页里没有找到任何幻灯片")
            .with_detail("期望 div.marpit > svg[data-marpit-svg] 至少 1 个"));
    }

    let mut shots = Vec::with_capacity(rects.len());
    for (i, rect) in rects.iter().enumerate() {
        let (data, w, h) = capture_one(&mut client, rect, scale, format)?;
        shots.push(Shot {
            index: i,
            data,
            w,
            h,
        });
    }
    let _ = client.close();
    Ok(shots)
}

fn capture_one(
    client: &mut CdpClient,
    rect: &Rect,
    scale: u32,
    format: CaptureFormat,
) -> Result<(Vec<u8>, u32, u32), ExpError> {
    let mut params = json!({
        "format": format.name(),
        "fromSurface": true,
        "captureBeyondViewport": true,
        "clip": {
            "x": rect.x,
            "y": rect.y,
            "width": rect.width,
            "height": rect.height,
            "scale": scale,
        }
    });
    if let Some(q) = format.quality() {
        params["quality"] = json!(q);
    }
    let result = client.call("Page.captureScreenshot", params)?;
    let data_b64 = result
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| ExpError::fail("CDP 截图返回缺少 data 字段"))?;
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| ExpError::fail("CDP 截图 base64 解码失败").with_detail(e.to_string()))?;
    let w = (rect.width * scale as f64).round() as u32;
    let h = (rect.height * scale as f64).round() as u32;
    Ok((bytes, w, h))
}

fn wait_ready(client: &mut CdpClient) -> Result<(), ExpError> {
    let start = Instant::now();
    loop {
        let v = client.evaluate("window.__MWB_READY__ === true")?;
        if v == Value::Bool(true) {
            return Ok(());
        }
        if start.elapsed() > READY_TIMEOUT {
            return Err(ExpError::fail("等待页面渲染就绪超时（20s）")
                .with_detail("window.__MWB_READY__ 未置位，可能是字体/布局阻塞"));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn read_rects(client: &mut CdpClient) -> Result<Vec<Rect>, ExpError> {
    let expr = r#"JSON.stringify([...document.querySelectorAll('div.marpit > svg[data-marpit-svg]')].map(function(s){
        var r = s.getBoundingClientRect();
        return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
    }))"#;
    let value = client.evaluate(expr)?;
    let text = value
        .as_str()
        .ok_or_else(|| ExpError::fail("读取幻灯片布局信息失败"))?;
    let raw: Vec<Value> = serde_json::from_str(text)
        .map_err(|e| ExpError::fail("解析幻灯片布局信息失败").with_detail(e.to_string()))?;
    let mut rects = Vec::with_capacity(raw.len());
    for item in raw {
        let num = |k: &str| item.get(k).and_then(Value::as_f64).unwrap_or(0.0);
        let rect = Rect {
            x: num("x"),
            y: num("y"),
            width: num("width"),
            height: num("height"),
        };
        if rect.width > 0.0 && rect.height > 0.0 {
            rects.push(rect);
        }
    }
    Ok(rects)
}

// ---------------------------------------------------------------------------
// 浏览器进程管理
// ---------------------------------------------------------------------------

struct BrowserGuard {
    child: Child,
}

impl BrowserGuard {
    fn spawn(exe: &str, profile: &Path, html_path: &Path) -> Result<Self, ExpError> {
        let args = vec![
            "--headless=new".to_string(),
            "--disable-gpu".to_string(),
            "--no-first-run".to_string(),
            "--no-default-browser-check".to_string(),
            "--remote-debugging-port=0".to_string(),
            "--remote-allow-origins=*".to_string(),
            format!("--user-data-dir={}", profile.display()),
            "--disable-extensions".to_string(),
            "--disable-sync".to_string(),
            "--disable-background-networking".to_string(),
            "--mute-audio".to_string(),
            "--allow-file-access-from-files".to_string(),
            "--hide-scrollbars".to_string(),
            "--window-size=1280,720".to_string(),
            xutil::file_url(html_path),
        ];
        let mut cmd = Command::new(exe);
        cmd.args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let child = cmd
            .spawn()
            .map_err(|e| ExpError::fail("无法启动无头浏览器（CDP 截图）").with_detail(e.to_string()))?;
        Ok(Self { child })
    }
}

impl Drop for BrowserGuard {
    fn drop(&mut self) {
        // Chrome 无头实例在 CDP 模式下不会自行退出 → 强杀进程树。
        // 注意：kill 后必须等到进程真正退出再删 profile 目录（Windows 文件句柄释放有延迟），
        // 否则会留下 cdp-profile-* 残留并占住临时目录。
        let pid = self.child.id();
        for attempt in 0..3 {
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            #[cfg(not(windows))]
            {
                let _ = self.child.kill();
            }
            let deadline = Instant::now() + Duration::from_millis(1500);
            loop {
                match self.child.try_wait() {
                    Ok(Some(_)) => {
                        let _ = self.child.wait();
                        return;
                    }
                    _ if Instant::now() >= deadline => break,
                    _ => std::thread::sleep(Duration::from_millis(50)),
                }
            }
            // 仍存活：再补一次强杀（任务管理器偶尔会延迟处理第一个 taskkill）
            let _ = attempt;
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn wait_devtools_port(profile: &Path, timeout: Duration) -> Result<u16, ExpError> {
    let port_file = profile.join("DevToolsActivePort");
    let start = Instant::now();
    while start.elapsed() < timeout {
        if let Ok(text) = std::fs::read_to_string(&port_file) {
            if let Some(port) = text
                .lines()
                .next()
                .and_then(|line| line.trim().parse::<u16>().ok())
            {
                if port > 0 {
                    return Ok(port);
                }
            }
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Err(ExpError::fail("无头浏览器启动超时（DevToolsActivePort 未就绪）")
        .with_detail("可能是安全软件拦截或浏览器版本不支持 --remote-debugging-port=0"))
}

fn find_page_ws(port: u16, timeout: Duration) -> Result<String, ExpError> {
    let start = Instant::now();
    let mut last_err = String::new();
    while start.elapsed() < timeout {
        match http_get_json(port, "/json/list") {
            Ok(body) => {
                if let Ok(list) = serde_json::from_str::<Vec<Value>>(&body) {
                    let pages: Vec<&Value> = list
                        .iter()
                        .filter(|t| t.get("type").and_then(Value::as_str) == Some("page"))
                        .collect();
                    let target = pages
                        .iter()
                        .find(|t| {
                            t.get("url")
                                .and_then(Value::as_str)
                                .map(|u| u.starts_with("file:"))
                                .unwrap_or(false)
                        })
                        .or_else(|| pages.first());
                    if let Some(t) = target {
                        if let Some(url) = t.get("webSocketDebuggerUrl").and_then(Value::as_str) {
                            return Ok(url.to_string());
                        }
                    }
                }
            }
            Err(e) => last_err = e,
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(ExpError::fail("未找到可调试的页面（/json/list 无 page target）")
        .with_detail(last_err))
}

/// 极简 HTTP GET（仅用于 CDP 的 /json/* 端点，本机 127.0.0.1）
fn http_get_json(port: u16, path: &str) -> Result<String, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2))
        .map_err(|e| format!("连接 DevTools HTTP 失败: {e}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("发送 DevTools HTTP 请求失败: {e}"))?;
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > 8 * 1024 * 1024 {
                    break;
                }
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                break
            }
            Err(e) => return Err(format!("读取 DevTools HTTP 响应失败: {e}")),
        }
    }
    let pos = find_subsequence(&buf, b"\r\n\r\n")
        .ok_or_else(|| "DevTools HTTP 响应格式异常（缺少头部结束标记）".to_string())?;
    let header = String::from_utf8_lossy(&buf[..pos]).to_string();
    let body = &buf[pos + 4..];
    let content_length = header.lines().find_map(|line| {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("content-length:") {
            rest.trim().parse::<usize>().ok()
        } else {
            None
        }
    });
    let body = match content_length {
        Some(len) if len <= body.len() => &body[..len],
        _ => body,
    };
    Ok(String::from_utf8_lossy(body).to_string())
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

// ---------------------------------------------------------------------------
// CDP WebSocket 客户端
// ---------------------------------------------------------------------------

struct CdpClient {
    ws: WebSocket<MaybeTlsStream<TcpStream>>,
    next_id: u64,
}

impl CdpClient {
    fn connect(url: &str) -> Result<Self, ExpError> {
        let (ws, _response) = tungstenite::connect(url).map_err(|e| {
            ExpError::fail("CDP WebSocket 连接失败").with_detail(e.to_string())
        })?;
        if let MaybeTlsStream::Plain(stream) = ws.get_ref() {
            let _ = stream.set_read_timeout(Some(COMMAND_TIMEOUT));
            let _ = stream.set_write_timeout(Some(COMMAND_TIMEOUT));
        }
        Ok(Self { ws, next_id: 1 })
    }

    fn close(&mut self) -> Result<(), ExpError> {
        let _ = self.ws.close(None);
        let _ = self.ws.flush();
        Ok(())
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, ExpError> {
        let id = self.next_id;
        self.next_id += 1;
        let payload = json!({ "id": id, "method": method, "params": params }).to_string();
        self.ws
            .send(Message::Text(payload.into()))
            .map_err(|e| ExpError::fail(format!("CDP 发送 {method} 失败")).with_detail(e.to_string()))?;
        loop {
            let msg = self.ws.read().map_err(|e| {
                ExpError::fail(format!("CDP 通信失败（等待 {method} 响应）")).with_detail(e.to_string())
            })?;
            match msg {
                Message::Text(text) => {
                    let value: Value = match serde_json::from_str(text.as_str()) {
                        Ok(v) => v,
                        Err(e) => {
                            return Err(ExpError::fail("CDP 响应不是合法 JSON")
                                .with_detail(e.to_string()))
                        }
                    };
                    if value.get("id").and_then(Value::as_u64) == Some(id) {
                        if let Some(err) = value.get("error") {
                            return Err(ExpError::fail(format!("CDP {method} 返回错误"))
                                .with_detail(err.to_string()));
                        }
                        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                    }
                    // 其他事件（Page.loadEventFired 等）忽略
                }
                Message::Ping(payload) => {
                    let _ = self.ws.send(Message::Pong(payload));
                }
                Message::Close(frame) => {
                    return Err(ExpError::fail("CDP 连接被浏览器关闭")
                        .with_detail(format!("{frame:?}")));
                }
                _ => {}
            }
        }
    }

    fn evaluate(&mut self, expression: &str) -> Result<Value, ExpError> {
        let result = self.call(
            "Runtime.evaluate",
            json!({ "expression": expression, "returnByValue": true, "awaitPromise": false }),
        )?;
        if result.get("exceptionDetails").is_some() {
            return Err(ExpError::fail("CDP 页面脚本执行异常")
                .with_detail(result.to_string().chars().take(500).collect::<String>()));
        }
        Ok(result
            .get("result")
            .and_then(|r| r.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }
}
