<script setup lang="ts">
/**
 * Mermaid 图表插入 / 编辑对话框（M5.0，契约 docs/UI_CONTRACT_M5_MERMAID.md §2）
 *
 * - 三类布局：左侧 19 类示例卡 / 中间可编辑代码 / 右侧实时预览 + 尺寸下拉
 * - 实时预览：400ms 防抖 + token 防竞态，调用 mermaid 模块的 renderMermaidPreview（失败显示中文错误）
 * - 尺寸：auto/s/m/l/xl/custom%，非 auto 时在代码块首行写 `%% mwb-size: <value>`（自动去掉旧指令，绝不重复）
 * - 编辑模式（initialBlock）：标题「编辑 Mermaid 图表」/ 按钮「保存修改」，由父组件原位替换
 *
 * 测试选择器（Lead e2e 依赖）：.mwb-mermaid-dialog / button.mwb-mermaid-type[data-type] /
 * textarea.mwb-mermaid-code / .mwb-mermaid-preview（失败加 .mwb-mermaid-preview-error）/
 * select.mwb-mermaid-size / input.mwb-mermaid-custom / button.primary / button.mwb-mermaid-cancel
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getMermaidSizeOptions, renderMermaidPreview, serializeMermaidSize, type MermaidSizePreset } from '../mermaid'
import { buildMermaidFence } from './mermaidBlock'

interface InitialBlock {
  from: number
  to: number
  code: string
  preset: MermaidSizePreset
  customValue?: string
  line: number
}

const props = defineProps<{
  markdown?: string
  currentPage?: number
  initialBlock?: InitialBlock | null
}>()

const emit = defineEmits<{
  insert: [{ snippet: string; mode: 'insert' | 'edit'; from?: number; to?: number; cursorLine?: number }]
  close: []
}>()

// ---------------- 示例库（19 类，全部真实可渲染；中文示例内容方便直接改） ----------------
interface MermaidExample {
  key: string
  name: string
  icon: string
  code: string
}

const EXAMPLES: MermaidExample[] = [
  {
    key: 'flowchart',
    name: '流程图',
    icon: '🔀',
    code: `graph LR
  A[开始] --> B{是否继续？}
  B -- 是 --> C[继续执行]
  B -- 否 --> D[结束]`,
  },
  {
    key: 'sequence',
    name: '时序图',
    icon: '⏱️',
    code: `sequenceDiagram
  participant U as 用户
  participant S as 系统
  U->>S: 提交订单
  S-->>U: 返回订单号
  Note right of S: 校验库存与支付状态`,
  },
  {
    key: 'class',
    name: '类图',
    icon: '🧩',
    code: `classDiagram
  class User {
    +String name
    +String phone
    +login()
  }
  class Order {
    +String orderNo
    +pay()
  }
  User "1" --> "*" Order : 下单
  note for User "用户"
  note for Order "订单"`,
  },
  {
    key: 'state',
    name: '状态图',
    icon: '🔁',
    code: `stateDiagram-v2
  state "待处理" as Pending
  state "处理中" as Processing
  state "已完成" as Done
  state "已取消" as Cancelled
  [*] --> Pending
  Pending --> Processing : 开始
  Processing --> Done : 完成
  Processing --> Cancelled : 取消
  Done --> [*]`,
  },
  {
    key: 'er',
    name: '实体关系图',
    icon: '🗄️',
    code: `erDiagram
  CUSTOMER ||--o{ ORDER : "创建"
  ORDER ||--|{ ORDER_ITEM : "包含"
  CUSTOMER {
    string name "姓名"
    string phone "电话"
  }
  ORDER {
    string orderNo "订单号"
    date createdAt "下单日期"
  }`,
  },
  {
    key: 'gantt',
    name: '甘特图',
    icon: '📅',
    code: `gantt
  title 项目计划
  dateFormat YYYY-MM-DD
  section 需求
  需求调研 :a1, 2024-01-01, 7d
  需求评审 :a2, after a1, 3d
  section 开发
  前端开发 :b1, after a2, 10d
  后端开发 :b2, after a2, 12d`,
  },
  {
    key: 'pie',
    name: '饼图',
    icon: '🥧',
    code: `pie title 用户来源分布
  "搜索引擎" : 45
  "直接访问" : 25
  "社交媒体" : 20
  "其他" : 10`,
  },
  {
    key: 'mindmap',
    name: '思维导图',
    icon: '🧠',
    code: `mindmap
  root((产品规划))
    用户需求
      用户调研
      反馈收集
    功能设计
      核心功能
      增值功能`,
  },
  {
    key: 'timeline',
    name: '时间线',
    icon: '🕒',
    code: `timeline
  title 产品发展历程
  2022 : 立项
  2023 : 首个版本发布
  2024 : 用户破万
  2025 : 企业版上线`,
  },
  {
    key: 'journey',
    name: '用户旅程',
    icon: '🗺️',
    code: `journey
  title 用户下单旅程
  section 浏览选购
    搜索商品: 4: 用户
    查看详情: 3: 用户
  section 下单支付
    加入购物车: 5: 用户
    提交订单: 2: 用户`,
  },
  {
    key: 'quadrant',
    name: '象限图',
    icon: '🎯',
    code: `quadrantChart
  title 需求优先级
  x-axis 低影响 --> 高影响
  y-axis 低成本 --> 高成本
  quadrant-1 优先做
  quadrant-2 计划做
  quadrant-3 稍后做
  quadrant-4 避免做
  需求A: [0.8, 0.3]
  需求B: [0.6, 0.7]
  需求C: [0.3, 0.4]`,
  },
  {
    key: 'xychart',
    name: '柱状/折线图',
    icon: '📊',
    code: `xychart-beta
  title "月度收入"
  x-axis ["一月", "二月", "三月", "四月", "五月"]
  y-axis "万元" 0 --> 100
  bar [20, 45, 38, 60, 72]
  line [20, 45, 38, 60, 72]`,
  },
  {
    key: 'sankey',
    name: '桑基图',
    icon: '🌊',
    // mermaid v12 的 sankey 解析器暂不支持中文节点名，示例用英文节点、中文标题由页面标题承担
    code: `sankey-beta
Web,Home,100
Web,Leave,20
Home,Signup,60
Home,Browse,40
Signup,Paid,15`,
  },
  {
    key: 'radar',
    name: '雷达图',
    icon: '🕸️',
    code: `radar-beta
  title 方案能力评估
  axis a["完整度"], b["成本"], c["风险"]
  curve one["方案A"]{80, 60, 40}
  curve two["方案B"]{60, 80, 50}`,
  },
  {
    key: 'treemap',
    name: '树图',
    icon: '🗂️',
    code: `treemap-beta
  "产品收入"
    "核心产品": 60
    "增值服务": 25
    "其他": 15`,
  },
  {
    key: 'block',
    name: '块图',
    icon: '🧱',
    code: `block-beta
  columns 3
  前端["前端"] 服务["本地服务"] 浏览器["浏览器"]
  前端 --> 服务`,
  },
  {
    key: 'git',
    name: 'Git 图',
    icon: '🌿',
    code: `gitGraph
  commit id: "初始化"
  branch feature
  checkout feature
  commit id: "功能开发"
  commit id: "测试"
  checkout main
  merge feature
  commit id: "发布"`,
  },
  {
    key: 'c4',
    name: 'C4 上下文图',
    icon: '🏛️',
    code: `C4Context
  title 系统上下文
  Person(user, "用户", "使用产品")
  System(app, "MarpWorkbench", "幻灯片工作台")
  System_Ext(browser, "浏览器", "渲染界面")
  Rel(user, app, "使用")
  Rel(app, browser, "打开")`,
  },
  {
    key: 'kanban',
    name: '看板',
    icon: '🗒️',
    code: `kanban
  待办
    [需求评审]
    [设计稿]
  进行中
    [开发]
  已完成
    [立项]`,
  },
]

const editing = computed(() => !!props.initialBlock)
const dialogTitle = computed(() => (editing.value ? '编辑 Mermaid 图表' : '插入 Mermaid 图表'))
const selectedKey = ref<string>('flowchart')

/** 编辑模式：按代码首行关键字高亮对应类型卡 */
function detectType(code: string): string {
  const first = code
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('%%'))
  if (!first) return ''
  if (/^block-beta/i.test(first)) return 'block'
  if (/^quadrantChart/i.test(first)) return 'quadrant'
  if (/^xychart-beta/i.test(first)) return 'xychart'
  if (/^sankey-beta/i.test(first)) return 'sankey'
  if (/^radar-beta/i.test(first)) return 'radar'
  if (/^treemap-beta/i.test(first)) return 'treemap'
  if (/^gitGraph/i.test(first)) return 'git'
  if (/^C4Context/i.test(first)) return 'c4'
  if (/^kanban/i.test(first)) return 'kanban'
  if (/^graph\b|^flowchart\b/i.test(first)) return 'flowchart'
  if (/^sequenceDiagram/i.test(first)) return 'sequence'
  if (/^classDiagram/i.test(first)) return 'class'
  if (/^stateDiagram/i.test(first)) return 'state'
  if (/^erDiagram/i.test(first)) return 'er'
  if (/^gantt/i.test(first)) return 'gantt'
  if (/^pie/i.test(first)) return 'pie'
  if (/^mindmap/i.test(first)) return 'mindmap'
  if (/^timeline/i.test(first)) return 'timeline'
  if (/^journey/i.test(first)) return 'journey'
  return ''
}

// ---------------- 代码 / 尺寸状态 ----------------
/** textarea 内容：当前 mermaid 源码（含尺寸指令，若有） */
const text = ref('')
const preset = ref<MermaidSizePreset>('auto')
const customPercent = ref<number>(70)
const codeRef = ref<HTMLTextAreaElement>()

const sizeOptions = getMermaidSizeOptions().map((o) => (o.value === 'custom' ? { ...o, label: '自定义百分比' } : o))
/** 编辑模式来自外部（如拷入）的 px 自定义指令：用户未改尺寸前原样保留，避免静默改成百分比 */
const rawCustomPx = ref<string | null>(null)
/** onMounted 初始化完成前，尺寸 watcher 不重写指令 */
const sizeInitialized = ref(false)

function currentSize(): { preset: MermaidSizePreset; customValue?: string } {
  return preset.value === 'custom'
    ? { preset: 'custom', customValue: `${Math.min(100, Math.max(1, Math.round(customPercent.value) || 70))}%` }
    : { preset: preset.value }
}

/** 去掉代码前 5 行内所有尺寸指令（防止重复；比模块的“只删第一条”更严格） */
function stripAllSizeDirectives(code: string): string {
  const lines = (code || '').split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (i < 5 && /^\s*%%\s*mwb-size\s*:/i.test(lines[i])) continue
    out.push(lines[i])
  }
  return out.join('\n')
}

/** 把当前尺寸写回 textarea（先清掉旧指令，保证永远至多一条） */
function syncTextDirective(): void {
  const body = stripAllSizeDirectives(text.value).replace(/\s+$/g, '')
  const value = serializeMermaidSize(preset.value, preset.value === 'custom' ? `${customPercent.value}%` : undefined)
  text.value = value ? `%% mwb-size: ${value}\n${body}` : body
}

const canInsert = computed(() => {
  if (!text.value.trim()) return false
  if (preset.value === 'custom') {
    const n = Number(customPercent.value)
    if (!Number.isFinite(n) || n < 1 || n > 100) return false
  }
  return true
})

// ---------------- 实时预览（400ms 防抖 + token） ----------------
const previewSvg = ref('')
const previewError = ref('')
const previewLoading = ref(false)
let previewTimer: number | undefined
let previewSeq = 0

async function renderPreviewNow(): Promise<void> {
  const seq = ++previewSeq
  const code = text.value.trim()
  if (!code) {
    previewSvg.value = ''
    previewError.value = ''
    previewLoading.value = false
    return
  }
  previewLoading.value = true
  try {
    const svg = await renderMermaidPreview(code)
    if (seq !== previewSeq) return
    previewSvg.value = svg
    previewError.value = ''
  } catch (err) {
    if (seq !== previewSeq) return
    previewSvg.value = ''
    previewError.value = String((err as Error)?.message || err || 'Mermaid 渲染失败')
  } finally {
    if (seq === previewSeq) previewLoading.value = false
  }
}

function schedulePreview(): void {
  window.clearTimeout(previewTimer)
  previewTimer = window.setTimeout(() => {
    void renderPreviewNow()
  }, 400)
}

watch(
  () => text.value,
  () => schedulePreview(),
)

watch(preset, () => {
  if (!sizeInitialized.value) return
  rawCustomPx.value = null
  if (preset.value === 'custom') {
    const n = Number(customPercent.value)
    if (!Number.isFinite(n) || n < 1 || n > 100) customPercent.value = 70
  }
  syncTextDirective()
})

watch(customPercent, () => {
  if (!sizeInitialized.value) return
  if (preset.value !== 'custom') return
  rawCustomPx.value = null
  const n = Number(customPercent.value)
  if (!Number.isFinite(n) || n < 1 || n > 100) return
  syncTextDirective()
})

// ---------------- 交互 ----------------
function pickExample(ex: MermaidExample): void {
  selectedKey.value = ex.key
  text.value = stripAllSizeDirectives(ex.code)
  syncTextDirective()
}

function applyDirectiveOnce(): void {
  // 防止从编辑模式进入时旧指令重复：确保 textarea 里只有一条指令
  if (text.value.split('\n').some((l) => /^\s*%%\s*mwb-size\s*:/i.test(l))) {
    syncTextDirective()
  }
}

function doInsert(): void {
  if (!canInsert.value) return
  const body = stripAllSizeDirectives(text.value).replace(/\s+$/g, '')
  const keepPx = rawCustomPx.value && preset.value === 'custom' ? rawCustomPx.value : null
  const value = keepPx || serializeMermaidSize(preset.value, preset.value === 'custom' ? `${Math.round(customPercent.value)}%` : undefined)
  const withDirective = value ? `%% mwb-size: ${value}\n${body}` : body
  const snippet = buildMermaidFence(withDirective)
  if (editing.value && props.initialBlock) {
    const block = props.initialBlock
    emit('insert', { snippet, mode: 'edit', from: block.from, to: block.to, cursorLine: block.line })
  } else {
    emit('insert', { snippet, mode: 'insert' })
  }
  emit('close')
}

function requestClose(): void {
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    requestClose()
  }
}

onMounted(async () => {
  const block = props.initialBlock
  if (block) {
    text.value = block.code
    preset.value = block.preset
    const percent = Number(String(block.customValue || '').replace(/[^\d.]/g, ''))
    if (block.preset === 'custom' && Number.isFinite(percent) && percent >= 1 && percent <= 100) {
      customPercent.value = Math.round(percent)
    }
    selectedKey.value = detectType(block.code)
    // 来自外部的 px 自定义尺寸：用户不改尺寸时原样保留
    if (block.preset === 'custom' && /px$/i.test(block.customValue || '')) {
      rawCustomPx.value = block.customValue || null
    } else {
      applyDirectiveOnce()
    }
  } else {
    const first = EXAMPLES[0]
    selectedKey.value = first.key
    text.value = first.code
    syncTextDirective()
  }
  window.addEventListener('keydown', onKeydown, true)
  await nextTick()
  sizeInitialized.value = true
  codeRef.value?.focus()
  void renderPreviewNow()
})

onBeforeUnmount(() => {
  window.clearTimeout(previewTimer)
  window.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <div
    class="modal-mask mwb-mermaid-dialog"
    role="dialog"
    aria-modal="true"
    :aria-label="dialogTitle"
    @click.self="requestClose"
  >
    <div class="modal-panel mermaid-panel">
      <div class="modal-head">
        <h2>{{ dialogTitle }}</h2>
        <div class="head-actions">
          <span v-if="editing && initialBlock" class="muted small">第 {{ initialBlock.line }} 行</span>
          <span v-if="typeof currentPage === 'number' && currentPage > 0" class="muted small">第 {{ currentPage }} 页</span>
          <button class="btn btn-ghost btn-sm mwb-mermaid-cancel" type="button" @click="requestClose">关闭</button>
        </div>
      </div>

      <div class="mermaid-body">
        <aside class="mermaid-types">
          <div class="block-title">图表类型 <span class="type-count">共 19 类 · 可滚动</span></div>
          <div class="type-grid">
            <button
              v-for="ex in EXAMPLES"
              :key="ex.key"
              class="mwb-mermaid-type"
              :class="{ active: selectedKey === ex.key }"
              :data-type="ex.key"
              type="button"
              :title="`${ex.name}示例`"
              @click="pickExample(ex)"
            >
              <span class="type-icon">{{ ex.icon }}</span>
              <span class="type-name">{{ ex.name }}</span>
            </button>
          </div>
        </aside>

        <section class="mermaid-editor">
          <div class="block-title">Mermaid 代码</div>
          <textarea
            ref="codeRef"
            v-model="text"
            class="mwb-mermaid-code mermaid-code"
            spellcheck="false"
            placeholder="在这里编辑 Mermaid 代码…"
          />
          <p class="muted small tip">直接修改示例中的文字即可；缩进与箭头符号需要保留。</p>
        </section>

        <section class="mermaid-preview-col">
          <div class="block-title">实时预览</div>
          <div class="mwb-mermaid-preview mermaid-preview" :class="{ 'mwb-mermaid-preview-error': !!previewError }">
            <div v-if="previewError" class="preview-error-text">
              <div class="preview-error-title">图表渲染失败</div>
              <div class="preview-error-detail">{{ previewError }}</div>
            </div>
            <div v-else-if="previewSvg" class="preview-svg" v-html="previewSvg" />
            <div v-else-if="previewLoading" class="preview-loading">
              <div class="spinner" />
              <span>正在渲染预览…</span>
            </div>
            <div v-else class="preview-empty">编辑代码后在此预览</div>
          </div>

          <div class="size-row">
            <label class="size-label" for="mwb-mermaid-size-input">尺寸</label>
            <select id="mwb-mermaid-size-input" v-model="preset" class="select mwb-mermaid-size">
              <option v-for="opt in sizeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
            <template v-if="preset === 'custom'">
              <input
                v-model.number="customPercent"
                class="text-input mwb-mermaid-custom custom-input"
                type="number"
                min="1"
                max="100"
                step="1"
                aria-label="自定义百分比"
              />
              <span class="muted small">%</span>
            </template>
          </div>
          <p class="muted small size-tip">尺寸写入代码首行 <code>%% mwb-size</code>，mermaid 会当注释忽略。</p>
        </section>
      </div>

      <div class="mermaid-foot">
        <span class="muted small foot-hint">
          {{ editing ? '保存后原位替换原图表，不会新增代码块' : '插入到光标位置' }}
        </span>
        <div class="foot-actions">
          <button class="btn mwb-mermaid-cancel" type="button" @click="requestClose">取消</button>
          <button
            class="btn btn-primary primary mwb-mermaid-insert"
            type="button"
            :disabled="!canInsert"
            @click="doInsert"
          >
            {{ editing ? '保存修改' : '插入图表' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mermaid-panel {
  width: min(980px, 96vw);
  height: min(640px, 92vh);
  max-height: 92vh;
}
.mermaid-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr) minmax(0, 1fr);
  gap: 14px;
  padding: 12px 16px;
  overflow: hidden;
}
.block-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--mwb-text-weak, #64748b);
  margin-bottom: 6px;
  flex: 0 0 auto;
}
.mermaid-types {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.type-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  overflow: auto;
  padding-right: 2px;
}
.mwb-mermaid-type {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 7px 8px;
  border: 1px solid var(--mwb-border, #e2e8f0);
  border-radius: 9px;
  background: #fbfcfe;
  cursor: pointer;
  text-align: left;
  font-size: 12px;
  color: var(--mwb-text, #0f172a);
  transition: border-color 0.12s ease, background 0.12s ease;
}
.mwb-mermaid-type:hover {
  border-color: #c7d2fe;
  background: #f5f7ff;
}
.mwb-mermaid-type.active {
  border-color: var(--mwb-primary, #4f46e5);
  background: #eef2ff;
  color: var(--mwb-primary, #4f46e5);
  font-weight: 600;
}
.type-icon {
  font-size: 15px;
  line-height: 1.1;
}
.type-name {
  font-size: 12px;
}
.mermaid-editor {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: 6px;
}
.mermaid-code {
  flex: 1;
  min-height: 260px;
  width: 100%;
  resize: none;
  border: 1px solid var(--mwb-border, #e2e8f0);
  border-radius: 10px;
  padding: 10px 12px;
  font-family: ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12.5px;
  line-height: 1.55;
  background: #f8fafc;
  color: #0f172a;
  outline: none;
}
.mermaid-code:focus {
  border-color: var(--mwb-primary, #4f46e5);
  background: #fff;
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.12);
}
.tip,
.size-tip {
  margin: 0;
  flex: 0 0 auto;
}
.mermaid-preview-col {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: 8px;
}
.mermaid-preview {
  flex: 1;
  min-height: 180px;
  overflow: auto;
  border: 1px solid var(--mwb-border, #e2e8f0);
  border-radius: 10px;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px;
}
.mermaid-preview.mwb-mermaid-preview-error {
  background: #fef2f2;
  border-color: #fca5a5;
  align-items: stretch;
}
.preview-svg {
  width: 100%;
}
.preview-svg :deep(svg) {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 0 auto;
}
.preview-loading,
.preview-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--mwb-text-weak, #64748b);
  font-size: 12.5px;
}
.preview-error-text {
  width: 100%;
  align-self: flex-start;
  color: #b91c1c;
  font-size: 12.5px;
  line-height: 1.6;
  word-break: break-word;
}
.preview-error-title {
  font-weight: 600;
  margin-bottom: 4px;
}
.preview-error-detail {
  white-space: pre-wrap;
  opacity: 0.9;
}
.size-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}
.size-label {
  font-size: 12.5px;
  color: var(--mwb-text-weak, #64748b);
  flex: 0 0 auto;
}
.mwb-mermaid-size {
  flex: 1;
  min-width: 0;
}
.custom-input {
  width: 72px;
  flex: 0 0 auto;
}
.mermaid-foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 18px;
  border-top: 1px solid var(--mwb-border, #e2e8f0);
}
.foot-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
