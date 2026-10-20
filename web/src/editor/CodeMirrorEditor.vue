<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { pageSeparatorExtension } from './pageSeparator'

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
})

watch(
  () => props.modelValue,
  (next) => {
    if (!view) return
    const current = view.state.doc.toString()
    if (next === current) return
    applyingExternal = true
    try {
      view.dispatch({ changes: { from: 0, to: current.length, insert: next } })
    } finally {
      applyingExternal = false
    }
  },
)

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})

defineExpose({
  focus(): void {
    view?.focus()
  },
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
