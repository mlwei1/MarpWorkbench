<script setup lang="ts">
/**
 * 全屏播放（M3.1 契约 §2）
 * - 黑底 16:9 单页播放；优先 requestFullscreen，被拒/不支持时退回 fixed 覆盖层
 * - 键盘：←/↑ 上一页；→/↓/Space/PageDown/Enter 下一页；PageUp/Backspace 上一页；Home/End 首/尾；Esc 退出
 * - 稳定 iframe 宿主：内容只写入一次，翻页只做显示/缩放切换（不重载 → 无闪烁）
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { loadMarpCore } from '../marp/renderer'

const props = defineProps<{
  html: string
  css: string
  page: number
  pageCount: number
  width: number
  height: number
  title?: string
}>()

const emit = defineEmits<{ close: [] }>()

const root = ref<HTMLElement>()
const frame = ref<HTMLIFrameElement>()
const current = ref(Math.max(1, Math.round(props.page) || 1))
const total = ref(Math.max(1, Math.round(props.pageCount) || 1))
const isFullscreen = ref(false)
const hudVisible = ref(true)
let hudTimer: number | undefined
let wasFullscreen = false
let hostLoaded = false
let pendingHtml: string | null = null
let bodyOverflowBefore = ''

const hostSrcdoc = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<base href="${location.origin}/">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; script-src 'unsafe-inline'">
<style id="mwb-theme-style"></style>
<style id="mwb-player-base">
html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden}
#mwb-root{position:absolute;inset:0;margin:0;padding:0}
div.marpit{width:100%;height:100%}
div.marpit > svg{position:absolute;left:50%;top:50%;display:none;margin:0 !important;box-shadow:none !important;background:transparent !important;transform-origin:center center}
</style></head><body><div id="mwb-root"></div></body></html>`

function doc(): Document | null {
  return frame.value?.contentDocument || null
}

function clampPage(n: number): number {
  return Math.min(Math.max(1, Math.round(n) || 1), total.value)
}

function applyThemeStyle(d: Document): void {
  const style = d.getElementById('mwb-theme-style')
  if (style && style.textContent !== props.css) style.textContent = props.css
}

/** 当前页单页居中铺满（黑底 16:9，其余 slide 隐藏） */
function applyPage(d: Document, page = current.value): void {
  const slides = [...d.querySelectorAll('svg[data-marpit-svg]')] as HTMLElement[]
  total.value = Math.max(1, slides.length || total.value)
  current.value = clampPage(page)
  const viewW = d.documentElement.clientWidth || window.innerWidth
  const viewH = d.documentElement.clientHeight || window.innerHeight
  const scale = Math.min(viewW / props.width, viewH / props.height)
  slides.forEach((el, i) => {
    const visible = i === current.value - 1
    el.style.display = visible ? 'block' : 'none'
    if (!visible) return
    el.style.position = 'absolute'
    el.style.left = '50%'
    el.style.top = '50%'
    el.style.width = `${props.width}px`
    el.style.height = `${props.height}px`
    el.style.margin = '0'
    el.style.boxShadow = 'none'
    el.style.background = 'transparent'
    el.style.transformOrigin = 'center center'
    el.style.transform = `translate(-50%, -50%) scale(${scale})`
  })
}

async function runBrowserHelper(d: Document): Promise<void> {
  try {
    const win = d.defaultView as (Window & { __mwbPlayerHelper?: () => void }) | null
    win?.__mwbPlayerHelper?.()
  } catch {
    /* ignore */
  }
  try {
    const core = await loadMarpCore()
    core.browser(d.body)
  } catch (err) {
    console.warn('[player] marp helper 执行失败', err)
  }
}

async function commit(html: string): Promise<void> {
  const d = doc()
  if (!d || !d.getElementById('mwb-root')) return
  const rootEl = d.getElementById('mwb-root') as HTMLElement
  applyThemeStyle(d)
  if (rootEl.innerHTML !== html) rootEl.innerHTML = html
  try {
    await runBrowserHelper(d)
  } catch {
    /* ignore */
  }
  applyPage(d)
}

function onLoad(): void {
  const d = doc()
  if (!d) return
  hostLoaded = true
  try {
    const script = d.createElement('script')
    script.textContent =
      "window.__mwbPlayerHelper = function () { try { parent.MarpCoreBundle.MarpCore.browser(document.body) } catch (err) { console.error('marp browser helper failed', err) } }"
    d.body.appendChild(script)
  } catch {
    /* ignore */
  }
  const html = pendingHtml ?? props.html
  pendingHtml = null
  void commit(html)
}

function go(delta: number): void {
  const next = clampPage(current.value + delta)
  if (next === current.value) return
  current.value = next
  const d = doc()
  if (d) applyPage(d, next)
  showHud()
}

function goTo(page: number): void {
  const next = clampPage(page)
  if (next === current.value) return
  current.value = next
  const d = doc()
  if (d) applyPage(d, next)
  showHud()
}

const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown', ' ', 'Spacebar', 'PageDown', 'Enter'])
const PREV_KEYS = new Set(['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'])

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    close()
    return
  }
  let handled = true
  if (NEXT_KEYS.has(e.key)) go(1)
  else if (PREV_KEYS.has(e.key)) go(-1)
  else if (e.key === 'Home') goTo(1)
  else if (e.key === 'End') goTo(total.value)
  else handled = false
  if (handled) {
    e.preventDefault()
    e.stopPropagation()
    showHud()
  }
}

function showHud(): void {
  hudVisible.value = true
  window.clearTimeout(hudTimer)
  hudTimer = window.setTimeout(() => {
    hudVisible.value = false
  }, 2000)
}

function onMousemove(): void {
  showHud()
}

async function close(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
  } catch {
    /* ignore */
  }
  emit('close')
}

function onFullscreenChange(): void {
  isFullscreen.value = !!document.fullscreenElement
  if (wasFullscreen && !document.fullscreenElement) {
    // 用户按 Esc / 浏览器主动退出全屏 → 退出播放
    emit('close')
    return
  }
  wasFullscreen = isFullscreen.value
  const d = doc()
  if (d) applyPage(d)
}

function onResize(): void {
  const d = doc()
  if (d) applyPage(d)
}

async function requestFullscreen(): Promise<void> {
  const el = root.value
  if (!el || !el.requestFullscreen) return
  try {
    await el.requestFullscreen()
    isFullscreen.value = true
    wasFullscreen = true
  } catch {
    // 被拒绝（如 headless / 无用户手势）→ 退回 fixed 覆盖层，功能等价
    isFullscreen.value = false
  }
}

watch(
  () => props.html,
  (html) => {
    if (!hostLoaded) {
      pendingHtml = html
      return
    }
    void commit(html || '')
  },
)

watch(
  () => props.css,
  () => {
    const d = doc()
    if (d) applyThemeStyle(d)
  },
)

onMounted(() => {
  bodyOverflowBefore = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  document.addEventListener('keydown', onKeydown, true)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  window.addEventListener('resize', onResize)
  window.addEventListener('mousemove', onMousemove)
  showHud()
  void requestFullscreen()
})

onBeforeUnmount(() => {
  window.clearTimeout(hudTimer)
  document.removeEventListener('keydown', onKeydown, true)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('mousemove', onMousemove)
  document.body.style.overflow = bodyOverflowBefore
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
})
</script>

<template>
  <div
    ref="root"
    class="mwb-player"
    :class="{ 'is-fallback': !isFullscreen }"
    :data-page="current"
    role="dialog"
    aria-modal="true"
    aria-label="全屏播放"
  >
    <iframe ref="frame" class="mwb-player-frame" title="全屏播放预览" :srcdoc="hostSrcdoc" @load="onLoad" />

    <div class="mwb-player-hud" :class="{ visible: hudVisible }">
      <div class="mwb-player-hud-left">
        <span class="mwb-player-title">{{ title || '播放' }}</span>
      </div>
      <div class="mwb-player-hud-right">
        <button class="mwb-player-btn" type="button" aria-label="上一页" title="上一页（←）" @click="go(-1)">‹</button>
        <span class="mwb-player-page">{{ current }} / {{ total }}</span>
        <button class="mwb-player-btn" type="button" aria-label="下一页" title="下一页（→）" @click="go(1)">›</button>
        <button class="mwb-player-btn mwb-player-exit" type="button" aria-label="退出播放" title="退出播放（Esc）" @click="close">
          退出
        </button>
      </div>
    </div>
    <div class="mwb-player-hint" :class="{ visible: hudVisible }">← → 翻页 · Esc 退出</div>
  </div>
</template>

<style scoped>
.mwb-player {
  position: fixed;
  inset: 0;
  z-index: 4000;
  background: #000;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}
.mwb-player.is-fallback {
  position: fixed;
  z-index: 4000;
}
.mwb-player-frame {
  width: 100%;
  height: 100%;
  border: 0;
  background: #000;
  display: block;
}
.mwb-player-hud {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  background: linear-gradient(180deg, rgba(15, 23, 42, 0.78), rgba(15, 23, 42, 0));
  color: #f8fafc;
  opacity: 0;
  transition: opacity 0.2s ease;
  pointer-events: none;
}
.mwb-player-hud.visible {
  opacity: 1;
  pointer-events: auto;
}
.mwb-player-hud-left,
.mwb-player-hud-right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.mwb-player-title {
  font-size: 13px;
  font-weight: 600;
  max-width: 40vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mwb-player-page {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  min-width: 52px;
  text-align: center;
}
.mwb-player-btn {
  height: 30px;
  min-width: 32px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid rgba(248, 250, 252, 0.28);
  background: rgba(15, 23, 42, 0.55);
  color: #f8fafc;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.mwb-player-btn:hover {
  background: rgba(79, 70, 229, 0.75);
  border-color: rgba(79, 70, 229, 0.9);
}
.mwb-player-exit {
  font-size: 13px;
}
.mwb-player-hint {
  position: absolute;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  padding: 6px 14px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.6);
  color: #e2e8f0;
  font-size: 12px;
  opacity: 0;
  transition: opacity 0.2s ease;
  pointer-events: none;
}
.mwb-player-hint.visible {
  opacity: 1;
}
</style>
