//! 打印页/截图页 HTML 模板。
//!
//! 规则来自 desktop-packaging 实测（docs/research/desktop-packaging.md §1.3/§1.4）：
//! 1. `@page { size: <W>px <H>px; margin: 0 }` —— 缺了会退化成 Letter 612×792pt + 白边；
//! 2. `print-color-adjust: exact` —— 深色主题/渐变必须打印，否则背景变白；
//! 3. 每页 `break-after: page`、最后一页 `auto` —— 否则多出空白页；
//! 4. marp-core 渲染产物是 `div.marpit > svg[data-marpit-svg]`，每个 svg 必须显式
//!    `display:block; width:Wpx; height:Hpx`，否则打印/截图尺寸不可控；
//! 5. 页面不加载任何外部资源（html/css 全部内联）—— 离线验收要求 0 外网请求。
//!
//! 注意：`spike/export/scripts/print-page.mjs` 是同一套规则的 Node 验证版，两者需保持一致。

pub const DEFAULT_WIDTH: u32 = 1280;
pub const DEFAULT_HEIGHT: u32 = 720;

/// 打印/截图共用 CSS
pub fn page_css(width: u32, height: u32) -> String {
    format!(
        r#"@page {{ size: {width}px {height}px; margin: 0; }}
html, body {{
  margin: 0; padding: 0; background: #ffffff;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}}
div.marpit {{ margin: 0; padding: 0; }}
div.marpit > svg[data-marpit-svg] {{
  display: block;
  width: {width}px;
  height: {height}px;
  margin: 0;
  padding: 0;
}}
@media print {{
  div.marpit > svg[data-marpit-svg] {{
    break-after: page;
    page-break-after: always;
    break-inside: avoid;
    page-break-inside: avoid;
  }}
  div.marpit > svg[data-marpit-svg]:last-child {{
    break-after: auto;
    page-break-after: auto;
  }}
}}"#
    )
}

/// CDP 就绪探测脚本：字体加载完成 + 连续三帧布局 + 120ms 让 auto-scaling 完成后再置位。
/// 截图前 Rust 侧轮询该标志，避免截到字体未就绪/布局未完成的页面。
pub fn ready_script() -> &'static str {
    r#"window.__MWB_READY__ = false;
(function () {
  function markReady() {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { window.__MWB_READY__ = true; });
      });
    });
  }
  var fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
  fontsReady.then(function () { setTimeout(markReady, 120); }).catch(markReady);
})();"#
}

/// marp-core 浏览器扩展包（browser helper，9.3KB 自执行 IIFE）：静态 HTML 默认没有
/// auto-scaling 运行时，内容密集页（长代码块/标题）会被 `overflow:hidden` 直接裁切，
/// 与「预览所见」不一致。前端预览在 iframe 里调用 `browser()`，导出页同样需要它。
///
/// 来源与重新生成方式：`spike/export/scripts/vendor-helper.mjs`
/// （`@marp-team/marp-core/lib/browser.js`，MIT；加载后自动应用到当前文档）。
/// 说明：最初尝试内嵌 3.85MB 的完整 `marp-core.browser.js`，会让每页多 5MB 且 CDP 就绪
/// 时间从 ~0.4s 涨到 ~1.1–4s，故改为只内嵌这份 9.3KB helper。
pub fn browser_helper_script() -> &'static str {
    include_str!("browser_helper.js")
}

/// 生成完整静态 HTML 页面。
///
/// - `ready_marker`：是否注入 `window.__MWB_READY__` 就绪探测（CDP 截图用）
/// - `with_helper`：是否注入 marp browser helper（PDF/截图/HTML 均应 true）
pub fn build_page(
    html: &str,
    css: &str,
    title: &str,
    width: u32,
    height: u32,
    ready_marker: bool,
    with_helper: bool,
) -> String {
    // helper 是普通内联脚本（已确认不含 `</script` / `<!--`），与后面的内联就绪脚本顺序执行
    let helper = if with_helper {
        format!("<script>{}</script>", browser_helper_script())
    } else {
        String::new()
    };
    let script = if ready_marker {
        format!("<script>{}</script>", ready_script())
    } else {
        String::new()
    };
    format!(
        r#"<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width={width}, height={height}, initial-scale=1">
<title>{title}</title>
<link rel="icon" href="data:,">
<style>
{css_common}
{css}
</style>
</head>
<body>
{html}
{helper}
{script}
</body>
</html>"#,
        title = escape_html(title),
        css_common = page_css(width, height),
        css = css
    )
}

/// HTML 转义（title 等插值位置）
pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_css_has_required_rules() {
        let css = page_css(1280, 720);
        assert!(css.contains("@page { size: 1280px 720px; margin: 0; }"));
        assert!(css.contains("print-color-adjust: exact"));
        assert!(css.contains("break-after: page"));
        assert!(css.contains(":last-child"));
    }

    #[test]
    fn build_page_escapes_title_and_inlines_css() {
        let page = build_page("<div class=\"marpit\"></div>", "section{color:red}", "a<b>&\"c", 1280, 720, false, false);
        assert!(page.contains("<title>a&lt;b&gt;&amp;&quot;c</title>"));
        assert!(page.contains("section{color:red}"));
        assert!(!page.contains("__MWB_READY__"));
        let page2 = build_page("<div class=\"marpit\"></div>", "", "t", 1280, 720, true, false);
        assert!(page2.contains("__MWB_READY__"));
    }
}
