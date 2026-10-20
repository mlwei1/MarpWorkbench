//! M3 网络图片下载管线（服务端公共能力）
//!
//! 用途：
//!  - `GET /api/proxy/image` 预览代理（routes/proxy.rs）
//!  - `POST /api/decks/:id/localize-images` 一键本地化（routes/proxy.rs）
//!
//! 设计说明（重要）：
//!  - **HTTP 客户端使用 Windows 系统自带 `curl.exe`**（Win10 1809+/Win11 均内置）而不是 reqwest/ureq。
//!    原因：当前构建环境 crates.io 被失效代理阻断、无法拉取新 crate（详见 docs/dev/server.md M3 章节）；
//!    curl.exe 方案零新增依赖、零 exe 体积增长、无 TLS 编译依赖，且行为可测试。
//!    若后续网络恢复、要求纯 Rust 客户端，可只替换本文件的 `run_curl()` 实现为 ureq/reqwest，接口不变。
//!  - 安全：仅 http/https；拒绝 localhost/私有网段/`.local`（DNS 解析后逐 IP 校验）；拒绝非图片 content-type；
//!    最大 15MB；超时 10s；最多 3 次重定向且每跳重新校验；缓存 7 天。
//!  - 测试：环境变量 `MWB_PROXY_ALLOW_PRIVATE=1` 放行本机/内网地址（**仅测试用**，生产文档已标注）。
use std::{
    fs,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs},
    path::PathBuf,
    process::Command,
    sync::OnceLock,
    time::{Duration, SystemTime},
};

use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;

/// 单张图片最大字节数（契约：15MB）
pub const MAX_BYTES: u64 = 15 * 1024 * 1024;
/// 单请求总超时（契约：10s）
const TIMEOUT_SECS: u64 = 10;
/// 最大重定向跳数（契约：3 跳）
const MAX_REDIRECTS: usize = 3;
/// 缓存有效期（契约：7 天）
const CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// 全局并发上限（避免被页面大量远程图片拖垮）
const GLOBAL_CONCURRENCY: usize = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageErrorKind {
    /// 非法 URL / 私有网络 / 非图片 / 超限 → 400
    BadRequest,
    /// 上游 404/410 → 404
    NotFound,
    /// 网络不可达 / 超时 / 上游 5xx / 重定向异常 → 502
    Upstream,
}

#[derive(Debug, Clone)]
pub struct ImageError {
    pub kind: ImageErrorKind,
    pub message: String,
}

impl ImageError {
    fn bad(message: impl Into<String>) -> Self {
        Self { kind: ImageErrorKind::BadRequest, message: message.into() }
    }
    fn not_found(message: impl Into<String>) -> Self {
        Self { kind: ImageErrorKind::NotFound, message: message.into() }
    }
    fn upstream(message: impl Into<String>) -> Self {
        Self { kind: ImageErrorKind::Upstream, message: message.into() }
    }
}

#[derive(Debug, Clone)]
pub struct DownloadedImage {
    pub bytes: Vec<u8>,
    pub content_type: String,
    /// 归一化扩展名（png/jpg/gif/webp/svg/bmp/avif/ico）
    pub ext: String,
}

/// 图片缓存目录：`%TEMP%\MarpWorkbench\imgcache`
pub fn cache_dir() -> PathBuf {
    std::env::temp_dir().join("MarpWorkbench").join("imgcache")
}

/// 测试用放行开关（仅 `MWB_PROXY_ALLOW_PRIVATE=1` 生效）
pub fn allow_private_env() -> bool {
    std::env::var("MWB_PROXY_ALLOW_PRIVATE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// 下载（带缓存 + 并发限制）：async 封装，内部用 spawn_blocking 调 curl。
pub async fn fetch_image(url: String, allow_private: bool) -> Result<DownloadedImage, ImageError> {
    static SEM: OnceLock<Semaphore> = OnceLock::new();
    let sem = SEM.get_or_init(|| Semaphore::new(GLOBAL_CONCURRENCY));
    let _permit = sem
        .acquire()
        .await
        .map_err(|_| ImageError::upstream("图片下载繁忙，请稍后重试"))?;
    tokio::task::spawn_blocking(move || fetch_image_blocking(&url, allow_private))
        .await
        .map_err(|err| ImageError::upstream(format!("图片下载任务失败：{err}")))?
}

/// 同步下载实现（只在 spawn_blocking 线程里调用）
fn fetch_image_blocking(raw_url: &str, allow_private: bool) -> Result<DownloadedImage, ImageError> {
    let original = raw_url.trim().to_string();
    if original.is_empty() {
        return Err(ImageError::bad("缺少图片 URL"));
    }
    let mut parsed = parse_url(&original)?;
    validate_target(&parsed, allow_private)?;

    // ---- 缓存命中：<sha256(url)>.<ext> ----
    let hash = sha256_hex(&original);
    if let Some(img) = cache_lookup(&hash) {
        return Ok(img);
    }

    fs::create_dir_all(cache_dir())
        .map_err(|err| ImageError::upstream(format!("无法创建图片缓存目录：{err}")))?;

    let mut redirects = 0usize;
    loop {
        let (status, headers, body_path) = run_curl(&parsed)?;

        if (300..400).contains(&status) {
            let location = headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("location"))
                .map(|(_, v)| v.clone())
                .ok_or_else(|| ImageError::upstream("远程服务器返回重定向但缺少 Location"))?;
            let _ = fs::remove_file(&body_path);
            if redirects >= MAX_REDIRECTS {
                return Err(ImageError::upstream("远程图片重定向次数过多（最多 3 次）"));
            }
            redirects += 1;
            let next = join_url(&parsed, &location)?;
            validate_target(&next, allow_private)?;
            parsed = next;
            continue;
        }

        if status == 404 || status == 410 {
            let _ = fs::remove_file(&body_path);
            return Err(ImageError::not_found("远程图片不存在（HTTP 404）"));
        }
        if !(200..300).contains(&status) {
            let _ = fs::remove_file(&body_path);
            return Err(ImageError::upstream(format!(
                "下载远程图片失败：服务器返回 HTTP {status}"
            )));
        }

        let content_type = headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
            .map(|(_, v)| normalize_content_type(v))
            .unwrap_or_default();
        let Some(ext) = ext_from_content_type(&content_type) else {
            let _ = fs::remove_file(&body_path);
            return Err(ImageError::bad(format!(
                "远程资源不是支持的图片类型（Content-Type: {}）",
                if content_type.is_empty() { "缺失" } else { &content_type }
            )));
        };

        let size = fs::metadata(&body_path).map(|m| m.len()).unwrap_or(0);
        if size == 0 {
            let _ = fs::remove_file(&body_path);
            return Err(ImageError::upstream("下载到的图片内容为空"));
        }
        if size > MAX_BYTES {
            let _ = fs::remove_file(&body_path);
            return Err(ImageError::bad("图片超过 15MB 限制"));
        }
        let bytes = fs::read(&body_path)
            .map_err(|err| ImageError::upstream(format!("读取下载内容失败：{err}")))?;
        let _ = fs::remove_file(&body_path);

        // 写缓存（失败不影响本次返回）
        let cache_path = cache_dir().join(format!("{hash}.{ext}"));
        let _ = write_atomic(&cache_path, &bytes);

        return Ok(DownloadedImage {
            bytes,
            content_type: content_type_from_ext(ext)
                .unwrap_or("application/octet-stream")
                .to_string(),
            ext: ext.to_string(),
        });
    }
}

/// 启动时清理：删除 >7 天缓存与残留临时文件（由 routes::build_router 起线程调用）
pub fn cleanup_cache_startup() {
    let dir = cache_dir();
    let _ = fs::create_dir_all(&dir);
    let now = SystemTime::now();
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let mut removed = 0u32;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let too_old = fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .map(|age| age > CACHE_TTL)
            .unwrap_or(false);
        if name.starts_with(".tmp-") || too_old {
            let _ = fs::remove_file(&path);
            removed += 1;
        }
    }
    if removed > 0 {
        eprintln!("[imgcache] 启动清理：删除 {removed} 个过期/临时缓存文件");
    }
}

/// 公开给 localize 命名用的 sha256 hex
pub fn sha256_hex(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

// ---------------------------------------------------------------------------
// curl.exe 调用
// ---------------------------------------------------------------------------

fn curl_exe() -> String {
    if let Some(root) = std::env::var_os("SystemRoot") {
        let p = PathBuf::from(root).join("System32").join("curl.exe");
        if p.is_file() {
            return p.to_string_lossy().to_string();
        }
    }
    "curl.exe".to_string()
}

fn run_curl(
    parsed: &ParsedUrl,
) -> Result<(u16, Vec<(String, String)>, PathBuf), ImageError> {
    let dir = cache_dir();
    fs::create_dir_all(&dir)
        .map_err(|err| ImageError::upstream(format!("无法创建图片缓存目录：{err}")))?;
    let rand_suffix = format!("{:08x}", rand::random::<u32>());
    let body_path = dir.join(format!(".tmp-{rand_suffix}.bin"));
    let header_path = dir.join(format!(".tmp-{rand_suffix}.hdr"));
    let url = parsed.to_url_string();

    let output = Command::new(curl_exe())
        .args(["-sS", "--max-redirs", "0", "--max-time", &TIMEOUT_SECS.to_string()])
        .arg("--max-filesize")
        .arg(MAX_BYTES.to_string())
        .args(["-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MarpWorkbench/0.1"])
        .args(["-H", "Accept: image/*,*/*;q=0.8"])
        .arg("-o")
        .arg(&body_path)
        .arg("-D")
        .arg(&header_path)
        .args(["-w", "%{http_code}"])
        .arg(&url)
        .output()
        .map_err(|err| {
            let _ = fs::remove_file(&body_path);
            let _ = fs::remove_file(&header_path);
            ImageError::upstream(format!(
                "无法调用系统 curl.exe 下载远程图片：{err}（Windows 10 1809+ 应自带 curl.exe）"
            ))
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let exit_code = output.status.code().unwrap_or(-1);
    let code: u16 = stdout.parse().unwrap_or(0);

    // curl 自身失败（网络/TLS/超时/超过 --max-filesize 等）优先于 HTTP 状态判断
    if exit_code != 0 {
        let reason = match exit_code {
            28 => "下载远程图片超时（10s）".to_string(),
            63 => "图片超过 15MB 限制".to_string(),
            6 => "无法解析图片域名".to_string(),
            7 => "无法连接图片服务器（域名不可达）".to_string(),
            35 | 60 => "图片服务器 TLS/证书校验失败".to_string(),
            _ => {
                if stderr.is_empty() {
                    format!("下载远程图片失败（curl 退出码 {exit_code}）")
                } else {
                    format!("下载远程图片失败：{}", truncate(&stderr, 200))
                }
            }
        };
        let _ = fs::remove_file(&body_path);
        let _ = fs::remove_file(&header_path);
        let kind = if exit_code == 63 { ImageErrorKind::BadRequest } else { ImageErrorKind::Upstream };
        return Err(ImageError { kind, message: reason });
    }
    if code == 0 {
        let _ = fs::remove_file(&body_path);
        let _ = fs::remove_file(&header_path);
        return Err(ImageError::upstream("下载远程图片失败（curl 未返回 HTTP 状态）"));
    }

    let headers = parse_header_file(&header_path);
    let _ = fs::remove_file(&header_path);
    Ok((code, headers, body_path))
}

fn truncate(text: &str, max_chars: usize) -> String {
    let mut out: String = text.chars().take(max_chars).collect();
    if text.chars().count() > max_chars {
        out.push('…');
    }
    out
}

/// 解析 curl `-D` 导出的响应头（无重定向跟随时只有一个响应块）
fn parse_header_file(path: &PathBuf) -> Vec<(String, String)> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut headers = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() || line.starts_with("HTTP/") {
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }
    }
    headers
}

// ---------------------------------------------------------------------------
// 缓存读写
// ---------------------------------------------------------------------------

fn cache_lookup(hash: &str) -> Option<DownloadedImage> {
    let dir = cache_dir();
    let entries = fs::read_dir(dir).ok()?;
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(rest) = name.strip_prefix(hash) else {
            continue;
        };
        let Some(ext) = rest.strip_prefix('.') else {
            continue;
        };
        if !is_valid_ext(ext) {
            continue;
        }
        let Some(content_type) = content_type_from_ext(ext) else {
            continue;
        };
        let path = entry.path();
        let fresh = fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .map(|age| age < CACHE_TTL)
            .unwrap_or(false);
        if !fresh {
            continue;
        }
        if let Ok(bytes) = fs::read(&path) {
            if !bytes.is_empty() && bytes.len() as u64 <= MAX_BYTES {
                return Some(DownloadedImage {
                    bytes,
                    content_type: content_type.to_string(),
                    ext: ext.to_string(),
                });
            }
        }
    }
    None
}

fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension(format!(
        "{}.tmp{}",
        path.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default(),
        rand::random::<u32>()
    ));
    fs::write(&tmp, bytes)?;
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = fs::remove_file(&tmp);
            Err(err)
        }
    }
}

// ---------------------------------------------------------------------------
// content-type / 扩展名
// ---------------------------------------------------------------------------

fn normalize_content_type(value: &str) -> String {
    value
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

fn ext_from_content_type(content_type: &str) -> Option<&'static str> {
    match content_type {
        "image/png" | "image/apng" => Some("png"),
        "image/jpeg" | "image/jpg" | "image/pjpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        "image/bmp" | "image/x-ms-bmp" => Some("bmp"),
        "image/avif" => Some("avif"),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some("ico"),
        _ => None,
    }
}

fn content_type_from_ext(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "bmp" => Some("image/bmp"),
        "avif" => Some("image/avif"),
        "ico" => Some("image/x-icon"),
        _ => None,
    }
}

fn is_valid_ext(ext: &str) -> bool {
    !ext.is_empty()
        && ext.len() <= 5
        && ext.chars().all(|c| c.is_ascii_alphanumeric())
        && content_type_from_ext(ext).is_some()
}

// ---------------------------------------------------------------------------
// URL 解析 / 私有网络校验 / 重定向
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct ParsedUrl {
    scheme: String,
    /// 用于 DNS/私有网段校验的主机名（IPv6 不带方括号）
    host: String,
    port: u16,
    /// 原始 authority（host[:port]，IPv6 保留方括号），用于重新拼接 URL
    authority: String,
    /// path?query（不含 fragment）
    path_query: String,
}

impl ParsedUrl {
    fn to_url_string(&self) -> String {
        format!("{}://{}{}", self.scheme, self.authority, self.path_query)
    }
}

fn parse_url(raw: &str) -> Result<ParsedUrl, ImageError> {
    let raw = raw.trim();
    let Some((scheme, rest)) = raw.split_once("://") else {
        return Err(ImageError::bad("图片 URL 非法：缺少 http:// 或 https://"));
    };
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(ImageError::bad("仅支持 http/https 图片地址"));
    }
    if rest.is_empty() {
        return Err(ImageError::bad("图片 URL 非法：缺少域名"));
    }

    let split_at = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..split_at];
    let path_query_raw = &rest[split_at..];
    if authority.is_empty() {
        return Err(ImageError::bad("图片 URL 非法：缺少域名"));
    }
    if authority.contains('@') {
        return Err(ImageError::bad("图片 URL 不允许包含用户名/密码"));
    }

    let default_port = if scheme == "https" { 443 } else { 80 };
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        // IPv6 字面量：[::1]:8080
        let Some((host, after)) = rest.split_once(']') else {
            return Err(ImageError::bad("图片 URL 非法：IPv6 地址缺少 ]"));
        };
        let port = after
            .strip_prefix(':')
            .map(|p| p.parse::<u16>())
            .transpose()
            .map_err(|_| ImageError::bad("图片 URL 非法：端口不合法"))?
            .unwrap_or(default_port);
        (host.to_string(), port)
    } else if let Some((h, p)) = authority.rsplit_once(':') {
        if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) {
            let port = p
                .parse::<u16>()
                .map_err(|_| ImageError::bad("图片 URL 非法：端口不合法"))?;
            (h.to_string(), port)
        } else {
            (authority.to_string(), default_port)
        }
    } else {
        (authority.to_string(), default_port)
    };
    if host.is_empty() || host.contains(char::is_whitespace) {
        return Err(ImageError::bad("图片 URL 非法：域名不合法"));
    }

    let mut path_query = if path_query_raw.is_empty() {
        "/".to_string()
    } else if path_query_raw.starts_with('/') {
        path_query_raw.to_string()
    } else if path_query_raw.starts_with('?') {
        format!("/{path_query_raw}")
    } else if path_query_raw.starts_with('#') {
        "/".to_string()
    } else {
        format!("/{path_query_raw}")
    };
    if let Some(idx) = path_query.find('#') {
        path_query.truncate(idx);
    }
    if path_query.is_empty() {
        path_query = "/".to_string();
    }

    Ok(ParsedUrl {
        scheme,
        host,
        port,
        authority: authority.to_string(),
        path_query,
    })
}

fn validate_target(parsed: &ParsedUrl, allow_private: bool) -> Result<(), ImageError> {
    if allow_private {
        return Ok(());
    }
    let host = parsed.host.to_ascii_lowercase();
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host == "0.0.0.0"
        || host == "::"
        || host == "ip6-localhost"
    {
        return Err(ImageError::bad("拒绝访问本机/内网图片地址"));
    }
    let addrs = (host.as_str(), parsed.port)
        .to_socket_addrs()
        .map_err(|_| ImageError::upstream("无法解析图片域名"))?;
    let mut any = false;
    for addr in addrs {
        any = true;
        if is_private_ip(addr.ip()) {
            return Err(ImageError::bad("拒绝访问本机/内网图片地址"));
        }
    }
    if !any {
        return Err(ImageError::upstream("无法解析图片域名"));
    }
    Ok(())
}

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_private_v4(v4),
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00 // fc00::/7 unique local
                || (first & 0xffc0) == 0xfe80 // fe80::/10 link local
        }
    }
}

fn is_private_v4(ip: Ipv4Addr) -> bool {
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.octets()[0] == 0
}

/// 解析重定向 Location（绝对/协议相对/根相对/相对路径/仅 query）
fn join_url(current: &ParsedUrl, location: &str) -> Result<ParsedUrl, ImageError> {
    let loc = location.trim();
    if loc.is_empty() {
        return Err(ImageError::upstream("远程服务器返回空重定向地址"));
    }
    let assembled = if loc.starts_with("http://") || loc.starts_with("https://") {
        loc.to_string()
    } else if let Some(rest) = loc.strip_prefix("//") {
        format!("{}://{rest}", current.scheme)
    } else if loc.starts_with('/') {
        format!("{}://{}{}", current.scheme, current.authority, loc)
    } else if loc.starts_with('?') {
        let path = current.path_query.split('?').next().unwrap_or("/");
        format!("{}://{}{}{}", current.scheme, current.authority, path, loc)
    } else {
        let path = current.path_query.split('?').next().unwrap_or("/");
        let dir = match path.rfind('/') {
            Some(idx) => &path[..=idx],
            None => "/",
        };
        format!("{}://{}{}{}", current.scheme, current.authority, dir, loc)
    };
    parse_url(&assembled)
}

/// 仅用于测试/文档的 IPv6 私有判断辅助（避免未使用告警）
#[allow(dead_code)]
fn is_private_v6_for_test(ip: Ipv6Addr) -> bool {
    is_private_ip(IpAddr::V6(ip))
}
