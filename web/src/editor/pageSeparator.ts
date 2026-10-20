import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'

/** `---` 分页线上的「第 N 页」小标签 */
class PageLabelWidget extends WidgetType {
  constructor(readonly page: number) {
    super()
  }
  eq(other: PageLabelWidget): boolean {
    return other.page === this.page
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-page-sep-label'
    span.textContent = `第 ${this.page} 页`
    return span
  }
  ignoreEvent(): boolean {
    return true
  }
}

const separatorLine = Decoration.line({ class: 'cm-page-sep' })
const frontmatterEndLine = Decoration.line({ class: 'cm-fm-end' })

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const { doc } = view.state

  // 识别 front-matter（首行 --- 到下一个 ---），避免把 front-matter 边界当分页
  let fmEnd = 0
  if (doc.lines >= 2 && doc.line(1).text.trim() === '---') {
    for (let i = 2; i <= doc.lines; i++) {
      if (doc.line(i).text.trim() === '---') {
        fmEnd = i
        break
      }
    }
  }

  let inFence = false
  let page = 1
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    const text = line.text.trim()
    if (/^(```|~~~)/.test(text)) inFence = !inFence
    if (!inFence && i === fmEnd) builder.add(line.from, line.from, frontmatterEndLine)
    if (inFence) continue
    if (i > fmEnd && /^-{3,}$/.test(text)) {
      page += 1
      builder.add(line.from, line.from, separatorLine)
      builder.add(line.to, line.to, Decoration.widget({ widget: new PageLabelWidget(page), side: 1 }))
    }
  }
  return builder.finish()
}

/** CodeMirror 扩展：Markdown 分页线可视化 */
export const pageSeparatorExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
)
