<script setup lang="ts">
/**
 * 格式工具栏（owner: frontend-core / marp-tech，契约 §2.7）
 * emit 给 EditView：format(cmd) 调用 CodeMirrorEditor.format；图片/表格打开对话框；撤销/重做。
 */
import type { FormatCommand } from '../editor/types'

defineProps<{ disabled?: boolean }>()

const emit = defineEmits<{
  format: [cmd: FormatCommand]
  openImage: []
  openTable: []
  /** M3：插入 mermaid 图表代码块 */
  insertChart: []
  undo: []
  redo: []
}>()

interface ToolButton {
  label: string
  title: string
  cmd?: FormatCommand
  action?: 'openImage' | 'openTable' | 'insertChart'
  className?: string
}

const headingButtons: ToolButton[] = [
  { label: 'H1', title: '一级标题', cmd: 'h1' },
  { label: 'H2', title: '二级标题', cmd: 'h2' },
  { label: 'H3', title: '三级标题', cmd: 'h3' },
]
const inlineButtons: ToolButton[] = [
  { label: 'B', title: '加粗（Ctrl+B）', cmd: 'bold', className: 'toolbar-strong' },
  { label: 'I', title: '斜体', cmd: 'italic', className: 'toolbar-em' },
  { label: 'S', title: '删除线', cmd: 'strike', className: 'toolbar-strike' },
]
const blockButtons: ToolButton[] = [
  { label: '• 列表', title: '无序列表', cmd: 'ul' },
  { label: '1. 列表', title: '有序列表', cmd: 'ol' },
  { label: '❝ 引用', title: '引用块', cmd: 'quote' },
]
const codeButtons: ToolButton[] = [
  { label: '`代码`', title: '行内代码', cmd: 'inlinecode' },
  { label: '代码块', title: '代码块', cmd: 'codeblock' },
  { label: '∑ 公式', title: '插入公式（$$...$$）', cmd: 'math' },
  { label: '分页', title: '插入分页线（---）', cmd: 'hr' },
]
const insertButtons: ToolButton[] = [
  { label: '🖼 图片', title: '插入图片 / 背景图（光标在已有图片上时为编辑）', action: 'openImage' },
  { label: '▦ 表格', title: '插入表格', action: 'openTable' },
  { label: '◈ 图表', title: '插入 Mermaid 图表', action: 'insertChart' },
]

function onButton(btn: ToolButton): void {
  if (btn.action === 'openImage') emit('openImage')
  else if (btn.action === 'openTable') emit('openTable')
  else if (btn.action === 'insertChart') emit('insertChart')
  else if (btn.cmd) emit('format', btn.cmd)
}
</script>

<template>
  <div class="editor-toolbar" role="toolbar" aria-label="格式工具栏">
    <div class="toolbar-group">
      <button
        v-for="b in headingButtons"
        :key="b.label"
        class="btn btn-ghost btn-sm toolbar-btn"
        :title="b.title"
        :disabled="disabled"
        @click="onButton(b)"
      >
        {{ b.label }}
      </button>
    </div>
    <span class="toolbar-sep" />
    <div class="toolbar-group">
      <button
        v-for="b in inlineButtons"
        :key="b.label"
        class="btn btn-ghost btn-sm toolbar-btn"
        :class="b.className"
        :title="b.title"
        :disabled="disabled"
        @click="onButton(b)"
      >
        {{ b.label }}
      </button>
    </div>
    <span class="toolbar-sep" />
    <div class="toolbar-group">
      <button
        v-for="b in blockButtons"
        :key="b.label"
        class="btn btn-ghost btn-sm toolbar-btn"
        :title="b.title"
        :disabled="disabled"
        @click="onButton(b)"
      >
        {{ b.label }}
      </button>
    </div>
    <span class="toolbar-sep" />
    <div class="toolbar-group">
      <button
        v-for="b in codeButtons"
        :key="b.label"
        class="btn btn-ghost btn-sm toolbar-btn"
        :title="b.title"
        :disabled="disabled"
        @click="onButton(b)"
      >
        {{ b.label }}
      </button>
    </div>
    <span class="toolbar-sep" />
    <div class="toolbar-group">
      <button
        v-for="b in insertButtons"
        :key="b.label"
        class="btn btn-secondary btn-sm toolbar-btn"
        :title="b.title"
        :disabled="disabled"
        @click="onButton(b)"
      >
        {{ b.label }}
      </button>
    </div>
    <div class="toolbar-right">
      <button class="btn btn-ghost btn-sm toolbar-btn" title="撤销（Ctrl+Z）" :disabled="disabled" @click="emit('undo')">↶ 撤销</button>
      <button class="btn btn-ghost btn-sm toolbar-btn" title="重做（Ctrl+Shift+Z）" :disabled="disabled" @click="emit('redo')">↷ 重做</button>
    </div>
  </div>
</template>

<style scoped>
.editor-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 38px;
  padding: 0 10px;
  border-bottom: 1px solid var(--mwb-border, #e2e8f0);
  background: #fbfcfe;
  overflow-x: auto;
  flex: 0 0 auto;
}
.toolbar-group {
  display: flex;
  align-items: center;
  gap: 2px;
}
.toolbar-btn {
  height: 26px;
  padding: 0 8px;
  font-size: 12px;
}
.toolbar-strong {
  font-weight: 700;
}
.toolbar-em {
  font-style: italic;
}
.toolbar-strike {
  text-decoration: line-through;
}
.toolbar-sep {
  width: 1px;
  height: 16px;
  background: #e2e8f0;
  margin: 0 4px;
  flex: 0 0 auto;
}
.toolbar-right {
  margin-left: auto;
  display: flex;
  gap: 2px;
  flex: 0 0 auto;
}
</style>
