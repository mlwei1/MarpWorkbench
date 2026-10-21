<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { loadMarpCore } from '../marp/renderer'
import { fetchDeckAssetBlob } from '../api'
import { loadRemoteImages } from '../integrations/optionalComponents'
import FullscreenPlayer from './FullscreenPlayer.vue'

const props = defineProps<{
  html: string
  css: string
  page: number
  width: number
  height: number
  /** 当前 deck id（用于把 Markdown 里的相对图片 assets/x.png 解析成可显示的 blob URL） */
  deckId?: string
  /** deck 资产列表（mock 模式下 url 可能是 dataURL） */
  assets?: { path: string; url: string }[]
  /** deck 标题（全屏播放 HUD 用） */
  title?: string
}>()

const emit = defineEmits<{
  'page-count': [count: number]
}>()

// deckId+path → objectURL 缓存（同一预览生命周期内复用）
const assetUrlCache = new Map<string, string>()

function assetBasename(path: string): string {
  return path.split('/').filter(Boolean).pop() || path
}

async function resolveAssetUrl(path: string): Promise<string | null> {
  const deckId = props.deckId
  if (!deckId) return null
  const clean = path.replace(/^\.\//, '')
  const key = `${deckId}:${clean}`
  const cached = assetUrlCache.get(key)
  if (cached) return cached

  const known = props.assets?.find((a) => a.path === clean || a.path.endsWith(`/${assetBasename(clean)}`))
  if (known?.url?.startsWith('data:')) {
    assetUrlCache.set(key, known.url)
    return known.url
  }

  try {
    const blob = await fetchDeckAssetBlob(deckId, assetBasename(clean))
    const url = URL.createObjectURL(blob)
    assetUrlCache.set(key, url)
    return url
  } catch (err) {
    console.warn('[preview] 图片资产解析失败', clean, err)
    return null
  }
}

// ---------------- M3：远程图片代理 ----------------
let remoteImagesProxy: ((url: string) => string) | null = null
let remoteImagesLoaded = false

async function ensureRemoteProxy(): Promise<((url: string) => string) | null> {
  if (remoteImagesLoaded) return remoteImagesProxy
  remoteImagesLoaded = true
  if (!loadRemoteImages) return null
  try {
    const mod = await loadRemoteImages()
    remoteImagesProxy = typeof mod.proxyImageUrl === 'function' ? mod.proxyImageUrl : null
  } catch (err) {
    console.warn('[preview] remoteImages 模块加载失败，网络图片暂不代理', err)
    remoteImagesProxy = null
  }
  return remoteImagesProxy
}

async function prepareRemoteImages(html: string): Promise<string> {
  if (!html || !/https?:\/\//.test(html)) return html
  const proxy = await ensureRemoteProxy()
  if (!proxy) return html

  const cache = new Map<string, string>()
  const toProxy = (url: string): string => {
    const hit = cache.get(url)
    if (hit) return hit
    let next = url
    try {
      next = proxy(url)
    } catch {
      next = url
    }
    cache.set(url, next)
    return next
  }
  const escapeAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

  let next = html.replace(
    /(<img\b[^>]*?\bsrc=)(["'])(https?:\/\/[^"']+)\2/gi,
    (_m, prefix: string, quote: string, url: string) => `${prefix}${quote}${escapeAttr(toProxy(url))}${quote}`,
  )
  next = next.replace(
    /url\((\s*)(["']?)(https?:\/\/[^)'"\s]+)\2(\s*)\)/gi,
    (_m, sp1: string, quote: string, url: string, sp2: string) => `url(${sp1}${quote}${toProxy(url)}${quote}${sp2})`,
  )
  return next
}

// ---------------- 稳定宿主文档（M3.1） ----------------
const wrap = ref<HTMLElement>()
const frame = ref<HTMLIFrameElement>()
const fitScale = ref(1)
const manualScale = ref(1)
const fitMode = ref(true)
const ready = ref(false)
const frameHeight = ref(720)
const currentHtml = ref('')
const pageCount = ref(0)
const playerOpen = ref(false)
let resizeObserver: ResizeObserver | null = null

const effectiveScale = computed(() => (fitMode.value ? fitScale.value : manualScale.value))
const empty = computed(() => !props.html || props.html.trim() === '')

/**
 * iframe 的 srcdoc 只生成一次：固定骨架（CSP/base/主题样式占位/内容容器）。
 * 内容变化时不再重建 srcdoc，而是父窗口直接更新同源 iframe 的 DOM（不 reload → 滚动不丢）。
 */
const hostSrcdoc = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<base href="${location.origin}/">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; script-src 'unsafe-inline'">
<style id="mwb-theme-style"></style>
<style id="mwb-base-style">
html,body{margin:0;padding:0}
body{background:#eef1f6;padding:18px 0 45vh}
div.marpit > svg{display:block;margin:0 auto 22px;box-shadow:0 3px 16px rgba(15,23,42,.16);background:#fff}
div.marpit > svg:last-child{margin-bottom:0}
</style></head><body><div id="mwb-root"></div></body></html>`

let hostLoaded = false
let pendingHtml: string | null = null
let lastAppliedHtml = ''
let prepareToken = 0
let applyToken = 0
let pendingPage: number | null = null
/** 原位更新失败时的兜底：记录待恢复的滚动位置 */
let fallbackView: { index: number; offset: number; top: number } | null = null

function scrollingEl(doc: Document): Element {
  return (doc.scrollingElement || doc.documentElement) as Element
}

interface ViewState {
  index: number
  offset: number
  top: number
}

/** 记录当前可见 slide 索引 + 页内偏移（用于原位更新后立即恢复） */
function captureView(doc: Document): ViewState {
  const sc = scrollingEl(doc)
  const top = sc.scrollTop
  const slides = [...doc.querySelectorAll('svg[data-marpit-svg]')] as HTMLElement[]
  if (!slides.length) return { index: 0, offset: 0, top }
  let index = 0
  const offsetOf = (el: HTMLElement): number => el.getBoundingClientRect().top + sc.scrollTop
  for (let i = 0; i < slides.length; i++) {
    if (offsetOf(slides[i]) <= top + 1) index = i
    else break
  }
  return { index, offset: top - offsetOf(slides[index]), top }
}

/** 立即恢复（禁止平滑滚动） */
function restoreView(doc: Document, view: ViewState): void {
  const sc = scrollingEl(doc) as HTMLElement | Element
  if (sc instanceof HTMLElement) sc.style.scrollBehavior = 'auto'
  const slides = [...doc.querySelectorAll('svg[data-marpit-svg]')] as HTMLElement[]
  if (!slides.length) {
    sc.scrollTop = view.top
    return
  }
  const index = Math.min(Math.max(view.index, 0), slides.length - 1)
  const targetTop = slides[index].getBoundingClientRect().top + sc.scrollTop + view.offset
  sc.scrollTop = Math.max(0, targetTop)
}

/** 滚动到指定页（1-based），默认 behavior:'auto'，绝不用于内容更新路径 */
function scrollToPage(doc: Document, page: number): void {
  const sc = scrollingEl(doc) as HTMLElement | Element
  if (sc instanceof HTMLElement) sc.style.scrollBehavior = 'auto'
  const slides = [...doc.querySelectorAll('svg[data-marpit-svg]')] as HTMLElement[]
  if (!slides.length) return
  const index = Math.min(Math.max(page - 1, 0), slides.length - 1)
  const top = slides[index].getBoundingClientRect().top + sc.scrollTop
  sc.scrollTop = Math.max(0, top)
}

/** 应用主题 CSS（单独更新，不重建内容） */
function applyThemeStyle(doc: Document): void {
  const style = doc.getElementById('mwb-theme-style')
  if (style && style.textContent !== props.css) style.textContent = props.css
}

/** 重新执行 marp-core 浏览器 helper（SVG polyfill / auto-scaling） */
async function runBrowserHelper(doc: Document): Promise<void> {
  const win = doc.defaultView as (Window & { __mwbApplyMarpHelper?: () => void }) | null
  try {
    win?.__mwbApplyMarpHelper?.()
  } catch {
    /* ignore */
  }
  try {
    const core = await loadMarpCore()
    core.browser(doc.body)
  } catch (err) {
    console.warn('[preview] marp helper 执行失败', err)
  }
}

type CommitMode = 'initial' | 'preserve' | 'page'

/**
 * 原位更新 iframe 内容（不 reload）：
 * - preserve：保持当前 slide/偏移（打字、mermaid/资产二次更新都用这个）
 * - initial / page：滚动到目标页（behavior:auto）
 */
async function commitContent(html: string, mode: CommitMode, targetPage?: number): Promise<void> {
  const doc = frame.value?.contentDocument
  if (!doc || !doc.getElementById('mwb-root')) return
  const token = ++applyToken
  const root = doc.getElementById('mwb-root') as HTMLElement
  const view = mode === 'preserve' ? captureView(doc) : null
  applyThemeStyle(doc)

  try {
    if (root.innerHTML !== html) root.innerHTML = html
    // 先在旧布局下恢复滚动（绝大多数情况 slide 高度固定 720px，位置完全一致）
    if (view) restoreView(doc, view)
    await runBrowserHelper(doc)
    if (token !== applyToken) return
    if (view) restoreView(doc, view)
    else scrollToPage(doc, targetPage ?? props.page)
    lastAppliedHtml = html
    currentHtml.value = html
    ready.value = true
    const count = doc.querySelectorAll('svg[data-marpit-svg]').length
    pageCount.value = count
    emit('page-count', count)
    updateScale()
  } catch (err) {
    console.warn('[preview] 原位更新失败，回退整页重载', err)
    fallbackReload(html, view)
  }
}

/** 兜底：原位更新异常时整页重载（load 前隐藏，load 后先恢复滚动再显示） */
function fallbackReload(html: string, view: ViewState | null): void {
  const f = frame.value
  if (!f) return
  fallbackView = view
  f.style.visibility = 'hidden'
  const script = ''
  f.srcdoc = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<base href="${location.origin}/">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; script-src 'unsafe-inline'">
<style id="mwb-theme-style">${props.css}</style>
<style id="mwb-base-style">
html,body{margin:0;padding:0}
body{background:#eef1f6;padding:18px 0 45vh}
div.marpit > svg{display:block;margin:0 auto 22px;box-shadow:0 3px 16px rgba(15,23,42,.16);background:#fff}
div.marpit > svg:last-child{margin-bottom:0}
</style></head><body><div id="mwb-root">${html}</div>${script}</body></html>`
}

/** 解析 html 中的相对资产 + 远程图片（异步；token 防竞态） */
async function prepareHtml(): Promise<void> {
  const token = ++prepareToken
  let html = props.html || ''
  if (!html) {
    pendingHtml = ''
    currentHtml.value = ''
    if (hostLoaded) {
      const doc = frame.value?.contentDocument
      const root = doc?.getElementById('mwb-root')
      if (root) root.innerHTML = ''
      ready.value = false
      pageCount.value = 0
      emit('page-count', 0)
    }
    return
  }
  if (props.deckId) {
    const refs = new Set<string>()
    for (const m of html.matchAll(/assets\/[^"'()<>\s&]+/g)) refs.add(m[0])
    let next = html
    for (const path of refs) {
      const url = await resolveAssetUrl(path)
      if (token !== prepareToken) return
      if (url) next = next.split(path).join(url)
    }
    html = next
  }
  try {
    html = await prepareRemoteImages(html)
  } catch (err) {
    console.warn('[preview] 远程图片代理预处理失败', err)
  }
  if (token !== prepareToken) return

  pendingHtml = html
  if (!hostLoaded) return // 等 iframe 首次 load 后统一 commit
  const mode: CommitMode = lastAppliedHtml === '' ? 'initial' : 'preserve'
  const target = pendingPage ?? props.page
  pendingPage = null
  void commitContent(html, mode, target)
}

function updateScale(): void {
  if (!wrap.value) return
  const available = Math.max(240, wrap.value.clientWidth - 36)
  fitScale.value = Math.min(1, available / props.width)
  if (wrap.value.clientHeight > 0) {
    frameHeight.value = Math.max(props.height, wrap.value.clientHeight / effectiveScale.value)
  }
}

async function onLoad(): Promise<void> {
  const f = frame.value
  const doc = f?.contentDocument
  if (!doc) return
  f!.style.visibility = ''

  if (fallbackView) {
    // 兜底重载完成：先恢复滚动位置，再显示
    try {
      await runBrowserHelper(doc)
    } catch {
      /* ignore */
    }
    restoreView(doc, fallbackView)
    fallbackView = null
    f!.style.visibility = ''
    ready.value = true
    currentHtml.value = doc.getElementById('mwb-root')?.innerHTML || ''
    pageCount.value = doc.querySelectorAll('svg[data-marpit-svg]').length
    emit('page-count', pageCount.value)
    updateScale()
    return
  }

  hostLoaded = true
  // 注入一次性的 helper 包装（后续每次原位更新调用，避免重复插 script）
  try {
    const script = doc.createElement('script')
    script.textContent =
      "window.__mwbApplyMarpHelper = function () { try { parent.MarpCoreBundle.MarpCore.browser(document.body) } catch (err) { console.error('marp browser helper failed', err) } }"
    doc.body.appendChild(script)
  } catch (err) {
    console.warn('[preview] helper 注入失败', err)
  }

  const target = pendingPage ?? props.page
  pendingPage = null
  if (pendingHtml != null) {
    const html = pendingHtml
    pendingHtml = null
    await commitContent(html, 'initial', target)
  } else {
    ready.value = true
    updateScale()
  }
}

watch(
  () => [props.html, props.css],
  () => {
    void prepareHtml()
  },
  { immediate: true },
)

watch(
  () => props.deckId,
  () => {
    assetUrlCache.clear()
    void prepareHtml()
  },
)

watch(
  () => props.page,
  (page) => {
    const doc = frame.value?.contentDocument
    if (!doc || !hostLoaded) {
      pendingPage = page
      return
    }
    if (lastAppliedHtml === '') {
      pendingPage = page
      return
    }
    scrollToPage(doc, page)
  },
)

function onOpenPlayer(): void {
  if (empty.value) return
  playerOpen.value = true
}

function setFit(): void {
  fitMode.value = true
  updateScale()
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
        <button
          class="btn btn-ghost btn-sm"
          title="全屏播放（方向键翻页）"
          aria-label="全屏播放"
          :disabled="empty"
          @click="onOpenPlayer"
        >
          ▶ 全屏播放
        </button>
        <button class="btn btn-ghost btn-sm" :class="{ active: fitMode }" title="适应宽度" @click="setFit">适应</button>
        <button class="btn btn-ghost btn-sm" :class="{ active: !fitMode && manualScale === 1 }" title="100%" @click="setActual">100%</button>
        <button class="btn btn-ghost btn-sm" title="缩小" @click="zoom(-0.1)">−</button>
        <button class="btn btn-ghost btn-sm" title="放大" @click="zoom(0.1)">＋</button>
      </div>
    </header>
    <div ref="wrap" class="preview-scroll">
      <div
        class="preview-scaler"
        :style="{ width: `${width * effectiveScale}px`, height: `${wrap?.clientHeight || 0}px` }"
      >
        <iframe
          ref="frame"
          class="preview-frame"
          title="Marp 预览"
          :srcdoc="hostSrcdoc"
          :style="{
            width: `${width}px`,
            height: `${frameHeight}px`,
            transform: `scale(${effectiveScale})`,
          }"
          @load="onLoad"
        />
      </div>
      <div v-if="empty" class="preview-empty preview-empty-overlay">
        <div class="preview-empty-icon">🖋️</div>
        <p>开始输入 Markdown，右侧即时预览</p>
        <p class="muted">用 <code>---</code> 分页；front-matter 里写 <code>theme:</code> 换主题</p>
      </div>
    </div>

    <FullscreenPlayer
      v-if="playerOpen"
      :html="currentHtml"
      :css="css"
      :page="page"
      :page-count="Math.max(1, pageCount)"
      :width="width"
      :height="height"
      :title="title || ''"
      @close="playerOpen = false"
    />
  </section>
</template>
