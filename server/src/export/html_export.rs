//! 单文件 HTML 导出：主题 CSS + 渲染结果内联，双击即播（离线、0 外网请求）。
//!
//! 与打印页的区别：额外内联一个极简键盘翻页脚本（←/→/空格/Home/End/F），
//! 屏幕上是"逐页演示"，打印时自动退化为逐页分页（沿用 @media print 规则）。

use std::{
    path::Path,
    time::Instant,
};

use super::{
    print_page::{browser_helper_script, escape_html, page_css},
    util as xutil, ExpError, RenderPayload,
};

pub struct HtmlResult {
    pub file_name: String,
    pub bytes: u64,
    pub ms: u64,
}

const VIEWER_CSS: &str = r#"
html, body { background: #111318; overflow: hidden; }
body.viewer div.marpit { position: fixed; inset: 0; }
body.viewer div.marpit > svg[data-marpit-svg] {
  position: absolute !important;
  left: 50% !important;
  top: 50% !important;
  visibility: hidden;
  transform: translate(-50%, -50%);
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.55);
}
body.viewer div.marpit > svg[data-marpit-svg].mwb-active { visibility: visible; }
.mwb-bar {
  position: fixed; left: 0; right: 0; bottom: 0; height: 40px;
  display: flex; align-items: center; justify-content: center; gap: 16px;
  color: #cbd5e1; font: 14px/1.4 "Microsoft YaHei", "Segoe UI", sans-serif;
  background: linear-gradient(to top, rgba(0,0,0,.55), rgba(0,0,0,0));
  opacity: 0; transition: opacity .2s; pointer-events: none;
}
body:hover .mwb-bar { opacity: 1; }
@media print {
  html, body { background: #fff; overflow: visible; }
  body.viewer div.marpit { position: static; }
  body.viewer div.marpit > svg[data-marpit-svg] {
    position: static !important;
    visibility: visible !important;
    transform: none !important;
    box-shadow: none !important;
    left: auto !important; top: auto !important;
  }
  .mwb-bar { display: none !important; }
}
"#;

const VIEWER_JS: &str = r#"(function () {
  var slides = Array.prototype.slice.call(document.querySelectorAll('div.marpit > svg[data-marpit-svg]'));
  if (!slides.length) return;
  var index = 0;
  var bar = document.createElement('div');
  bar.className = 'mwb-bar';
  document.body.appendChild(bar);
  function fit() {
    var w = window.innerWidth, h = window.innerHeight;
    var scale = Math.min(w / 1280, (h - 0) / 720);
    if (document.body.classList.contains('print')) scale = 1;
    slides.forEach(function (s) {
      s.style.transform = 'translate(-50%, -50%) scale(' + scale + ')';
    });
  }
  function show(i) {
    index = Math.max(0, Math.min(slides.length - 1, i));
    slides.forEach(function (s, k) { s.classList.toggle('mwb-active', k === index); });
    bar.textContent = (index + 1) + ' / ' + slides.length + '　←/→ 翻页　F 全屏　Ctrl+P 打印/PDF';
  }
  window.addEventListener('resize', fit);
  document.addEventListener('keydown', function (e) {
    var k = e.key;
    if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || k === ' ') { e.preventDefault(); show(index + 1); }
    else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp') { e.preventDefault(); show(index - 1); }
    else if (k === 'Home') { e.preventDefault(); show(0); }
    else if (k === 'End') { e.preventDefault(); show(slides.length - 1); }
    else if (k === 'f' || k === 'F') {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(function () {});
    }
  });
  document.addEventListener('click', function (e) {
    if (e.target === document.body || e.target === document.documentElement) show(index + 1);
  });
  show(0); fit();
  window.__MWB_VIEWER_READY__ = true;
})();"#;

pub async fn export_html(
    exports_dir: &Path,
    payload: &RenderPayload,
) -> Result<HtmlResult, ExpError> {
    let t0 = Instant::now();
    payload.validate(32 * 1024 * 1024)?;
    let width = payload.width();
    let height = payload.height();
    let title = payload.title.as_deref().unwrap_or("MarpWorkbench 演示");
    // marp browser helper（9.3KB）：注册 auto-scaling 自定义元素，保证离屏打开时与预览一致
    let helper = browser_helper_script();
    let page = format!(
        r#"<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<link rel="icon" href="data:,">
<style>
{css_common}
{css}
{viewer_css}
</style>
</head>
<body class="viewer">
{html}
<div class="mwb-bar"></div>
{helper}
<script>{viewer_js}</script>
</body>
</html>"#,
        title = escape_html(title),
        css_common = page_css(width, height),
        css = payload.css,
        viewer_css = VIEWER_CSS,
        html = payload.html,
        helper = helper,
        viewer_js = VIEWER_JS,
    );

    tokio::fs::create_dir_all(exports_dir).await?;
    let stem = xutil::safe_stem(payload.title.as_deref(), "演示文稿");
    let file_name = xutil::unique_file_name(exports_dir, &stem, "html");
    let path = exports_dir.join(&file_name);
    tokio::fs::write(&path, page.as_bytes()).await.map_err(|e| {
        ExpError::fail("写入 HTML 文件失败").with_detail(e.to_string())
    })?;
    let bytes = page.len() as u64;
    Ok(HtmlResult {
        file_name,
        bytes,
        ms: t0.elapsed().as_millis() as u64,
    })
}
