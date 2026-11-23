# M5.1 验收报告 —— CLI `--export`（AI 生成 md → 直接产出 PPT）

> 日期：2026-11-23 ｜ 状态：**通过（Lead 验收）** ｜ 契约：`docs/CLI_CONTRACT.md`
> 用户需求："添加一个CLI，理想中ai看了使用文档，生成md然后用cli就可以直接做成ppt。工程太大就不要做了"

---

## 1. 交付内容

| 类别 | 内容 |
|---|---|
| Rust CLI | `server/src/cli.rs`（新）：参数解析、本机 HTTP（std TcpStream）、建 deck/写 md、headless Chrome（profile Preferences 预设下载目录）、轮询下载、移动输出、taskkill/清理、JSON/退出码 |
| 服务改造 | `server/src/main.rs`：检测 `--export` → 不打开浏览器、不写单实例握手、spawn axum → 执行 CLI → shutdown → 按结果退出；GUI 行为不变 |
| 前端自动导出 | `web/src/main.ts` 读取 `?autoExport=`；`EditView.vue` 自动打开导出面板；`ExportPanel.vue` `autoExportFormat` prop + 只触发一次；仍走现有 `saveBlob` 下载 |
| 文档 | `docs/CLI_CONTRACT.md`、`docs/CLI.md`、`docs/dev/server.md` §10、`docs/dev/frontend.md` §14、README 中英文、AI 写作指南 |
| 验收 | `scripts/verify-cli.mjs`（20 项）、`scripts/fixtures/cli-demo.md`（10 页） |

## 2. 验收结果（真实 exe 12.49MB + Chrome 157）

| 验收项 | 结果 |
|---|---|
| `--help` / `--version` | ✅ 0.4.0 |
| `--export ... --format pptx-editable` | ✅ 退出 0；10 页 / 1.65MB / 13.333×7.5in；python-pptx：1 表格、备注、10/10 页背景 |
| `--format pptx`（图片版） | ✅ 退出 0；10 页 / 2.11MB |
| `--format pdf` | ✅ 退出 0；`%PDF`、10 页 / 229KB |
| `--format html` | ✅ 退出 0；单文件 89KB、10 张幻灯片 |
| 完整测试 `node scripts/verify-cli.mjs` | **20/20 ✅** |
| 非法输入 | ✅ 退出 1 + 中文错误 + JSON ok:false |
| 无残留 | ✅ 无 headless Chrome/临时目录/服务进程 |
| 全量回归 | M1 13/13、M2 26/26、M3 21/21、M3.1 14/14、M4 23/23、M5 17/17、API 冒烟 12/12 全绿 |
| 前端 autoExport 自测 | 无点击自动下载可编辑 PPTX；普通访问不自动导出；非法值忽略 |

**实测耗时/体积（10 页示例）**：可编辑 ~23s/1.69MB；图片版 ~18s/2.11MB；PDF ~7s/234KB；HTML ~15s/89KB。

## 3. 使用

```powershell
MarpWorkbench.exe --export .\deck.md --format pptx-editable --out .\deck.pptx
```

详见 `docs/CLI.md`。AI 工作流：`AI_WRITING_GUIDE.md` → AI 生成 md → CLI 一条命令 → `.pptx`。

## 4. 已知限制

- 依赖本机 Chrome/Edge；无浏览器会返回可读错误。
- 首次导出含 Chrome 启动，10–35s 属正常；可用 `--timeout` 调大。
- `pptx-editable` 仍为"文字/表格可编辑 + 背景底图"（与 GUI 一致）。
- 默认删除导入 deck（保留用 `--keep-deck`）；`--theme` 只改导入副本。
- 未实现 HTTP API / MCP（后续计划见 `docs/M5_PLAN.md`）。

## 5. 复现

```powershell
pnpm run build
pnpm run verify:cli
```
