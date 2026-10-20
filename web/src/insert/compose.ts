/**
 * 插入器 Markdown 合成工具（M2，owner: export-eng）
 *
 * 目标：所有 UI 操作只产出**标准 Marp Markdown**（可拷回 VS Code / marp-cli），
 * 同时为对话框提供「插入到当前页后的候选 Markdown」用于实时预览。
 *
 * 实测（spike/export/scripts/diag-image-syntax.mjs，marp-core 4.4.0）：
 * - 普通图片：`![w:300px](assets/x.png)` → `<img style="width:300px">`；
 *   **`![w:50%]` 百分比不被 marp-core 支持**（不产生任何样式）→ 本模块把百分比换算成 px
 *   （基于当前 deck 宽度：16:9 = 1280px），产出仍是标准 Marp 语法。
 * - 背景图：`![bg left:40% opacity:.5 blur:5px grayscale](assets/x.png)`
 *   → `<section data-marpit-advanced-background="background" ...>` +
 *     `<figure style="background-image:url(...);filter:opacity(.5) blur(5px) grayscale(1)">`；
 *   `contain` / `fit` → `background-size:contain`；`cover` 为默认（不写）。
 * - 表格：GFM 对齐行 `:---` / `:---:` / `---:` → `<th style="text-align:...">` 生效。
 */

export type ImageMode = 'image' | 'background'
export type BgLayout = 'full' | 'left' | 'right'
export type BgFit = 'cover' | 'contain' | 'fit'
export type TableAlign = 'left' | 'center' | 'right'

export interface ImageSnippetOptions {
  /** 资产路径（`assets/x.png`）或 http(s)/data URL */
  path: string
  mode?: ImageMode
  /** 普通图片宽度百分比（25/50/75/100）；null/undefined = 原图不写宽度 */
  widthPercent?: number | null
  /** 当前 deck 的幻灯片宽度（px），用于把百分比换算成 px；默认 1280 */
  slideWidth?: number
  bgLayout?: BgLayout
  /** 背景左右分栏占比 20–70（%），默认 40 */
  bgRatio?: number
  fit?: BgFit
  /** 透明度 0–100（0 = 不透明，不写 opacity；50 → opacity:.5） */
  transparency?: number
  /** 模糊 0–10（px） */
  blur?: number
  grayscale?: boolean
  alt?: string
  /** 原图里本 UI 不认识的修饰符（如 vertical/brightness:…），编辑保存时原样保留 */
  extraModifiers?: string[]
}

export interface TableSnippetOptions {
  rows: number
  cols: number
  header?: boolean
  align?: TableAlign
  firstColBold?: boolean
  /** 自定义单元格文本（行优先，含表头行）；缺省用占位文本 */
  cells?: string[][]
}

const DEFAULT_SLIDE_WIDTH = 1280
const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n))
const round2 = (n: number): number => Math.round(n * 100) / 100

/** 数字 → Marp 修饰符写法：0.5 → `.5`，0.35 → `.35`，1 → `1` */
function fmtOpacity(value01: number): string {
  const s = round2(value01).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
  return s.startsWith('0.') ? s.slice(1) : s
}

/**
 * 资产 URL 处理：非 ASCII / 空格等编码为安全形式；http(s)/data/blob 原样保留。
 * 返回的字符串可直接放进 Markdown 的 `(...)`，含空格/括号时由 `mdDest()` 包 <>。
 */
export function encodeAssetUrl(raw: string): string {
  const p = String(raw || '').trim()
  if (!p) return p
  if (/^(https?:|data:|blob:)/i.test(p)) return p
  let out: string
  try {
    out = encodeURI(p)
  } catch {
    out = p
  }
  // encodeURI 不编码 #（会被当 URL fragment），手动处理
  return out.replace(/#/g, '%23')
}

/** Markdown 链接目标：含空格/括号等用 <> 包裹（GFM/Marp 支持） */
function mdDest(encodedPath: string): string {
  if (/[ ()\t]/.test(encodedPath)) return `<${encodedPath}>`
  return encodedPath
}

/** 背景图修饰符（不含 `bg`）：`left:40%` / `contain` / `opacity:.5` … */
function backgroundModifiers(opts: ImageSnippetOptions): string[] {
  const mods: string[] = []
  const layout = opts.bgLayout || 'full'
  if (layout === 'left' || layout === 'right') {
    const ratio = clamp(Math.round(opts.bgRatio ?? 40), 20, 70)
    mods.push(`${layout}:${ratio}%`)
  }
  const fit = opts.fit || 'cover'
  if (fit === 'contain' || fit === 'fit') mods.push(fit)
  return mods
}

/** 滤镜修饰符（普通图片与背景图都支持；顺序与 Marp 文档示例一致） */
function filterModifiers(opts: ImageSnippetOptions): string[] {
  const mods: string[] = []
  const t = clamp(Math.round(opts.transparency ?? 0), 0, 100)
  if (t > 0) mods.push(`opacity:${fmtOpacity(1 - t / 100)}`)
  const blur = clamp(Math.round(opts.blur ?? 0), 0, 20)
  if (blur > 0) mods.push(`blur:${blur}px`)
  if (opts.grayscale) mods.push('grayscale')
  return mods
}

/**
 * 生成图片插入片段（单行 Markdown，不含前后空行；由插入逻辑补块级空行）。
 * 例：`![w:640px](assets/a.png)`、`![bg left:40% opacity:.5](assets/a.png)`
 */
export function buildImageSnippet(opts: ImageSnippetOptions): string {
  const path = encodeAssetUrl(opts.path)
  if (!path) return ''
  const mode: ImageMode = opts.mode === 'background' ? 'background' : 'image'
  const filters = filterModifiers(opts)
  const extras = (opts.extraModifiers || []).filter(Boolean)
  const filtersWithExtras = extras.length ? [...filters, ...extras] : filters
  // alt 文本（普通图片）：保留用户原有 alt（背景图的 alt 是修饰符，不写 alt）
  const altText = mode === 'image' ? String(opts.alt || '').trim() : ''
  const altPrefix = altText ? `${altText} ` : ''
  if (mode === 'background') {
    const mods = ['bg', ...backgroundModifiers(opts), ...filtersWithExtras]
    return `![${mods.join(' ')}](${mdDest(path)})`
  }
  const mods: string[] = []
  const percent = opts.widthPercent
  if (percent != null && percent > 0) {
    const slideWidth = opts.slideWidth && opts.slideWidth > 0 ? opts.slideWidth : DEFAULT_SLIDE_WIDTH
    const px = Math.max(1, Math.round((clamp(percent, 1, 200) / 100) * slideWidth))
    mods.push(`w:${px}px`)
  }
  mods.push(...filtersWithExtras)
  return `![${altPrefix}${mods.join(' ')}](${mdDest(path)})`
}

// ---------------------------------------------------------------------------
// 表格
// ---------------------------------------------------------------------------

export function defaultTableCell(row: number, col: number, header: boolean): string {
  return header ? `表头${col + 1}` : `内容 ${col + 1}`
}

/** 初始化可编辑单元格（保持已存在的文本） */
export function defaultTableCells(rows: number, cols: number, header: boolean): string[][] {
  const out: string[][] = []
  for (let r = 0; r < rows; r++) {
    const line: string[] = []
    for (let c = 0; c < cols; c++) line.push(defaultTableCell(r, c, header && r === 0))
    out.push(line)
  }
  return out
}

function escapeCell(text: string): string {
  return String(text ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim()
}

function alignMarker(align: TableAlign): string {
  if (align === 'center') return ':---:'
  if (align === 'right') return '---:'
  return ':---'
}

/**
 * 生成 GFM 表格块（前后各带一个空行，便于直接插入块级上下文）。
 * 首行表头可选；对齐行按列统一；`firstColBold` 只加粗数据行首列。
 */
export function buildTableSnippet(opts: TableSnippetOptions): string {
  const cols = clamp(Math.floor(opts.cols || 0), 1, 50)
  const rows = clamp(Math.floor(opts.rows || 0), 1, 200)
  const header = opts.header !== false
  const align: TableAlign = opts.align || 'left'
  const cells: string[][] = []
  for (let r = 0; r < rows; r++) {
    const source = opts.cells?.[r] || []
    const line: string[] = []
    for (let c = 0; c < cols; c++) {
      let text = source[c] ?? defaultTableCell(r, c, header && r === 0)
      if (text === '' && header && r === 0) text = defaultTableCell(r, c, true)
      line.push(escapeCell(text))
    }
    cells.push(line)
  }
  const lines: string[] = []
  const toRow = (r: number): string => {
    const cs = cells[r].map((text, c) => {
      if (opts.firstColBold && c === 0 && r > 0 && text !== '') return `**${text}**`
      return text
    })
    return `| ${cs.join(' | ')} |`
  }
  if (header) {
    lines.push(toRow(0))
    lines.push(`| ${Array.from({ length: cols }, () => alignMarker(align)).join(' | ')} |`)
    for (let r = 1; r < rows; r++) lines.push(toRow(r))
  } else {
    lines.push(`| ${Array.from({ length: cols }, () => alignMarker(align)).join(' | ')} |`)
    for (let r = 0; r < rows; r++) lines.push(toRow(r))
  }
  return `\n\n${lines.join('\n')}\n\n`
}

// ---------------------------------------------------------------------------
// 页面定位 / 插入（供对话框预览与父组件插入页首使用）
// ---------------------------------------------------------------------------

export interface PageRange {
  /** 1-based 页码 */
  index: number
  /** 页内容起始 offset（跳过 front-matter 与分页线） */
  startOffset: number
  /** 页内容结束 offset（exclusive，停在下一页分页线之前） */
  endOffset: number
  /** 全局 1-based 行号 */
  startLine: number
  endLine: number
}

const FRONT_MATTER_RE = /^(?:\uFEFF)?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/

function lineNumberAt(markdown: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < markdown.length; i++) {
    if (markdown.charCodeAt(i) === 10) line++
  }
  return line
}

/**
 * 切分 Marp 页面（跳过 front-matter 与 ``` / ~~~ 代码围栏里的 `---`）。
 * 返回每页内容的 [startOffset, endOffset)。
 */
export function splitPages(markdown: string): PageRange[] {
  const md = String(markdown ?? '')
  const fmMatch = FRONT_MATTER_RE.exec(md)
  const bodyStart = fmMatch ? fmMatch[0].length : 0
  const pages: PageRange[] = []
  let pageStart = bodyStart
  let cursor = bodyStart
  let inFence = false
  let pageIndex = 1
  while (cursor <= md.length) {
    const nl = md.indexOf('\n', cursor)
    const lineEnd = nl === -1 ? md.length : nl
    const lineText = md.slice(cursor, lineEnd).trim()
    const nextCursor = nl === -1 ? md.length + 1 : nl + 1
    if (/^(```|~~~)/.test(lineText)) inFence = !inFence
    else if (!inFence && /^-{3,}$/.test(lineText)) {
      pages.push({
        index: pageIndex,
        startOffset: pageStart,
        endOffset: cursor,
        startLine: lineNumberAt(md, pageStart),
        endLine: lineNumberAt(md, cursor)
      })
      pageIndex++
      pageStart = nextCursor
    }
    if (nl === -1) break
    cursor = nextCursor
  }
  pages.push({
    index: pageIndex,
    startOffset: pageStart,
    endOffset: md.length,
    startLine: lineNumberAt(md, pageStart),
    endLine: lineNumberAt(md, md.length)
  })
  return pages
}

export function countPages(markdown: string): number {
  return splitPages(markdown).length
}

function pickPage(pages: PageRange[], page: number): PageRange {
  const index = Math.min(Math.max(Math.round(page || 1), 1), Math.max(pages.length, 1))
  return pages[index - 1] || pages[0]
}

/** 页首插入：跳过页首已有的空白与 `<!-- ... -->` 指令块，保证背景图/内容紧跟指令之后 */
function pageContentStartAfterDirectives(content: string): number {
  let offset = 0
  while (offset < content.length) {
    const rest = content.slice(offset)
    const blank = /^[ \t]*\r?\n/.exec(rest)
    if (blank) {
      offset += blank[0].length
      continue
    }
    const directive = /^<!--\s*_?[a-zA-Z][\s\S]*?-->\s*(?:\r?\n|$)/.exec(rest)
    if (directive) {
      offset += directive[0].length
      continue
    }
    break
  }
  return offset
}

/** 在指定页页首插入一个块（背景图等页面级指令用） */
export function insertAtPageStart(markdown: string, page: number, snippet: string): string {
  const md = String(markdown ?? '')
  const block = String(snippet || '').trim()
  if (!block) return md
  const pages = splitPages(md)
  const target = pickPage(pages, page)
  const content = md.slice(target.startOffset, target.endOffset)
  const inner = pageContentStartAfterDirectives(content)
  const head = md.slice(0, target.startOffset)
  const directives = content.slice(0, inner)
  const rest = content.slice(inner).replace(/^[ \t]*\r?\n/, '')
  const restTrimmed = rest.replace(/\s+$/, '')
  const tail = md.slice(target.endOffset)
  const beforeTail = (`${block}\n\n${restTrimmed}` as string).replace(/\s+$/, '')
  // tail 非空 = 后面还有页（以 --- 分隔线开头）→ 补空行，避免块内容被当成 setext 标题
  return tail ? `${head}${directives}${beforeTail}\n\n${tail}` : `${head}${directives}${beforeTail}\n`
}

/** 在指定页末尾插入一个块（普通图片预览用；实际 UI 插入以光标为准） */
export function insertAtPageEnd(markdown: string, page: number, snippet: string): string {
  const md = String(markdown ?? '')
  const block = String(snippet || '').trim()
  if (!block) return md
  const pages = splitPages(md)
  const target = pickPage(pages, page)
  const head = md.slice(0, target.endOffset).replace(/\s+$/, '')
  const tail = md.slice(target.endOffset)
  // 分隔线/后续内容前必须空行，否则 `text\n---` 会被解析成 setext 标题
  return tail ? `${head}\n\n${block}\n\n${tail}` : `${head}\n\n${block}\n`
}

/** 生成用于预览的候选 Markdown（背景图插页首；普通图片插当前页末尾） */
export function composePreviewMarkdown(
  markdown: string,
  snippet: string,
  mode: ImageMode,
  currentPage: number
): { markdown: string; page: number } {
  const pages = splitPages(markdown)
  const page = Math.min(Math.max(Math.round(currentPage || 1), 1), Math.max(pages.length, 1))
  const next =
    mode === 'background'
      ? insertAtPageStart(markdown, page, snippet)
      : insertAtPageEnd(markdown, page, snippet)
  return { markdown: next, page }
}

/** 行号 → 第几页（1-based）；供父组件把光标位置换算成当前页 */
export function pageAtLine(markdown: string, line1: number): number {
  const pages = splitPages(markdown)
  let page = 1
  for (const p of pages) if (line1 >= p.startLine) page = p.index
  return page
}

/** 页首行号（1-based）；父组件「插入到页首」时可用 editor.setCursor(此值) + insertText */
export function pageStartLine(markdown: string, page: number): number {
  return pickPage(splitPages(markdown), page).startLine
}

// ---------------------------------------------------------------------------
// 图片语法解析 / 原位替换（M3）
// ---------------------------------------------------------------------------

/** 解析出的一处图片语法（普通图片或背景图） */
export interface ParsedImage {
  /** 1-based 行号 */
  line: number
  /** Markdown 字符 range（图片语法本体，不含行尾换行；替换时保留前后文） */
  start: number
  end: number
  raw: string
  kind: ImageMode
  alt: string
  path: string
  /** 原始修饰符 token（如 ['bg','left:40%','opacity:.5']） */
  modifiers: string[]
  bgLayout: BgLayout
  bgRatio: number
  fit: BgFit
  widthPx: number | null
  widthPercent: number | null
  /** 0–1（opacity 修饰符）；无则 null */
  opacity: number | null
  blur: number
  grayscale: boolean
  /** 本 UI 不认识的修饰符（编辑保存时透传保留） */
  extraModifiers: string[]
}

interface ScanLine {
  line: number
  start: number
  end: number
  text: string
  isFence: boolean
  insideFence: boolean
}

/** 逐行扫描（含代码围栏状态）；行 range 不含 \n，end 为 \n 位置或文本末 */
function scanLinesDetailed(markdown: string): ScanLine[] {
  const md = String(markdown ?? '')
  const out: ScanLine[] = []
  let start = 0
  let line = 1
  let inFence = false
  for (;;) {
    const nl = md.indexOf('\n', start)
    const rawEnd = nl === -1 ? md.length : nl
    const text = md.slice(start, rawEnd).replace(/\r$/, '')
    const isFence = /^[ \t]*(```|~~~)/.test(text)
    out.push({ line, start, end: rawEnd, text, isFence, insideFence: inFence })
    if (isFence) inFence = !inFence
    if (nl === -1) break
    start = nl + 1
    line++
  }
  return out
}

/** 匹配 ![alt](dest) 语法（dest 支持 <…> 包裹与可选 title） */
const IMAGE_TOKEN_RE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g

interface RawImageToken {
  raw: string
  alt: string
  path: string
  offset: number
}

function matchImageTokensInLine(text: string): RawImageToken[] {
  const out: RawImageToken[] = []
  IMAGE_TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = IMAGE_TOKEN_RE.exec(text))) {
    let dest = m[2] || ''
    if (dest.startsWith('<') && dest.endsWith('>')) dest = dest.slice(1, -1)
    out.push({ raw: m[0], alt: m[1] || '', path: dest, offset: m.index })
  }
  return out
}

const MODIFIER_RE = {
  bg: /^bg$/,
  layout: /^(left|right)(?::\s*(\d+(?:\.\d+)?)%)?$/,
  fit: /^(cover|contain|fit)$/,
  opacity: /^opacity:\s*(\d*\.?\d+)(%?)$/,
  width: /^(?:w|width):\s*(\d+(?:\.\d+)?)(px|%)?$/,
  height: /^(?:h|height):/,
  blur: /^blur:\s*(\d*\.?\d+)(px)?$/,
  grayscale: /^grayscale$/,
  percent: /^(\d+(?:\.\d+)?)%$/,
  /// 其它 Marp 滤镜/方向修饰符（保留透传，避免编辑保存丢信息）
  otherFilter: /^(brightness|contrast|drop-shadow|hue-rotate|invert|saturate|sepia|vertical|horizontal):?/i,
}

interface ParsedModifiers {
  modifiers: string[]
  kind: ImageMode
  alt: string
  bgLayout: BgLayout
  bgRatio: number
  fit: BgFit
  widthPx: number | null
  widthPercent: number | null
  opacity: number | null
  blur: number
  grayscale: boolean
  extraModifiers: string[]
}

/** 解析 alt 里的 Marp 图片修饰符；无法识别的词作为 alt 文本 */
function parseAltModifiers(altRaw: string): ParsedModifiers {
  const tokens = String(altRaw || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const result: ParsedModifiers = {
    modifiers: [],
    kind: 'image',
    alt: '',
    bgLayout: 'full',
    bgRatio: 40,
    fit: 'cover',
    widthPx: null,
    widthPercent: null,
    opacity: null,
    blur: 0,
    grayscale: false,
    extraModifiers: [],
  }
  const altParts: string[] = []
  for (const token of tokens) {
    if (MODIFIER_RE.bg.test(token)) {
      result.kind = 'background'
      result.modifiers.push(token)
      continue
    }
    const layout = MODIFIER_RE.layout.exec(token)
    if (layout) {
      result.bgLayout = layout[1] as BgLayout
      if (layout[2]) result.bgRatio = clamp(Math.round(parseFloat(layout[2])), 1, 99)
      result.modifiers.push(token)
      continue
    }
    if (MODIFIER_RE.fit.test(token)) {
      result.fit = token as BgFit
      result.modifiers.push(token)
      continue
    }
    const opacity = MODIFIER_RE.opacity.exec(token)
    if (opacity) {
      let value = parseFloat(opacity[1])
      if (opacity[2] === '%') value /= 100
      if (Number.isFinite(value)) result.opacity = clamp(value, 0, 1)
      result.modifiers.push(token)
      continue
    }
    const width = MODIFIER_RE.width.exec(token)
    if (width) {
      const value = parseFloat(width[1])
      if (width[2] === '%') result.widthPercent = clamp(value, 1, 200)
      else result.widthPx = Math.max(1, Math.round(value))
      result.modifiers.push(token)
      continue
    }
    const blur = MODIFIER_RE.blur.exec(token)
    if (blur) {
      result.blur = clamp(Math.round(parseFloat(blur[1]) || 0), 0, 20)
      result.modifiers.push(token)
      continue
    }
    if (MODIFIER_RE.grayscale.test(token)) {
      result.grayscale = true
      result.modifiers.push(token)
      continue
    }
    const percent = MODIFIER_RE.percent.exec(token)
    if (percent) {
      result.widthPercent = clamp(parseFloat(percent[1]), 1, 200)
      result.modifiers.push(token)
      continue
    }
    if (MODIFIER_RE.otherFilter.test(token)) {
      result.extraModifiers.push(token)
      result.modifiers.push(token)
      continue
    }
    altParts.push(token)
  }
  result.alt = altParts.join(' ')
  return result
}

function buildParsedImage(
  md: string,
  lineInfo: ScanLine,
  token: RawImageToken
): ParsedImage {
  const start = lineInfo.start + token.offset
  const end = start + token.raw.length
  const mods = parseAltModifiers(token.alt)
  return {
    line: lineInfo.line,
    start,
    end,
    raw: md.slice(start, end),
    kind: mods.kind,
    alt: mods.alt,
    path: token.path,
    modifiers: mods.modifiers,
    bgLayout: mods.bgLayout,
    bgRatio: mods.bgRatio,
    fit: mods.fit,
    widthPx: mods.widthPx,
    widthPercent: mods.widthPercent,
    opacity: mods.opacity,
    blur: mods.blur,
    grayscale: mods.grayscale,
    extraModifiers: mods.extraModifiers,
  }
}

/** 找出文档里所有图片语法（跳过 front-matter 之外的代码围栏内的行） */
export function findImageTokens(markdown: string): ParsedImage[] {
  const md = String(markdown ?? '')
  const lines = scanLinesDetailed(md)
  const out: ParsedImage[] = []
  for (const info of lines) {
    if (info.insideFence || info.isFence) continue
    if (!info.text.includes('![')) continue
    for (const token of matchImageTokensInLine(info.text)) out.push(buildParsedImage(md, info, token))
  }
  return out
}

/**
 * 光标行附近解析图片：从目标行开始，按「本行 → 上一行 → 下一行 → 再远」顺序找，
 * 跳过代码围栏内/围栏行。默认容差 1 行（光标在图片行上下 1 行都能命中）。
 */
export function parseImageAtLine(markdown: string, line1: number, tolerance = 1): ParsedImage | null {
  const md = String(markdown ?? '')
  if (!md) return null
  const lines = scanLinesDetailed(md)
  const total = lines.length
  const target = clamp(Math.round(line1 || 1), 1, total)
  const tol = Math.max(0, Math.floor(tolerance))
  const deltas: number[] = [0]
  for (let d = 1; d <= tol; d++) {
    deltas.push(-d, d)
  }
  for (const delta of deltas) {
    const lineNo = target + delta
    if (lineNo < 1 || lineNo > total) continue
    const info = lines[lineNo - 1]
    if (info.insideFence || info.isFence) continue
    if (!info.text.includes('![')) continue
    const tokens = matchImageTokensInLine(info.text)
    if (!tokens.length) continue
    // 同一行多张图：优先含 bg 的背景图（编辑背景图意图更强），否则第一张
    const bg = tokens.find((t) => parseAltModifiers(t.alt).kind === 'background')
    return buildParsedImage(md, info, bg || tokens[0])
  }
  return null
}

/**
 * 用 snippet 原位替换图片语法（保留前后文与行尾换行）。
 * 若入参 image 的 range 已因内容变化失效，会在原行附近/全文按相同 path 重新定位。
 */
export function replaceImageAt(markdown: string, image: ParsedImage, snippet: string): string {
  const md = String(markdown ?? '')
  const block = String(snippet || '').trim()
  if (!block || !image) return md
  let { start, end } = image
  const rangeValid =
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    end <= md.length &&
    start < end &&
    md.slice(start, end) === image.raw
  let target: ParsedImage | null = null
  if (!rangeValid) {
    target =
      parseImageAtLine(md, image.line, 1) ||
      findImageTokens(md).find((t) => t.path === image.path && t.raw === image.raw) ||
      findImageTokens(md).find((t) => t.path === image.path) ||
      null
    if (!target) return md
    start = target.start
    end = target.end
  }
  return `${md.slice(0, start)}${block}${md.slice(end)}`
}
