<script setup lang="ts">
/**
 * ThemeEditor —— 主题 CSS 编辑器（契约 UI_CONTRACT_M2 §2.5）
 *
 * - 名称输入 + CSS 编辑（带行号）+ 实时预览（当前 deck 前 2 页，临时 Marp 实例渲染，不污染正式主题列表）
 * - 校验：必须含 `@theme <name>`，且与名称一致；非法时行内错误 + 禁用保存
 * - 保存动作交给父组件（ThemeGallery）：emit save({name, css, asCopy}) → 父组件调
 *   createTheme / saveTheme，再 emit changed 刷新主题列表
 * - 关闭前有改动会确认
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { loadMarpCore, renderer, sanitizeCss, sanitizeHtml } from '../marp/renderer'
import { setMarkdownTheme } from '../marp/frontmatter'

const props = defineProps<{
  /** 编辑模式下的原主题名（另存为/新建时不传） */
  name?: string
  /** 初始 CSS */
  css: string
  /** 当前 deck Markdown（实时预览用） */
  markdown: string
  /** create=新建/另存为；edit=编辑我的主题 */
  mode?: 'create' | 'edit'
  /** 父组件保存中（创建/保存 API 进行中） */
  saving?: boolean
  /** 父组件保存失败时的可读错误 */
  saveError?: string
}>()

const emit = defineEmits<{
  (e: 'save', payload: { name: string; css: string; asCopy?: boolean }): void
  (e: 'close'): void
}>()

const mode = computed<'create' | 'edit'>(() => props.mode ?? 'create')
const initialCss = ref(props.css)
const css = ref(props.css)
const name = ref(props.name || guessName(props.css) || 'my-theme')
const previewError = ref('')
const previewHtml = ref('')
const previewLoading = ref(false)
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const gutterRef = ref<HTMLElement | null>(null)
const previewWrapRef = ref<HTMLElement | null>(null)
const previewFrame = ref<HTMLIFrameElement | null>(null)
const scale = ref(0.3)
let previewTimer = 0
let resizeObserver: ResizeObserver | null = null
let previewSeq = 0

const lineCount = computed(() => css.value.split('\n').length)
const lineNumbers = computed(() => Array.from({ length: lineCount.value }, (_, i) => i + 1))
const dirty = computed(() => css.value !== initialCss.value || name.value !== (props.name || guessName(initialCss.value) || 'my-theme'))

/** 从 CSS 注释头里提取 @theme 名（块注释/单行注释都支持） */
function parseThemeName(source: string): string {
  const m = /@theme\s+([A-Za-z0-9_-]+)/.exec(source)
  return m ? m[1] : ''
}
function guessName(source: string): string {
  return parseThemeName(source)
}

const cssThemeName = computed(() => parseThemeName(css.value))
const nameError = computed(() => {
  const n = name.value.trim()
  if (!n) return '请填写主题名称'
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(n)) return '主题名只能包含字母、数字、- 和 _'
  if (!cssThemeName.value) return 'CSS 缺少注释头 /* @theme 名称 */'
  if (cssThemeName.value !== n) return `CSS 中的 @theme 名称（${cssThemeName.value}）与上方名称（${n}）不一致`
  return ''
})
const canSave = computed(() => !nameError.value && css.value.trim().length > 0 && !props.saving)

function buildSrcdoc(html: string, themeCss: string): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#fff;overflow:hidden;}
.marpit>svg{display:block!important;width:1280px!important;height:720px!important;}
${themeCss}
</style></head><body>${html}</body></html>`
}

function applyPreviewScale(): void {
  const el = previewWrapRef.value
  if (!el) return
  scale.value = el.clientWidth > 0 ? el.clientWidth / 1280 : 0.3
}

/** 用独立 Marp 实例渲染当前 deck 前 2 页（避免临时主题污染 renderer 的正式列表） */
async function runPreview(): Promise<void> {
  const themeName = cssThemeName.value
  if (!themeName) {
    previewError.value = 'CSS 缺少 /* @theme 名称 */ 注释头，无法预览'
    previewHtml.value = ''
    return
  }
  const seq = ++previewSeq
  previewLoading.value = true
  try {
    const core = await loadMarpCore()
    if (seq !== previewSeq) return
    const marp = new core.Marp({ html: true, math: 'mathjax', script: false, minifyCSS: true })
    marp.themeSet.add(css.value)
    const md = props.markdown && props.markdown.trim() ? props.markdown : '# 主题预览\n\n## 第二页\n\n- 选项 A\n- 选项 B'
    const out = marp.render(setMarkdownTheme(md, themeName))
    // M3：主题预览也同步套用 mermaid 缓存（主预览渲染过的图表可直接显示为 SVG）
    const previewHtmlWithMermaid = renderer.applyMermaidCacheSync(sanitizeHtml(String(out.html)))
    previewHtml.value = buildSrcdoc(previewHtmlWithMermaid, sanitizeCss(String(out.css)))
    previewError.value = ''
    await nextTick()
    applyPreviewScale()
  } catch (err) {
    previewError.value = `预览渲染失败：${err instanceof Error ? err.message : String(err)}`
    previewHtml.value = ''
  } finally {
    if (seq === previewSeq) previewLoading.value = false
  }
}

function schedulePreview(): void {
  window.clearTimeout(previewTimer)
  previewTimer = window.setTimeout(() => void runPreview(), 420)
}

watch([css, () => props.markdown], () => schedulePreview())
watch(
  () => props.css,
  (next) => {
    if (next === css.value) return
    initialCss.value = next
    css.value = next
  },
)

function onTextareaScroll(): void {
  if (gutterRef.value && textareaRef.value) gutterRef.value.scrollTop = textareaRef.value.scrollTop
}

function requestSave(asCopy = false): void {
  if (!canSave.value) return
  emit('save', { name: name.value.trim(), css: css.value, asCopy })
}

function requestClose(): void {
  if (dirty.value && !window.confirm('主题有未保存的修改，确定关闭吗？')) return
  emit('close')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    requestClose()
  } else if (e.key.toLowerCase() === 's' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    requestSave(false)
  }
}

onMounted(() => {
  resizeObserver = new ResizeObserver(() => applyPreviewScale())
  if (previewWrapRef.value) resizeObserver.observe(previewWrapRef.value)
  schedulePreview()
})
onBeforeUnmount(() => {
  window.clearTimeout(previewTimer)
  resizeObserver?.disconnect()
})
</script>

<template>
  <div class="modal-mask theme-editor-mask" @click.self="requestClose">
    <div class="modal-panel theme-editor" @keydown="onKeydown">
      <div class="modal-head">
        <h2>{{ mode === 'edit' ? `编辑主题：${name || '未命名'}` : '新建主题' }}</h2>
        <div class="te-head-actions">
          <span v-if="dirty" class="te-dirty">未保存</span>
          <button class="btn btn-ghost btn-sm" type="button" @click="requestClose">关闭</button>
        </div>
      </div>

      <div class="te-body" @keydown="onKeydown">
        <div class="te-left">
          <label class="te-label" for="te-name">主题名称（与 CSS 中 @theme 一致）</label>
          <input
            id="te-name"
            v-model="name"
            class="te-name"
            type="text"
            spellcheck="false"
            placeholder="例如 my-theme"
            :class="{ invalid: !!nameError && name.length > 0 }"
          />
          <p class="te-error" :class="{ ok: !nameError }">{{ nameError || `@theme ${cssThemeName} ✓` }}</p>

          <div class="te-css-head">
            <label class="te-label" for="te-css">主题 CSS</label>
            <span class="te-hint">支持 Marp 标准主题语法（@theme / @import 'default' / @size …）</span>
          </div>
          <div class="te-css-wrap">
            <div ref="gutterRef" class="te-gutter" aria-hidden="true">
              <div v-for="n in lineNumbers" :key="n" class="te-line-no">{{ n }}</div>
            </div>
            <textarea
              id="te-css"
              ref="textareaRef"
              v-model="css"
              class="te-textarea"
              spellcheck="false"
              wrap="off"
              @scroll="onTextareaScroll"
            />
          </div>
        </div>

        <div class="te-right">
          <div class="te-label-row">
            <span class="te-label">实时预览（当前演示文稿前 2 页）</span>
            <span v-if="previewLoading" class="te-hint">渲染中…</span>
          </div>
          <div ref="previewWrapRef" class="te-preview-wrap">
            <iframe
              v-if="previewHtml"
              ref="previewFrame"
              class="te-preview-frame"
              :srcdoc="previewHtml"
              :style="{ transform: `scale(${scale})` }"
              scrolling="no"
              title="主题实时预览"
            />
            <div v-else class="te-preview-empty">
              {{ previewError || '正在生成预览…' }}
            </div>
          </div>
          <p v-if="previewError && previewHtml" class="te-error">{{ previewError }}</p>
          <p class="te-hint">
            预览用独立渲染实例，保存前不会影响正式主题列表；深色主题请确保在 §打印页设置有 print-color-adjust。
          </p>

          <p v-if="saveError" class="te-error te-save-error">{{ saveError }}</p>

          <div class="te-footer">
            <button class="btn btn-secondary btn-sm" type="button" :disabled="!canSave" @click="requestSave(true)">
              {{ mode === 'edit' ? '另存为新主题' : '另存为副本' }}
            </button>
            <div class="te-footer-right">
              <button class="btn btn-ghost btn-sm" type="button" @click="requestClose">取消</button>
              <button class="btn btn-primary btn-sm" type="button" :disabled="!canSave" @click="requestSave(false)">
                {{ saving ? '保存中…' : mode === 'edit' ? '保存修改' : '创建主题' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.theme-editor-mask {
  z-index: 70;
}
.theme-editor {
  width: min(1180px, 96vw);
  height: min(760px, 92vh);
}
.te-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.te-dirty {
  padding: 1px 7px;
  border-radius: 999px;
  background: #fef3c7;
  color: #92400e;
  font-size: 11px;
}
.te-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
  gap: 16px;
  padding: 14px 18px 12px;
}
.te-left,
.te-right {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.te-label {
  color: var(--mwb-text-weak, #64748b);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.te-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.te-hint {
  color: var(--mwb-text-weak, #94a3b8);
  font-size: 11px;
  line-height: 1.5;
}
.te-name {
  margin: 6px 0 0;
  padding: 8px 10px;
  border: 1px solid var(--mwb-border, #e2e8f0);
  border-radius: 8px;
  font-size: 13px;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  outline: none;
}
.te-name:focus {
  border-color: var(--mwb-primary, #4f46e5);
}
.te-name.invalid {
  border-color: var(--mwb-danger, #dc2626);
}
.te-error {
  margin: 5px 0 8px;
  color: var(--mwb-danger, #dc2626);
  font-size: 11px;
  min-height: 15px;
}
.te-error.ok {
  color: #15803d;
}
.te-css-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-top: 2px;
  margin-bottom: 6px;
}
.te-css-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  border: 1px solid var(--mwb-border, #e2e8f0);
  border-radius: 8px;
  overflow: hidden;
  background: #0f172a;
}
.te-gutter {
  flex: 0 0 auto;
  width: 42px;
  padding: 10px 6px;
  overflow: hidden;
  background: #0b1220;
  color: #475569;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  font-size: 12px;
  line-height: 1.55;
  text-align: right;
  user-select: none;
}
.te-line-no {
  height: 18.6px;
}
.te-textarea {
  flex: 1;
  min-width: 0;
  padding: 10px 12px;
  border: 0;
  outline: none;
  resize: none;
  background: transparent;
  color: #e2e8f0;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre;
  overflow: auto;
  tab-size: 2;
}
.te-preview-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 8 / 9;
  max-height: 480px;
  overflow: hidden;
  border: 1px solid var(--mwb-border, #e2e8f0);
  border-radius: 8px;
  background: #f1f5f9;
}
.te-preview-frame {
  position: absolute;
  top: 0;
  left: 0;
  width: 1280px;
  height: 1440px;
  border: 0;
  transform-origin: top left;
  background: #fff;
  pointer-events: none;
}
.te-preview-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: var(--mwb-text-weak, #64748b);
  font-size: 12px;
  text-align: center;
}
.te-footer {
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 12px;
}
.te-footer-right {
  display: flex;
  gap: 8px;
}
@media (max-width: 900px) {
  .te-body {
    grid-template-columns: 1fr;
  }
  .te-preview-wrap {
    max-height: 300px;
  }
}
</style>
