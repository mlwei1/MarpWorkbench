/**
 * DOM → 可编辑 PPTX：布局测量（`measureDeckForEditablePptx`）
 *
 * 契约：docs/UI_CONTRACT_M4_PPTX_EDITABLE.md §2.1
 *
 * 流程：
 *   1. 创建离屏隐藏 iframe（width=deck 宽、height=deck 高、visibility:hidden、left:-10000px），
 *      srcdoc 注入 `html` + `css`（资源必须已由调用方 inline 成 dataURL）；
 *   2. 等待 load / document.fonts.ready / 布局稳定；尝试在 iframe 内加载 `/marp-core.browser.js`
 *      并调用 `browser()`（与服务端 capture 页一致的 auto-scaling），保证 DOM 几何 = 底图几何；
 *   3. 逐 `svg[data-marpit-svg]` 取内容 `section`，递归抽取文本块（runs/li 项目符号/pre 逐 span 颜色/
 *      <br>/内联 code 底色）与表格块（colW/rowH/fill/bold/border）；
 *   4. 生成 `backgroundCss` = 主题 CSS + 文字透明/表格隐藏/Mermaid 恢复覆盖样式（见 css.ts）。
 *
 * 纯前端模块，不依赖 Vue / pptxgenjs；可在浏览器页面与 puppeteer 测试页中运行。
 * 所有几何坐标最终都换算到「标称页面坐标系」：px，页面 = width × height（1280×720 / 960×720）。
 */
import { buildBackgroundCss } from './css'
import type {
  EditableRun,
  EditableTableBlock,
  EditableTableCell,
  EditableTextBlock,
  MeasureContext,
  MeasureOptions,
  MeasuredDeck,
  SlideEditableLayout,
} from './types'

const PX_PER_INCH = 96
/** 1 CSS px = 0.75 pt（px/96 英寸，pt/72 英寸） */
const PT_PER_PX = 72 / 96
/** 等待 iframe 加载 / 内核 bundle 的兜底超时 */
const LOAD_TIMEOUT_MS = 15_000
const HELPER_TIMEOUT_MS = 10_000
const FONTS_TIMEOUT_MS = 4_000
const STABLE_TIMEOUT_MS = 4_000

/** 这些标签永远不参与文本提取（作为底图保留） */
const SKIP_TAGS = new Set([
  'SVG',
  'IMG',
  'PICTURE',
  'SOURCE',
  'SCRIPT',
  'STYLE',
  'LINK',
  'META',
  'IFRAME',
  'CANVAS',
  'VIDEO',
  'AUDIO',
  'OBJECT',
  'EMBED',
  'TEMPLATE',
  'NOSCRIPT',
  'BR',
  'HR',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'BUTTON',
])

/** 这些显示类型的元素视为「块级」，递归处理 */
const BLOCK_DISPLAYS = new Set([
  'block',
  'flow-root',
  'list-item',
  'flex',
  'grid',
  'table',
  'table-row',
  'table-row-group',
  'table-header-group',
  'table-footer-group',
  'table-cell',
  'table-caption',
  'table-column',
  'table-column-group',
  'ruby-base-container',
  '-webkit-box',
  '-webkit-flex',
])

/** 通用字体族 → Windows 可用字体（契约：monospace→Consolas / serif→Times New Roman / sans-serif→Segoe UI） */
const GENERIC_FONT_MAP: Record<string, string> = {
  monospace: 'Consolas',
  'ui-monospace': 'Consolas',
  'sfmono-regular': 'Consolas',
  'sf mono': 'Consolas',
  menlo: 'Consolas',
  consolas: 'Consolas',
  serif: 'Times New Roman',
  'ui-serif': 'Times New Roman',
  'times new roman': 'Times New Roman',
  times: 'Times New Roman',
  'sans-serif': 'Segoe UI',
  'ui-sans-serif': 'Segoe UI',
  'system-ui': 'Segoe UI',
  'segoe ui': 'Segoe UI',
  'microsoft yahei': 'Microsoft YaHei',
  'pingfang sc': 'PingFang SC',
  cursive: 'Comic Sans MS',
  fantasy: 'Impact',
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function fail(stage: string, detail: string): Error {
  const err = new Error(`${stage}：${detail}`) as Error & { stage?: string }
  err.stage = stage
  return err
}

function isEditableError(err: unknown): boolean {
  return !!(err && typeof err === 'object' && (err as any).stage)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function parsePx(value: string | null | undefined): number {
  if (!value) return 0
  const n = parseFloat(value)
  return Number.isFinite(n) ? n : 0
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nextFrame(): Promise<void> {
  // 注意：后台标签页的 rAF 可能被浏览器暂停，所以用 setTimeout 兜底，避免测量永久挂起
  return new Promise((resolve) => {
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      resolve()
    }
    const timer = setTimeout(finish, 120)
    if (!raf) {
      finish()
      return
    }
    raf(() => {
      clearTimeout(timer)
      finish()
    })
  })
}

async function nextFrames(count: number): Promise<void> {
  for (let i = 0; i < count; i++) await nextFrame()
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolve(fallback)
    }, ms)
    promise.then(
      (value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

/** rgb()/rgba()/hex → 'RRGGBB'；透明返回 null */
function colorToHex(color: string | null | undefined): string | null {
  if (!color) return null
  const value = color.trim().toLowerCase()
  if (!value || value === 'transparent' || value === 'none') return null
  if (value.startsWith('#')) {
    const hex = value.slice(1)
    if (hex.length === 3) return `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`.toUpperCase()
    if (hex.length === 6) return hex.toUpperCase()
    return null
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(value)
  if (!m) return null
  const parts = m[1].split(/[,/\s]+/).filter(Boolean)
  if (parts.length < 3) return null
  const [r, g, b] = parts.slice(0, 3).map((p) => Math.round(parseFloat(p)))
  const alpha = parts.length >= 4 ? parseFloat(parts[3]) : 1
  if (![r, g, b].every((n) => Number.isFinite(n))) return null
  if (!Number.isFinite(alpha) || alpha <= 0.01) return null
  const to2 = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0').toUpperCase()
  return `${to2(r)}${to2(g)}${to2(b)}`
}

/** 从 font-family 列表里取第一个「真实字体」，通用族映射到 Windows 可用字体 */
function firstFontFamily(fontFamily: string | null | undefined): string | undefined {
  if (!fontFamily) return undefined
  const parts = fontFamily
    .split(',')
    .map((p) => p.trim().replace(/^["']|["']$/g, '').trim())
    .filter(Boolean)
  for (const part of parts) {
    const key = part.toLowerCase()
    if (GENERIC_FONT_MAP[key]) return GENERIC_FONT_MAP[key]
    if (/^(inherit|initial|unset|revert|revert-layer|var\(.*\))$/i.test(part)) continue
    return part
  }
  return undefined
}

/** 文本块/表格里一个「页面坐标矩形」 */
interface PageRect {
  x: number
  y: number
  w: number
  h: number
}

function unionRect(a: PageRect | null, b: PageRect | null): PageRect | null {
  if (!a) return b
  if (!b) return a
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.w, b.x + b.w)
  const bottom = Math.max(a.y + a.h, b.y + b.h)
  return { x, y, w: right - x, h: bottom - y }
}

// ---------------------------------------------------------------------------
// 元素分类
// ---------------------------------------------------------------------------

function isSkippedElement(el: Element): boolean {
  const tag = el.tagName.toUpperCase()
  if (SKIP_TAGS.has(tag)) return true
  // MathJax / KaTeX / Mermaid：只能以底图形式保留
  if (tag === 'MJX-CONTAINER' || tag === 'MJX-MATH' || tag === 'MATH') return true
  const cls = el.getAttribute('class') || ''
  if (/(^|\s)(mwb-mermaid|mermaid)(\s|$)/i.test(cls)) return true
  if (/(^|\s)(katex|MathJax)(\s|$)/i.test(cls)) return true
  const id = el.getAttribute('id') || ''
  if (/^MathJax/i.test(id)) return true
  return false
}

function isPreformatted(el: Element, style: CSSStyleDeclaration): boolean {
  const tag = el.tagName.toUpperCase()
  if (tag === 'PRE' || tag === 'MARP-PRE' || tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') return true
  if (el.closest('pre, marp-pre')) return true
  const ws = style.whiteSpace || ''
  return ws.startsWith('pre') || ws === 'break-spaces'
}

function displayOf(el: Element, win: Window): string {
  try {
    return win.getComputedStyle(el).display || ''
  } catch {
    return ''
  }
}

function isBlockDisplay(display: string): boolean {
  return BLOCK_DISPLAYS.has(display)
}

function isVisible(el: Element, style: CSSStyleDeclaration): boolean {
  if (!style) return false
  if (style.display === 'none') return false
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false
  const opacity = parseFloat(style.opacity || '1')
  if (Number.isFinite(opacity) && opacity <= 0.01) return false
  return true
}

function hasVisibleBox(el: Element): boolean {
  const rect = el.getBoundingClientRect()
  return rect.width >= 1 && rect.height >= 1
}

// ---------------------------------------------------------------------------
// 样式 → run 样式
// ---------------------------------------------------------------------------

interface RunStyle {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: string
  fontFace?: string
  fontSize?: number
}

function fontSizePt(style: CSSStyleDeclaration, scale: number): number | undefined {
  const px = parsePx(style.fontSize)
  if (!px) return undefined
  return round2(px * scale * PT_PER_PX)
}

function styleToRunStyle(style: CSSStyleDeclaration, scale: number): RunStyle {
  const weightRaw = (style.fontWeight || '').toLowerCase()
  const weightNum = parseFloat(weightRaw)
  const bold = weightRaw === 'bold' || weightRaw === 'bolder' || (Number.isFinite(weightNum) && weightNum >= 600)
  const italic = /italic|oblique/i.test(style.fontStyle || '')
  const decoration = `${style.textDecorationLine || ''} ${style.textDecoration || ''}`
  const underline = /underline/i.test(decoration)
  const strike = /line-through/i.test(decoration)
  const out: RunStyle = {}
  if (bold) out.bold = true
  if (italic) out.italic = true
  if (underline) out.underline = true
  if (strike) out.strike = true
  const color = colorToHex(style.color)
  if (color) out.color = color
  const fontFace = firstFontFamily(style.fontFamily)
  if (fontFace) out.fontFace = fontFace
  const size = fontSizePt(style, scale)
  if (size) out.fontSize = size
  return out
}

function runStylesEqual(a: RunStyle, b: RunStyle): boolean {
  return (
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strike === !!b.strike &&
    (a.color || '') === (b.color || '') &&
    (a.fontFace || '') === (b.fontFace || '') &&
    (a.fontSize ?? 0) === (b.fontSize ?? 0)
  )
}

// ---------------------------------------------------------------------------
// auto-scaling（与 capture 页一致的 marp browser helper）
// ---------------------------------------------------------------------------

let autoScaleCache: WeakMap<Element, number> | null = null

function getAutoScale(el: Element): number {
  if (!autoScaleCache) autoScaleCache = new WeakMap()
  const host = el.closest('marp-pre, pre') || (el.tagName.toUpperCase() === 'MARP-PRE' ? el : null)
  if (!host) return 1
  const cached = autoScaleCache.get(host)
  if (cached != null) return cached
  let scale = 1
  try {
    const shadow = (host as HTMLElement).shadowRoot
    const autoScaling = shadow?.querySelector('marp-auto-scaling') as HTMLElement | null
    const svg = autoScaling?.shadowRoot?.querySelector('svg') as SVGSVGElement | null
    if (svg && svg.viewBox?.baseVal?.width) {
      const rect = svg.getBoundingClientRect()
      const ratio = rect.width / svg.viewBox.baseVal.width
      if (Number.isFinite(ratio) && ratio > 0) scale = Math.min(1, ratio)
    }
  } catch {
    scale = 1
  }
  autoScaleCache.set(host, scale)
  return scale
}

// ---------------------------------------------------------------------------
// 几何
// ---------------------------------------------------------------------------

function toPageX(x: number, ctx: MeasureContext): number {
  return (x - ctx.originX) / (ctx.pageScale || 1)
}

function toPageY(y: number, ctx: MeasureContext): number {
  return (y - ctx.originY) / (ctx.pageScale || 1)
}

function toPageW(w: number, ctx: MeasureContext): number {
  return w / (ctx.pageScale || 1)
}

function rectToPage(rect: DOMRect | { left: number; top: number; width: number; height: number }, ctx: MeasureContext): PageRect {
  return {
    x: toPageX(rect.left, ctx),
    y: toPageY(rect.top, ctx),
    w: toPageW(rect.width, ctx),
    h: toPageW(rect.height, ctx),
  }
}

/** 元素「内容盒」矩形（去掉 border + padding） */
function contentBox(el: Element, ctx: MeasureContext): PageRect {
  const rect = el.getBoundingClientRect()
  let padLeft = 0
  let padRight = 0
  let padTop = 0
  let padBottom = 0
  try {
    const style = ctx.win.getComputedStyle(el)
    padLeft = parsePx(style.borderLeftWidth) + parsePx(style.paddingLeft)
    padRight = parsePx(style.borderRightWidth) + parsePx(style.paddingRight)
    padTop = parsePx(style.borderTopWidth) + parsePx(style.paddingTop)
    padBottom = parsePx(style.borderBottomWidth) + parsePx(style.paddingBottom)
  } catch {
    /* ignore */
  }
  const w = Math.max(0, rect.width - padLeft - padRight)
  const h = Math.max(0, rect.height - padTop - padBottom)
  return rectToPage({ left: rect.left + padLeft, top: rect.top + padTop, width: w, height: h }, ctx)
}

// ---------------------------------------------------------------------------
// 文本 run 抽取
// ---------------------------------------------------------------------------

interface CollectOptions {
  preserveWhitespace: boolean
  scale: number
  /** 只收集这些子元素之外的 inline 内容（li 内嵌 ul 等混合内容） */
  exclude?: Set<Element>
  styleCache: WeakMap<Element, RunStyle>
}

function normalizeInlineWhitespace(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ')
}

function pushRun(out: EditableRun[], style: RunStyle, text: string): EditableRun {
  const run: EditableRun = { text, ...style }
  out.push(run)
  return run
}

function markBreak(out: EditableRun[]): void {
  if (!out.length) {
    out.push({ text: '', breakLine: true })
    return
  }
  out[out.length - 1].breakLine = true
}

function isInlineDisplay(display: string): boolean {
  return !isBlockDisplay(display) || display === 'contents'
}

function collectRuns(root: Element, ctx: MeasureContext, opts: CollectOptions): EditableRun[] {
  const out: EditableRun[] = []
  const win = ctx.win

  const styleOfInlineCode = (el: Element): string | undefined => {
    try {
      if (el.closest('pre, marp-pre')) return undefined
      const codeEl = el.tagName.toUpperCase() === 'CODE' ? el : el.closest('code')
      if (!codeEl) return undefined
      const style = win.getComputedStyle(codeEl)
      return colorToHex(style.backgroundColor) || undefined
    } catch {
      return undefined
    }
  }

  const runStyleOf = (el: Element): RunStyle => {
    const cached = opts.styleCache.get(el)
    if (cached) return cached
    let style: RunStyle = {}
    try {
      style = styleToRunStyle(win.getComputedStyle(el), opts.scale)
    } catch {
      style = {}
    }
    opts.styleCache.set(el, style)
    return style
  }

  const visitText = (node: Text): void => {
    const parent = node.parentElement
    if (!parent) return
    const raw = node.data
    if (!raw) return
    const style = runStyleOf(parent)
    const highlight = parent.tagName.toUpperCase() === 'CODE' ? styleOfInlineCode(parent) : undefined
    const withHighlight = highlight ? { ...style, highlight } : style

    if (opts.preserveWhitespace) {
      const lines = raw.replace(/\u00a0/g, ' ').split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line) pushRun(out, withHighlight, line)
        if (i < lines.length - 1) markBreak(out)
      }
    } else {
      const text = normalizeInlineWhitespace(raw)
      if (text) pushRun(out, withHighlight, text)
    }
  }

  const visitElement = (el: Element): void => {
    if (opts.exclude?.has(el)) return
    if (isSkippedElement(el)) return
    const tag = el.tagName.toUpperCase()
    if (tag === 'BR') {
      markBreak(out)
      return
    }
    // 内联元素递归；块级元素出现在 inline 上下文时也递归（浏览器里少见，如 <p><div>）
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) visitText(child as Text)
      else if (child.nodeType === 1) visitElement(child as Element)
    }
  }

  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === 3) visitText(child as Text)
    else if (child.nodeType === 1) visitElement(child as Element)
  }
  return out
}

/** 修整 runs：去首尾空白、合并同样式、去掉最后一个 breakLine、丢弃空 run */
function trimRuns(runs: EditableRun[]): EditableRun[] {
  const list = runs.map((r) => ({ ...r }))
  // 首尾空白
  for (let i = 0; i < list.length; i++) {
    if (list[i].breakLine) continue
    list[i].text = list[i].text.replace(/^\s+/, '')
    if (list[i].text) break
    if (i === list.length - 1) break
  }
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].breakLine) continue
    list[i].text = list[i].text.replace(/\s+$/, '')
    if (list[i].text) break
  }
  // 过滤空 run（保留 breakLine）
  const filtered = list.filter((r) => r.text.length > 0 || r.breakLine)
  // 去掉最后的换行（PPT 文本块末尾不需要段落换行）
  for (let i = filtered.length - 1; i >= 0; i--) {
    if (filtered[i].breakLine) {
      delete filtered[i].breakLine
      if (!filtered[i].text) filtered.splice(i, 1)
      continue
    }
    break
  }
  // 合并同样式相邻 run（减少 XML 体积）
  const merged: EditableRun[] = []
  for (const run of filtered) {
    const prev = merged[merged.length - 1]
    if (
      prev &&
      !prev.breakLine &&
      !run.breakLine &&
      runStylesEqual(prev, run) &&
      (prev.highlight || '') === (run.highlight || '')
    ) {
      prev.text += run.text
      continue
    }
    merged.push(run)
  }
  return merged
}

// ---------------------------------------------------------------------------
// 文本块抽取
// ---------------------------------------------------------------------------

function directTextRect(el: Element, ctx: MeasureContext, exclude?: Set<Element>): PageRect | null {
  const doc = ctx.doc
  const win = ctx.win
  let union: PageRect | null = null

  const addRange = (node: Text): void => {
    if (!node.data || !node.data.trim()) return
    try {
      const range = doc.createRange()
      range.selectNodeContents(node)
      const rects = range.getClientRects()
      if (!rects || !rects.length) return
      for (const rect of Array.from(rects)) {
        if (rect.width <= 0 || rect.height <= 0) continue
        union = unionRect(union, rectToPage(rect, ctx))
      }
      range.detach?.()
    } catch {
      /* ignore */
    }
  }

  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      addRange(node as Text)
      return
    }
    if (node.nodeType !== 1) return
    const elNode = node as Element
    if (exclude?.has(elNode)) return
    if (isSkippedElement(elNode)) return
    // 隐藏元素不参与 bbox
    try {
      if (!isVisible(elNode, win.getComputedStyle(elNode))) return
    } catch {
      /* ignore */
    }
    for (const child of Array.from(elNode.childNodes)) visit(child)
  }

  for (const child of Array.from(el.childNodes)) visit(child)
  return union
}

function mapAlign(textAlign: string): EditableTextBlock['align'] {
  const value = (textAlign || '').toLowerCase()
  if (value === 'center') return 'center'
  if (value === 'right' || value === 'end') return 'right'
  if (value === 'justify') return 'justify'
  return 'left'
}

function lineSpacingPt(style: CSSStyleDeclaration, fontSizePx: number, scale: number): number | undefined {
  const raw = style.lineHeight || ''
  const pxBase = fontSizePx
  let px = 0
  if (raw === 'normal' || !raw) px = pxBase * 1.2
  else if (raw.endsWith('px')) px = parseFloat(raw)
  else {
    const ratio = parseFloat(raw)
    px = Number.isFinite(ratio) ? pxBase * ratio : pxBase * 1.2
  }
  if (!Number.isFinite(px) || px <= 0) return undefined
  return round2(px * scale * PT_PER_PX)
}

function charSpacingPt(style: CSSStyleDeclaration, scale: number): number | undefined {
  const raw = style.letterSpacing || ''
  if (!raw || raw === 'normal') return undefined
  const px = parseFloat(raw)
  if (!Number.isFinite(px) || Math.abs(px) < 0.01) return undefined
  return round2(px * scale * PT_PER_PX)
}

interface ExtractTextOptions {
  onlyInline?: boolean
  exclude?: Element[]
}

function extractTextBlock(el: Element, ctx: MeasureContext, options: ExtractTextOptions = {}): EditableTextBlock | null {
  const win = ctx.win
  let style: CSSStyleDeclaration
  try {
    style = win.getComputedStyle(el)
  } catch {
    return null
  }
  if (!isVisible(el, style)) return null
  if (!hasVisibleBox(el)) return null

  const autoScale = getAutoScale(el)
  const preformatted = isPreformatted(el, style)
  const exclude = options.exclude?.length ? new Set(options.exclude) : undefined
  const styleCache = new WeakMap<Element, RunStyle>()
  const runs = trimRuns(
    collectRuns(el, ctx, {
      preserveWhitespace: preformatted,
      scale: autoScale,
      exclude,
      styleCache,
    }),
  )
  if (!runs.length) return null
  const plain = runs.map((r) => r.text).join('')
  if (!plain.trim()) return null
  // 防御：整个文本块就是一行未渲染的图片指令（如 markdown-it 拒绝的 data:image/svg+xml
  //   背景图会被渲染成字面文本）——真实 app 里 marp 会把它变成 <figure>，不应作为可编辑文本导出。
  if (/^!\[[^\]]*\]\([^\n]*\)$/.test(plain.trim())) return null

  const baseStyle = styleToRunStyle(style, autoScale)
  const baseColor = baseStyle.color
  const fillColor = colorToHex((style as any).webkitTextFillColor as string | undefined)
  // 契约 §2.1 文本颜色透明 → 跳过（渐变文字 background-clip:text 也走这条，写进已知限制）
  if (!baseColor && !fillColor) return null

  const textRect = directTextRect(el, ctx, exclude)
  const box = contentBox(el, ctx)
  const fontSizePx = parsePx(style.fontSize)
  const minHeight = Math.max(1, fontSizePx * autoScale * 1.15)

  let x: number
  let y: number
  let w: number
  let h: number
  if (preformatted) {
    // 代码块：用文本实际 bbox（auto-scaling 下宿主 padding 与缩放内容不一致）
    x = textRect ? textRect.x : box.x
    y = textRect ? textRect.y : box.y
    w = textRect ? Math.max(textRect.w, 1) : Math.max(box.w, 1)
    h = textRect ? Math.max(textRect.h, minHeight) : Math.max(box.h, minHeight)
  } else {
    x = box.x
    y = textRect ? textRect.y : box.y
    w = Math.max(box.w, 1)
    h = Math.max(textRect ? textRect.h : box.h, minHeight)
  }

  const block: EditableTextBlock = {
    kind: 'text',
    x: round2(x),
    y: round2(y),
    w: round2(w),
    h: round2(h),
    runs,
    align: mapAlign(style.textAlign),
    valign: 'top',
    bullet: el.tagName.toUpperCase() === 'LI',
  }
  if (baseStyle.fontFace) block.fontFace = baseStyle.fontFace
  if (baseStyle.fontSize) block.fontSize = baseStyle.fontSize
  if (baseColor) block.color = baseColor
  if (baseStyle.bold) block.bold = true
  if (baseStyle.italic) block.italic = true
  const lineSpacing = lineSpacingPt(style, fontSizePx, autoScale)
  if (lineSpacing) block.lineSpacing = lineSpacing
  const charSpacing = charSpacingPt(style, autoScale)
  if (charSpacing) block.charSpacing = charSpacing
  return block
}

// ---------------------------------------------------------------------------
// 表格抽取
// ---------------------------------------------------------------------------

function runsToPlainText(runs: EditableRun[]): string {
  return runs
    .map((r) => (r.breakLine ? `${r.text}\n` : r.text))
    .join('')
    .replace(/\n+$/, '')
    .trim()
}

function extractTable(el: Element, ctx: MeasureContext): EditableTableBlock | null {
  const table = el as HTMLTableElement
  if (!hasVisibleBox(table)) return null
  const win = ctx.win
  let tableStyle: CSSStyleDeclaration
  try {
    tableStyle = win.getComputedStyle(table)
  } catch {
    return null
  }
  if (!isVisible(table, tableStyle)) return null

  const rowsEl = Array.from(table.rows)
  if (!rowsEl.length) return null
  const tableRect = rectToPage(table.getBoundingClientRect(), ctx)
  const rowRects = rowsEl.map((row) => rectToPage(row.getBoundingClientRect(), ctx))
  // 部分主题（GitHub 风格 base CSS）把 table 设为 display:block：
  // 此时 table 元素宽度 ≠ 真实表格网格宽度，必须用行盒并集作为表格几何。
  const rowUnion = rowRects.reduce<PageRect | null>((acc, rect) => unionRect(acc, rect), null)
  const gridRect =
    rowUnion && Math.abs(rowUnion.w - tableRect.w) > 1
      ? rowUnion
      : tableRect

  // 列宽：优先首行各 cell 的实际宽度；colspan 时退化为均分
  let colCount = 0
  for (const row of rowsEl) colCount = Math.max(colCount, row.cells.length)
  if (!colCount) return null
  const hasSpan = rowsEl.some((row) => Array.from(row.cells).some((c) => (c.colSpan || 1) > 1 || (c.rowSpan || 1) > 1))
  let colW: number[] = []
  const firstRow = rowsEl[0]
  if (!hasSpan && firstRow.cells.length === colCount) {
    colW = Array.from(firstRow.cells).map((cell) => round2(toPageW(cell.getBoundingClientRect().width, ctx)))
  }
  if (!colW.length || colW.some((w) => !Number.isFinite(w) || w <= 0)) {
    colW = new Array(colCount).fill(round2(gridRect.w / colCount))
  }
  const rowH = rowRects.map((rect) => round2(Math.max(1, rect.h)))

  const firstCell = firstRow.cells[0] || null
  let cellStyle: CSSStyleDeclaration | null = null
  try {
    cellStyle = firstCell ? win.getComputedStyle(firstCell) : null
  } catch {
    cellStyle = null
  }
  const baseFontSize = cellStyle ? fontSizePt(cellStyle, 1) : undefined
  const baseFontFace = cellStyle ? firstFontFamily(cellStyle.fontFamily) : undefined
  const baseColor = cellStyle ? colorToHex(cellStyle.color) : undefined
  let borderColor = 'D9D9D9'
  if (firstCell) {
    const color = colorToHex(win.getComputedStyle(firstCell).borderTopColor)
    if (color) borderColor = color
  }

  const styleCache = new WeakMap<Element, RunStyle>()
  const rows = rowsEl.map((row) => {
    const cells: EditableTableCell[] = Array.from(row.cells).map((cell) => {
      let cellCS: CSSStyleDeclaration | null = null
      try {
        cellCS = win.getComputedStyle(cell)
      } catch {
        cellCS = null
      }
      const runs = trimRuns(
        collectRuns(cell, ctx, { preserveWhitespace: false, scale: 1, styleCache }),
      )
      const text = runsToPlainText(runs)
      const cellRuns: EditableRun[] = text
        ? runs.length
          ? runs
          : [{ text }]
        : [{ text: '' }]
      const bold = cell.tagName.toUpperCase() === 'TH' || (cellCS ? /bold|bolder/i.test(cellCS.fontWeight) || parseFloat(cellCS.fontWeight) >= 600 : false)
      const cellOut: EditableTableCell = { runs: cellRuns }
      if (bold) cellOut.bold = true
      const fill = cellCS ? colorToHex(cellCS.backgroundColor) : null
      if (fill) cellOut.fill = fill
      if (cellCS) cellOut.align = mapAlign(cellCS.textAlign) as EditableTableCell['align']
      return cellOut
    })
    return { cells }
  })

  const block: EditableTableBlock = {
    kind: 'table',
    x: round2(gridRect.x),
    y: round2(gridRect.y),
    w: round2(gridRect.w),
    h: round2(gridRect.h),
    colW,
    rowH,
    rows,
    borderColor,
  }
  if (baseFontSize) block.fontSize = baseFontSize
  if (baseFontFace) block.fontFace = baseFontFace
  if (baseColor) block.color = baseColor
  return block
}

// ---------------------------------------------------------------------------
// 遍历 section
// ---------------------------------------------------------------------------

function hasDirectInlineText(el: Element, excludeEls: Set<Element>, ctx: MeasureContext): boolean {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) {
      const text = (child as Text).data
      if (text && text.trim()) return true
      continue
    }
    if (child.nodeType !== 1) continue
    const elChild = child as Element
    if (excludeEls.has(elChild)) continue
    if (isSkippedElement(elChild)) continue
    if ((elChild.textContent || '').trim()) return true
  }
  return false
}

function walkElement(el: Element, ctx: MeasureContext): void {
  const win = ctx.win
  if (isSkippedElement(el)) return
  let style: CSSStyleDeclaration
  try {
    style = win.getComputedStyle(el)
  } catch {
    return
  }
  if (!isVisible(el, style)) return
  const tag = el.tagName.toUpperCase()
  if (tag === 'BR' || tag === 'HR') return

  if (tag === 'TABLE') {
    const table = extractTable(el, ctx)
    if (table) ctx.layout.tables.push(table)
    return
  }

  const display = style.display
  if (display === 'contents') {
    for (const child of Array.from(el.children)) walkElement(child, ctx)
    return
  }

  const children = Array.from(el.children).filter((child) => {
    if (isSkippedElement(child)) return false
    try {
      return isVisible(child, win.getComputedStyle(child))
    } catch {
      return false
    }
  })
  const blockChildren: Element[] = []
  const inlineChildren: Element[] = []
  for (const child of children) {
    const childDisplay = displayOf(child, win)
    if (child.tagName.toUpperCase() === 'TABLE' || isBlockDisplay(childDisplay)) blockChildren.push(child)
    else inlineChildren.push(child)
  }

  if (!isBlockDisplay(display)) {
    // 顶层内联元素：整体当一个文本块
    const block = extractTextBlock(el, ctx, { onlyInline: true })
    if (block) ctx.layout.texts.push(block)
    return
  }

  if (!blockChildren.length) {
    const block = extractTextBlock(el, ctx)
    if (block) ctx.layout.texts.push(block)
    return
  }

  // 混合内容（如 li 里既有文字又有嵌套 ul）：先把直接 inline 文本抽成一个块
  if (inlineChildren.length || hasDirectInlineText(el, new Set(blockChildren), ctx)) {
    const block = extractTextBlock(el, ctx, { exclude: blockChildren })
    if (block) ctx.layout.texts.push(block)
  }
  for (const child of blockChildren) walkElement(child, ctx)
}

function findContentSection(svg: Element): Element | null {
  const advanced = svg.querySelector('section[data-marpit-advanced-background="content"]')
  if (advanced) return advanced
  const foreignObjects = svg.querySelectorAll('foreignObject')
  for (const fo of Array.from(foreignObjects)) {
    const section = fo.querySelector('section')
    if (section) return section
  }
  return null
}

// ---------------------------------------------------------------------------
// iframe 生命周期
// ---------------------------------------------------------------------------

function baseStyleForMeasure(width: number, height: number): string {
  return `
html, body { margin: 0; padding: 0; overflow: hidden; background: #fff; }
div.marpit { margin: 0; padding: 0; }
div.marpit > svg[data-marpit-svg] { display: block; width: ${width}px; height: ${height}px; margin: 0; }
`
}

function buildMeasureSrcdoc(html: string, css: string, width: number, height: number): string {
  // CSP：禁止 deck 内联脚本（html:true 时用户 raw HTML 可带事件处理器），只允许同源脚本（marp helper）
  const csp =
    "default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'"
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style id="mwb-measure-base">${baseStyleForMeasure(width, height)}</style>
<style id="mwb-measure-theme">${css || ''}</style>
</head><body>${html || ''}</body></html>`
}

function createMeasureIframe(width: number, height: number): HTMLIFrameElement {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.setAttribute('tabindex', '-1')
  iframe.setAttribute('title', 'editable-pptx-measure')
  iframe.style.cssText = [
    'position:fixed',
    'left:-10000px',
    'top:0',
    `width:${width}px`,
    `height:${height}px`,
    'border:0',
    'visibility:hidden',
    'pointer-events:none',
    'opacity:0',
    'z-index:-2147483647',
  ].join(';')
  return iframe
}

function mountIframe(iframe: HTMLIFrameElement, srcdoc: string): Promise<Document> {
  return new Promise<Document>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(fail('版式测量失败', `测量页加载超时（${LOAD_TIMEOUT_MS}ms），请重试`))
    }, LOAD_TIMEOUT_MS)
    const cleanup = () => {
      clearTimeout(timer)
      iframe.onload = null
    }
    iframe.onload = () => {
      const doc = iframe.contentDocument
      cleanup()
      if (!doc) {
        reject(fail('版式测量失败', '无法访问测量页 document（iframe 被跨域/沙箱隔离）'))
        return
      }
      resolve(doc)
    }
    const host = document.body || document.documentElement
    // 先设置 srcdoc 再挂载，避免 onload 先被 about:blank 的首次加载触发
    iframe.srcdoc = srcdoc
    host.appendChild(iframe)
  })
}

function helperScriptUrl(): string {
  const origin = typeof location !== 'undefined' ? location.origin : ''
  if (!origin || origin === 'null' || origin === 'file://') return '/marp-core.browser.js'
  return `${origin}/marp-core.browser.js`
}

async function injectHelperScript(doc: Document): Promise<boolean> {
  const existed = (doc.defaultView as any)?.MarpCoreBundle?.MarpCore?.browser
  if (typeof existed === 'function') return true
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const script = doc.createElement('script')
    script.async = true
    script.src = helperScriptUrl()
    script.onload = () => finish(true)
    script.onerror = () => finish(false)
    const timer = setTimeout(() => finish(false), HELPER_TIMEOUT_MS)
    ;(doc.head || doc.documentElement).appendChild(script)
  })
}

/**
 * 在测量 iframe 内应用 marp browser helper（auto-scaling），与 /api/export/capture 的打印页一致。
 * helper 必须运行在 iframe 的 realm 里（customElements 是 per-window 的），因此取 iframe realm 的函数。
 */
async function applyBrowserHelper(doc: Document): Promise<boolean> {
  const win = doc.defaultView as any
  if (!win) return false
  try {
    if (!win.MarpCoreBundle?.MarpCore?.browser) {
      const loaded = await injectHelperScript(doc)
      if (!loaded) {
        console.warn('[editable-pptx] /marp-core.browser.js 未加载，auto-scaling 不可用（长代码块可能与底图错位）')
        return false
      }
    }
    const core = win.MarpCoreBundle?.MarpCore
    if (typeof core?.browser !== 'function') return false
    core.browser(doc.body)
    return true
  } catch (err) {
    console.warn('[editable-pptx] marp browser helper 应用失败', err)
    return false
  }
}

async function waitForStableLayout(doc: Document): Promise<void> {
  const win = doc.defaultView as any
  try {
    if (doc.fonts?.ready) await withTimeout(Promise.resolve(doc.fonts.ready), FONTS_TIMEOUT_MS, undefined)
  } catch {
    /* ignore */
  }
  await nextFrames(1)
  await applyBrowserHelper(doc)
  await nextFrames(2)
  // auto-scaling 的 ResizeObserver 是异步的：轮询直到每页尺寸连续两次一致
  const started = Date.now()
  let lastSignature = ''
  while (Date.now() - started < STABLE_TIMEOUT_MS) {
    const slides = Array.from(doc.querySelectorAll('svg[data-marpit-svg]'))
    if (!slides.length) {
      await sleep(30)
      continue
    }
    const signature = slides
      .map((svg) => {
        const rect = svg.getBoundingClientRect()
        return `${Math.round(rect.width)}x${Math.round(rect.height)}`
      })
      .join(',')
    if (signature === lastSignature) return
    lastSignature = signature
    await sleep(40)
  }
  void win
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 测量 deck 的可编辑布局。
 * @param html marp-core 渲染结果（资源须已 inline）
 * @param css  marp-core 渲染的 CSS
 */
export async function measureDeckForEditablePptx(
  html: string,
  css: string,
  opts: MeasureOptions,
): Promise<MeasuredDeck> {
  const pageWidth = Math.max(1, Math.round(Number(opts?.width) || 1280))
  const pageHeight = Math.max(1, Math.round(Number(opts?.height) || 720))

  if (typeof document === 'undefined' || typeof window === 'undefined') {
    throw fail('版式测量失败', '当前环境没有 DOM，measureDeckForEditablePptx 必须在浏览器中调用')
  }
  if (!html || !html.trim()) {
    throw fail('版式测量失败', '渲染结果为空：请先输入内容并渲染后再导出')
  }

  const iframe = createMeasureIframe(pageWidth, pageHeight)
  let doc: Document | null = null
  try {
    doc = await mountIframe(iframe, buildMeasureSrcdoc(html, css, pageWidth, pageHeight))
    if (doc.readyState !== 'complete') {
      await withTimeout(
        new Promise<void>((resolve) => {
          doc!.addEventListener('DOMContentLoaded', () => resolve(), { once: true })
          setTimeout(resolve, 1000)
        }),
        1500,
        undefined,
      )
    }
    await waitForStableLayout(doc)

    const slides = Array.from(doc.querySelectorAll('svg[data-marpit-svg]'))
    if (!slides.length) {
      throw fail('版式测量失败', '渲染结果里没有找到幻灯片（svg[data-marpit-svg]），请检查 markdown 是否为空或渲染是否失败')
    }

    const layouts: SlideEditableLayout[] = []
    let textBlocks = 0
    let tables = 0
    let runs = 0
    for (const svg of slides) {
      const origin = svg.getBoundingClientRect()
      const pageScale = origin.width > 0 ? origin.width / pageWidth : 1
      const layout: SlideEditableLayout = { texts: [], tables: [] }
      const section = findContentSection(svg)
      if (section) {
        const ctx: MeasureContext = {
          doc,
          win: doc.defaultView as Window,
          originX: origin.left,
          originY: origin.top,
          pageScale: pageScale > 0 ? pageScale : 1,
          pageWidth,
          pageHeight,
          layout,
        }
        for (const child of Array.from(section.children)) walkElement(child, ctx)
        // section 直属文本节点（极少见）
        for (const child of Array.from(section.childNodes)) {
          if (child.nodeType === 3 && (child as Text).data.trim()) {
            const block = extractTextBlock(section, ctx, { onlyInline: true })
            if (block) layout.texts.push(block)
            break
          }
        }
      }
      textBlocks += layout.texts.length
      tables += layout.tables.length
      for (const text of layout.texts) runs += text.runs.length
      layouts.push(layout)
    }

    return {
      layouts,
      backgroundHtml: html,
      backgroundCss: buildBackgroundCss(css),
      pageCount: layouts.length,
      width: pageWidth,
      height: pageHeight,
      stats: { textBlocks, tables, runs },
    }
  } catch (err: any) {
    if (isEditableError(err)) throw err
    throw fail('版式测量失败', String(err?.message || err))
  } finally {
    try {
      iframe.remove()
    } catch {
      /* ignore */
    }
    autoScaleCache = null
  }
}

export { PX_PER_INCH }
