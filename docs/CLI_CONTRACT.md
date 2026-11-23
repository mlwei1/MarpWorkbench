# CLI 契约：`MarpWorkbench.exe --export`（AI 生成 md → 直接产出 PPTX）

> 状态：v1（2026-11-23）｜ 用户需求："添加一个CLI，理想中ai看了使用文档，生成md然后用cli就可以直接做成ppt。工程太大就不要做了"
> 目标：**最小可用 CLI**——一条命令把标准 Marp Markdown 变成 `.pptx`（图片版/可编辑版）或 PDF/HTML，无需用户点 UI；AI 只要读 `docs/AI_WRITING_GUIDE.md` 生成 md，再执行 CLI 即可。

---

## 1. 命令

```powershell
MarpWorkbench.exe --export <deck.md> [--format pptx|pptx-editable|pdf|html] [--out <file>] [--theme <name>] [--timeout 180] [--keep-deck]
```

- `--export <file>`：输入 Markdown；必填。
- `--format`：默认 `pptx`（图片版，100% 版式保真）；可选 `pptx-editable`（文字/表格可编辑）、`pdf`、`html`。
- `--out`：输出文件；默认与输入同目录、同名、按格式加扩展名（`pptx-editable` → `<stem>-可编辑.pptx`）。
- `--theme`：可选覆盖 front-matter 的 `theme`（不修改源文件，只在导入时替换/追加）。
- `--timeout`：导出超时秒数，默认 180。
- `--keep-deck`：保留导入到工作区的 deck（默认成功后删除，避免污染）。
- `--help`：打印用法；`--version` 保持现有。

**成功**：stdout 最后一行打印 JSON，例如
```json
{"ok":true,"format":"pptx-editable","file":"C:\\out\\demo.pptx","bytes":123456,"pages":13,"ms":12000}
```
**失败**：stderr 可读中文错误，stdout JSON `{"ok":false,"error":"..."}`，退出码 1。
不打开浏览器窗口（headless Chrome）。

---

## 2. 实现架构（最小方案，不新增依赖）

```
MarpWorkbench.exe --export deck.md --format pptx-editable --out out.pptx
  │
  ├─ 解析参数、读取 md（UTF-8）
  ├─ 启动本地服务（现有 axum，随机端口 + token；不打开浏览器）
  ├─ HTTP（127.0.0.1）：POST /api/decks 创建 deck → PUT /api/decks/:id 写入 md（必要时改 theme）
  ├─ 创建临时 Chrome profile + Preferences：
  │     download.default_directory = <临时下载目录>
  │     download.prompt_for_download = false
  │  启动 Chrome：
  │     chrome.exe --headless=new --disable-gpu --no-first-run --no-default-browser-check
  │       --user-data-dir=<profile> --window-size=1680,1050
  │       "http://127.0.0.1:<port>/edit/<id>?token=<token>&autoExport=<format>"
  ├─ 前端（见 §3）检测 autoExport → 自动执行现有导出 → 现有 saveBlob 下载文件
  ├─ CLI 轮询临时下载目录，出现目标扩展名文件（取最新）→ 移到 --out
  ├─ 杀掉 Chrome 进程树（taskkill /PID <pid> /T /F）、清理 profile/下载目录
  ├─ 关闭本地服务；默认 DELETE /api/decks/:id（除非 --keep-deck）
  └─ 打印 JSON、退出 0/1
```

**为什么这样最小**：复用现有前端导出（PPTX 图片版/可编辑、PDF、HTML 全部已实现），不重写任何导出逻辑；服务端只需现有 decks API，**无需新接口**；Chrome 下载目录通过 profile Preferences 预设（已实测可行）。

### 2.1 Rust CLI（owner: desktop-packaging）

- `server/src/main.rs`：解析 `--export`；若存在：
  1. 与正常模式一样初始化 data_dir、监听、token、AppState、router；
  2. `tokio::spawn(axum::serve(...).with_graceful_shutdown(...))` 供 CLI 调用；
  3. 调用新模块 `server/src/cli.rs::run_export(args, &app_state)`；
  4. 完成后 `shutdown_tx.send(true)`，等待 server task，按结果退出。
- 新增 `server/src/cli.rs`（或拆分）：
  - 参数解析：`--export/--format/--out/--theme/--timeout/--keep-deck/--help`；未知参数报错。
  - 极简 HTTP 客户端（仅 127.0.0.1）：用 `std::net::TcpStream` 手写 HTTP/1.1，支持 GET/POST/PUT/DELETE + JSON body + `X-MWB-Token`；读取响应按 `Content-Length`/chunked（只需本地 axum，正常为 Content-Length）。不要新增 crate。
  - 创建 deck：`POST /api/decks {name: <stem>, template:"blank"}` → `id`；`PUT /api/decks/:id {content: md}`（若 `--theme`：只替换/追加 front-matter `theme:`，不写源文件）。
  - Chrome 探测：复用 `browser::detect()`；无 Chrome/Edge → 可读错误。
  - Chrome 启动：`std::process::Command`，profile/下载目录放 `%TEMP%\MarpWorkbench\cli-<rand>`；写 `Default/Preferences`（JSON）设置下载目录；启动后轮询下载目录（每 200ms）直到出现 `.{pptx,pdf,html}` 文件（按 format 定扩展名），超过 timeout 失败。
  - 杀掉 Chrome：Windows `taskkill /PID <pid> /T /F`；清理临时目录；关闭服务；默认删除 deck。
  - 输出 JSON 一行（`serde_json` 已有）；退出码。
- `--help` 输出中文用法（同时兼容 `-h`）。
- 保持 `--version`、`--no-open`、默认 GUI 行为不变。

### 2.2 前端自动导出（owner: marp-tech/frontend）

1. `web/src/main.ts`：在 `history.replaceState` 清 query 前，读取并保存：
   - `autoExport`（格式字符串）→ `sessionStorage['mwb.autoExport']`
   - 若存在则保留（不要清掉）；页面加载完成后由 EditView 消费并清除。
2. `web/src/views/EditView.vue`：
   - 读 `sessionStorage['mwb.autoExport']`（值在 `pptx|pptx-editable|pdf|html` 内才生效），设置 `autoExportFormat`。
   - deck 加载完成后（`deck` 有值、`renderer` 可渲染）自动打开导出面板 `exportOpen = true`，并把 `auto-export-format` 传给 ExportPanel。
   - 消费后清除 sessionStorage；普通用户不带参数时行为完全不变。
3. `web/src/export/ExportPanel.vue`：
   - 新增 prop `autoExportFormat?: Format`。
   - `onMounted` 若存在：设置 `format`；等待 `slideCount > 0`（watch 或轮询），只触发一次 `startExport()`；避免重复/竞态。
   - 下载仍走现有 `saveBlob`（a[download]）；不新增服务端接口。
   - 自动导出期间禁用关闭/重复导出即可；导出完成显示结果（CLI 会杀进程）。
4. 测试选择器/行为不破坏现有 e2e；普通手动导出完全不变。

---

## 3. 验收

### 3.1 Lead 自动化（`scripts/verify-cli.mjs`，真实 exe）

1. `MarpWorkbench.exe --help` 输出包含 `--export` / `--format`；退出 0。
2. `--version` 仍输出 `MarpWorkbench 0.4.0`。
3. `--export scripts/fixtures/cli-demo.md --format pptx-editable --out <tmp>\cli-editable.pptx`：
   - 退出码 0；stdout JSON ok=true；文件存在且 > 100KB；
   - python-pptx 校验：页数、13.333×7.5in、文本/表格/备注；
4. `--format pptx`（图片版）：文件可被 python-pptx 打开，页数正确；
5. `--format pdf`：文件头 `%PDF`，页数 > 0；
6. `--format html`：文件包含 `data-marpit-svg` / `<html`；
7. 失败路径：不存在的输入文件 → 退出 1 + 可读错误；超时/格式非法 → 可读错误；
8. 无残留：CLI 退出后无 `chrome.exe` headless 子进程（可检查 CLI 启动的 PID 已退出）。
- 测试数据：`scripts/fixtures/cli-demo.md`（中文标题/列表/表格/Mermaid/备注，10 页左右）。

### 3.2 文档

- 新增 `docs/CLI.md`：用法、示例、AI 工作流、退出码、限制。
- `README.md` / `README.en.md`：加「CLI」章节（用法 + AI 流程）。
- `docs/AI_WRITING_GUIDE.md`：末尾加「用 CLI 直接生成 PPT」3 行示例。
- `docs/M5_PLAN.md`：把「阶段 B CLI」标记为已实现（HTTP/MCP 仍待）。

### 3.3 版本 / 发布

- 版本 **0.4.0**；构建 exe；发布 GitHub Release v0.4.0（exe/zip/SHA）+ 推送 Gitee。
- README 下载链接改为 v0.4.0。

---

## 4. 写范围

| 路径 | owner |
|---|---|
| `server/src/main.rs`（最小改动）、`server/src/cli.rs`、`server/src/...`（如需） | desktop-packaging |
| `web/src/main.ts`、`web/src/views/EditView.vue`、`web/src/export/ExportPanel.vue`、相关文档 | marp-tech |
| `scripts/verify-cli.mjs`、`scripts/fixtures/cli-demo.md`、`docs/CLI.md`、README/计划/验收 | Lead |
| `docs/CLI_CONTRACT.md` | Lead |

不新增 Cargo/npm 依赖；不改其他功能；不执行 git commit。
