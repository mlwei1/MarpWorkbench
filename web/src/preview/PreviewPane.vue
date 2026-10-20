<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { loadMarpCore } from '../marp/renderer'

const props = defineProps<{
  html: string
  css: string
  page: number
  width: number
  height: number
}>()

const emit = defineEmits<{
  'page-count': [count: number]
}>()

const wrap = ref<HTMLElement>()
const frame = ref<HTMLIFrameElement>()
const fitScale = ref(1)
const manualScale = ref(1)
const fitMode = ref(true)
const ready = ref(false)
const frameHeight = ref(720)
let resizeObserver: ResizeObserver | null = null

const effectiveScale = computed(() => (fitMode.value ? fitScale.value : manualScale.value))
const empty = computed(() => !props.html || props.html.trim() === '')

const srcdoc = computed(() => {
  if (empty.value) return ''
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; script-src 'unsafe-inline'">
<style>html,body{margin:0;padding:0}${props.css}</style>
<style>
html{scroll-behavior:smooth}
body{background:#eef1f6;padding:18px 0 45vh}
div.marpit > svg{display:block;margin:0 auto 22px;box-shadow:0 3px 16px rgba(15,23,42,.16);background:#fff}
div.marpit > svg:last-child{margin-bottom:0}
</style></head><body>${props.html}</body></html>`
})

function updateScale(): void {
  if (!wrap.value) return
  const available = Math.max(240, wrap.value.clientWidth - 36)
  fitScale.value = Math.min(1, available / props.width)
  if (wrap.value.clientHeight > 0) {
    frameHeight.value = Math.max(props.height, wrap.value.clientHeight / effectiveScale.value)
  }
}

function scrollToPage(page: number): void {
  const doc = frame.value?.contentDocument
  if (!doc) return
  const slides = doc.querySelectorAll('svg[data-marpit-svg]')
  if (!slides.length) return
  const index = Math.min(Math.max(page - 1, 0), slides.length - 1)
  ;(slides[index] as HTMLElement).scrollIntoView({ block: 'start', behavior: ready.value ? 'smooth' : 'auto' })
}

async function onLoad(): Promise<void> {
  const f = frame.value
  const doc = f?.contentDocument
  if (!doc) return
  ready.value = false
  try {
    // script:false + 手动调用 marp browser helper（缩放在 iframe 内执行，兼容性最好）
    const core = await loadMarpCore()
    const script = doc.createElement('script')
    script.textContent =
      "try { parent.MarpCoreBundle.MarpCore.browser(document.body) } catch (err) { console.error('marp browser helper failed', err) }"
    doc.body.appendChild(script)
    try {
      core.browser(doc.body)
    } catch {
      /* iframe 内脚本已兜底 */
    }
  } catch (err) {
    console.warn('[preview] marp helper 初始化失败', err)
  }
  ready.value = true
  emit('page-count', doc.querySelectorAll('svg[data-marpit-svg]').length)
  updateScale()
  scrollToPage(props.page)
}

watch(
  () => [props.html, props.css],
  () => {
    ready.value = false
  },
)

watch(
  () => props.page,
  (page) => scrollToPage(page),
)

function setFit(): void {
  fitMode.value = true
  updateScale()
  scrollToPage(props.page)
}

function setActual(): void {
  fitMode.value = false
  manualScale.value = 1
  updateScale()
}

function zoom(delta: number): void {
  if (fitMode.value) {
    manualScale.value = fitScale.value
    fitMode.value = false
  }
  manualScale.value = Math.min(2, Math.max(0.2, Math.round((manualScale.value + delta) * 100) / 100))
  updateScale()
}

onMounted(() => {
  if (wrap.value) {
    resizeObserver = new ResizeObserver(() => updateScale())
    resizeObserver.observe(wrap.value)
  }
  updateScale()
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})
</script>

<template>
  <section class="preview-pane">
    <header class="preview-toolbar">
      <span class="preview-title">预览</span>
      <span class="preview-scale">{{ Math.round(effectiveScale * 100) }}%</span>
      <div class="preview-actions">
        <button class="btn btn-ghost btn-sm" :class="{ active: fitMode }" title="适应宽度" @click="setFit">适应</button>
        <button class="btn btn-ghost btn-sm" :class="{ active: !fitMode && manualScale === 1 }" title="100%" @click="setActual">100%</button>
        <button class="btn btn-ghost btn-sm" title="缩小" @click="zoom(-0.1)">−</button>
        <button class="btn btn-ghost btn-sm" title="放大" @click="zoom(0.1)">＋</button>
      </div>
    </header>
    <div ref="wrap" class="preview-scroll">
      <div v-if="empty" class="preview-empty">
        <div class="preview-empty-icon">🖋️</div>
        <p>开始输入 Markdown，右侧即时预览</p>
        <p class="muted">用 <code>---</code> 分页；front-matter 里写 <code>theme:</code> 换主题</p>
      </div>
      <div
        v-else
        class="preview-scaler"
        :style="{ width: `${width * effectiveScale}px`, height: `${wrap?.clientHeight || 0}px` }"
      >
        <iframe
          ref="frame"
          class="preview-frame"
          title="Marp 预览"
          :srcdoc="srcdoc"
          :style="{
            width: `${width}px`,
            height: `${frameHeight}px`,
            transform: `scale(${effectiveScale})`,
          }"
          @load="onLoad"
        />
      </div>
    </div>
  </section>
</template>
