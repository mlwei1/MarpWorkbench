/**
 * 可编辑 PPTX 组装（`assembleEditablePptx`）：MeasuredDeck + 背景图 → pptxgenjs → Blob
 *
 * 契约：docs/UI_CONTRACT_M4_PPTX_EDITABLE.md §1 / §2.1.6
 * - 幻灯片尺寸 = width/96 × height/96 英寸（16:9 → 13.333…×7.5；4:3 → 10×7.5）
 * - 每页：background = 背景图 dataURL + addText/addTable + addNotes
 * - 坐标 px/96 → 英寸；字号 px×0.75 → pt（layout 已换算好）
 * - 本模块**不依赖 DOM**（只依赖调用方传入的 pptxgenjs），可在浏览器 / Node（带 Blob 的实现）中跑
 */
import type {
  AssembleOptions,
  AssembleResult,
  EditableRun,
  EditableTableBlock,
  EditableTextBlock,
  MeasuredDeck,
} from './types'

const PX_PER_INCH = 96

/** li 项目符号的悬挂缩进（pt）。PowerPoint 会把文本从 shape 左边右移这么多，组装时在 x 上补偿 */
const BULLET_INDENT_PT = 12

function fail(stage: string, detail: string): Error {
  const err = new Error(`${stage}：${detail}`) as Error & { stage?: string }
  err.stage = stage
  return err
}

function isEditableError(err: unknown): boolean {
  return !!(err && typeof err === 'object' && (err as any).stage)
}

function pxToIn(px: number): number {
  const value = Number(px)
  if (!Number.isFinite(value)) return 0
  return Math.round((value / PX_PER_INCH) * 10000) / 10000
}

function clampSizeIn(px: number): number {
  return Math.max(0.004, pxToIn(px))
}

function hex(color: string | undefined): string | undefined {
  if (!color) return undefined
  const value = color.replace(/^#/, '').trim()
  return /^[0-9a-fA-F]{6}$/.test(value) ? value.toUpperCase() : undefined
}

// ---------------------------------------------------------------------------
// 文本
// ---------------------------------------------------------------------------

function buildRunObjects(block: EditableTextBlock): any[] {
  const runs = (block.runs || []).filter((run) => run.text || run.breakLine)
  const out: any[] = []
  runs.forEach((run, index) => {
    const options: Record<string, any> = {}
    if (run.bold) options.bold = true
    if (run.italic) options.italic = true
    if (run.underline) options.underline = { style: 'sng' }
    if (run.strike) options.strike = true
    const color = hex(run.color)
    if (color) options.color = color
    const fontFace = run.fontFace
    if (fontFace) options.fontFace = fontFace
    if (run.fontSize) options.fontSize = run.fontSize
    const highlight = hex(run.highlight)
    if (highlight) options.highlight = highlight
    // 最后一个 run 不加 breakLine（避免产生空段落）
    if (run.breakLine && index < runs.length - 1) options.breakLine = true
    out.push({ text: run.text || '', options })
  })
  if (!out.length) out.push({ text: '', options: {} })
  return out
}

function buildTextOptions(block: EditableTextBlock): Record<string, any> {
  const bullet = block.bullet === true
  const bulletShiftPx = bullet ? (BULLET_INDENT_PT / 72) * PX_PER_INCH : 0
  const options: Record<string, any> = {
    x: pxToIn(block.x - bulletShiftPx),
    y: pxToIn(block.y),
    w: clampSizeIn(block.w + bulletShiftPx),
    h: clampSizeIn(block.h),
    margin: 0,
    valign: block.valign || 'top',
    fit: 'none',
    wrap: block.w > 0 ? true : false,
    align: block.align || 'left',
    bullet: bullet ? { indent: BULLET_INDENT_PT } : false,
  }
  if (block.fontFace) options.fontFace = block.fontFace
  if (block.fontSize) options.fontSize = block.fontSize
  const color = hex(block.color)
  if (color) options.color = color
  if (block.bold) options.bold = true
  if (block.italic) options.italic = true
  if (block.lineSpacing) options.lineSpacing = block.lineSpacing
  if (block.charSpacing) options.charSpacing = block.charSpacing
  return options
}

// ---------------------------------------------------------------------------
// 表格
// ---------------------------------------------------------------------------

function cellPlainText(runs: EditableRun[]): string {
  const text = (runs || [])
    .map((run) => (run.breakLine ? `${run.text}\n` : run.text))
    .join('')
    .replace(/\n+$/, '')
  return text
}

function buildTableRows(table: EditableTableBlock): any[][] {
  return (table.rows || []).map((row) =>
    (row.cells || []).map((cell) => {
      const text = cellPlainText(cell.runs)
      const options: Record<string, any> = {}
      if (cell.bold) options.bold = true
      const fill = hex(cell.fill)
      if (fill) options.fill = { color: fill }
      if (cell.align) options.align = cell.align
      if (table.fontFace) options.fontFace = table.fontFace
      if (table.fontSize) options.fontSize = table.fontSize
      const baseColor = hex(table.color)
      const runColor = hex(cell.runs?.find((run) => run.color)?.color)
      if (runColor && runColor !== baseColor) options.color = runColor
      return { text, options }
    }),
  )
}

function buildTableOptions(table: EditableTableBlock): Record<string, any> {
  const options: Record<string, any> = {
    x: pxToIn(table.x),
    y: pxToIn(table.y),
    w: clampSizeIn(table.w),
    colW: (table.colW || []).map(pxToIn),
    rowH: (table.rowH || []).map(pxToIn),
    border: { type: 'solid', pt: 0.5, color: hex(table.borderColor) || 'D9D9D9' },
    margin: 0,
    valign: 'middle',
    autoPage: false,
  }
  if (table.fontFace) options.fontFace = table.fontFace
  if (table.fontSize) options.fontSize = table.fontSize
  const color = hex(table.color)
  if (color) options.color = color
  return options
}

// ---------------------------------------------------------------------------
// Blob 兜底（兼容 pptxgenjs 在部分环境返回 ArrayBuffer/Uint8Array/base64 的情况）
// ---------------------------------------------------------------------------

function ensureBlob(written: any): Blob {
  const MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  if (typeof Blob === 'undefined') throw fail('PPTX 组装失败', '当前环境不支持 Blob，无法生成 PPTX 文件')
  if (written instanceof Blob) return written
  if (written instanceof ArrayBuffer) return new Blob([written], { type: MIME })
  if (ArrayBuffer.isView(written)) {
    const view = written as ArrayBufferView
    return new Blob([view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer], { type: MIME })
  }
  if (typeof written === 'string') {
    // pptxgenjs 某些版本在 Node 下返回 base64 字符串
    try {
      const binary = atob(written)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return new Blob([bytes], { type: MIME })
    } catch {
      /* fallthrough */
    }
  }
  throw fail('PPTX 组装失败', 'pptxgenjs 未返回可用的文件数据（既不是 Blob 也不是二进制）')
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 按测量结果 + 背景图组装可编辑 PPTX。
 * @param deck        measureDeckForEditablePptx 的返回值
 * @param backgrounds dataURL/base64 列表，长度必须 = deck.pageCount，顺序与 layouts 一致
 */
export async function assembleEditablePptx(
  deck: MeasuredDeck,
  backgrounds: string[],
  opts: AssembleOptions,
): Promise<AssembleResult> {
  if (!deck || !Array.isArray(deck.layouts) || !deck.layouts.length) {
    throw fail('PPTX 组装失败', '版式数据为空，请先完成布局测量')
  }
  const pageCount = deck.layouts.length
  if (!Array.isArray(backgrounds) || backgrounds.length !== pageCount) {
    throw fail(
      'PPTX 组装失败',
      `背景图数量与页数不一致（背景 ${Array.isArray(backgrounds) ? backgrounds.length : 0} / 页数 ${pageCount}），请重试导出`,
    )
  }
  const PptxGenJS = opts?.pptxgenjs
  if (!PptxGenJS) throw fail('PPTX 组装失败', '缺少 pptxgenjs 依赖（由导出面板通过 opts.pptxgenjs 传入）')

  let pptx: any
  try {
    pptx = typeof PptxGenJS === 'function' ? new PptxGenJS() : PptxGenJS
  } catch (err: any) {
    throw fail('PPTX 组装失败', `pptxgenjs 初始化失败：${String(err?.message || err)}`)
  }
  if (!pptx || typeof pptx.addSlide !== 'function' || typeof pptx.defineLayout !== 'function') {
    throw fail('PPTX 组装失败', 'pptxgenjs 实例无效（缺少 addSlide/defineLayout）')
  }

  const title = String(opts?.title || '').trim() || '演示文稿'
  const widthIn = deck.width / PX_PER_INCH
  const heightIn = deck.height / PX_PER_INCH
  const layoutName = `MWB_${Math.round(deck.width)}x${Math.round(deck.height)}`
  try {
    if (!pptx.author) pptx.author = 'MarpWorkbench'
    if (!pptx.company) pptx.company = 'MarpWorkbench'
    pptx.title = title
    pptx.defineLayout({ name: layoutName, width: widthIn, height: heightIn })
    pptx.layout = layoutName
  } catch (err: any) {
    throw fail('PPTX 组装失败', `定义幻灯片尺寸失败：${String(err?.message || err)}`)
  }

  let textCount = 0
  let tableCount = 0
  const progress = (i: number): void => {
    const pct = 5 + Math.round(((i + 1) / pageCount) * 90)
    try {
      opts?.onProgress?.(Math.min(95, pct), `正在组装第 ${i + 1}/${pageCount} 页…`)
    } catch {
      /* 进度回调异常不影响导出 */
    }
  }

  for (let i = 0; i < pageCount; i++) {
    let slide: any
    try {
      slide = pptx.addSlide()
    } catch (err: any) {
      throw fail('PPTX 组装失败', `第 ${i + 1} 页：创建幻灯片失败（${String(err?.message || err)}）`)
    }
    try {
      slide.background = { data: backgrounds[i] }
      const layout = deck.layouts[i]
      for (const block of layout.texts || []) {
        slide.addText(buildRunObjects(block), buildTextOptions(block))
        textCount += 1
      }
      for (const table of layout.tables || []) {
        slide.addTable(buildTableRows(table), buildTableOptions(table))
        tableCount += 1
      }
      const note = opts?.comments?.[i]
      if (note && String(note).trim()) slide.addNotes(String(note))
    } catch (err: any) {
      if (isEditableError(err)) throw err
      throw fail('PPTX 组装失败', `第 ${i + 1} 页：${String(err?.message || err)}`)
    }
    progress(i)
    if (i % 5 === 4) await new Promise((resolve) => setTimeout(resolve, 0))
  }

  try {
    opts?.onProgress?.(97, '正在生成 PPTX 文件…')
  } catch {
    /* ignore */
  }

  let blob: Blob
  try {
    let written: any
    try {
      written = await pptx.write({ outputType: 'blob' })
    } catch (err) {
      // 兼容极老版本 pptxgenjs 的字符串参数写法
      written = await pptx.write('blob')
    }
    blob = ensureBlob(written)
  } catch (err: any) {
    if (isEditableError(err)) throw err
    throw fail('PPTX 组装失败', `生成文件失败：${String(err?.message || err)}`)
  }

  try {
    opts?.onProgress?.(100, 'PPTX 已生成')
  } catch {
    /* ignore */
  }

  return {
    blob,
    stats: { slides: pageCount, textBlocks: textCount, tables: tableCount, bytes: blob.size },
  }
}
