/**
 * useOutline —— 大纲解析 + 页码映射（M2 / task-11，契约 docs/UI_CONTRACT_M2.md §2.1）
 *
 * 设计说明：
 * - 分页扫描的语义与 `web/src/marp/frontmatter.ts` 的 `scanSlides()` / `slideIndexAtLine()`
 *   保持一致（跳过 front-matter、跳过代码围栏里的 `---`），但这里是**独立实现**：
 *   frontmatter.ts 由 marp-tech 维护，本组件不修改、也不依赖其内部实现；
 *   契约 §3 的 `pageStartLine()/mapLineToPage()` 落地后可以平滑替换这里的实现。
 * - 标题解析按 CommonMark ATX 规则（`#` ~ `######`，最多 3 个前导空格，允许行尾闭合 `###`），
 *   额外跳过 HTML 注释块（`<!-- ... -->`）——Marp 的备注就是注释，里面常出现 `#` 行。
 * - 不识别 Setext 标题（`标题\n===`）：Marp 里 `---` 是分页线，与 Setext H2 二义，故意不支持。
 *
 * 纯函数、无副作用；组件里通过 `useOutline()` 组合式函数拿到响应式结果。
 */
import { computed, type ComputedRef } from 'vue'

/** 一条大纲标题 */
export interface OutlineHeading {
  /** 标题级别 1–6（来自 `#` 数量） */
  level: number
  /** 去掉行内 Markdown 标记后的纯文本（用于展示） */
  text: string
  /** 原始标题行（trim 后，便于调试/悬浮提示） */
  raw: string
  /** 标题所在行号（1-based，含 front-matter 占用的行） */
  line: number
  /** 标题所在页（1-based） */
  page: number
  /** 相对文档最小标题级别的缩进层级（0 起；已按文档归一化，UI 直接使用） */
  indent: number
}

/** front-matter：仅当文件最开头是 `---` 块时识别（与 frontmatter.ts 同语义） */
const FRONT_MATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
/** ATX 标题：最多 3 个前导空格 + 1–6 个 `#` + 空白 + 文本（或仅 `#`） */
const ATX_HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/
/** 代码围栏开始：最多 3 个前导空格 + ``` 或 ~~~ 至少 3 个 */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
/** 代码围栏结束：同字符、长度不小于开始，且后面不再有内容 */
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
/** 分页线：整行 3 个及以上 `-`（Marp 用 `---` 分页） */
const PAGE_BREAK_RE = /^-{3,}[ \t]*$/

interface FenceState {
  char: '`' | '~'
  len: number
}

/**
 * front-matter 在源文件里占用的行数（用于跳过它、计算真实行号）。
 * - 无 front-matter → 0
 * - 有 → closing `---` 所在行的行号（1-based），正好等于后面的内容起始行号 - 1
 */
export function frontMatterLineCount(markdown: string): number {
  const m = FRONT_MATTER_RE.exec(markdown)
  if (!m) return 0
  const raw = m[0]
  const newlines = (raw.match(/\r?\n/g) || []).length
  // raw 以换行结尾时，行数 = 换行数；否则最后一个 `---` 没有换行，行数 = 换行数 + 1
  return raw.endsWith('\n') ? newlines : newlines + 1
}

/** 纯文本化：去掉行内代码/链接/图片/强调/HTML 标签等标记（供大纲展示与搜索） */
export function stripInlineMarkdown(text: string): string {
  if (!text) return ''
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 图片 → alt
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 链接 → 文本
    .replace(/`([^`]*)`/g, '$1') // 行内代码
    .replace(/<[^>]+>/g, '') // HTML 标签
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // 粗体
    .replace(/\*([^*\n]+)\*/g, '$1') // 斜体 *
    .replace(/(^|[^A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, '$1$2') // 斜体 _
    .replace(/~~(.*?)~~/g, '$1') // 删除线
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1') // 转义字符
    .trim()
}

/** 逐行遍历正文（跳过 front-matter / 代码围栏 / HTML 注释块），回调拿到行内容与 1-based 行号 */
function walkContentLines(
  markdown: string,
  visit: (line: string, lineNo1: number) => void,
): void {
  const lines = markdown.split(/\r?\n/)
  const fmLines = frontMatterLineCount(markdown)
  let fence: FenceState | null = null
  let inComment = false

  for (let i = fmLines; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (fence) {
      const close = FENCE_CLOSE_RE.exec(line)
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null
      continue
    }
    if (inComment) {
      if (trimmed.includes('-->')) inComment = false
      continue
    }
    const open = FENCE_OPEN_RE.exec(line)
    if (open) {
      fence = { char: open[1][0] as '`' | '~', len: open[1].length }
      continue
    }
    // HTML 注释：Marp 备注（单行或多行）里可能有 `#` 行，不能算标题
    if (/^ {0,3}<!--/.test(line)) {
      if (!line.includes('-->')) inComment = true
      continue
    }
    visit(line, i + 1)
  }
}

/**
 * 每页起始行号（1-based），第一页从 front-matter 之后的第一行开始。
 * 语义与 `frontmatter.ts` 的 `scanSlides().pageStarts` 一致；代码围栏内的 `---` 不算分页。
 */
export function scanPageStarts(markdown: string): number[] {
  if (!markdown) return [1]
  const starts: number[] = [frontMatterLineCount(markdown) + 1]
  walkContentLines(markdown, (line, lineNo1) => {
    if (PAGE_BREAK_RE.test(line.trim())) {
      // 该行的下一行是下一页起始
      starts.push(lineNo1 + 1)
    }
  })
  return starts
}

/** 页数（按分页线统计；空文档按 1 页算，与 renderer 的 comments 语义一致） */
export function pageCountOf(markdown: string): number {
  return scanPageStarts(markdown).length
}

/** 行号（1-based）→ 页号（1-based） */
export function pageAtLine(markdown: string, line1: number): number {
  const starts = scanPageStarts(markdown)
  let page = 1
  for (let i = 1; i < starts.length; i++) {
    if (line1 >= starts[i]) page = i + 1
    else break
  }
  return page
}

/**
 * 解析 markdown 里的标题树（打平成一维数组，按出现顺序；同一页的多个标题都会列出）。
 * @param pageCountHint 父组件传进来的真实页数（renderer 结果）。若与本地分页扫描不一致，
 *        用它将越界页码夹回 [1, pageCountHint]，保证点击跳转不越界。
 */
export function parseOutline(markdown: string, pageCountHint?: number): OutlineHeading[] {
  if (!markdown || !markdown.trim()) return []
  const starts = scanPageStarts(markdown)
  const found: Array<{ level: number; text: string; raw: string; line: number }> = []

  walkContentLines(markdown, (line, lineNo1) => {
    const m = ATX_HEADING_RE.exec(line)
    if (!m) return
    let text = m[2] ?? ''
    // 去掉行尾闭合序列（`## 标题 ##`）
    text = text.replace(/[ \t]+#+[ \t]*$/, '')
    found.push({
      level: m[1].length,
      text: stripInlineMarkdown(text).trim(),
      raw: line.trim(),
      line: lineNo1,
    })
  })
  if (!found.length) return []

  const baseLevel = found.reduce((min, h) => Math.min(min, h.level), 6)
  const maxPage = pageCountHint && pageCountHint > 0 ? pageCountHint : Number.POSITIVE_INFINITY

  return found.map((h) => {
    let page = 1
    for (let i = 1; i < starts.length; i++) {
      if (h.line >= starts[i]) page = i + 1
      else break
    }
    return {
      level: h.level,
      text: h.text,
      raw: h.raw,
      line: h.line,
      page: Math.min(Math.max(page, 1), maxPage),
      indent: Math.min(5, Math.max(0, h.level - baseLevel)),
    }
  })
}

/** 当前页应高亮/滚动到的标题下标（页号 <= currentPage 的最后一条）；没有则 -1 */
export function activeHeadingIndex(headings: OutlineHeading[], currentPage: number): number {
  let idx = -1
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].page <= currentPage) idx = i
    else break
  }
  return idx
}

/** 把页号夹到 [1, pageCount]（pageCount<=0 时原样返回） */
export function clampPage(page: number, pageCount: number): number {
  if (!Number.isFinite(page)) return 1
  const n = Number.isFinite(pageCount) ? Math.floor(pageCount) : 0
  const p = Math.floor(page)
  if (n <= 0) return Math.max(1, p)
  return Math.min(Math.max(p, 1), n)
}

/** 详情文字：给大纲项生成 title 提示 */
export function describeHeading(h: OutlineHeading): string {
  return `第 ${h.page} 页 · 第 ${h.line} 行 · ${h.text || '(无标题文本)'}`
}

/**
 * 组合式函数：`SlideNavigator.vue` 使用。
 * 传入 getter 以便对父组件 props 保持响应式。
 */
export function useOutline(
  markdown: () => string,
  pageCount?: () => number,
): {
  headings: ComputedRef<OutlineHeading[]>
  pageStarts: ComputedRef<number[]>
  pageCountLocal: ComputedRef<number>
  hasHeadings: ComputedRef<boolean>
} {
  const headings = computed<OutlineHeading[]>(() =>
    parseOutline(markdown(), pageCount ? pageCount() : undefined),
  )
  const pageStarts = computed<number[]>(() => scanPageStarts(markdown()))
  const pageCountLocal = computed<number>(() => pageStarts.value.length)
  return {
    headings,
    pageStarts,
    pageCountLocal,
    hasHeadings: computed(() => headings.value.length > 0),
  }
}
