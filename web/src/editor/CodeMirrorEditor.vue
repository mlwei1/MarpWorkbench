<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { basicSetup } from 'codemirror'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { undo as cmUndo, redo as cmRedo } from '@codemirror/commands'
import { pageSeparatorExtension } from './pageSeparator'
import type { FormatCommand } from './types'

const props = defineProps<{
  modelValue: string
  readonly?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  cursorLine: [line: number]
  ready: []
}>()

const host = ref<HTMLElement>()
let view: EditorView | null = null
let applyingExternal = false

const editorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontSize: '14px',
      backgroundColor: '#ffffff',
      color: '#1f2937',
    },
    '.cm-scroller': {
      fontFamily: "'Cascadia Code', 'JetBrains Mono', 'Consolas', 'Microsoft YaHei', monospace",
      lineHeight: '1.7',
      overflow: 'auto',
    },
    '.cm-content': { padding: '18px 0 40vh', caretColor: '#4f46e5' },
    '.cm-gutters': {
      backgroundColor: '#f8fafc',
      color: '#94a3b8',
      borderRight: '1px solid #e2e8f0',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 14px' },
    '.cm-activeLine': { backgroundColor: 'rgba(79,70,229,0.045)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(79,70,229,0.10)', color: '#4f46e5' },
    '&.cm-focused .cm-cursor': { borderLeftColor: '#4f46e5', borderLeftWidth: '2px' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'rgba(79,70,229,.18)',
    },
    '.cm-page-sep': {
      backgroundColor: '#eef2ff',
      borderTop: '1px dashed #c7d2fe',
      borderBottom: '1px dashed #c7d2fe',
    },
    '.cm-page-sep-label': {
      color: '#6366f1',
      fontSize: '11px',
      marginLeft: '10px',
      opacity: '0.85',
      userSelect: 'none',
    },
    '.cm-fm-end': { borderBottom: '1px dashed #cbd5e1' },
    '.cm-placeholder': { color: '#94a3b8' },
  },
  { dark: false },
)

onMounted(() => {
  if (!host.value) return
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        editorTheme,
        pageSeparatorExtension,
        EditorState.readOnly.of(!!props.readonly),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !applyingExternal) {
            emit('update:modelValue', update.state.doc.toString())
          }
          if (update.docChanged || update.selectionSet) {
            const head = update.state.selection.main.head
            emit('cursorLine', update.state.doc.lineAt(head).number)
          }
        }),
      ],
    }),
  })
  emit('ready')
  // e2e/调试用：暴露 EditorView（只读句柄），便于自动化测试读取完整文档与光标
  ;(window as unknown as { __mwbEditorView?: EditorView }).__mwbEditorView = view
})

/**
 * 外部 modelValue 更新：只应用最小 diff（公共前后缀之间），
 * 让 CodeMirror 自行把光标/选区映射到新文档，避免属性面板修改后光标跳到开头/抖动。
 */
watch(
  () => props.modelValue,
  (next) => {
    if (!view) return
    const current = view.state.doc.toString()
    if (next === current) return

    let start = 0
    const max = Math.min(current.length, next.length)
    while (start < max && current[start] === next[start]) start++
    let endCurrent = current.length
    let endNext = next.length
    while (endCurrent > start && endNext > start && current[endCurrent - 1] === next[endNext - 1]) {
      endCurrent--
      endNext--
    }

    applyingExternal = true
    try {
      view.dispatch({
        changes: { from: start, to: endCurrent, insert: next.slice(start, endNext) },
      })
    } finally {
      applyingExternal = false
    }
  },
)

onBeforeUnmount(() => {
  view?.destroy()
  view = null
  delete (window as unknown as { __mwbEditorView?: EditorView }).__mwbEditorView
})

// ---------------- Editor API（契约 §2.7） ----------------

function currentView(): EditorView | null {
  return view
}

function focus(): void {
  view?.focus()
}

function getCursorLine(): number {
  if (!view) return 1
  return view.state.doc.lineAt(view.state.selection.main.head).number
}

function setCursor(line: number, ch = 0): void {
  if (!view) return
  const doc = view.state.doc
  const lineNo = Math.min(Math.max(1, Math.round(line)), doc.lines)
  const lineInfo = doc.line(lineNo)
  const pos = Math.min(lineInfo.from + Math.max(0, ch), lineInfo.to)
  view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: true })
  view.focus()
}

function scrollToLine(line: number): void {
  if (!view) return
  const doc = view.state.doc
  const lineNo = Math.min(Math.max(1, Math.round(line)), doc.lines)
  view.dispatch({ effects: EditorView.scrollIntoView(doc.line(lineNo).from, { y: 'center' }) })
}

interface InsertOptions {
  block?: boolean
  atCursor?: boolean
}

function insertText(text: string, opts: InsertOptions = {}): void {
  const v = view
  if (!v) return
  const { from, to } = v.state.selection.main
  let insert = text
  const before = v.state.doc.sliceString(Math.max(0, from - 2), from)
  const after = v.state.doc.sliceString(to, Math.min(v.state.doc.length, to + 2))
  if (opts.block) {
    if (from > 0 && !before.endsWith('\n\n')) insert = (before.endsWith('\n') ? '' : '\n') + '\n' + insert
    if (to < v.state.doc.length && !after.startsWith('\n\n')) insert = insert + (after.startsWith('\n') ? '\n' : '\n\n')
  }
  const cursor = from + insert.length
  v.dispatch({
    changes: { from, to, insert },
    selection: EditorSelection.cursor(cursor),
    scrollIntoView: true,
  })
  v.focus()
}

function wrapSelection(beforeText: string, afterText: string, placeholder: string): void {
  const v = view
  if (!v) return
  const { from, to } = v.state.selection.main
  const selected = v.state.sliceDoc(from, to)
  const isWrapped = selected.startsWith(beforeText) && selected.endsWith(afterText) && selected.length >= beforeText.length + afterText.length
  if (isWrapped && selected.length > beforeText.length + afterText.length) {
    const inner = selected.slice(beforeText.length, selected.length - afterText.length)
    v.dispatch({
      changes: { from, to, insert: inner },
      selection: EditorSelection.range(from, from + inner.length),
    })
  } else {
    const content = selected || placeholder
    const insert = `${beforeText}${content}${afterText}`
    v.dispatch({
      changes: { from, to, insert },
      selection: selected
        ? EditorSelection.range(from + beforeText.length, from + beforeText.length + content.length)
        : EditorSelection.range(from + beforeText.length, from + beforeText.length + content.length),
    })
  }
  v.focus()
}

function applyLinePrefix(prefix: string, stripRe: RegExp): void {
  const v = view
  if (!v) return
  const { from, to } = v.state.selection.main
  const startLine = v.state.doc.lineAt(from).number
  const endLine = v.state.doc.lineAt(Math.max(from, to === from ? from : to - 1)).number
  const changes: { from: number; to: number; insert: string }[] = []
  for (let lineNo = startLine; lineNo <= endLine; lineNo++) {
    const line = v.state.doc.line(lineNo)
    const stripped = line.text.replace(stripRe, '')
    const hasPrefix = new RegExp(`^\\s*${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(line.text)
    if (hasPrefix) {
      const m = new RegExp(`^(\\s*)${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).exec(line.text)
      const indent = m ? m[1] : ''
      changes.push({ from: line.from, to: line.from + (m ? m[0].length : 0), insert: indent })
    } else {
      changes.push({ from: line.from, to: line.from, insert: prefix })
    }
    void stripped
  }
  v.dispatch({ changes })
  v.focus()
}

function format(cmd: FormatCommand): void {
  const v = view
  if (!v) return
  switch (cmd) {
    case 'bold':
      wrapSelection('**', '**', '加粗文字')
      break
    case 'italic':
      wrapSelection('*', '*', '斜体文字')
      break
    case 'strike':
      wrapSelection('~~', '~~', '删除线')
      break
    case 'inlinecode':
      wrapSelection('`', '`', '代码')
      break
    case 'h1':
      applyLinePrefix('# ', /^#{1,6}\s+/)
      break
    case 'h2':
      applyLinePrefix('## ', /^#{1,6}\s+/)
      break
    case 'h3':
      applyLinePrefix('### ', /^#{1,6}\s+/)
      break
    case 'ul':
      applyLinePrefix('- ', /^(\s*)([-*+]|\d+\.)\s+/)
      break
    case 'ol':
      applyLinePrefix('1. ', /^(\s*)([-*+]|\d+\.)\s+/)
      break
    case 'quote':
      applyLinePrefix('> ', /^>\s?/)
      break
    case 'codeblock': {
      const { from, to } = v.state.selection.main
      const selected = v.state.sliceDoc(from, to)
      const insert = selected ? `\n\n\`\`\`\n${selected}\n\`\`\`\n\n` : `\n\n\`\`\`js\n// 代码\n\`\`\`\n\n`
      v.dispatch({ changes: { from, to, insert }, selection: EditorSelection.cursor(from + insert.length) })
      v.focus()
      break
    }
    case 'math': {
      const { from, to } = v.state.selection.main
      const selected = v.state.sliceDoc(from, to)
      const body = selected || 'x = 1'
      const insert = `\n\n$$\n${body}\n$$\n\n`
      v.dispatch({ changes: { from, to, insert }, selection: EditorSelection.cursor(from + insert.length) })
      v.focus()
      break
    }
    case 'hr': {
      // 在 Marp 中 --- 是分页线（不是水平线），这里插入分页
      insertText('\n\n---\n\n', { block: false })
      break
    }
  }
}

function doUndo(): void {
  if (view) {
    cmUndo(view)
    view.focus()
  }
}

function doRedo(): void {
  if (view) {
    cmRedo(view)
    view.focus()
  }
}

defineExpose({
  focus,
  getCursorLine,
  setCursor,
  scrollToLine,
  insertText,
  format,
  undo: doUndo,
  redo: doRedo,
  getView: currentView,
})
</script>

<template>
  <div ref="host" class="cm-host" />
</template>

<style scoped>
.cm-host {
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
</style>
