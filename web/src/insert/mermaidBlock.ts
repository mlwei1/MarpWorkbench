/**
 * Mermaid 代码块定位 + `%% mwb-size` 尺寸指令工具（M5.0，契约 docs/UI_CONTRACT_M5_MERMAID.md §2.4）
 *
 * - `findMermaidBlockAtLine`：光标在 ```mermaid / ```mmd 代码块内（±tolerance 行）时返回精确块信息，
 *   用于「编辑 Mermaid 图表」原位替换；未闭合/其它语言 fence 会被正确跳过。
 * - 尺寸指令写在代码块前 5 行内（推荐第 1 行），mermaid 会当注释忽略；指令行保留在源码中便于下次编辑。
 */
export type MermaidSizePreset = 'auto' | 's' | 'm' | 'l' | 'xl' | 'custom'

export interface MermaidSizeState {
  preset: MermaidSizePreset
  /** 仅 preset === 'custom' 时有效，如 '70%' / '900px' */
  customValue?: string
}

export interface MermaidBlockRef {
  /** 代码块起始 offset（包含 fence 起始行） */
  from: number
  /** 代码块结束 offset（包含 fence 结束行，不含行尾换行） */
  to: number
  /** fence 起始行（1-based） */
  line: number
  /** 不含 fence 的 mermaid 源码（保留 `%% mwb-size` 行） */
  code: string
  preset: MermaidSizePreset
  customValue?: string
}

const SIZE_DIRECTIVE_RE = /^\s*%%\s*mwb-size\s*:\s*(.+?)\s*$/i

/** fence info string 是否为 mermaid/mmd */
export function isMermaidLang(info: string): boolean {
  const lang = (info || '').trim().split(/\s+/)[0]?.toLowerCase() || ''
  return lang === 'mermaid' || lang === 'mmd'
}

function clampInt(n: number, min: number, max: number): number {
  return Math.min(Math.max(1, Math.round(n) || 1), Math.max(min, max))
}

/** 归一化尺寸指令值（大小写不敏感，支持别名字符串）；非法值返回 auto */
export function normalizeMermaidSize(value: string | null | undefined): MermaidSizeState {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return { preset: 'auto' }
  if (raw === 'auto' || raw === '自动') return { preset: 'auto' }
  if (['s', 'small', '小'].includes(raw)) return { preset: 's' }
  if (['m', 'medium', '中'].includes(raw)) return { preset: 'm' }
  if (['l', 'large', '大'].includes(raw)) return { preset: 'l' }
  if (['xl', 'xlarge', '超大'].includes(raw)) return { preset: 'xl' }
  const pct = /^(\d{1,3})\s*%$/.exec(raw)
  if (pct) {
    const n = clampInt(Number(pct[1]), 1, 100)
    return { preset: 'custom', customValue: `${n}%` }
  }
  const px = /^(\d{3,4})\s*px$/.exec(raw)
  if (px) {
    const n = clampInt(Number(px[1]), 200, 1200)
    return { preset: 'custom', customValue: `${n}px` }
  }
  return { preset: 'auto' }
}

/** 解析代码中的尺寸指令（只看前 5 行；返回去掉指令后的代码） */
export function parseMermaidSizeDirective(code: string): {
  size: MermaidSizeState
  codeWithoutDirective: string
  directiveFound: boolean
} {
  const lines = (code || '').split('\n')
  const limit = Math.min(lines.length, 5)
  for (let i = 0; i < limit; i++) {
    const m = SIZE_DIRECTIVE_RE.exec(lines[i])
    if (!m) continue
    lines.splice(i, 1)
    return { size: normalizeMermaidSize(m[1]), codeWithoutDirective: lines.join('\n'), directiveFound: true }
  }
  return { size: { preset: 'auto' }, codeWithoutDirective: code, directiveFound: false }
}

/** 去掉尺寸指令行（预览/编辑框展示用） */
export function stripMermaidSizeDirective(code: string): string {
  return parseMermaidSizeDirective(code).codeWithoutDirective
}

/** 把尺寸状态序列化为指令值；auto → null（不写指令） */
export function serializeMermaidSize(size: MermaidSizeState): string | null {
  switch (size.preset) {
    case 'auto':
      return null
    case 's':
    case 'm':
    case 'l':
    case 'xl':
      return size.preset
    case 'custom': {
      const raw = String(size.customValue || '').trim().toLowerCase()
      const pct = /^(\d{1,3})\s*%$/.exec(raw)
      if (pct) return `${clampInt(Number(pct[1]), 1, 100)}%`
      const px = /^(\d{3,4})\s*px$/.exec(raw)
      if (px) return `${clampInt(Number(px[1]), 200, 1200)}px`
      const bare = /^\d{1,3}$/.exec(raw)
      if (bare) return `${clampInt(Number(raw), 1, 100)}%`
      return null
    }
    default:
      return null
  }
}

/** 代码 + 尺寸状态 → 含尺寸指令的 mermaid 源码（替换已有指令，不重复） */
export function applyMermaidSizeDirective(code: string, size: MermaidSizeState): string {
  const base = stripMermaidSizeDirective(code).replace(/\s+$/g, '')
  const directive = serializeMermaidSize(size)
  return directive ? `${directive ? `%% mwb-size: ${directive}` : ''}\n${base}` : base
}

/** 用 fence 包裹源码（源码已包含尺寸指令时直接包裹，不再重复添加） */
export function buildMermaidFence(code: string): string {
  const body = (code || '').replace(/\s+$/g, '')
  return `\`\`\`mermaid\n${body}\n\`\`\``
}

/** 源码 + 尺寸 → 可插入/替换的完整 Markdown 片段 */
export function buildMermaidSnippet(code: string, size: MermaidSizeState): string {
  return buildMermaidFence(applyMermaidSizeDirective(code, size))
}

interface FenceBlock {
  openLine: number // 0-based
  closeLine: number // 0-based
  info: string
}

/** 扫描 Markdown 中所有已闭合的 fence（未闭合的忽略） */
function scanFences(markdown: string): FenceBlock[] {
  const lines = markdown.split('\n')
  const blocks: FenceBlock[] = []
  let open: { char: '`' | '~'; len: number; openLine: number; info: string } | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!open) {
      const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line)
      if (!m) continue
      open = { char: m[2][0] as '`' | '~', len: m[2].length, openLine: i, info: m[3].trim() }
      continue
    }
    const charRe = open.char === '`' ? '`' : '~'
    const closeRe = new RegExp(`^ {0,3}${charRe}{${open.len},}\\s*$`)
    if (closeRe.test(line)) {
      blocks.push({ openLine: open.openLine, closeLine: i, info: open.info })
      open = null
    }
  }
  return blocks
}

/**
 * 光标所在行 ±tolerance 命中 ```mermaid / ```mmd 代码块（fence 内也算）时返回块信息；
 * 未命中返回 null。返回的 from/to 精确到原 Markdown 字符（用于原位替换）。
 */
export function findMermaidBlockAtLine(markdown: string, line1: number, tolerance = 1): MermaidBlockRef | null {
  if (!markdown) return null
  const lines = markdown.split('\n')
  const lineStarts: number[] = []
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    lineStarts.push(offset)
    offset += lines[i].length + 1 // + '\n'
  }
  const cursorLine = clampInt(line1, 1, lines.length)
  const tol = Math.max(0, Math.round(tolerance) || 0)

  for (const block of scanFences(markdown)) {
    if (!isMermaidLang(block.info)) continue
    const openLineNo = block.openLine + 1
    const closeLineNo = block.closeLine + 1
    if (cursorLine < openLineNo - tol || cursorLine > closeLineNo + tol) continue
    const code = lines.slice(block.openLine + 1, block.closeLine).join('\n')
    const { size } = parseMermaidSizeDirective(code)
    const from = lineStarts[block.openLine]
    const to = lineStarts[block.closeLine] + lines[block.closeLine].length
    return {
      from,
      to,
      line: openLineNo,
      code,
      preset: size.preset,
      ...(size.customValue ? { customValue: size.customValue } : {}),
    }
  }
  return null
}
