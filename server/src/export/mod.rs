//! 导出管线（export-eng）：打印页生成、无头浏览器 PDF、CDP 原生截图、单文件 HTML。
//!
//! 挂载方式：`server/src/routes/export.rs` 通过 `#[path = "../export/mod.rs"] mod imp;`
//! 引入本模块 —— 这样不必改动 `server/src/main.rs`（server-core 写范围）。
//! 子模块声明均用显式 `#[path]`，避免模块路径解析歧义。
//!
//! 设计依据：docs/API_CONTRACT.md §1.6/§1.7、docs/research/desktop-packaging.md §1.4、
//! docs/research/marp-tech.md §4.1（PPTX=逐页位图 + pptxgenjs）；实测数据见 docs/dev/export.md。

#[path = "capture.rs"]
pub mod capture;
#[path = "cdp.rs"]
pub mod cdp;
#[path = "html_export.rs"]
pub mod html_export;
#[path = "pdf.rs"]
pub mod pdf;
#[path = "print_page.rs"]
pub mod print_page;
#[path = "util.rs"]
pub mod util;

use serde::Deserialize;

/// 前端 marp-core 渲染结果（契约 §1.6）：`{html, css, title?, width?, height?, comments?}`
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPayload {
    pub html: String,
    #[serde(default)]
    pub css: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    /// 备注按页提取：PDF 通道暂不写入（M2 可做 PDF notes）；PPTX 由前端使用
    #[allow(dead_code)]
    #[serde(default)]
    pub comments: Vec<String>,
}

/// 截图请求（契约 §1.6）：在 RenderPayload 基础上增加截图参数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturePayload {
    pub html: String,
    #[serde(default)]
    pub css: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub scale: Option<u32>,
    /// 期望页数（仅用于校验/日志；实际以页面内 slide 数为主）
    #[serde(default)]
    pub slide_count: Option<usize>,
    /// `png`（默认，无损）| `jpeg`（PPTX 默认通道：快、体积小）
    #[serde(default)]
    pub format: Option<String>,
}

impl CapturePayload {
    pub fn scale(&self) -> u32 {
        match self.scale.unwrap_or(2) {
            1 => 1,
            _ => 2,
        }
    }
    pub fn format(&self) -> cdp::CaptureFormat {
        match self.format.as_deref() {
            Some("jpeg") | Some("jpg") => cdp::CaptureFormat::Jpeg(90),
            _ => cdp::CaptureFormat::Png,
        }
    }
}

impl RenderPayload {
    pub fn width(&self) -> u32 {
        clamp_dimension(self.width, print_page::DEFAULT_WIDTH)
    }
    pub fn height(&self) -> u32 {
        clamp_dimension(self.height, print_page::DEFAULT_HEIGHT)
    }
    /// 请求体体积/内容校验（防止把导出接口当大文件上传口）
    pub fn validate(&self, max_bytes: usize) -> Result<(), ExpError> {
        let total = self.html.len() + self.css.len();
        if self.html.trim().is_empty() {
            return Err(ExpError::bad("导出内容为空：前端没有渲染出 HTML"));
        }
        if total > max_bytes {
            return Err(ExpError::bad(format!(
                "导出内容过大（{} MB > {} MB）",
                total / (1024 * 1024),
                max_bytes / (1024 * 1024)
            )));
        }
        Ok(())
    }
}

impl CapturePayload {
    pub fn render(&self) -> RenderPayload {
        RenderPayload {
            html: self.html.clone(),
            css: self.css.clone(),
            title: self.title.clone(),
            width: self.width,
            height: self.height,
            comments: Vec::new(),
        }
    }
}

fn clamp_dimension(value: Option<u32>, default: u32) -> u32 {
    match value {
        Some(v) if (320..=7680).contains(&v) => v,
        _ => default,
    }
}

/// 导出错误（路由层映射为契约错误 `EXPORT_FAILED` / `BAD_REQUEST`）
#[derive(Debug, Clone)]
pub struct ExpError {
    /// 面向用户的中文可读说明
    pub message: String,
    /// 便于排查的细节（浏览器路径/退出码/超时等）
    pub detail: Option<String>,
    /// 是否属于请求参数问题（true → HTTP 400）
    pub bad_request: bool,
}

impl ExpError {
    pub fn fail(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            detail: None,
            bad_request: false,
        }
    }
    pub fn bad(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            detail: None,
            bad_request: true,
        }
    }
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

impl std::fmt::Display for ExpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)?;
        if let Some(detail) = &self.detail {
            write!(f, "（{detail}）")?;
        }
        Ok(())
    }
}

impl From<std::io::Error> for ExpError {
    fn from(err: std::io::Error) -> Self {
        ExpError::fail("导出时文件读写失败").with_detail(err.to_string())
    }
}
