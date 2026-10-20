/**
 * Marp Markdown front-matter / 指令工具（M2 扩展）
 *
 * 设计原则（契约 §2.2）：
 * - 只改目标字段：保留未知 front-matter 字段、原顺序与注释；
 * - 所有操作返回新字符串（纯函数），不重新格式化整篇文档；
 * - 页内指令写标准 Marp 形式 `<!-- _class: lead -->`（多行注释也兼容）。
 */

export interface FrontMatterInfo {
  exists: boolean
  /** 完整匹配到的 front-matter 块（含首尾 ---）在文中的起止 offset */
  start: number
  end: number
  raw: string
  data: Record<string, string>
}

const FM_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

function parseYamlValue(raw: string): string {
  const v = raw.trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    const inner = v.slice(1, -1)
    if (v.startsWith('"')) {
      try {
        return JSON.parse(v) as string
      } catch {
        return inner
      }
    }
    return inner.replace(/''/g, "'")
  }
  return v
}

export function parseFrontMatter(markdown: string): FrontMatterInfo {
  const m = FM_RE.exec(markdown)
  if (!m) return { exists: false, start: 0, end: 0, raw: '', data: {} }
  const data: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim())
    if (mm) data[mm[1]] = parseYamlValue(mm[2])
  }
  return { exists: true, start: 0, end: m[0].length, raw: m[0], data }
}

/** 读取 front-matter 扁平字段（字符串值，去引号） */
export function getFrontMatterData(markdown: string): Record<string, string> {
  return parseFrontMatter(markdown).data
}

export function getMarkdownTheme(markdown: string): string | null {
  const theme = parseFrontMatter(markdown).data.theme
  return theme && theme.trim() ? theme.trim() : null
}

// ---------------- 内部行工具 ----------------

interface LinesDoc {
  lines: string[]
  eol: string
}

function splitDoc(markdown: string): LinesDoc {
  return { lines: markdown.split(/\r?\n/), eol: markdown.includes('\r\n') ? '\r\n' : '\n' }
}

function joinDoc(doc: LinesDoc): string {
  return doc.lines.join(doc.eol)
}

interface FmBounds {
  open: number
  close: number
}

/** front-matter 在 lines 数组中的首尾行下标（0-based，含首尾 ---） */
function frontMatterBounds(lines: string[]): FmBounds | null {
  if (lines.length < 2) return null
  if (lines[0].trim() !== '---') return null
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return { open: 0, close: i }
  }
  return null
}

function isFence(line: string): boolean {
  return /^\s*(```|~~~)/.test(line)
}

function isSeparator(line: string): boolean {
  return /^\s*-{3,}\s*$/.test(line)
}

/** 每页起始行下标（0-based，指向页内容第一行；第一页在 front-matter 之后） */
function pageStartIndexes(lines: string[]): number[] {
  const fm = frontMatterBounds(lines)
  const first = fm ? fm.close + 1 : 0
  const starts = [first]
  let inFence = false
  for (let i = first; i < lines.length; i++) {
    if (isFence(lines[i])) inFence = !inFence
    if (inFence) continue
    if (isSeparator(lines[i])) starts.push(i + 1)
  }
  return starts
}

/** 页内容实际起点：跳过页首空行，返回第一个非空行下标（空页返回页起点） */
function pageContentStart(lines: string[], page: number): number {
  const starts = pageStartIndexes(lines)
  const idx = Math.min(Math.max(page - 1, 0), starts.length - 1)
  let i = starts[idx]
  while (i < lines.length && lines[i].trim() === '') i++
  // 不要越过下一页
  const next = starts[idx + 1]
  if (next != null && i >= next) return starts[idx]
  return Math.min(i, Math.max(lines.length - 1, 0))
}

interface DirectiveLine {
  lineIndex: number
  key: string
  value: string
  /** 该行所属注释块的首尾行下标（0-based，含 <!-- 与 -->） */
  blockStart: number
  blockEnd: number
  /** 注释块是否只有这一行（单行注释） */
  singleLine: boolean
}

/** 扫描某页页首的 `<!-- _key: value -->` 指令块（支持多行注释） */
function scanPageDirectives(lines: string[], page: number): { blocks: Array<{ start: number; end: number }>; directives: DirectiveLine[] } {
  const contentStart = pageContentStart(lines, page)
  const blocks: Array<{ start: number; end: number }> = []
  const directives: DirectiveLine[] = []
  let i = contentStart
  // 允许页首存在空行
  while (i < lines.length && lines[i].trim() === '') i++
  while (i < lines.length) {
    const trimmed = lines[i].trim()
    if (!trimmed.startsWith('<!--')) break
    const blockStart = i
    let blockEnd = i
    if (!trimmed.includes('-->')) {
      let j = i + 1
      while (j < lines.length && !lines[j].includes('-->')) j++
      blockEnd = Math.min(j, lines.length - 1)
    }
    blocks.push({ start: blockStart, end: blockEnd })
    for (let k = blockStart; k <= blockEnd; k++) {
      let text = lines[k]
      text = text.replace(/^\s*<!--\s*/, '').replace(/\s*-->\s*$/, '')
      text = text.replace(/^\s*\*\s?/, '') // 兼容 /* 风格? 不需要，但容错
      const mm = /^\s*_([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(text)
      if (mm) {
        directives.push({
          lineIndex: k,
          key: mm[1],
          value: parseYamlValue(mm[2]),
          blockStart,
          blockEnd,
          singleLine: blockStart === blockEnd,
        })
      }
    }
    i = blockEnd + 1
  }
  return { blocks, directives }
}

/** 写 front-matter 字段：value=null 删除；保留未知字段/顺序/注释 */
export function setFrontMatterField(markdown: string, key: string, value: string | null): string {
  const doc = splitDoc(markdown)
  const { lines, eol } = doc
  const bounds = frontMatterBounds(lines)

  const formatValue = (v: string): string => {
    const clean = v.replace(/[\r\n]+/g, ' ').trim()
    if (clean === '') return '""'
    // 简单安全值（中文/字母/数字/空格/常见标点）不加引号
    if (/^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5 .,;:!?%/()+\-*&@#$^~|='"<>\[\]{}]*$/.test(clean) && !/:\s|^\s|\s$|^[-?]|^#/.test(clean)) {
      return clean
    }
    return JSON.stringify(clean)
  }

  if (!bounds) {
    if (value === null) return markdown
    const head = ['---', 'marp: true']
    if (key !== 'marp' && key !== 'theme') head.push(`theme: ${getMarkdownTheme(markdown) || 'default'}`)
    head.push(`${key}: ${formatValue(value)}`, '---', '')
    const body = lines.filter((l, i) => !(i === 0 && l === '')).join(eol)
    return head.join(eol) + (body ? eol + body : '')
  }

  const { open, close } = bounds
  const body = lines.slice(open + 1, close)
  let found = -1
  let indent = ''
  for (let i = 0; i < body.length; i++) {
    const mm = /^(\s*)([A-Za-z0-9_-]+)\s*:/.exec(body[i])
    if (mm && mm[2] === key) {
      found = i
      indent = mm[1]
      break
    }
  }

  if (value === null) {
    if (found < 0) return markdown
    body.splice(found, 1)
  } else if (found >= 0) {
    body[found] = `${indent}${key}: ${formatValue(value)}`
  } else {
    body.push(`${key}: ${formatValue(value)}`)
  }

  const nextLines = [...lines.slice(0, open + 1), ...body, ...lines.slice(close)]
  doc.lines = nextLines
  return joinDoc(doc)
}

/** 兼容旧接口：设置 theme */
export function setMarkdownTheme(markdown: string, theme: string): string {
  return setFrontMatterField(markdown, 'theme', theme)
}

export function isMarpDocument(markdown: string): boolean {
  const data = parseFrontMatter(markdown).data
  return String(data.marp).toLowerCase() === 'true'
}

/** 导入非 Marp Markdown 时补 front-matter（保留原内容） */
export function ensureMarpDocument(markdown: string, theme: string): string {
  if (isMarpDocument(markdown)) return markdown
  let out = setFrontMatterField(markdown, 'marp', 'true')
  if (!getMarkdownTheme(out)) out = setFrontMatterField(out, 'theme', theme)
  return out
}

// ---------------- 分页 ----------------

/** 页起始行（页内容第一行，1-based；空页返回页起点行） */
export function pageStartLine(markdown: string, page: number): number {
  const { lines } = splitDoc(markdown)
  if (lines.length === 0) return 1
  const idx = pageContentStart(lines, page)
  return Math.min(idx + 1, lines.length)
}

/** 第几页（1-based），兼容旧接口 */
export function countSlides(markdown: string): number {
  return scanSlides(markdown).pageStarts.length
}

interface ScanResult {
  pageStarts: number[]
}

/** 跳过 front-matter 与代码围栏，找出 `---` 分页行（1-based 页起点） */
export function scanSlides(markdown: string): ScanResult {
  const { lines } = splitDoc(markdown)
  const starts = pageStartIndexes(lines).map((i) => i + 1)
  return { pageStarts: starts }
}

/** 光标所在行（1-based）→ 第几页（1-based） */
export function slideIndexAtLine(markdown: string, line1: number): number {
  if (!markdown.trim()) return 1
  const { pageStarts } = scanSlides(markdown)
  let index = 1
  for (let i = 0; i < pageStarts.length; i++) {
    if (line1 >= pageStarts[i]) index = i + 1
  }
  return index
}

// ---------------- 页内指令 ----------------

/** 读取某页页首指令值（如 class/paginate/header/footer），不存在返回 null */
export function getSlideDirective(markdown: string, page: number, key: string): string | null {
  const { lines } = splitDoc(markdown)
  const { directives } = scanPageDirectives(lines, page)
  const hit = directives.filter((d) => d.key === key).pop()
  return hit ? hit.value : null
}

/** 写入/删除某页页首指令 `<!-- _key: value -->`；value=null 删除 */
export function setSlideDirective(markdown: string, page: number, key: string, value: string | null): string {
  const doc = splitDoc(markdown)
  const { lines, eol } = doc
  const { directives } = scanPageDirectives(lines, page)
  const hit = directives.filter((d) => d.key === key).pop()

  if (hit) {
    const block = { start: hit.blockStart, end: hit.blockEnd }
    if (value === null) {
      if (hit.singleLine) {
        // 单行注释：整行删除
        lines.splice(block.start, block.end - block.start + 1)
      } else {
        // 多行注释：删除该指令行；若注释内无其它指令则删整个注释
        const others = directives.filter(
          (d) => d.blockStart === block.start && d.lineIndex !== hit.lineIndex,
        )
        if (others.length === 0) {
          lines.splice(block.start, block.end - block.start + 1)
        } else {
          lines.splice(hit.lineIndex, 1)
        }
      }
    } else {
      const clean = inlineValue(value)
      if (hit.singleLine) {
        lines[hit.lineIndex] = `<!-- _${key}: ${clean} -->`
      } else {
        const indent = /^\s*/.exec(lines[hit.lineIndex])?.[0] ?? ''
        lines[hit.lineIndex] = `${indent}_${key}: ${clean}`
      }
    }
    doc.lines = trimExtraBlankLines(lines, page, eol)
    return joinDoc(doc)
  }

  if (value === null) return markdown

  // 不存在：插入到已有指令块之后（若没有指令块则放在页首）
  const contentStart = pageContentStart(lines, page)
  let insertAt = contentStart
  let i = contentStart
  while (i < lines.length && lines[i].trim() === '') i++
  while (i < lines.length && lines[i].trim().startsWith('<!--')) {
    let end = i
    if (!lines[i].includes('-->')) {
      let j = i + 1
      while (j < lines.length && !lines[j].includes('-->')) j++
      end = Math.min(j, lines.length - 1)
    }
    insertAt = end + 1
    i = end + 1
    while (i < lines.length && lines[i].trim() === '') i++
  }
  lines.splice(insertAt, 0, `<!-- _${key}: ${inlineValue(value)} -->`)
  doc.lines = lines
  return joinDoc(doc)
}

function inlineValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/-->/g, '--&gt;').trim()
}

/** 删除指令后可能出现的连续空行（最多保留一个） */
function trimExtraBlankLines(lines: string[], _page: number, _eol: string): string[] {
  const out: string[] = []
  for (const line of lines) {
    if (line.trim() === '' && out.length > 0 && out[out.length - 1].trim() === '') continue
    out.push(line)
  }
  return out
}

/** 在页首（已有指令之后、正文之前）插入一段 Markdown 片段 */
export function insertAtPageStart(markdown: string, page: number, snippet: string): string {
  const doc = splitDoc(markdown)
  const { lines, eol } = doc
  const contentStart = pageContentStart(lines, page)
  let insertAt = contentStart
  let i = contentStart
  while (i < lines.length && lines[i].trim() === '') i++
  while (i < lines.length && lines[i].trim().startsWith('<!--')) {
    let end = i
    if (!lines[i].includes('-->')) {
      let j = i + 1
      while (j < lines.length && !lines[j].includes('-->')) j++
      end = Math.min(j, lines.length - 1)
    }
    insertAt = end + 1
    i = end + 1
    while (i < lines.length && lines[i].trim() === '') i++
  }

  const block = snippet.split(/\r?\n/).filter((l, idx, arr) => !(l === '' && idx === arr.length - 1))
  const before = lines[insertAt - 1]
  const after = lines[insertAt]
  const prefix: string[] = []
  if (before !== undefined && before.trim() !== '' && !isSeparator(before)) {
    // 与上一行内容之间留空行（页首通常无需）
    prefix.push('')
  }
  const suffix: string[] = []
  if (after !== undefined && after.trim() !== '') suffix.push('')
  lines.splice(insertAt, 0, ...prefix, ...block, ...suffix)
  doc.lines = lines
  return joinDoc(doc)
}

// ---------------- 图片指令 ----------------

export interface ImageDirective {
  page: number
  /** 完整 Markdown 图片语法 */
  raw: string
  /** 图片路径（assets/x.png 或 URL） */
  path: string
  /** alt 文本拆出的修饰符，如 ['bg','left:40%','opacity:.5'] */
  modifiers: string[]
  /** 在全文中的字符 offset */
  offset: number
  /** 所在行号（1-based） */
  line: number
}

const IMAGE_RE = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g

/** 找出文档中所有图片指令（含 bg/w 修饰符） */
export function findImageDirectives(markdown: string): ImageDirective[] {
  const { lines } = splitDoc(markdown)
  const result: ImageDirective[] = []
  let lineOffset = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    IMAGE_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = IMAGE_RE.exec(line)) !== null) {
      const alt = m[1].trim()
      const modifiers = alt ? alt.split(/\s+/).filter(Boolean) : []
      result.push({
        page: slideIndexAtLine(markdown, i + 1),
        raw: m[0],
        path: m[2],
        modifiers,
        offset: lineOffset + m.index,
        line: i + 1,
      })
    }
    lineOffset += line.length + 1
  }
  return result
}

/** 替换/删除指定图片指令（按 offset 精确定位；newRaw=null 删除） */
export function replaceImageDirective(markdown: string, offset: number, newRaw: string | null): string {
  const directives = findImageDirectives(markdown)
  const hit = directives.find((d) => d.offset === offset)
  if (!hit) return markdown
  if (newRaw === null) {
    // 若整行只有这条图片语法则删整行（含换行），否则只删片段
    const lineStart = markdown.lastIndexOf('\n', offset - 1) + 1
    const lineEndIdx = markdown.indexOf('\n', offset)
    const lineEnd = lineEndIdx === -1 ? markdown.length : lineEndIdx
    const lineText = markdown.slice(lineStart, lineEnd)
    if (lineText.trim() === hit.raw.trim()) {
      const cutStart = lineStart
      const cutEnd = lineEndIdx === -1 ? markdown.length : lineEndIdx + 1
      return markdown.slice(0, cutStart) + markdown.slice(cutEnd)
    }
    return markdown.slice(0, offset) + markdown.slice(offset + hit.raw.length)
  }
  return markdown.slice(0, offset) + newRaw + markdown.slice(offset + hit.raw.length)
}

/** 当前页的背景图（修饰符含 bg） */
export function getPageBackground(markdown: string, page: number): ImageDirective | null {
  const hits = findImageDirectives(markdown).filter(
    (d) => d.page === page && d.modifiers.some((m) => m === 'bg' || m.startsWith('bg')),
  )
  return hits.length ? hits[hits.length - 1] : null
}

/** 组合图片指令（用于属性面板改适配/透明度） */
export function buildImageDirective(path: string, modifiers: string[]): string {
  const alt = modifiers.join(' ')
  return alt ? `![${alt}](${path})` : `![](${path})`
}
