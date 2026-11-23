# CLI 使用说明：`MarpWorkbench.exe --export`

> 一条命令把标准 Marp Markdown 变成 **PPTX（图片版/可编辑版）/ PDF / HTML**，不打开 GUI、不需要点击。
> 典型用途：AI 按 `docs/AI_WRITING_GUIDE.md` 生成 `deck.md` → CLI 直接产出 `.pptx`。

---

## 快速开始

```powershell
# 1) 可编辑 PPTX（文字/表格可在 PowerPoint 修改，背景为高清底图）
MarpWorkbench.exe --export .\deck.md --format pptx-editable --out .\deck.pptx

# 2) 图片版 PPTX（版式 100% 保真，整页不可编辑）
MarpWorkbench.exe --export .\deck.md --format pptx --out .\deck-image.pptx

# 3) PDF（矢量、可复制文字）
MarpWorkbench.exe --export .\deck.md --format pdf --out .\deck.pdf

# 4) 单文件 HTML（离线可播）
MarpWorkbench.exe --export .\deck.md --format html --out .\deck.html
```

> 需要本机有 Chrome 或 Edge（导出用）。CLI 会启动 headless Chrome，完成后自动关闭；不弹窗口。
> 想先看效果但不导出：直接双击 exe 进 GUI 即可（行为不变）。

---

## 参数

```text
MarpWorkbench.exe --export <deck.md> [选项]

--format <pptx|pptx-editable|pdf|html>   默认 pptx（图片版）
--out <file>                             输出路径；默认与输入同目录、按格式命名
--theme <name>                           覆盖 front-matter 的 theme（只改导入副本，不改源文件）
--timeout <秒>                           导出超时，默认 180
--keep-deck                              保留导入到工作区的 deck（默认成功后删除）
--help / -h                              显示帮助
--version                                显示版本
```

- `--out` 省略时：
  - `pptx` → `<stem>.pptx`
  - `pptx-editable` → `<stem>-可编辑.pptx`
  - `pdf` → `<stem>.pdf`
  - `html` → `<stem>.html`
- 退出码：`0` 成功；`1` 失败（文件不存在、格式非法、超时、Chrome 不可用等）。

成功时 stdout 最后一行是 JSON（便于 AI/脚本解析）：

```json
{"ok":true,"format":"pptx-editable","file":"C:\\out\\deck.pptx","bytes":1691804,"ms":22924,"deckId":"cli-demo","keptDeck":false,"pages":null}
```

失败时 JSON `{"ok":false,"error":"..."}`，同时 stderr 有中文错误。

---

## AI 工作流（推荐的"AI 直接做 PPT"方式）

1. 把 [AI_WRITING_GUIDE.md](AI_WRITING_GUIDE.md) 和 [AI_PROMPT.md](AI_PROMPT.md) 给 AI（ChatGPT / Claude / DeepSeek / Cursor）。
2. AI 输出 `.md`（标准 Marp Markdown）。
3. 保存为 `deck.md`，执行：

```powershell
MarpWorkbench.exe --export .\deck.md --format pptx-editable --out .\deck.pptx
```

4. 打开 `deck.pptx` 检查/微调；也可以先 `--format pdf` 快速预览。

AI 侧可调用命令（给 Agent 的提示词可加）：

```text
生成 md 后，执行：
MarpWorkbench.exe --export <md路径> --format pptx-editable --out <输出路径>
并解析 stdout 最后一行的 JSON，若 ok=false 把 error 反馈给用户。
```

---

## 实测（本机 Windows 11 + Chrome 157，10 页示例 deck）

| 格式 | 耗时 | 体积 | 校验 |
|---|---|---|---|
| `pptx-editable` | ~23s | 1.69 MB | python-pptx：10 页、13.333×7.5in、1 表格、备注；10/10 页背景 |
| `pptx`（图片版） | ~18s | 2.11 MB | 10 页、13.333×7.5in |
| `pdf` | ~7s | 234 KB | 10 页、960×540pt |
| `html` | ~15s | 89 KB | 单文件，含 10 张幻灯片 |

> 首次导出含 Chrome 启动，10–35s 属正常；页面复杂/图片多会更慢。超时用 `--timeout` 调大。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| `未找到 Chrome 或 Edge` | 安装 Chrome 或 Edge（Win10/11 自带 Edge） |
| 超时 | 增大 `--timeout 300`；确认没有安全软件拦截 headless Chrome |
| 输出文件被占用/无法写入 | 关闭已打开的同名文件；换 `--out` 路径 |
| 想保留导入的 deck | 加 `--keep-deck`；否则默认删除（移到工作区 `.trash`） |
| 主题不生效 | 确认 `theme` 名称在 [AI_WRITING_GUIDE.md](AI_WRITING_GUIDE.md) 主题列表内，或 `--theme` 指定 |
| 中文/字体异常 | PPTX 的可编辑文本字体取决于目标机；PDF 已嵌入字体/矢量 |

## 安全 / 隐私

- CLI 只监听 `127.0.0.1`，token 随机；不联网（除你 md 中的远程图片）。
- 不修改源 `.md`；`--theme` 只改导入副本。
- 临时 Chrome profile/下载目录在 `%TEMP%`，退出时清理；默认删除导入 deck。

---

## 相关文档

- [AI_WRITING_GUIDE.md](AI_WRITING_GUIDE.md) · [AI_PROMPT.md](AI_PROMPT.md) — 让 AI 写出可导入的 md
- [M5_1_ACCEPTANCE.md](M5_1_ACCEPTANCE.md) — CLI 验收数据
- [CLI_CONTRACT.md](CLI_CONTRACT.md) — 实现契约
- [M5_PLAN.md](M5_PLAN.md) — 后续 HTTP API / MCP 计划
