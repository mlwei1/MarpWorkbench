//! 逐页截图（PPTX / PNG 用）：生成截图页 → CDP 原生截图 → 写临时 PNG/JPEG。
//!
//! CDP 不可用时不返回 HTTP 错误，而是返回 `fallback: true` 的降级标记，
//! 前端据此改用浏览器端 html-to-image 快速版（契约 §1.6）。

use std::{
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};

use crate::browser;

use super::{cdp, print_page, util as xutil, CapturePayload, ExpError};

/// 截图临时目录 TTL（契约 §1.6：10 分钟自动清理）
const CAPTURE_TTL: Duration = Duration::from_secs(600);

pub struct CapturedImage {
    pub index: usize,
    /// 相对 URL：`/api/export/tmp/<token>/<file>`
    pub url: String,
    pub w: u32,
    pub h: u32,
}

pub struct CaptureOutcome {
    pub images: Vec<CapturedImage>,
    pub ms: u64,
    pub fallback: bool,
    pub fallback_reason: Option<String>,
    /// `cdp` | `fallback`
    pub mode: String,
}

/// 同步执行截图（调用方负责 `spawn_blocking`）。
pub fn capture_slides(
    data_dir: &std::path::Path,
    payload: &CapturePayload,
) -> Result<CaptureOutcome, ExpError> {
    let t0 = Instant::now();
    let render = payload.render();
    render.validate(32 * 1024 * 1024)?;

    // 顺手清理过期截图目录（10 分钟 TTL）+ 1 小时前异常中断留下的 profile/工作目录
    cleanup_captures(CAPTURE_TTL);
    xutil::cleanup_stale_dirs(
        &xutil::temp_root(),
        &["cdp-profile-", "pdf-", "chrome-profile-"],
        Duration::from_secs(3600),
    );

    let token = xutil::random_hex(8);
    let dir = xutil::temp_root().join(format!("capture-{token}"));
    fs::create_dir_all(&dir)
        .map_err(|e| ExpError::fail("无法创建截图临时目录").with_detail(e.to_string()))?;

    let html_path = dir.join("page.html");
    let page = print_page::build_page(
        &payload.html,
        &payload.css,
        "MarpWorkbench 截图",
        render.width(),
        render.height(),
        true,
        true, // 注入 marp browser helper，保证截图与预览一致（auto-scaling）
    );
    fs::write(&html_path, page.as_bytes())
        .map_err(|e| ExpError::fail("写入截图页失败").with_detail(e.to_string()))?;

    let exe = match pick_browser() {
        Some(exe) => exe,
        None => {
            xutil::cleanup_dir(&dir);
            return Ok(CaptureOutcome {
                images: Vec::new(),
                ms: t0.elapsed().as_millis() as u64,
                fallback: true,
                fallback_reason: Some("未检测到 Chrome / Edge，无法使用原生截图".to_string()),
                mode: "fallback".to_string(),
            });
        }
    };

    let scale = payload.scale();
    let format = payload.format();
    let result = cdp::capture_slides(
        &exe,
        &html_path,
        render.width(),
        render.height(),
        scale,
        format,
    );

    let outcome = match result {
        Ok(shots) => {
            let mut images = Vec::with_capacity(shots.len());
            for shot in shots {
                let file_name = format!("slide-{}.{}", shot.index + 1, format.ext());
                let file_path = dir.join(&file_name);
                if let Err(e) = fs::write(&file_path, &shot.data) {
                    crate::util::log_line(
                        data_dir,
                        &format!("capture: 写入截图失败 {}: {e}", file_path.display()),
                    );
                    xutil::cleanup_dir(&dir);
                    return Err(ExpError::fail("写入截图文件失败").with_detail(e.to_string()));
                }
                images.push(CapturedImage {
                    index: shot.index,
                    url: format!("/api/export/tmp/{token}/{file_name}"),
                    w: shot.w,
                    h: shot.h,
                });
            }
            // 前端声明页数与实际截图数不一致时记录（不阻断导出）
            if let Some(expected) = payload.slide_count {
                if expected != images.len() {
                    crate::util::log_line(
                        data_dir,
                        &format!(
                            "capture: slideCount 不一致 expected={expected} actual={}",
                            images.len()
                        ),
                    );
                }
            }
            let ms = t0.elapsed().as_millis() as u64;
            crate::util::log_line(
                data_dir,
                &format!(
                    "capture ok: slides={} format={} scale={} ms={ms}",
                    images.len(),
                    format.name(),
                    scale
                ),
            );
            CaptureOutcome {
                images,
                ms,
                fallback: false,
                fallback_reason: None,
                mode: "cdp".to_string(),
            }
        }
        Err(err) => {
            crate::util::log_line(
                data_dir,
                &format!("capture cdp failed, fallback to html-to-image: {err}"),
            );
            xutil::cleanup_dir(&dir);
            CaptureOutcome {
                images: Vec::new(),
                ms: t0.elapsed().as_millis() as u64,
                fallback: true,
                fallback_reason: Some(err.to_string()),
                mode: "fallback".to_string(),
            }
        }
    };

    // 截图完成后页面 html 不再需要（保留截图目录供前端取图）
    if outcome.images.is_empty() {
        xutil::cleanup_dir(&dir);
    } else {
        let _ = fs::remove_file(&html_path);
    }
    Ok(outcome)
}

/// Chrome 优先（正常退出），Edge 兜底；`MWB_BROWSER_PATH` 可强制指定
fn pick_browser() -> Option<String> {
    if let Some(custom) = std::env::var_os("MWB_BROWSER_PATH") {
        let p = custom.to_string_lossy().to_string();
        if !p.is_empty() {
            return Some(p);
        }
    }
    let info = browser::detect();
    info.chrome.or(info.edge)
}

/// 清理超过 TTL 的 `capture-*` 目录
pub fn cleanup_captures(max_age: Duration) {
    let root = xutil::temp_root();
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("capture-") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else { continue };
        let Ok(age) = now.duration_since(modified) else {
            continue;
        };
        if age > max_age {
            xutil::cleanup_dir(&entry.path());
        }
    }
}

/// 截图目录（供路由读取临时 PNG）
pub fn capture_dir(token: &str) -> PathBuf {
    xutil::temp_root().join(format!("capture-{token}"))
}
