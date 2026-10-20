use std::{
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use chrono::{DateTime, SecondsFormat, Utc};
use sha2::{Digest, Sha256};

use crate::error::{ApiError, ApiResult};

/// 数据目录解析（优先级）：
/// 1. 环境变量 `MWB_DATA_DIR`（测试/联调必须能用）
/// 2. exe 同目录存在 `data\`（便携模式）
/// 3. `%USERPROFILE%\Documents\MarpWorkbench\`
pub fn resolve_data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("MWB_DATA_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let portable = exe_dir.join("data");
            if portable.is_dir() {
                return portable;
            }
        }
    }
    let home = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join("Documents").join("MarpWorkbench")
}

/// 首次启动创建目录结构：数据目录（=工作区根）、.trash、exports、themes、logs
pub async fn ensure_dirs(data_dir: &Path) -> std::io::Result<()> {
    for sub in ["", ".trash", "exports", "themes", "logs"] {
        tokio::fs::create_dir_all(data_dir.join(sub)).await?;
    }
    Ok(())
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub fn fmt_system_time(t: SystemTime) -> String {
    let dt: DateTime<Utc> = t.into();
    dt.to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub fn file_updated_at(path: &Path) -> String {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(fmt_system_time)
        .unwrap_or_else(|_| now_iso())
}

pub fn file_created_at(path: &Path) -> String {
    std::fs::metadata(path)
        .and_then(|m| m.created().or_else(|_| m.modified()))
        .map(fmt_system_time)
        .unwrap_or_else(|_| now_iso())
}

/// rev = 内容 sha256 前 16 位（hex）
pub fn sha256_16(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    hex[..16].to_string()
}

/// 校验 deck id（=工作区子目录名）：拒绝路径分隔符/穿越/Windows 保留名
pub fn validate_deck_id(id: &str) -> ApiResult<String> {
    let id = id.trim();
    if id.is_empty() {
        return Err(ApiError::bad_request("deck id 不能为空"));
    }
    if id.len() > 120 {
        return Err(ApiError::bad_request("deck id 过长"));
    }
    if id == "." || id == ".." {
        return Err(ApiError::bad_request("非法 deck id"));
    }
    if id.chars().any(|c| {
        matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control()
    }) {
        return Err(ApiError::bad_request("deck id 含非法字符"));
    }
    if id.starts_with('.') || id.ends_with('.') || id.ends_with(' ') {
        return Err(ApiError::bad_request("deck id 不能以点开头/结尾"));
    }
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = id.split('.').next().unwrap_or(id).to_ascii_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        return Err(ApiError::bad_request("deck id 为 Windows 保留名"));
    }
    Ok(id.to_string())
}

/// 把用户输入的展示名清洗成可安全当目录名使用的名字（保留中文/空格）
pub fn sanitize_deck_name(name: &str) -> String {
    let mut out = String::new();
    for ch in name.trim().chars() {
        if matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || ch.is_control() {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let out = out.trim().trim_matches('.').trim().to_string();
    if out.is_empty() {
        "未命名演示".to_string()
    } else {
        out
    }
}

/// 文件名清洗（资源上传）：只保留 basename，去掉路径与非法字符
pub fn sanitize_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name).trim();
    let mut out = String::new();
    for ch in base.chars() {
        if matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || ch.is_control() {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let out = out.trim().to_string();
    if out.is_empty() || out == "." || out == ".." {
        "file".to_string()
    } else {
        out
    }
}

/// URL path 片段编码（中文/空格安全）
pub fn url_seg(s: &str) -> String {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

/// `Content-Disposition` 中文文件名
pub fn content_disposition(filename: &str) -> String {
    let ascii: String = filename
        .chars()
        .map(|c| if c.is_ascii_graphic() { c } else { '_' })
        .collect();
    format!(
        "attachment; filename=\"{}\"; filename*=UTF-8''{}",
        ascii,
        url_seg(filename)
    )
}

pub fn mime_for_ext(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "md" | "markdown" => "text/markdown; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

pub fn ext_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// 文件名去扩展名（用于同名校验生成 `name-1.ext`）
pub fn file_stem(name: &str) -> String {
    Path::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string())
}

/// 校验相对静态资源路径，拒绝穿越
pub fn safe_relative_path(raw: &str) -> Option<String> {
    let decoded = percent_encoding::percent_decode_str(raw).decode_utf8().ok()?;
    let p = Path::new(decoded.as_ref());
    for comp in p.components() {
        match comp {
            Component::Normal(_) => {}
            _ => return None,
        }
    }
    let rel = decoded.trim_start_matches('/').to_string();
    if rel.is_empty() {
        None
    } else {
        Some(rel)
    }
}

/// 原子写入（同目录临时文件 + rename，Windows 下 rename 覆盖旧文件）
pub async fn atomic_write(path: &Path, bytes: &[u8]) -> ApiResult<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp{}",
        path.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default(),
        rand::random::<u32>()
    ));
    tokio::fs::write(&tmp, bytes).await?;
    match tokio::fs::rename(&tmp, path).await {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            Err(e.into())
        }
    }
}

pub fn open_browser(url: &str) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

pub fn log_line(data_dir: &Path, msg: &str) {
    let line = format!("[{}] {}\n", now_iso(), msg);
    #[cfg(debug_assertions)]
    eprint!("{line}");
    let dir = data_dir.join("logs");
    let _ = std::fs::create_dir_all(&dir);
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("server.log"))
    {
        let _ = f.write_all(line.as_bytes());
    }
}

/// 探测已有实例（单实例二次启动）：读 instance.json 并请求 /api/health
pub fn probe_existing_instance(data_dir: &Path) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct InstanceFile {
        port: u16,
        token: String,
    }
    let text = std::fs::read_to_string(data_dir.join("instance.json")).ok()?;
    let info: InstanceFile = serde_json::from_str(&text).ok()?;
    if health_ok(info.port) {
        Some(format!(
            "http://127.0.0.1:{}/?token={}",
            info.port, info.token
        ))
    } else {
        let _ = std::fs::remove_file(data_dir.join("instance.json"));
        None
    }
}

fn health_ok(port: u16) -> bool {
    use std::io::{Read, Write};
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(800))
    else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.write_all(
        b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    );
    let mut buf = Vec::new();
    let _ = stream.take(8192).read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    text.contains("200") && text.contains("\"ok\"")
}

pub fn unix_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
