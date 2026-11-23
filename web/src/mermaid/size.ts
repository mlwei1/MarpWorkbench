/**
 * Mermaid 图表尺寸指令（契约 `docs/UI_CONTRACT_M5_MERMAID.md` §1）
 *
 * 用户诉求：「现在的图太小了」，所以要：
 * 1) 默认取消 mermaid 自然宽度上限（小图放大到容器宽度，见 replace.ts 的 cleanupMermaidSvg）；
 * 2) 支持在 mermaid 代码块内用注释行指定每张图大小：
 *
 *   ```mermaid
 *   %% mwb-size: xl
 *   graph LR
 *     A[开始] --> B[结束]
 *   ```
 *
 * - 指令必须在代码块**前 5 行内**（推荐第 1 行）；大小写不敏感；非法值回退 `auto`。
 * - mermaid 把 `%%` 开头的行当注释忽略，因此指令行可以一直留在源码里（编辑时可见、可改）。
 * - 支持别名：s/small/小、m/medium/中、l/large/大、xl/xlarge/超大、auto/自动；
 *   自定义：`NN%`（1–100，推荐 ≥10）或 `NNNpx`（200–1200）。
 */

export type MermaidSizePreset = 'auto' | 's' | 'm' | 'l' | 'xl' | 'custom'

export interface MermaidSize {
  preset: MermaidSizePreset
  /** 中文显示名（对话框下拉用） */
  label: string
  /** SVG 的 CSS max-width 值，如 '100%' / '60%' / '900px' */
  maxWidth: string
  /** SVG 的 CSS max-height（px），480/540/560/640 或自定义时默认 560 */
  maxHeightPx: number
  /** 要写进 Markdown 的指令值（auto 时为 undefined） */
  directiveValue?: string
}

/** 默认预设表（契约 §1.2）：max-height 依据 16:9 slide 内容区高度设计 */
const PRESET_DEFS: Record<'auto' | 's' | 'm' | 'l' | 'xl', { label: string; maxWidth: string; maxHeightPx: number }> = {
  auto: { label: '自动（推荐）', maxWidth: '100%', maxHeightPx: 560 },
  s: { label: '小', maxWidth: '60%', maxHeightPx: 480 },
  m: { label: '中', maxWidth: '80%', maxHeightPx: 540 },
  l: { label: '大', maxWidth: '100%', maxHeightPx: 560 },
  xl: { label: '超大', maxWidth: '100%', maxHeightPx: 640 },
}

/** 自定义尺寸（% / px）的上限，超出视为非法 → 回退 auto */
export const MERMAID_CUSTOM_PERCENT_MIN = 1
export const MERMAID_CUSTOM_PERCENT_MAX = 100
export const MERMAID_CUSTOM_PX_MIN = 200
export const MERMAID_CUSTOM_PX_MAX = 1200

/** 指令行正则：%% mwb-size: <value>（行首可有空白；值可带空格） */
const DIRECTIVE_RE = /^\s*%%\s*mwb-size\s*:\s*(.+?)\s*$/i
/** 只扫描代码块前 N 行（契约 §1.2） */
export const MERMAID_SIZE_SCAN_LINES = 5

const ALIASES: Record<string, 'auto' | 's' | 'm' | 'l' | 'xl'> = {
  auto: 'auto',
  '自动': 'auto',
  s: 's',
  small: 's',
  '小': 's',
  m: 'm',
  medium: 'm',
  '中': 'm',
  l: 'l',
  large: 'l',
  '大': 'l',
  xl: 'xl',
  xlarge: 'xl',
  '超大': 'xl',
}

function autoSize(): MermaidSize {
  return { preset: 'auto', ...PRESET_DEFS.auto }
}

function presetSize(preset: 'auto' | 's' | 'm' | 'l' | 'xl'): MermaidSize {
  return { preset, ...PRESET_DEFS[preset], directiveValue: preset === 'auto' ? undefined : preset }
}

function customSize(maxWidth: string, directiveValue: string): MermaidSize {
  return {
    preset: 'custom',
    label: `自定义 ${directiveValue}`,
    maxWidth,
    maxHeightPx: PRESET_DEFS.auto.maxHeightPx,
    directiveValue,
  }
}

/**
 * 解析单个指令值 → MermaidSize；非法返回 null（由调用方回退 auto）。
 * 说明：百分比放宽到 1–100（对话框自定义输入范围 1–100），<10% 虽小但允许；px 严格 200–1200。
 */
export function parseMermaidSizeValue(rawValue: string): MermaidSize | null {
  const value = String(rawValue ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
  if (!value) return null

  const percent = /^(\d{1,3})%$/.exec(value)
  if (percent) {
    const n = Number(percent[1])
    if (!Number.isFinite(n) || n < MERMAID_CUSTOM_PERCENT_MIN || n > MERMAID_CUSTOM_PERCENT_MAX) return null
    return customSize(`${n}%`, `${n}%`)
  }

  const px = /^(\d{1,4})px$/.exec(value)
  if (px) {
    const n = Number(px[1])
    if (!Number.isFinite(n) || n < MERMAID_CUSTOM_PX_MIN || n > MERMAID_CUSTOM_PX_MAX) return null
    return customSize(`${n}px`, `${n}px`)
  }

  const alias = ALIASES[value]
  return alias ? presetSize(alias) : null
}

/** 在代码块前 5 行内找 `%% mwb-size:` 指令行；返回 { lineIndex, value } 或 null */
export function findMermaidSizeDirective(code: string): { lineIndex: number; rawValue: string } | null {
  const lines = String(code ?? '').split(/\r?\n/)
  const limit = Math.min(lines.length, MERMAID_SIZE_SCAN_LINES)
  for (let i = 0; i < limit; i++) {
    const match = DIRECTIVE_RE.exec(lines[i])
    if (match) return { lineIndex: i, rawValue: match[1].trim() }
  }
  return null
}

/**
 * 解析 mermaid 源码里的尺寸指令。
 * 无指令 / 非法值 / 超出范围 → `auto`（默认放大后的新样式）。
 */
export function parseMermaidSize(code: string): MermaidSize {
  const directive = findMermaidSizeDirective(code)
  if (!directive) return autoSize()
  return parseMermaidSizeValue(directive.rawValue) ?? autoSize()
}

/**
 * 生成要写进 Markdown 的指令值。
 * - `auto` → `null`（不写指令，保持默认）
 * - s/m/l/xl → 规范值 's' | 'm' | 'l' | 'xl'
 * - custom → 校验 `customValue`（'70%' / '900px'）；非法返回 `null`
 */
export function serializeMermaidSize(preset: MermaidSizePreset, customValue?: string): string | null {
  if (preset === 'auto') return null
  if (preset === 's' || preset === 'm' || preset === 'l' || preset === 'xl') return preset
  if (preset !== 'custom') return null
  const parsed = parseMermaidSizeValue(customValue ?? '')
  return parsed && parsed.preset === 'custom' ? (parsed.directiveValue ?? null) : null
}

/** 对话框尺寸下拉选项（契约 §1.3） */
export function getMermaidSizeOptions(): { value: string; label: string }[] {
  return [
    { value: 'auto', label: '自动（推荐）' },
    { value: 's', label: '小' },
    { value: 'm', label: '中' },
    { value: 'l', label: '大' },
    { value: 'xl', label: '超大' },
    { value: 'custom', label: '自定义' },
  ]
}

/** 去掉指令行（统计字数/预览调试用）；无指令时原样返回 */
export function stripMermaidSizeDirective(code: string): string {
  const source = String(code ?? '')
  const directive = findMermaidSizeDirective(source)
  if (!directive) return source
  const lines = source.split(/\r?\n/)
  lines.splice(directive.lineIndex, 1)
  return lines.join('\n')
}
