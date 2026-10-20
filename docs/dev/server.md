# MarpWorkbench 服务端（server-core）开发文档

> 归属：task-4 / server-core（desktop-packaging）｜ 状态：M1 骨架完成，构建+冒烟全绿（server-core 42/42、Lead 集成 12/12）
> **release exe = 7.12 MB**（内嵌 `web/dist` 4.65MB：marp-core 浏览器包 3.76MB + KaTeX 字体 + Vite 产物；内嵌 6 套主题 CSS；
> 含 export-eng 导出模块与 tungstenite/base64 依赖）
> 接口唯一依据：`docs/API_CONTRACT.md` v1；产品计划：`docs/PROJECT_PLAN.md` v1.1 §3
> 最后更新：2026-10-20

## 1. 技术栈与目录

- Rust 2021，`axum 0.8` + `tokio 1` + `rust-embed 8` + `serde` + `sha2` + `chrono` + `rand`
  + `tower-http`（br/gzip 响应压缩）+ `percent-encoding`。
- release profile：`opt-level="z"`、`lto=true`、`codegen-units=1`、`strip=true`、`panic="abort"`；
  release 下 `#![windows_subsystem = "windows"]`（无控制台窗口）。

```
server/
├─ Cargo.toml
├─ build.rs                    # 构建期探测 web/dist、themes/ 是否存在 → 决定 rust-embed 内容
├─ src/
│  ├─ main.rs                  # 单实例锁 / 监听 / token / 自动开浏览器 / 优雅退出
│  ├─ state.rs                 # AppState（数据目录、端口、token、shutdown 通道、浏览器信息）
│  ├─ error.rs                 # 统一错误 JSON（契约 §0.3）
│  ├─ util.rs                  # 路径校验、rev(sha256 16)、原子写、中文文件名、日志、单实例探测
│  ├─ assets.rs                # 静态资源（内嵌/开发期磁盘）与内置主题读取
│  ├─ browser.rs               # Chrome/Edge 探测（标准路径 + App Paths 注册表）
│  └─ routes/
│     ├─ mod.rs                # 路由组装 + 鉴权/同源中间件 + SPA fallback + 压缩
│     ├─ lifecycle.rs          # §1.1 health / shutdown / browser
│     ├─ settings.rs           # §1.2 settings
│     ├─ decks.rs              # §1.3 workspace/decks CRUD/recent + §1.4 assets
│     ├─ themes.rs             # §1.5 themes
│     └─ export.rs             # 导出路由 **stub（501）**，由 export-eng 接管实现
├─ assets/placeholder/         # web/dist 未构建时的占位首页（保证骨架可编译可运行）
├─ assets/empty/               # themes/ 未存在时的 rust-embed 占位目录
└─ scripts/smoke.ps1           # PowerShell 冒烟测试（42 项断言，UTF-8 BOM）
```

## 2. 构建与运行

```powershell
# 前端产物（frontend-core 负责；缺失时服务端仍可编译、返回占位页）
pnpm --dir web build

# 内核主题（themes 组负责；缺失时 themes 列表为空）
# themes/*.css

# 构建（后端 debug 快速验证 / release 出单文件）
cargo build            --manifest-path server/Cargo.toml
cargo build --release  --manifest-path server/Cargo.toml
# 产物：server\target\release\MarpWorkbench.exe

# 运行（release 双击等价；开发期建议 --no-open + 固定端口 + 隔离数据目录）
server\target\release\MarpWorkbench.exe
server\target\debug\MarpWorkbench.exe --no-open
server\target\release\MarpWorkbench.exe --version    # 打印版本后退出 0
```

**启动握手输出（契约 §0.2，供 `scripts/smoke.mjs`/CI 读取）**：服务监听成功后向 stdout 打印两行：

```
MWB_LISTEN_URL=http://127.0.0.1:<port>
MWB_TOKEN=<64 hex token>
```

无 stdout 句柄（release 双击、`windows_subsystem=windows`）时安全忽略、不 panic；需要读取时用
`node scripts/smoke.mjs` / 启动时重定向 stdout 即可。

**内嵌规则（build.rs）**：构建时若 `../web/dist` 存在 → 把前端产物内嵌进 exe；否则内嵌 `server/assets/placeholder/`
的占位页（保证「web 尚未 ready 时 `cargo build --release` 也能过」）。`../themes` 同理（缺失时 themes 列表为空）。

- 开发期（debug）静态资源**从磁盘读取**：默认 `web/dist`、`themes/`，可用 `MWB_WEB_DIR` / `MWB_THEMES_DIR` 覆盖；
  改前端后刷新浏览器即可，**不用重新 cargo build**。
- release 用编译期内嵌资源；**前端/主题产物变更后需重新 `cargo build --release`**（build.rs 已 `rerun-if-changed`）。
- 骨架期验证：`web/dist`、`themes/` 均存在时，release exe 会自动内嵌真实前端与主题。

## 3. 启动参数与环境变量

| 变量/参数 | 作用 |
|---|---|
| `MWB_DATA_DIR` | 覆盖数据目录（=工作区根），**联调/测试隔离必用** |
| `MWB_PORT` | 覆盖监听端口（默认 `0` = 系统随机分配；**被占用时自动回退随机端口**，不报错退出） |
| `--version` / `-V` | 打印 `MarpWorkbench 0.1.0` 后退出 0 |
| `MWB_NO_OPEN=1` 或 `--no-open` | 不自动打开浏览器（测试用） |
| `MWB_WEB_DIR` | 开发期静态资源目录覆盖（默认 `web/dist`，debug 生效；release 设了也优先读磁盘） |
| `MWB_THEMES_DIR` | 内置主题目录覆盖（默认 `themes/`） |
| `--no-open` | 同 `MWB_NO_OPEN` |

启动流程：解析数据目录 → 创建目录结构（`.trash/`、`exports/`、`themes/`、`logs/`、settings/recent 按需）→
**单实例锁**（固定本地端口 `127.0.0.1:46327`）→ `127.0.0.1:0` 监听 → 生成 64 hex token →
写 `instance.json`（pid/port/token/startedAt/url）→ 打开默认浏览器 `http://127.0.0.1:<port>/?token=<token>`。

- **单实例**：第二实例 bind 失败的锁端口 → 读 `instance.json` → `GET /api/health` 探测 → 打开已有实例 URL 后退出。
  锁用本地 TCP 端口实现（**端口号由数据目录 sha256 派生**：同一数据目录=同一实例；不同数据目录/并行测试互不影响；
  进程异常退出由操作系统自动释放，无需清理陈旧锁文件）。
- **退出**：`POST /api/shutdown`（需 token）→ 返回 `{ok:true}` 后优雅停机、删除 `instance.json`、进程 exit 0。
- **日志**：`<数据目录>\logs\server.log`（启动、监听、异常）；debug 下同时输出到 stderr。
- **无控制台**：release 下无黑窗；错误通过日志与 HTTP 错误 JSON 暴露。

## 4. 数据目录（默认 `%USERPROFILE%\Documents\MarpWorkbench\`）

```
<数据目录>\                    # = 工作区根（workspaceRoot）
├─ <deck-id>\slides.md         # 每个 deck 一个目录；id=目录名（允许中文）
├─ <deck-id>\assets\           # 图片/附件（§1.4）
├─ exports\                    # 导出产物（export-eng 写入）
├─ themes\*.css                # 用户导入主题
├─ .trash\<id>-<时间戳>\       # 删除的 deck（不物理删除）
├─ settings.json               # §1.2
├─ recent.json                 # 最近文件（最多 20 条返回）
├─ instance.json               # 运行时：pid/port/token（退出删除）
└─ logs\server.log
```

优先级：`MWB_DATA_DIR` → exe 同目录存在 `data\`（便携模式）→ `%USERPROFILE%\Documents\MarpWorkbench\`。

## 5. 已实现 API（契约 §1.1–1.5 全部）
所有 `/api/*` 除 `GET /api/health` 外都要求请求头 `X-MWB-Token`；有 `Origin`/`Referer` 时必须为本服务地址。
静态资源（`/`、`/edit/:id`、`/settings`、`/assets/*`、`/marp-core.browser.js`、`/themes/*.css` 等）不鉴权、SPA fallback 到 index.html。
响应统一 `Content-Encoding: br/gzip`（按 `Accept-Encoding`，tower-http 运行时压缩）。

| 方法/路径 | 状态 | 说明 |
|---|---|---|
| GET `/api/health` | ✅ | 不鉴权，`{ok,app,version,pid,port,workspaceRoot,startedAt}` |
| POST `/api/shutdown` | ✅ | 优雅退出 |
| GET `/api/browser` | ✅ | `{chrome?,edge?,usable,preferred}`（标准路径 + App Paths 注册表） |
| GET/PUT `/api/settings` | ✅ | PUT 部分字段；`workspaceRoot` 固定为数据目录（移动工作区后续版本） |
| GET `/api/workspace` | ✅ | `{root,decks:[{id,name,updatedAt,createdAt,bytes,pages:null}]}` |
| POST `/api/decks` | ✅ | `{name?,template:"blank"|"title"|"sample"}`；重名自动 `-1` 序号 |
| GET `/api/decks/:id` | ✅ | `{id,name,content,rev,updatedAt,assets:[{path,url}]}` |
| PUT `/api/decks/:id` | ✅ | `{content,ifRev?}`；`ifRev` 不匹配 → **409 CONFLICT**；原子写盘 |
| POST `/api/decks/:id/rename` | ✅ | `{name}`；已存在同名 → 409 |
| DELETE `/api/decks/:id` | ✅ | 移入 `.trash/<id>-<时间戳>/` |
| GET `/api/recent` | ✅ | 最多 20 条，自动过滤已删除 deck |
| POST `/api/decks/:id/assets` | ✅ | multipart `file`；png/jpg/jpeg/gif/webp/svg/bmp；≤32MB；同名 `-1` 序号 |
| GET `/api/decks/:id/assets/:name` | ✅ | 原始字节 + 正确 Content-Type |
| GET `/api/themes` | ✅ | 内置（`themes/*.css` 内嵌）+ 用户主题（`<数据目录>/themes/*.css`），同名用户主题覆盖内置 |
| GET `/api/themes/:name/css` | ✅ | `text/css` |
| POST `/api/themes` | ✅ | JSON `{css,fileName?}`；校验 `@theme` 唯一；**M1 暂不支持 multipart 导入（M2 补）** |
| PUT `/api/themes/:name` | ✅ | 仅用户主题；`@theme` 名须与 URL 一致 |
| DELETE `/api/themes/:name` | ✅ | 仅用户主题 |
| POST `/api/export/*`、GET `/api/export/file|tmp/*` | ✅ 已由 export-eng 实现 | `server/src/routes/export.rs` + `server/src/export/**`；PDF 走无头 Chrome/Edge（Lead 冒烟实测 pages=3、capture 3 张 PNG） |

主题元信息解析：`/* @theme name */`（必须、唯一）、`@name`、`@tags`（逗号/空格分隔）、`@size`、`@auto-scaling`、`@author`。

## 6. 冒烟测试（已实测 42/42 PASS）

```powershell
# debug（开发验证）  /  release（出包验证）
powershell -ExecutionPolicy Bypass -File server/scripts/smoke.ps1
powershell -ExecutionPolicy Bypass -File server/scripts/smoke.ps1 -Exe target\release\MarpWorkbench.exe
# 保留测试数据目录以便排查：追加 -KeepData
```

脚本行为：用 `MWB_DATA_DIR=<临时目录>` + `MWB_PORT=18999` 启动 `--no-open`，读取 `instance.json` 拿 port+token，
覆盖 health/browser/settings/静态与 SPA/workspace/deck CRUD（含 409 冲突、rename、delete 进 .trash）/recent/
assets 上传下载/主题列表+导入+读取+更新+非法校验+删除/无 token 401/单实例二次启动/shutdown 退出与清理。

> PowerShell 5.1 注意：`Invoke-RestMethod` 对无 charset 的 JSON 按 Latin-1 解码（中文乱码），脚本统一走
> `curl.exe` + UTF-8 显式解码；`.ps1` 文件保存为 **UTF-8 with BOM**（否则 PS5.1 按 ANSI 解析中文会报语法错）。

### 6.1 实测结果（2026-10-20，release exe）

| 项 | 结果 |
|---|---|
| `cargo build --release` | ✅ 通过（首次全量约 5m14s；增量约 1.5–2min，LTO 主导） |
| release exe 体积 | **7.12 MB**（内嵌 `web/dist` 4.65MB + 6 套主题 CSS + export-eng 导出模块；M1 目标 ≤20MB ✅） |
| `--version` | ✅ 输出 `MarpWorkbench 0.1.0`，退出码 0 |
| stdout 握手 | ✅ `MWB_LISTEN_URL=http://127.0.0.1:<port>` + `MWB_TOKEN=<64hex>` 两行（release 亦可用，重定向时） |
| 端到端冒烟（`server/scripts/smoke.ps1`） | ✅ **42/42 PASS**（debug 与 release 各跑一遍） |
| 内嵌前端 | ✅ `GET /` 返回 Vite 产物（引用 `/assets/index-*.js`、`/assets/index-*.css`）；`/marp-core.browser.js` 200 |
| br/gzip 压缩 | ✅ `marp-core.browser.js`：raw 3,846,274 B → br 1,136,210 B / gzip 1,205,050 B |
| 内嵌主题 | ✅ 6 套内置主题（business-blue / tech-dark / academic-white / minimal-gray / magazine / gradient-vivid），`GET /api/themes` 返回 `source=builtin` |
| KaTeX 字体 | ✅ `/katex/fonts/KaTeX_Main-Regular.woff2` 200（离线可用） |
| 单实例 / shutdown | ✅ 二次启动自动退出并复用已有实例；shutdown 后进程 ≤10s 退出且 `instance.json` 清理 |
| Lead 的 `scripts/smoke.mjs` | ✅ **12/12 PASS**（29.5s）：health / 新建 / 保存 / 读回 / 409 / themes(6) / settings / **PDF 导出 pages=3** / capture 逐页截图（3 张 PNG）/ shutdown |
| 启动参数契约（§0.2） | ✅ `--version` → `MarpWorkbench 0.1.0` 退出 0；stdout 两行 `MWB_LISTEN_URL=` + `MWB_TOKEN=`；`MWB_PORT=18997` 固定生效、被占用自动回退随机端口（实测 8477） |
| 单实例 | ✅ 锁端口按数据目录 sha256 派生：同一数据目录二次启动复用并退出；不同数据目录（两份便携副本/并行测试）可同时运行 |

> 注意：exe 体积随内嵌的 `web/dist` 变化；前端/主题重新构建后需重新 `cargo build --release`。

## 7. 给并行成员的协作说明

- **export-eng**：
  - 导出路由 stub 在 `server/src/routes/export.rs`（已 wire 到 `/api`，当前返回 501），可直接替换实现；
    export-eng 已在 `server/src/export/**` 建模块，并约定用 `#[path = "../export/mod.rs"]` 在 export.rs 内挂载
    （server-core 无需在 `main.rs` 加 `mod export;`）。
  - export-eng 已在 `server/Cargo.toml` 增加 `tungstenite = "0.24"`、`base64 = "0.22"`（CDP 用），**勿删**。
  - 浏览器探测复用 `crate::browser::detect()`；打印页走 `file://` 临时 HTML（不用 `/api/export/print/:token`）。
  - 可复用：`crate::browser::detect()`（Chrome/Edge 探测，返回 `BrowserInfo`）、`crate::state::AppState`
    （`data_dir`/`exports_dir()`/`token`/`port`）、`crate::util`（`atomic_write`/`url_seg`/`content_disposition`/`mime_for_ext`）、
    `crate::error::{ApiError, ApiResult}`（错误码可用 `EXPORT_FAILED` 等，契约允许）。
  - 导出产物目录：`<数据目录>\exports\`；临时目录建议 `%TEMP%\MarpWorkbench\`。静态下载/打印页鉴权可参考
    `/api/export/file` 与 `/api/export/print/:token` 的设计约定（内部 URL token 不暴露主 token）。
- **frontend-core**：token 用 `X-MWB-Token` 头；`GET /api/health` 免鉴权可用于「本地服务 ●」状态灯；
  静态资源带 br/gzip；`GET /api/workspace` 的 `pages` M1 固定 null 由前端填充；保存/读取以 `rev` 做冲突检测。
- 契约有分歧：先给 Lead 发消息，**不要自行修改 `docs/API_CONTRACT.md`**。

## 8. 已知限制 / 后续（M2+）

1. **压缩**：M1 用 tower-http 运行时压缩（按 `Accept-Encoding` 返回 br/gzip），非构建期预压缩；
   若首屏/静态资源成为瓶颈，M2 换「预压缩资源 + `Content-Encoding` 直接返回」。
2. 主题 **multipart 导入**未实现（M1 JSON 导入已可用）；前端拖拽 `.css` 后可改成 JSON 上传。
3. `PUT /api/settings` 的 `workspaceRoot` 仅记录展示，工作区固定为数据目录（移动工作区 M3+）。
4. 空闲自动退出（`idleExitMinutes`）尚未接线；rfd 原生文件对话框未接入（契约 M1 可延后）。
5. 无单元测试/集成测试（M2 补：路径校验、主题解析、rev/409、打印页生成）。
6. `web/dist`/`themes` 变更后需重新 release 构建才能进 exe（开发期用 `MWB_WEB_DIR` 免构建）。
7. release exe 尚未加图标/版本信息资源（M4 发布项）。
