/**
 * 极简 front-matter 工具：读取/修改 `theme`，统计页数与光标页。
 * 只处理 Marp 文档常见的扁平 key: value，不引入 YAML 依赖。
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

export function parseFrontMatter(markdown: string): FrontMatterInfo {
  const m = FM_RE.exec(markdown)
  if (!m) return { exists: false, start: 0, end: 0, raw: '', data: {} }
  const data: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim())
    if (mm) data[mm[1]] = mm[2].replace(/^['"]|['"]$/g, '').trim()
  }
  return { exists: true, start: 0, end: m[0].length, raw: m[0], data }
}

export function getMarkdownTheme(markdown: string): string | null {
  const theme = parseFrontMatter(markdown).data.theme
  return theme && theme.trim() ? theme.trim() : null
}

export function setMarkdownTheme(markdown: string, theme: string): string {
  const fm = parseFrontMatter(markdown)
  if (!fm.exists) {
    return `---\nmarp: true\ntheme: ${theme}\n---\n\n${markdown}`
  }
  const inner = fm.raw.replace(/^---[ \t]*\r?\n/, '').replace(/\r?\n---[ \t]*(?:\r?\n)?$/, '')
  const lines = inner.split(/\r?\n/)
  let found = false
  for (let i = 0; i < lines.length; i++) {
    if (/^theme\s*:/.test(lines[i])) {
      lines[i] = `theme: ${theme}`
      found = true
      break
    }
  }
  if (!found) lines.push(`theme: ${theme}`)
  return `---\n${lines.join('\n')}\n---\n\n${markdown.slice(fm.end).replace(/^\r?\n/, '')}`
}

export function isMarpDocument(markdown: string): boolean {
  const data = parseFrontMatter(markdown).data
  return String(data.marp).toLowerCase() === 'true'
}

/** 导入非 Marp Markdown 时补 front-matter（保留原内容） */
export function ensureMarpDocument(markdown: string, theme: string): string {
  if (isMarpDocument(markdown)) return markdown
  if (parseFrontMatter(markdown).exists) {
    const fm = parseFrontMatter(markdown)
    const inner = fm.raw.replace(/^---[ \t]*\r?\n/, '').replace(/\r?\n---[ \t]*(?:\r?\n)?$/, '')
    const lines = inner.split(/\r?\n/).filter((l) => l.trim() !== '')
    lines.push('marp: true')
    if (!lines.some((l) => /^theme\s*:/.test(l))) lines.push(`theme: ${theme}`)
    return `---\n${lines.join('\n')}\n---\n\n${markdown.slice(fm.end).replace(/^\r?\n/, '')}`
  }
  return `---\nmarp: true\ntheme: ${theme}\n---\n\n${markdown}`
}

interface ScanResult {
  /** 每页起始行号（1-based）；第一页为 1 */
  pageStarts: number[]
}

/** 跳过 front-matter 与代码围栏，找出 `---` 分页行 */
export function scanSlides(markdown: string): ScanResult {
  const lines = markdown.split(/\r?\n/)
  const fm = parseFrontMatter(markdown)
  const fmLineCount = fm.exists ? fm.raw.split(/\r?\n/).length - 1 : 0
  const pageStarts = [fmLineCount + 1]
  let inFence = false
  for (let i = fmLineCount; i < lines.length; i++) {
    const text = lines[i].trim()
    if (/^(```|~~~)/.test(text)) inFence = !inFence
    if (inFence) continue
    if (/^-{3,}$/.test(text) && i > fmLineCount) {
      pageStarts.push(i + 2) // 分页线下一行是下一页起始（1-based）
    }
  }
  return { pageStarts }
}

export function countSlides(markdown: string): number {
  return scanSlides(markdown).pageStarts.length
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
