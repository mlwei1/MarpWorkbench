/**
 * 可编辑 PPTX 导出的数据契约（docs/UI_CONTRACT_M4_PPTX_EDITABLE.md §2.1）
 *
 * 这些类型是 `layout.ts`（DOM 测量）与 `assemble.ts`（pptxgenjs 组装）之间的唯一接口，
 * 也是 ExportPanel（export-eng）集成时依赖的公开类型。
 * 坐标系：px，相对每页 svg 左上角，页面标称尺寸 = deck.width × deck.height（1280×720 / 960×720 …）。
 */

/** 一个文本 run（PowerPoint 里的一次样式连续片段） */
export interface EditableRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  /** 'RRGGBB'（不带 #） */
  color?: string
  fontFace?: string
  /** pt（= DOM px × 0.75） */
  fontSize?: number
  /** 内联代码底色 'RRGGBB' */
  highlight?: string
  /** 该 run 之后插入段落换行（对应 <br> / pre 内的 \n） */
  breakLine?: boolean
}

/** 一个文本块（DOM 中一个块级元素，或 li/段落等） */
export interface EditableTextBlock {
  kind: 'text'
  /** px，相对页原点（1280×720 坐标系） */
  x: number
  y: number
  w: number
  h: number
  runs: EditableRun[]
  align?: 'left' | 'center' | 'right' | 'justify'
  valign?: 'top' | 'middle' | 'bottom'
  /** pt */
  lineSpacing?: number
  /** pt */
  charSpacing?: number
  /** li 项（组装为 PowerPoint 项目符号） */
  bullet?: boolean
  /** 段落级默认样式（runs 未覆盖时） */
  fontFace?: string
  fontSize?: number
  color?: string
  bold?: boolean
  italic?: boolean
}

export interface EditableTableCell {
  runs: EditableRun[]
  bold?: boolean
  /** 'RRGGBB' */
  fill?: string
  align?: 'left' | 'center' | 'right'
}

export interface EditableTableBlock {
  kind: 'table'
  x: number
  y: number
  w: number
  h: number
  /** px */
  colW: number[]
  /** px */
  rowH: number[]
  rows: { cells: EditableTableCell[]; fill?: string }[]
  fontSize?: number
  fontFace?: string
  color?: string
  borderColor?: string
}

export interface SlideEditableLayout {
  texts: EditableTextBlock[]
  tables: EditableTableBlock[]
}

export interface MeasuredDeck {
  layouts: SlideEditableLayout[]
  /**
   * 用于服务端截背景：
   * - backgroundHtml = 原始渲染 html（调用方需先把 deck 资产/网络图 inline 成 dataURL）
   * - backgroundCss  = 主题 CSS + 「文字透明 / 表格隐藏 / Mermaid 恢复」覆盖样式
   */
  backgroundHtml: string
  backgroundCss: string
  pageCount: number
  /** px（标称页面尺寸，assemble 按 width/96 英寸定义 PPT 版面） */
  width: number
  height: number
  stats: { textBlocks: number; tables: number; runs: number }
}

export interface MeasureOptions {
  width: number
  height: number
  comments?: string[]
  title?: string
}

export interface AssembleOptions {
  title?: string
  /** 调用方传入的 pptxgenjs（构造函数，也兼容已实例化对象） */
  pptxgenjs: any
  comments?: string[]
  /** pct: 0-100（组装阶段约 5 → 95） */
  onProgress?: (pct: number, label: string) => void
}

export interface AssembleResult {
  /** pptxgenjs `write({outputType:'blob'})` 产物（浏览器可直接 a.download） */
  blob: Blob
  stats: { slides: number; textBlocks: number; tables: number; bytes: number }
}

/** 内部：测量上下文 */
export interface MeasureContext {
  doc: Document
  win: Window
  /** 页原点（iframe viewport 坐标） */
  originX: number
  originY: number
  /** svg 实际宽度 / 标称宽度的比例（正常为 1，用于容错） */
  pageScale: number
  /** 当前页标称尺寸 */
  pageWidth: number
  pageHeight: number
  layout: SlideEditableLayout
}
