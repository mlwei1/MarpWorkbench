//! M5.1 CLI：`MarpWorkbench.exe --export <deck.md> [--format ...]`
//!
//! 设计（docs/CLI_CONTRACT.md §1/§2.1）：
//! - main.rs 检测到 `--export` 后：不打开浏览器、照常启动本地 axum 服务 → spawn 服务 →
//!   在 blocking 线程跑本模块 → 结束后 shutdown 服务、按结果退出。
//! - 复用现有前端导出能力：创建 deck → 写入 md → 用 headless Chrome 打开
//!   `/edit/<id>?token=<token>&autoExport=<format>` → 前端自动导出并下载 → CLI 轮询下载目录取文件。
//! - 不新增 crate：本机 HTTP 用 std::net::TcpStream 手写 HTTP/1.1；JSON 用 serde_json（已有）。
use std::{
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::{json, Value};

use crate::browser;
use crate::state::AppState;

const DEFAULT_TIMEOUT_SECS: u64 = 180;
const POLL_INTERVAL: Duration = Duration::from_millis(200);
const API_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const API_READ_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_MD_BYTES: u64 = 32 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Format {
    Pptx,
    PptxEditable,
    Pdf,
    Html,
}

impl Format {
    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "pptx" => Some(Format::Pptx),
            "pptx-editable" => Some(Format::PptxEditable),
            "pdf" => Some(Format::Pdf),
            "html" => Some(Format::Html),
            _ => None,
        }
    }

    /// 传给前端 `?autoExport=` 的值
    pub fn as_str(&self) -> &'static str {
        match self {
            Format::Pptx => "pptx",
            Format::PptxEditable => "pptx-editable",
            Format::Pdf => "pdf",
            Format::Html => "html",
        }
    }

    fn ext(&self) -> &'static str {
        match self {
            Format::Pptx | Format::PptxEditable => "pptx",
            Format::Pdf => "pdf",
            Format::Html => "html",
        }
    }

    fn out_suffix(&self) -> &'static str {
        match self {
            Format::PptxEditable => "-可编辑",
            _ => "",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ExportArgs {
    pub input: PathBuf,
    pub format: Format,
    pub out: Option<PathBuf>,
    pub theme: Option<String>,
    pub timeout_secs: u64,
    pub keep_deck: bool,
}

#[derive(Debug, Clone)]
pub struct ExportReport {
    pub format: Format,
    pub file: PathBuf,
    pub bytes: u64,
    pub pages: Option<u64>,
    pub deck_id: String,
    pub kept_deck: bool,
    pub ms: u64,
}

impl ExportReport {
    fn to_json_line(&self) -> String {
        json!({
            "ok": true,
            "format": self.format.as_str(),
            "file": self.file.to_string_lossy(),
            "bytes": self.bytes,
            "pages": self.pages,
            "ms": self.ms,
            "deckId": self.deck_id,
            "keptDeck": self.kept_deck,
        })
        .to_string()
    }
}

pub fn wants_help(args: &[String]) -> bool {
    args.iter().any(|a| a == "--help" || a == "-h")
}

fn emit(text: &str) {
    use std::io::Write as _;
    let mut out = std::io::stdout();
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
}

fn emit_stderr(text: &str) {
    use std::io::Write as _;
    let mut err = std::io::stderr();
    let _ = err.write_all(text.as_bytes());
    let _ = err.flush();
}

pub fn print_help() {
    emit(concat!(
        "MarpWorkbench CLI —— 把 Marp Markdown 直接导出为 PPTX / PDF / HTML\n",
        "\n",
        "用法:\n",
        "  MarpWorkbench.exe --export <deck.md> [选项]\n",
        "\n",
        "选项:\n",
        "  --format <pptx|pptx-editable|pdf|html>  导出格式（默认 pptx 图片版）\n",
        "  --out <file>                            输出文件路径（默认与输入同目录同名）\n",
        "  --theme <name>                          覆盖 front-matter 的 theme（不改源文件）\n",
        "  --timeout <秒>                          导出超时，默认 180\n",
        "  --keep-deck                             保留导入到工作区的 deck（默认成功后删除）\n",
        "  --help, -h                              显示本帮助\n",
        "  --version, -V                           显示版本号\n",
        "\n",
        "示例:\n",
        "  MarpWorkbench.exe --export demo.md\n",
        "  MarpWorkbench.exe --export demo.md --format pdf --out C:\\out\\demo.pdf\n",
        "  MarpWorkbench.exe --export demo.md --format pptx-editable --theme business-blue\n",
        "\n",
        "说明:\n",
        "  - 无窗口运行（headless Chrome），需要本机安装 Chrome 或 Edge。\n",
        "  - 成功时 stdout 最后一行打印 JSON（ok=true）；失败时退出码 1 且 stderr 给出中文原因。\n",
    ));
}

pub fn print_error_json(message: &str) {
    emit(&format!("{}\n", json!({ "ok": false, "error": message })));
}

pub fn print_error(message: &str) {
    emit_stderr(&format!("错误：{message}\n"));
}

/// 解析 `--export` 参数。返回 Ok(None) 表示不是 CLI 导出模式（保持 GUI 行为）。
pub fn parse_export_args(args: &[String]) -> Result<Option<ExportArgs>, String> {
    if !args.iter().any(|a| a == "--export" || a.starts_with("--export=")) {
        return Ok(None);
    }

    let mut input: Option<PathBuf> = None;
    let mut format = Format::Pptx;
    let mut out: Option<PathBuf> = None;
    let mut theme: Option<String> = None;
    let mut timeout_secs = DEFAULT_TIMEOUT_SECS;
    let mut keep_deck = false;

    let mut i = 1usize;
    while i < args.len() {
        let arg = args[i].clone();
        let (flag, inline_value) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f.to_string(), Some(v.to_string())),
            _ => (arg.clone(), None),
        };

        match flag.as_str() {
            "--export" => {
                input = Some(PathBuf::from(take_value(args, &mut i, "--export", inline_value.as_deref())?))
            }
            "--format" => {
                let raw = take_value(args, &mut i, "--format", inline_value.as_deref())?;
                format = Format::parse(&raw).ok_or_else(|| {
                    format!(
                        "未知导出格式: {raw}（可选 pptx | pptx-editable | pdf | html）"
                    )
                })?;
            }
            "--out" => {
                out = Some(PathBuf::from(take_value(args, &mut i, "--out", inline_value.as_deref())?))
            }
            "--theme" => {
                let raw = take_value(args, &mut i, "--theme", inline_value.as_deref())?
                    .trim()
                    .to_string();
                if raw.is_empty() {
                    return Err("--theme 不能为空".to_string());
                }
                if !raw
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                {
                    return Err(format!(
                        "主题名不合法: {raw}（只允许字母/数字/-/_，与 Marp @theme 一致）"
                    ));
                }
                theme = Some(raw);
            }
            "--timeout" => {
                let raw = take_value(args, &mut i, "--timeout", inline_value.as_deref())?;
                let secs: u64 = raw
                    .parse()
                    .map_err(|_| format!("--timeout 需要整数秒，收到: {raw}"))?;
                if !(10..=1800).contains(&secs) {
                    return Err(format!("--timeout 超出范围（10-1800 秒）: {secs}"));
                }
                timeout_secs = secs;
            }
            "--keep-deck" => keep_deck = true,
            // GUI 参数在 CLI 模式下无害，忽略
            "--no-open" => {}
            "--help" | "-h" | "--version" | "-V" => {}
            other => return Err(format!("未知参数: {other}（--help 查看用法）")),
        }
        i += 1;
    }

    let input = input.ok_or_else(|| "--export 需要指定 Markdown 文件路径".to_string())?;
    Ok(Some(ExportArgs {
        input,
        format,
        out,
        theme,
        timeout_secs,
        keep_deck,
    }))
}

fn take_value(
    args: &[String],
    index: &mut usize,
    flag: &str,
    inline: Option<&str>,
) -> Result<String, String> {
    if let Some(value) = inline {
        if value.is_empty() {
            return Err(format!("'{flag}' 缺少参数值"));
        }
        return Ok(value.to_string());
    }
    match args.get(*index + 1) {
        Some(value) if !value.starts_with("--") => {
            *index += 1;
            Ok(value.clone())
        }
        _ => Err(format!("'{flag}' 缺少参数值")),
    }
}

// ---------------------------------------------------------------------------
// 入口（由 main 在 spawn_blocking 中调用）
// ---------------------------------------------------------------------------

pub fn run_export(state: &AppState, args: ExportArgs) -> Result<ExportReport, String> {
    let started = Instant::now();
    let mut ctx = ExportContext::new(state, args)?;
    let mut result = ctx.execute();
    ctx.cleanup();
    if let Ok(report) = result.as_mut() {
        report.ms = started.elapsed().as_millis() as u64;
    }
    result
}

/// main 在服务关闭后调用：打印结果 JSON 并返回退出码
pub fn finish(result: Result<ExportReport, String>) -> i32 {
    match result {
        Ok(report) => {
            emit(&format!("{}\n", report.to_json_line()));
            0
        }
        Err(message) => {
            emit_stderr(&format!("错误：{message}\n"));
            emit(&format!(
                "{}\n",
                json!({ "ok": false, "error": message })
            ));
            1
        }
    }
}

// ---------------------------------------------------------------------------
// 导出上下文
// ---------------------------------------------------------------------------

struct ExportContext {
    args: ExportArgs,
    api: LocalApi,
    out_path: PathBuf,
    deck_name: String,
    content: String,
    deck_id: Option<String>,
    temp_root: Option<PathBuf>,
    download_dir: Option<PathBuf>,
    chrome: Option<Child>,
    chrome_log: Option<PathBuf>,
    chrome_exe: Option<String>,
}

impl ExportContext {
    fn new(state: &AppState, args: ExportArgs) -> Result<Self, String> {
        // 输入校验 + 读取
        if !args.input.exists() {
            return Err(format!("输入文件不存在: {}", args.input.display()));
        }
        if !args.input.is_file() {
            return Err(format!("输入路径不是文件: {}", args.input.display()));
        }
        let meta = fs::metadata(&args.input)
            .map_err(|err| format!("无法读取输入文件信息: {}（{err}）", args.input.display()))?;
        if meta.len() > MAX_MD_BYTES {
            return Err(format!(
                "输入 Markdown 过大（{}MB，上限 32MB）",
                meta.len() / 1024 / 1024
            ));
        }
        let raw = fs::read(&args.input)
            .map_err(|err| format!("读取 Markdown 失败: {}（{err}）", args.input.display()))?;
        let text = String::from_utf8(raw).map_err(|_| {
            format!(
                "输入文件不是 UTF-8 文本: {}（请另存为 UTF-8）",
                args.input.display()
            )
        })?;
        if text.trim().is_empty() {
            return Err("输入的 Markdown 为空".to_string());
        }
        let content = prepare_content(&text, args.theme.as_deref());

        let out_path = resolve_out_path(&args)?;
        let deck_name = deck_name_for(&args.input);

        let browser_info = browser::detect();
        let chrome_exe = browser_info.chrome.clone().or(browser_info.edge.clone());
        if chrome_exe.is_none() {
            return Err(
                "未找到 Chrome/Edge 浏览器（CLI 导出需要本机安装 Chrome 或 Edge）".to_string(),
            );
        }

        Ok(Self {
            api: LocalApi {
                port: state.port,
                token: state.token.clone(),
            },
            out_path,
            deck_name,
            content,
            deck_id: None,
            temp_root: None,
            download_dir: None,
            chrome: None,
            chrome_log: None,
            chrome_exe: browser_info.chrome.or(browser_info.edge),
            args,
        })
    }

    fn execute(&mut self) -> Result<ExportReport, String> {
        // 1) 创建 deck 并写入 Markdown
        let (status, created) = self.api.json(
            "POST",
            "/api/decks",
            Some(json!({ "name": self.deck_name, "template": "blank" })),
        )?;
        let created = expect_ok(status, created, "创建 deck")?;
        let id = created
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "创建 deck 失败：服务响应缺少 id".to_string())?
            .to_string();
        self.deck_id = Some(id.clone());
        let enc_id = url_seg(&id);

        let (status, put_resp) = self.api.json(
            "PUT",
            &format!("/api/decks/{enc_id}"),
            Some(json!({ "content": self.content })),
        )?;
        expect_ok(status, put_resp, "写入 deck 内容")?;

        // 2) 临时 Chrome profile + 下载目录
        let temp_root = cli_temp_root();
        fs::create_dir_all(&temp_root)
            .map_err(|err| format!("创建临时目录失败: {}（{err}）", temp_root.display()))?;
        self.temp_root = Some(temp_root.clone());
        let download_dir = temp_root.join("downloads");
        let profile_dir = temp_root.join("profile");
        fs::create_dir_all(&download_dir)
            .map_err(|err| format!("创建下载目录失败: {err}"))?;
        let default_profile = profile_dir.join("Default");
        fs::create_dir_all(&default_profile)
            .map_err(|err| format!("创建 Chrome profile 失败: {err}"))?;
        write_chrome_preferences(&default_profile.join("Preferences"), &download_dir)?;
        self.download_dir = Some(download_dir.clone());
        let chrome_log = temp_root.join("chrome.log");
        self.chrome_log = Some(chrome_log.clone());

        // 3) 启动 headless Chrome 打开自动导出页面
        let chrome_exe = self
            .chrome_exe
            .clone()
            .ok_or_else(|| "未找到 Chrome/Edge 浏览器".to_string())?;
        let url = format!(
            "http://127.0.0.1:{}/edit/{}?token={}&autoExport={}",
            self.api.port,
            enc_id,
            url_seg(&self.api.token),
            url_seg(self.args.format.as_str())
        );
        util_log(
            self.temp_root.as_deref(),
            &format!("CLI 启动浏览器: {chrome_exe} 打开 {url}"),
        );

        let log_file = fs::File::create(&chrome_log)
            .map_err(|err| format!("创建 Chrome 日志文件失败: {err}"))?;
        let log_err = log_file
            .try_clone()
            .map_err(|err| format!("创建 Chrome 日志文件失败: {err}"))?;
        let mut command = Command::new(&chrome_exe);
        command
            .arg("--headless=new")
            .arg("--disable-gpu")
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("--disable-extensions")
            .arg("--disable-background-networking")
            .arg("--disable-features=DownloadBubble,DownloadBubbleV2")
            .arg(format!("--user-data-dir={}", profile_dir.display()))
            .arg("--window-size=1680,1050")
            .arg(&url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(log_err));
        let child = command
            .spawn()
            .map_err(|err| format!("启动 Chrome 失败: {err}"))?;
        self.chrome = Some(child);

        // 4) 轮询下载目录
        let deadline = Instant::now() + Duration::from_secs(self.args.timeout_secs);
        let mut last_seen: Option<(PathBuf, u64)> = None;
        let downloaded = loop {
            match find_downloaded(&download_dir, self.args.format.ext()) {
                Ok(Some(path)) => {
                    let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    match &last_seen {
                        Some((last_path, last_size)) if last_path == &path && *last_size == size && size > 0 => {
                            break path;
                        }
                        _ => last_seen = Some((path, size)),
                    }
                }
                Ok(None) => last_seen = None,
                Err(err) => return Err(err),
            }

            if let Some(child) = self.chrome.as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    return Err(format!(
                        "Chrome 提前退出（{}），未产生下载文件。{}",
                        status,
                        self.chrome_log_tail()
                    ));
                }
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "导出超时（{} 秒）：未在下载目录发现 .{} 文件。{}",
                    self.args.timeout_secs,
                    self.args.format.ext(),
                    self.chrome_log_tail()
                ));
            }
            std::thread::sleep(POLL_INTERVAL);
        };

        // 5) 清理 Chrome、移动结果
        self.kill_chrome();
        let bytes = fs::metadata(&downloaded).map(|m| m.len()).unwrap_or(0);
        self.move_output(&downloaded)?;
        let pages = if self.args.format == Format::Pdf {
            fs::read(&self.out_path).ok().and_then(|b| count_pdf_pages(&b))
        } else {
            None
        };

        Ok(ExportReport {
            format: self.args.format,
            file: self.out_path.clone(),
            bytes,
            pages,
            deck_id: self.deck_id.clone().unwrap_or_default(),
            kept_deck: self.args.keep_deck,
            ms: 0,
        })
    }

    fn move_output(&self, downloaded: &Path) -> Result<(), String> {
        if let Some(parent) = self.out_path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)
                    .map_err(|err| format!("创建输出目录失败: {}（{err}）", parent.display()))?;
            }
        }
        if fs::rename(downloaded, &self.out_path).is_ok() {
            return Ok(());
        }
        fs::copy(downloaded, &self.out_path).map_err(|err| {
            format!(
                "保存导出文件失败: {}（{err}）",
                self.out_path.display()
            )
        })?;
        let _ = fs::remove_file(downloaded);
        Ok(())
    }

    fn kill_chrome(&mut self) {
        if let Some(mut child) = self.chrome.take() {
            let pid = child.id().to_string();
            let _ = Command::new("taskkill")
                .args(["/PID", &pid, "/T", "/F"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let _ = child.wait();
        }
    }

    fn chrome_log_tail(&self) -> String {
        let Some(path) = self.chrome_log.as_ref() else {
            return String::new();
        };
        let Ok(text) = fs::read_to_string(path) else {
            return String::new();
        };
        let text = text.trim();
        if text.is_empty() {
            return String::new();
        }
        let tail: String = {
            let mut chars: Vec<char> = text.chars().collect();
            if chars.len() > 600 {
                chars = chars.split_off(chars.len() - 600);
            }
            chars.into_iter().collect()
        };
        format!("\nChrome 日志（末尾）：{}", tail.replace('\n', " | "))
    }

    fn cleanup(&mut self) {
        self.kill_chrome();
        // 默认删除导入的 deck（失败也清理，除非 --keep-deck）
        if let Some(id) = self.deck_id.take() {
            if !self.args.keep_deck {
                let path = format!("/api/decks/{}", url_seg(&id));
                let _ = self.api.request("DELETE", &path, None);
            }
        }
        if let Some(root) = self.temp_root.take() {
            for _ in 0..20 {
                if fs::remove_dir_all(&root).is_ok() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Markdown / 输出路径 / Chrome Preferences
// ---------------------------------------------------------------------------

fn prepare_content(input: &str, theme: Option<&str>) -> String {
    let text = input.strip_prefix('\u{feff}').unwrap_or(input);
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = text.split(newline).map(|s| s.to_string()).collect();

    let fm_start = lines
        .first()
        .map(|l| l.trim() == "---")
        .unwrap_or(false);

    if fm_start {
        let closing = lines
            .iter()
            .enumerate()
            .skip(1)
            .find(|(_, l)| l.trim() == "---")
            .map(|(i, _)| i);
        if let Some(end) = closing {
            let mut has_marp = false;
            let mut theme_idx: Option<usize> = None;
            for (idx, line) in lines.iter().enumerate().take(end).skip(1) {
                let trimmed = line.trim_start();
                if trimmed.starts_with("marp:") {
                    has_marp = true;
                }
                if trimmed.starts_with("theme:") {
                    theme_idx = Some(idx);
                }
            }
            let mut changed = false;
            if let Some(theme_name) = theme {
                let line = format!("theme: {theme_name}");
                match theme_idx {
                    Some(idx) => lines[idx] = line,
                    None => lines.insert(end, line),
                }
                changed = true;
            }
            if !has_marp {
                lines.insert(1, "marp: true".to_string());
                changed = true;
            }
            if !changed {
                return text.to_string();
            }
            return lines.join(newline);
        }
        // front-matter 没有闭合 ---：直接补一个标准头（保守兜底）
    }

    let mut block = vec!["---".to_string(), "marp: true".to_string()];
    if let Some(theme_name) = theme {
        block.push(format!("theme: {theme_name}"));
    }
    block.push("---".to_string());
    block.push(String::new());
    lines.splice(0..0, block);
    lines.join(newline)
}

fn resolve_out_path(args: &ExportArgs) -> Result<PathBuf, String> {
    let default_name = default_out_name(&args.input, args.format);
    match &args.out {
        Some(out) => {
            let is_dir = out.is_dir()
                || out
                    .to_string_lossy()
                    .ends_with('\\')
                || out.to_string_lossy().ends_with('/');
            if is_dir {
                Ok(out.join(default_name))
            } else {
                Ok(out.clone())
            }
        }
        None => Ok(args
            .input
            .parent()
            .map(|p| {
                if p.as_os_str().is_empty() {
                    PathBuf::from(&default_name)
                } else {
                    p.join(&default_name)
                }
            })
            .unwrap_or_else(|| PathBuf::from(&default_name))),
    }
}

fn default_out_name(input: &Path, format: Format) -> String {
    let stem = input
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "演示文稿".to_string());
    format!("{stem}{}.{}", format.out_suffix(), format.ext())
}

fn deck_name_for(input: &Path) -> String {
    input
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "cli-export".to_string())
}

fn write_chrome_preferences(path: &Path, download_dir: &Path) -> Result<(), String> {
    let dir = download_dir.to_string_lossy().to_string();
    let prefs = json!({
        "download": {
            "default_directory": dir,
            "prompt_for_download": false,
            "directory_upgrade": true
        },
        "savefile": {
            "default_directory": download_dir.to_string_lossy().to_string()
        },
        "profile": {
            "default_content_setting_values": {
                "automatic_downloads": 1
            }
        }
    });
    let text = serde_json::to_string_pretty(&prefs)
        .map_err(|err| format!("生成 Chrome Preferences 失败: {err}"))?;
    fs::write(path, text)
        .map_err(|err| format!("写入 Chrome Preferences 失败: {}（{err}）", path.display()))
}

fn cli_temp_root() -> PathBuf {
    let mut rng = rand::random::<u64>();
    if rng == 0 {
        rng = 1;
    }
    std::env::temp_dir()
        .join("MarpWorkbench")
        .join(format!("cli-{}-{rng:016x}", std::process::id()))
}

fn util_log(_root: Option<&Path>, message: &str) {
    #[cfg(debug_assertions)]
    emit_stderr(&format!("[cli] {message}\n"));
    #[cfg(not(debug_assertions))]
    {
        let _ = _root;
        let _ = message;
    }
}

// ---------------------------------------------------------------------------
// 下载轮询 / PDF 页数
// ---------------------------------------------------------------------------

fn find_downloaded(dir: &Path, ext: &str) -> Result<Option<PathBuf>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("读取下载目录失败: {err}")),
    };
    let target = format!(".{}", ext.to_ascii_lowercase());
    let mut candidates: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
        if !is_file {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".crdownload")
            || name.ends_with(".tmp")
            || name.starts_with('.')
        {
            continue;
        }
        if !name.to_ascii_lowercase().ends_with(&target) {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        candidates.push((modified, path));
    }
    candidates.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(candidates.pop().map(|(_, p)| p))
}

fn count_pdf_pages(bytes: &[u8]) -> Option<u64> {
    let needle = b"/Type /Page";
    let mut count = 0u64;
    let mut idx = 0usize;
    while idx + needle.len() <= bytes.len() {
        let Some(pos) = find_bytes(&bytes[idx..], needle) else {
            break;
        };
        let abs = idx + pos + needle.len();
        // "/Type /Pages" 不是页对象，跳过
        if bytes.get(abs) != Some(&b's') {
            count += 1;
        }
        idx = abs;
    }
    if count > 0 {
        Some(count)
    } else {
        None
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

// ---------------------------------------------------------------------------
// 极简本机 HTTP 客户端（std TcpStream，不新增依赖）
// ---------------------------------------------------------------------------

struct LocalApi {
    port: u16,
    token: String,
}

impl LocalApi {
    fn json(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<(u16, Value), String> {
        let body_bytes = match body {
            Some(value) => Some(
                serde_json::to_vec(&value)
                    .map_err(|err| format!("序列化请求 JSON 失败: {err}"))?,
            ),
            None => None,
        };
        let (status, raw) = self.request(method, path, body_bytes.as_deref())?;
        let value: Value = if raw.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&raw).map_err(|err| {
                format!("本地服务响应不是合法 JSON（HTTP {status}）: {err}")
            })?
        };
        Ok((status, value))
    }

    fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
    ) -> Result<(u16, Vec<u8>), String> {
        let addr = SocketAddr::from(([127, 0, 0, 1], self.port));
        let mut stream = TcpStream::connect_timeout(&addr, API_CONNECT_TIMEOUT)
            .map_err(|err| format!("无法连接本地 MarpWorkbench 服务（127.0.0.1:{}）: {err}", self.port))?;
        let _ = stream.set_read_timeout(Some(API_READ_TIMEOUT));
        let _ = stream.set_write_timeout(Some(API_READ_TIMEOUT));

        let mut head = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nX-MWB-Token: {}\r\nAccept: application/json\r\nConnection: close\r\n",
            self.port, self.token
        );
        if let Some(bytes) = body {
            head.push_str(&format!(
                "Content-Type: application/json\r\nContent-Length: {}\r\n",
                bytes.len()
            ));
        }
        head.push_str("\r\n");
        stream
            .write_all(head.as_bytes())
            .map_err(|err| format!("发送本地 HTTP 请求失败: {err}"))?;
        if let Some(bytes) = body {
            stream
                .write_all(bytes)
                .map_err(|err| format!("发送本地 HTTP 请求体失败: {err}"))?;
        }
        let _ = stream.flush();

        let mut raw = Vec::new();
        stream
            .read_to_end(&mut raw)
            .map_err(|err| format!("读取本地 HTTP 响应失败: {err}"))?;
        parse_http_response(&raw)
    }
}

fn expect_ok(status: u16, value: Value, action: &str) -> Result<Value, String> {
    if (200..300).contains(&status) {
        return Ok(value);
    }
    let message = value
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("服务返回错误");
    Err(format!("{action}失败（HTTP {status}）：{message}"))
}

fn parse_http_response(raw: &[u8]) -> Result<(u16, Vec<u8>), String> {
    let header_end = find_bytes(raw, b"\r\n\r\n")
        .ok_or_else(|| "本地 HTTP 响应格式异常（缺少响应头结束）".to_string())?;
    let head = String::from_utf8_lossy(&raw[..header_end]);
    let mut lines = head.split("\r\n");
    let status_line = lines
        .next()
        .ok_or_else(|| "本地 HTTP 响应格式异常（缺少状态行）".to_string())?;
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("本地 HTTP 响应状态行异常: {status_line}"))?;

    let mut content_length: Option<usize> = None;
    let mut chunked = false;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim().to_ascii_lowercase();
            let value = value.trim();
            if name == "content-length" {
                content_length = value.parse().ok();
            } else if name == "transfer-encoding" && value.to_ascii_lowercase().contains("chunked") {
                chunked = true;
            }
        }
    }

    let body = &raw[header_end + 4..];
    if chunked {
        let decoded = decode_chunked(body)
            .ok_or_else(|| "本地 HTTP 响应 chunked 解码失败".to_string())?;
        return Ok((status, decoded));
    }
    if let Some(len) = content_length {
        let body = if body.len() >= len {
            body[..len].to_vec()
        } else {
            body.to_vec()
        };
        return Ok((status, body));
    }
    Ok((status, body.to_vec()))
}

fn decode_chunked(mut data: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line_end = find_bytes(data, b"\r\n")?;
        let size_line = String::from_utf8_lossy(&data[..line_end]);
        let size_hex = size_line.split(';').next()?.trim();
        let size = usize::from_str_radix(size_hex, 16).ok()?;
        data = &data[line_end + 2..];
        if size == 0 {
            return Some(out);
        }
        if data.len() < size {
            return None;
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size..];
        if data.starts_with(b"\r\n") {
            data = &data[2..];
        }
    }
}

fn url_seg(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}
