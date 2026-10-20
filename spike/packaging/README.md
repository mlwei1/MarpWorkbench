# spike/packaging — 桌面封装/导出通道实测（非产品代码）

服务于 `docs/research/desktop-packaging.md` 的实测证据。所有内容均为调研 spike，不是正式产品代码。

## 目录

| 路径 | 说明 |
|---|---|
| `rust-server/` | **推荐运行时实测**：Rust 1.95 + axum 0.8 + tokio 1 + rust-embed 8，单文件 HTTP 服务 demo。`cargo build --release` 后 `target/release/marp-lite-server.exe` 实测 **0.50 MB**；启动后 `127.0.0.1:0` 动态端口 + 打开默认浏览器；`assets/index.html` 编译期内嵌 |
| `slides/deck.html` | 3 页测试 deck（中文/深色背景/渐变/代码样式/`@page { size: 1280px 720px; margin: 0 }`） |
| `slides/deck-100.html` | 100 页 deck（由 `browser-print/gen-deck-100.mjs` 生成），用于导出性能实测 |
| `slides/deck-no-page-css.html` | 对照：去掉 `@page` 规则（验证其必要性） |
| `browser-print/serve.mjs` | 本地静态 HTTP 服务（模拟便携 exe 内置服务） |
| `browser-print/run-matrix.ps1` | 一键矩阵：Edge/Chrome headless 打印本地 HTTP 页面 + 对照 + 100 页，输出 `out/edge-export-report.json` |
| `browser-print/verify.mjs` | PDF 校验：页数 / 精确页面尺寸 / 文本与中文提取 / 页眉页脚（`--strict` 做断言） |
| `browser-print/verify-paint.mjs` | PDF 操作符级校验：整页背景填充、渐变、文本包围盒（无白边/无裁切证据） |
| `browser-print/gen-deck-100.mjs` | 生成 100 页 deck |
| `out/` | 实测 PDF 产物 + `verify-*.json` 报告（已 gitignore） |
| `src/main.js`、`scripts/verify-pdf.mjs` | **对照组**（Electron 44 `webContents.printToPDF` 最小 demo，未实际运行二进制；仅作 API 依据） |

## 快速复现

```powershell
# Rust 单文件体积
cd rust-server
cargo build --release
Get-Item target/release/marp-lite-server.exe | Select-Object Length   # ≈ 0.50 MB
.\target\release\marp-lite-server.exe --no-open --port 17321          # 打开 http://127.0.0.1:17321/

# 浏览器 headless 导出 PDF（主通道）
cd ..
node browser-print/serve.mjs    # 另开终端：127.0.0.1:18765
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless --disable-gpu --no-first-run `
  --no-default-browser-check --user-data-dir="$env:TEMP\marp-export-profile" `
  --no-pdf-header-footer --virtual-time-budget=4000 `
  --print-to-pdf="$PWD\out\deck.pdf" "http://127.0.0.1:18765/deck.html"
node browser-print/verify.mjs out/deck.pdf --strict
node browser-print/verify-paint.mjs out/deck.pdf
```

## 实测摘要（2026-10-20，Windows）

- Chrome 155：3 页 deck → 3 页 960×540pt PDF，106.7KB，4.13s；100 页 → 100 页全部 960×540pt，384.3KB，8.34s。
- Edge 155：同样 PDF 质量（109224B），但打印完成后进程不退出 → 需检测 PDF 落盘后 kill（或用 CDP `Page.printToPDF`）。
- 对照：无 `@page` → 页面退化为 Letter 612×792pt，内容缩小并出现白边 → `@page { size: 1280px 720px; margin: 0 }` 必需。
- 文本/中文可提取；背景（#0b1020 整页填充）与渐变（setFillColorN）确实打印；文本坐标与 CSS 布局 1:1（88px padding = 66pt），无裁切。
- headless 截图（PPTX 图片版备选）：`--screenshot --window-size=2560,1440` 单进程 2.0–2.9s/次，不适合逐页起进程。
