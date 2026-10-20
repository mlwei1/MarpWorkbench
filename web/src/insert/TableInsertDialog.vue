<script setup lang="ts">
/**
 * 表格插入对话框（M2，owner: export-eng；契约 docs/UI_CONTRACT_M2.md §2.4）
 *
 * props: { markdown, currentPage }
 * emits: insert(snippet: string) / close
 *
 * 能力：
 * - 12×12 网格 hover/点击快速选行列（也可数字输入）
 * - 表头开关、对齐（左/中/右，GFM `:---` / `:---:` / `---:`）、首列加粗
 * - 单元格可编辑（占位文字默认「表头1 / 内容 1」）
 * - 对话框内 HTML 预览表格样式；生成 GFM 表格块（前后空行）→ 父组件插到光标处
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  buildTableSnippet,
  defaultTableCell,
  defaultTableCells,
  type TableAlign,
} from './compose'

const props = defineProps<{ markdown: string; currentPage: number }>()

const emit = defineEmits<{
  insert: [snippet: string]
  close: []
}>()

const MAX = 12

const rows = ref(3)
const cols = ref(3)
const header = ref(true)
const align = ref<TableAlign>('left')
const firstColBold = ref(false)
const cells = ref<string[][]>(defaultTableCells(3, 3, true))

const hoverRow = ref(0)
const hoverCol = ref(0)

const previewRows = computed(() => (hoverRow.value > 0 ? hoverRow.value : rows.value))
const previewCols = computed(() => (hoverCol.value > 0 ? hoverCol.value : cols.value))

const grid = Array.from({ length: MAX }, (_, r) => r + 1)
const gridCols = Array.from({ length: MAX }, (_, c) => c + 1)

const snippet = computed(() =>
  buildTableSnippet({
    rows: rows.value,
    cols: cols.value,
    header: header.value,
    align: align.value,
    firstColBold: firstColBold.value,
    cells: cells.value,
  })
)

/** 行列/表头变化时同步单元格（保留已输入文本） */
function syncCells(): void {
  const r = Math.max(1, Math.min(MAX, Math.round(rows.value)))
  const c = Math.max(1, Math.min(MAX, Math.round(cols.value)))
  rows.value = r
  cols.value = c
  const next: string[][] = []
  for (let i = 0; i < r; i++) {
    const line: string[] = []
    for (let j = 0; j < c; j++) {
      const old = cells.value[i]?.[j]
      line.push(old != null && old !== '' ? old : defaultTableCell(i, j, header.value && i === 0))
    }
    next.push(line)
  }
  cells.value = next
}

function pick(rc: number, cc: number): void {
  rows.value = rc
  cols.value = cc
  syncCells()
}

function onRowsInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  rows.value = Math.max(1, Math.min(MAX, Math.round(value || 1)))
  syncCells()
}

function onColsInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  cols.value = Math.max(1, Math.min(MAX, Math.round(value || 1)))
  syncCells()
}

function onHeaderChange(): void {
  // 表头关闭时，把原本的「表头N」占位换成「内容 N」
  for (let j = 0; j < cols.value; j++) {
    if (!header.value && /^表头\d+$/.test(cells.value[0]?.[j] || '')) {
      cells.value[0][j] = defaultTableCell(0, j, false)
    }
    if (header.value && /^内容 \d+$/.test(cells.value[0]?.[j] || '')) {
      cells.value[0][j] = defaultTableCell(0, j, true)
    }
  }
}

const alignOptions: { value: TableAlign; label: string }[] = [
  { value: 'left', label: '左对齐' },
  { value: 'center', label: '居中' },
  { value: 'right', label: '右对齐' },
]

const alignStyle = (idx: number): Record<string, string> =>
  idx === 0 ? { textAlign: align.value } : {}

function doInsert(): void {
  emit('insert', snippet.value)
  emit('close')
}

function requestClose(): void {
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    requestClose()
  }
}

watch(
  () => props.markdown,
  () => {
    /* 表格片段与 markdown 内容无关；保留接口以便将来统计当前页已有表格 */
  }
)

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="modal-mask" @click.self="requestClose">
    <div class="modal-panel table-panel">
      <div class="modal-head">
        <h2>插入表格</h2>
        <div class="head-actions">
          <span class="muted small">第 {{ currentPage }} 页</span>
          <button class="btn btn-ghost btn-sm" type="button" @click="requestClose">关闭</button>
        </div>
      </div>

      <div class="table-body">
        <!-- 选择行列 -->
        <section class="pane">
          <div class="block-title">选择行列</div>
          <div class="size-hint">{{ previewRows }} 行 × {{ previewCols }} 列</div>
          <div class="grid" @mouseleave="hoverRow = 0; hoverCol = 0">
            <template v-for="r in grid" :key="r">
              <button
                v-for="c in gridCols"
                :key="`${r}-${c}`"
                type="button"
                class="grid-cell"
                :class="{ on: r <= previewRows && c <= previewCols, edge: r === rows && c === cols }"
                :title="`${r} 行 × ${c} 列`"
                @mouseenter="hoverRow = r; hoverCol = c"
                @click="pick(r, c)"
              />
            </template>
          </div>
          <div class="num-row">
            <label class="num-field">
              <span>行</span>
              <input :value="rows" type="number" min="1" max="12" @change="onRowsInput" />
            </label>
            <label class="num-field">
              <span>列</span>
              <input :value="cols" type="number" min="1" max="12" @change="onColsInput" />
            </label>
          </div>

          <div class="block-title mt">选项</div>
          <label class="check">
            <input v-model="header" type="checkbox" @change="onHeaderChange" />
            <span>首行作为表头（加粗 + 分隔线）</span>
          </label>
          <label class="check">
            <input v-model="firstColBold" type="checkbox" />
            <span>首列加粗（数据行）</span>
          </label>
          <div class="align-row">
            <span class="field-label">对齐</span>
            <div class="seg">
              <button
                v-for="opt in alignOptions"
                :key="opt.value"
                type="button"
                class="seg-btn"
                :class="{ active: align === opt.value }"
                @click="align = opt.value"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>
        </section>

        <!-- 单元格编辑 + 预览 -->
        <section class="pane grow">
          <div class="block-title">单元格内容（可直接编辑）</div>
          <div class="cells-scroll">
            <table class="cell-editor">
              <tbody>
                <tr v-for="(row, ri) in cells" :key="ri" :class="{ head: header && ri === 0 }">
                  <th class="row-head">{{ header && ri === 0 ? '表头' : ri + (header ? 0 : 1) }}</th>
                  <td v-for="(cell, ci) in row" :key="ci">
                    <input v-model="cells[ri][ci]" type="text" :style="alignStyle(ci)" />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="block-title mt">预览</div>
          <div class="table-preview">
            <table>
              <thead v-if="header">
                <tr>
                  <th v-for="(cell, ci) in cells[0]" :key="`h-${ci}`" :style="alignStyle(ci)">
                    <strong v-if="firstColBold && ci === 0">{{ cell }}</strong>
                    <template v-else>{{ cell }}</template>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, ri) in cells.slice(header ? 1 : 0)" :key="`b-${ri}`">
                  <td v-for="(cell, ci) in row" :key="`b-${ri}-${ci}`" :style="alignStyle(ci)">
                    <strong v-if="firstColBold && ci === 0">{{ cell }}</strong>
                    <template v-else>{{ cell }}</template>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="snippet-box">
            <div class="snippet-head">
              <span>将写入的 GFM Markdown</span>
              <span class="muted small">插入到光标处（前后自动空行）</span>
            </div>
            <pre class="snippet">{{ snippet.trim() }}</pre>
          </div>
        </section>
      </div>

      <div class="table-foot">
        <span class="muted small">插入后仍是标准 GFM 表格，可拷回 VS Code / marp-cli。</span>
        <div class="foot-actions">
          <button class="btn btn-ghost" type="button" @click="requestClose">取消</button>
          <button class="btn btn-primary" type="button" @click="doInsert">插入表格</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.table-panel {
  width: min(980px, 96vw);
  height: min(720px, 92vh);
  font-family: 'Microsoft YaHei', 'Segoe UI', sans-serif;
  color: var(--mwb-text);
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.table-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  overflow: hidden;
}
.pane {
  min-height: 0;
  padding: 14px 18px;
  overflow-y: auto;
}
.pane:first-child {
  border-right: 1px solid var(--mwb-border);
  background: #fbfcfe;
}
.pane.grow {
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: #f4f6fb;
}
.block-title {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 6px;
}
.block-title.mt {
  margin-top: 14px;
}
.size-hint {
  font-size: 12px;
  color: var(--mwb-primary);
  margin-bottom: 6px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: 2px;
  width: fit-content;
  user-select: none;
}
.grid-cell {
  width: 16px;
  height: 16px;
  padding: 0;
  border: 1px solid var(--mwb-border);
  border-radius: 3px;
  background: #fff;
  cursor: pointer;
  transition: background 0.06s, border-color 0.06s;
}
.grid-cell.on {
  background: #dbeafe;
  border-color: #93c5fd;
}
.grid-cell.edge {
  background: var(--mwb-primary);
  border-color: var(--mwb-primary);
}
.num-row {
  display: flex;
  gap: 14px;
  margin-top: 10px;
}
.num-field {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--mwb-text-weak);
}
.num-field input {
  width: 56px;
  height: 28px;
  border: 1px solid var(--mwb-border-strong);
  border-radius: 7px;
  padding: 0 6px;
  font-size: 12px;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 12.5px;
}
.align-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  font-size: 12px;
}
.field-label {
  color: var(--mwb-text-weak);
  width: 40px;
}
.seg {
  display: inline-flex;
  border: 1px solid var(--mwb-border);
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
}
.seg-btn {
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-right: 1px solid var(--mwb-border);
  background: transparent;
  font-size: 12px;
  cursor: pointer;
  color: var(--mwb-text);
}
.seg-btn:last-child {
  border-right: 0;
}
.seg-btn.active {
  background: var(--mwb-primary-soft);
  color: var(--mwb-primary);
  font-weight: 600;
}
.cells-scroll {
  max-height: 208px;
  overflow: auto;
  border: 1px solid var(--mwb-border);
  border-radius: 10px;
  background: #fff;
}
.cell-editor {
  border-collapse: collapse;
  width: 100%;
  font-size: 12px;
}
.cell-editor th,
.cell-editor td {
  border-bottom: 1px solid #eef2f7;
  border-right: 1px solid #eef2f7;
  padding: 2px;
}
.cell-editor tr.head td {
  background: #f8fafc;
}
.cell-editor tr.head td input {
  font-weight: 600;
}
.cell-editor .row-head {
  width: 44px;
  color: var(--mwb-text-weak);
  font-weight: 400;
  background: #fbfcfe;
  position: sticky;
  left: 0;
}
.cell-editor input {
  width: 100%;
  min-width: 88px;
  height: 26px;
  border: 1px solid transparent;
  border-radius: 5px;
  padding: 0 6px;
  font-size: 12px;
  background: transparent;
}
.cell-editor input:focus {
  outline: none;
  border-color: var(--mwb-primary);
  background: #fff;
}
.table-preview {
  border: 1px solid var(--mwb-border);
  border-radius: 10px;
  background: #fff;
  padding: 12px;
  overflow: auto;
  max-height: 220px;
}
.table-preview table {
  border-collapse: collapse;
  width: 100%;
  font-size: 12.5px;
}
.table-preview th,
.table-preview td {
  border: 1px solid #d7dee9;
  padding: 6px 10px;
}
.table-preview thead th {
  background: #eef2ff;
  color: #312e81;
}
.snippet-box {
  border: 1px solid var(--mwb-border);
  border-radius: 10px;
  background: #fff;
  overflow: hidden;
  margin-top: 4px;
}
.snippet-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--mwb-border);
  font-size: 12px;
  color: var(--mwb-text-weak);
  background: #fbfcfe;
}
.snippet {
  margin: 0;
  padding: 10px;
  font-size: 12px;
  line-height: 1.5;
  color: #0f172a;
  white-space: pre-wrap;
  word-break: break-word;
}
.table-foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 18px;
  border-top: 1px solid var(--mwb-border);
}
.foot-actions {
  display: flex;
  gap: 8px;
}
@media (max-width: 860px) {
  .table-body {
    grid-template-columns: 1fr;
    overflow-y: auto;
  }
  .pane:first-child {
    border-right: 0;
    border-bottom: 1px solid var(--mwb-border);
  }
  .pane {
    overflow: visible;
  }
}
</style>
