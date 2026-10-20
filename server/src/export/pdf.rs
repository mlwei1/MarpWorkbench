//! PDF 导出：静态打印页 → 无头 Chrome/Edge `--print-to-pdf` → 写入导出目录。
//!
//! 实测依据（docs/research/desktop-packaging.md §1.3/§1.4）：
//! - Chrome 155：3 页 4.13s / 100 页 8.34s，页面精确 960×540pt，中文可提取；
//! - Edge 155：PDF 质量相同，但打印完进程不退出 → 必须「落盘 + 大小稳定」后 kill；
//! - 必须先写临时 HTML 再用 `file://` 打开（浏览器 CLI 无法携带 X-MWB-Token 头；
//!   实测 file:// 与本地 HTTP 打印的 PDF 字节大小/质量一致）。
//!
//! 等待策略：轮询 PDF 文件「存在 && 大小稳定 ≥300ms」；总超时 60s。

use std::{
    path::Path,
    process::Stdio,
    time::{Duration, Instant},
};

use tokio::process::Command;

use crate::browser;

use super::{print_page, util as xutil, ExpError, RenderPayload};

const PDF_TIMEOUT: Duration = Duration::from_secs(60);
const STABLE_FOR: Duration = Duration::from_millis(300);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const MIN_PDF_BYTES: u64 = 1024;

pub struct PdfResult {
    pub file_name: String,
    pub bytes: u64,
    pub pages: usize,
    pub ms: u64,
    pub browser: String,
}

/// 导出 PDF。成功返回导出目录内的文件名与统计信息。
pub async fn export_pdf(
    data_dir: &Path,
    exports_dir: &Path,
    payload: &RenderPayload,
) -> Result<PdfResult, ExpError> {
    let t0 = Instant::now();
    payload.validate(32 * 1024 * 1024)?;

    // 顺手清理 7 天前的导出临时目录 + 1 小时前异常中断留下的浏览器 profile/工作目录
    xutil::cleanup_older_than(&xutil::temp_root(), Duration::from_secs(7 * 24 * 3600));
    xutil::cleanup_stale_dirs(
        &xutil::temp_root(),
        &["pdf-", "chrome-profile-"],
        Duration::from_secs(3600),
    );

    let work = xutil::new_dir("pdf").map_err(|e| {
        ExpError::fail("无法创建导出临时目录").with_detail(e.to_string())
    })?;
    let result = export_pdf_inner(&work, data_dir, exports_dir, payload, t0).await;
    // 成功/失败都清理本次临时目录（PDF 已 rename 到导出目录；profile 目录由 print_with_browser 清理）
    xutil::cleanup_dir(&work);
    result
}

async fn export_pdf_inner(
    work: &Path,
    data_dir: &Path,
    exports_dir: &Path,
    payload: &RenderPayload,
    t0: Instant,
) -> Result<PdfResult, ExpError> {
    let html_path = work.join("print.html");
    let page = print_page::build_page(
        &payload.html,
        &payload.css,
        payload.title.as_deref().unwrap_or("MarpWorkbench 导出"),
        payload.width(),
        payload.height(),
        false,
        true, // 注入 marp browser helper：static HTML 默认没有 auto-scaling，内容密集页会被裁切
    );
    tokio::fs::write(&html_path, page.as_bytes()).await.map_err(|e| {
        ExpError::fail("写入打印页失败").with_detail(e.to_string())
    })?;

    let candidates = browser_candidates();
    if candidates.is_empty() {
        return Err(ExpError::fail(
            "未检测到 Chrome / Edge，无法导出 PDF",
        )
        .with_detail("请安装 Chrome 或 Edge；也可在设置页查看浏览器探测结果"));
    }

    let mut attempts: Vec<String> = Vec::new();
    for (name, exe) in candidates {
        let pdf_path = work.join("out.pdf");
        let _ = tokio::fs::remove_file(&pdf_path).await;
        match print_with_browser(&exe, &html_path, &pdf_path, data_dir).await {
            Ok(()) => {
                let bytes = match tokio::fs::read(&pdf_path).await {
                    Ok(b) => b,
                    Err(e) => {
                        attempts.push(format!("{name}: 读取 PDF 失败 {e}"));
                        continue;
                    }
                };
                if (bytes.len() as u64) < MIN_PDF_BYTES {
                    attempts.push(format!("{name}: PDF 过小（{} 字节）", bytes.len()));
                    continue;
                }
                if !xutil::looks_like_pdf(&bytes) {
                    attempts.push(format!("{name}: 输出不是 PDF"));
                    continue;
                }
                let pages = xutil::count_pdf_pages(&bytes);
                if pages == 0 {
                    attempts.push(format!("{name}: 未能解析出任何页面"));
                    continue;
                }
                tokio::fs::create_dir_all(exports_dir).await?;
                let stem = xutil::safe_stem(payload.title.as_deref(), "演示文稿");
                let file_name = xutil::unique_file_name(exports_dir, &stem, "pdf");
                let dest = exports_dir.join(&file_name);
                move_file(&pdf_path, &dest).await?;
                let bytes_len = bytes.len() as u64;
                crate::util::log_line(
                    data_dir,
                    &format!(
                        "export pdf ok: {file_name} pages={pages} bytes={bytes_len} browser={name} ms={}",
                        t0.elapsed().as_millis()
                    ),
                );
                return Ok(PdfResult {
                    file_name,
                    bytes: bytes_len,
                    pages,
                    ms: t0.elapsed().as_millis() as u64,
                    browser: name,
                });
            }
            Err(err) => {
                attempts.push(format!("{name}: {err}"));
            }
        }
    }

    let detail = attempts.join("；");
    crate::util::log_line(data_dir, &format!("export pdf failed: {detail}"));
    Err(ExpError::fail(
        "PDF 导出失败：无头浏览器未能生成 PDF",
    )
    .with_detail(detail))
}

/// 浏览器候选顺序：Chrome 优先（正常退出），Edge 兜底（需 kill）。
/// `MWB_BROWSER_PATH` 环境变量可强制指定（测试/排查用）。
fn browser_candidates() -> Vec<(String, String)> {
    if let Some(custom) = std::env::var_os("MWB_BROWSER_PATH") {
        let p = custom.to_string_lossy().to_string();
        if !p.is_empty() {
            let name = if p.to_ascii_lowercase().contains("edge") {
                "edge"
            } else {
                "chrome"
            };
            return vec![(name.to_string(), p)];
        }
    }
    let info = browser::detect();
    let mut out = Vec::new();
    if let Some(chrome) = info.chrome {
        out.push(("chrome".to_string(), chrome));
    }
    if let Some(edge) = info.edge {
        out.push(("edge".to_string(), edge));
    }
    out
}

async fn print_with_browser(
    exe: &str,
    html_path: &Path,
    pdf_path: &Path,
    data_dir: &Path,
) -> Result<(), String> {
    let profile = xutil::new_dir("chrome-profile").map_err(|e| format!("临时 profile 创建失败: {e}"))?;
    let file_url = xutil::file_url(html_path);
    let args = vec![
        "--headless=new".to_string(),
        "--disable-gpu".to_string(),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--no-pdf-header-footer".to_string(),
        "--virtual-time-budget=8000".to_string(),
        format!("--user-data-dir={}", profile.display()),
        "--disable-extensions".to_string(),
        "--disable-sync".to_string(),
        "--disable-background-networking".to_string(),
        "--mute-audio".to_string(),
        format!("--print-to-pdf={}", pdf_path.display()),
        file_url,
    ];

    let mut cmd = Command::new(exe);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        // tokio::process::Command 自带 creation_flags（Windows 专用固有方法）
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("无法启动浏览器: {e}"))?;
    let pid = child.id();

    let outcome = wait_for_pdf(&mut child, pdf_path).await;

    // 收尾：Chrome 通常自然退出；Edge/异常情况强杀进程树
    if !matches!(outcome, Err(_)) {
        let grace = Instant::now() + Duration::from_millis(1500);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < grace => {
                    tokio::time::sleep(Duration::from_millis(50)).await
                }
                _ => break,
            }
        }
    }
    if child.try_wait().ok().flatten().is_none() {
        if let Some(pid) = pid {
            kill_tree(pid).await;
        }
        let _ = child.wait().await;
    }

    xutil::cleanup_dir(&profile);
    if let Err(e) = &outcome {
        crate::util::log_line(data_dir, &format!("print_to_pdf failed: {e}"));
    }
    outcome
}

async fn wait_for_pdf(child: &mut tokio::process::Child, pdf_path: &Path) -> Result<(), String> {
    let deadline = Instant::now() + PDF_TIMEOUT;
    let mut last_size: u64 = 0;
    let mut stable_since: Option<Instant> = None;
    loop {
        if Instant::now() > deadline {
            return Err("等待 PDF 超时（60s）".to_string());
        }
        tokio::time::sleep(POLL_INTERVAL).await;
        let size = tokio::fs::metadata(pdf_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        if size > 0 {
            if size != last_size {
                last_size = size;
                stable_since = Some(Instant::now());
            } else if let Some(since) = stable_since {
                if since.elapsed() >= STABLE_FOR {
                    return Ok(());
                }
            }
        } else if let Ok(Some(status)) = child.try_wait() {
            // 进程已退出但 PDF 还没出现：给 300ms 落盘宽限
            tokio::time::sleep(Duration::from_millis(300)).await;
            if tokio::fs::metadata(pdf_path)
                .await
                .map(|m| m.len())
                .unwrap_or(0)
                > 0
            {
                return Ok(());
            }
            return Err(format!("浏览器退出（{status}）但未生成 PDF"));
        }
    }
}

/// 强杀进程树（Windows：taskkill /T /F）
pub async fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).status().await;
    }
}

/// 移动文件（跨盘失败则复制后删除）
async fn move_file(from: &Path, to: &Path) -> Result<(), ExpError> {
    if tokio::fs::rename(from, to).await.is_ok() {
        return Ok(());
    }
    tokio::fs::copy(from, to).await?;
    let _ = tokio::fs::remove_file(from).await;
    Ok(())
}
