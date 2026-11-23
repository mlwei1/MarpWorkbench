# 给 AI 的 Prompt 模板（复制即用）

> 用法：把下面整段复制给 ChatGPT / Claude / DeepSeek / Cursor 等，替换 `{主题}` 等占位内容；把生成的 Markdown 保存为 `.md`，在 MarpWorkbench 首页「导入」或在编辑器里粘贴即可。
> 更完整的规范见：`docs/AI_WRITING_GUIDE.md`。AI 支持读取文件时，直接把该文件一起发给它效果最好。

---

## 模板 A：一句话生成一份 deck

```text
你是 Marp（Marpit）幻灯片专家。请为我生成一份可直接导入 MarpWorkbench 的 Marp Markdown 幻灯片文件。

主题：{主题，例如：2026 年 Q4 产品规划}
受众：{受众，例如：公司管理层}
目标：{目标，例如：讲清楚 Q4 三个重点方向与资源需求}
页数：{10–15 页}
语言：简体中文
风格：{商务简洁 / 科技深色 / 学术 / 创意}

必须遵守：
1. 只输出一个 .md 文件内容，不要输出解释、不要用 ``` 包裹整篇。
2. 第一页前加 YAML front-matter：
   ---
   marp: true
   theme: business-blue
   paginate: true
   size: 16:9
   header: '{页眉}'
   footer: '{页脚}'
   ---
3. 每页用单独一行 --- 分隔；每页一个 ## 标题 + 3–6 条要点（每条 ≤ 40 个中文字）。
4. 首页用 <!-- _class: lead --> + # 大标题 + 副标题；结尾页给结论/下一步。
5. 图片只用 https:// 地址（没有合适图片就不放图）；宽度写 ![w:640px](url)。
6. 需要图表时用 Mermaid 代码块（graph/sequenceDiagram/classDiagram/stateDiagram-v2/erDiagram/gantt/pie/mindmap/timeline/journey），第一行可加尺寸：%% mwb-size: l；图最多 12 个节点。
7. 每页用 <!-- 备注：2–4 句口播稿 --> 写演讲者备注。
8. 主题只能用：business-blue、tech-dark、academic-white、minimal-gray、paper-warm、data-teal、magazine、gradient-vivid、startup-orange、dark-neon、chinese-ink、nature-green、default、gaia、uncover。

结构建议：封面 → 结论先行 → 背景/问题 → 方案（2–3 页）→ 数据/证据 → 风险 → 计划/里程碑 → 结尾。
```

---

## 模板 B：给已有材料，整理成 deck

```text
下面是我的一份材料（{粘贴/附件}）。请把它整理成一份 MarpWorkbench 可导入的 Marp Markdown 幻灯片。

要求：
- 受众：{受众}；时长：{X 分钟}；页数：15 页以内
- 先给结论，再给论据；每页只讲一个观点
- 用 ## 标题 + 3–6 条要点；数据用表格（≤5 列）；需要时用 Mermaid 图（≤12 节点）
- 只输出 .md 文件内容；front-matter 固定使用：
  ---
  marp: true
  theme: business-blue
  paginate: true
  size: 16:9
  ---
- 每页备注：<!-- 这页的口播稿，2–4 句 -->
- 不要编造材料中没有的数字；没有数据的页只做结构化总结
```

---

## 模板 C：修改现有 deck

```text
下面是一份 Marp Markdown。请在不破坏 front-matter 与分页结构的前提下修改：
{修改要求，例如：第 3–5 页压缩成 2 页；加一页 Mermaid 时间线；把要点改写成结论式标题}

要求：
- 保持标准 Marp 语法；不要使用未在规范里的语法
- 只输出修改后的完整 .md 内容
- 保留每页的 <!-- 备注 -->；新增页补 2–4 句备注
- 图片/图表遵循：https 图片、Mermaid 第一行可 %% mwb-size: l
```

---

## 模板 D：一键生成「产品/项目介绍 PPT」的变量清单

```
产品/项目名称：
一句话定位：
目标用户：
核心问题：
解决方案（3 点）：
差异化（2 点）：
数据/成果（如有）：
商业模式（可选）：
团队（可选）：
下一步/需求：
风格：商务蓝（business-blue） / 科技深色（tech-dark） / 创业橙（startup-orange）
```

> 拿到 AI 输出后：MarpWorkbench 首页「导入 .md」→ 预览 → 选主题/改细节 → 导出 PPTX（图片版/可编辑）或 PDF。
> 后续版本计划提供 CLI / MCP，让 AI 直接调用本应用生成与导出，见 `docs/M5_PLAN.md`。
