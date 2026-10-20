<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { loadMarpCore } from '../marp/renderer'
import { fetchDeckAssetBlob } from '../api'
import { loadRemoteImages } from '../integrations/optionalComponents'

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

/** 把 iframe 内相对图片路径（assets/x.png）替换成可访问的 blob/data URL（预览用，不改 Markdown） */
async function resolveDeckAssets(doc: Document): Promise<void> {
  if (!props.deckId) return
  const pending: Promise<void>[] = []

  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || ''
    if (!/^\.?\/?assets\//.test(src) && !src.startsWith('assets/')) return
    pending.push(
      resolveAssetUrl(src).then((url) => {
        if (url) img.setAttribute('src', url)
      }),
    )
  })

  doc.querySelectorAll<HTMLElement>('[style*="assets/"]').forEach((el) => {
    const style = el.getAttribute('style') || ''
    const matches = [...style.matchAll(/assets\/[^)"'\s]+/g)].map((m) => m[0])
    if (!matches.length) return
    pending.push(
      (async () => {
        let next = style
        for (const raw of new Set(matches)) {
          const url = await resolveAssetUrl(raw)
          if (url) next = next.split(raw).join(url)
        }
        if (next !== style) el.setAttribute('style', next)
      })(),
    )
  })

  await Promise.all(pending)
}

/**
 * M3：把 html 里的远程图片（http(s)://）换成同源代理 URL（`/api/proxy/image?url=…&token=…`）。
 * 代理路由允许 iframe 的 <img> 不带 header 访问；CSP `img-src 'self'` 继续生效，零外网请求。
 * export-eng 的 remoteImages.ts 未就绪时安全跳过（图片保持原 URL，会被 CSP 拦下但不报错）。
 */
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
  // marp 背景图：<figure style="background-image:url('https://…')">
  next = next.replace(
    /url\((\s*)(["']?)(https?:\/\/[^)'"\s]+)\2(\s*)\)/gi,
    (_m, sp1: string, quote: string, url: string, sp2: string) => `url(${sp1}${quote}${toProxy(url)}${quote}${sp2})`,
  )
  return next
}

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
const resolvedHtml = ref('')
let prepareToken = 0
let resizeObserver: ResizeObserver | null = null

const effectiveScale = computed(() => (fitMode.value ? fitScale.value : manualScale.value))
const empty = computed(() => !props.html || props.html.trim() === '')

/**
 * 预览前先把 html 里的 `assets/x.png` 预解析成 blob/data URL。
 * 原因：Marp 背景图是 `<figure style="background-image:url('assets/x.png')">`，
 * 若直接放进 iframe，浏览器会先按 iframe 相对路径发请求（404）再被 onLoad 后处理，体验差且闪图。
 */
async function prepareHtml(): Promise<void> {
  const token = ++prepareToken
  let html = props.html || ''
  if (!html) {
    resolvedHtml.value = ''
    return
  }
  // 1) deck 相对资产 assets/x.png → dataURL/blob（避免 iframe 相对路径 404）
  if (props.deckId) {
    const refs = new Map<string, string>()
    for (const m of html.matchAll(/assets\/[^"'()<>\s&]+/g)) refs.set(m[0], m[0])
    let next = html
    for (const path of refs.keys()) {
      const url = await resolveAssetUrl(path)
      if (token !== prepareToken) return
      if (url) next = next.split(path).join(url)
    }
    html = next
  }
  // 2) M3：远程图片 http(s):// → 同源代理 URL（代理模块未就绪时保持原样）
  try {
    html = await prepareRemoteImages(html)
  } catch (err) {
    console.warn('[preview] 远程图片代理预处理失败', err)
  }
  if (token === prepareToken) resolvedHtml.value = html
}

const srcdoc = computed(() => {
  if (empty.value) return ''
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<base href="${location.origin}/">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; script-src 'unsafe-inline'">
<style>html,body{margin:0;padding:0}${props.css}</style>
<style>
html{scroll-behavior:smooth}
body{background:#eef1f6;padding:18px 0 45vh}
div.marpit > svg{display:block;margin:0 auto 22px;box-shadow:0 3px 16px rgba(15,23,42,.16);background:#fff}
div.marpit > svg:last-child{margin-bottom:0}
</style></head><body>${resolvedHtml.value}</body></html>`
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
  // M2：把 Markdown 中 assets/xxx.png 的图片解析为可显示的 blob/data URL（dataURL 用于 mock）
  try {
    await resolveDeckAssets(doc)
  } catch (err) {
    console.warn('[preview] 图片资产处理失败', err)
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
