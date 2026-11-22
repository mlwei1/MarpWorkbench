/**
 * PPTX 可编辑导出模块（M4，owner: editable-ppt-eng）
 *
 * 契约：docs/UI_CONTRACT_M4_PPTX_EDITABLE.md §2.1
 *
 * 用法（ExportPanel / 调用方）：
 * ```ts
 * const mod = await import('./editable/index')
 * const deck = await mod.measureDeckForEditablePptx(html, css, { width, height, comments, title })
 * // backgrounds: 把 deck.backgroundHtml / deck.backgroundCss POST /api/export/capture 后按序取 dataURL
 * const { blob, stats } = await mod.assembleEditablePptx(deck, backgrounds, {
 *   title, comments, pptxgenjs: (await import('pptxgenjs')).default,
 *   onProgress: (pct, label) => { ... },
 * })
 * ```
 *
 * 产物：每页高清背景图 + 真正的 PowerPoint 文本/表格对象 + 演讲者备注。
 * 背景/装饰/图片/Mermaid/页码为底图不可编辑（见 docs/dev/editable-pptx.md）。
 */
export { measureDeckForEditablePptx } from './layout'
export { assembleEditablePptx } from './assemble'
export { buildBackgroundCss, BACKGROUND_OVERRIDE_CSS } from './css'
export type {
  AssembleOptions,
  AssembleResult,
  EditableRun,
  EditableTableCell,
  EditableTableBlock,
  EditableTextBlock,
  MeasureOptions,
  MeasuredDeck,
  SlideEditableLayout,
} from './types'

import { measureDeckForEditablePptx } from './layout'
import { assembleEditablePptx } from './assemble'

const editablePptxApi = {
  measureDeckForEditablePptx,
  assembleEditablePptx,
}

export default editablePptxApi
