<script setup lang="ts">
/**
 * ThemeGallery —— 主题画廊（M1 可用版，themes 成员提供；M2 继续增强）
 *
 * 由 frontend-core 在编辑器「主题画廊」弹窗中挂载（见 integrations/optionalComponents.ts）：
 *   <ThemeGallery :themes="app.themes" :current="currentTheme" :markdown="content"
 *                  :render="renderForGallery" @select @preview @preview-end />
 * - props.render：按主题名渲染当前 deck 的前若干页，返回 {html, css}（不含 <html> 壳）
 * - 缩略图：iframe srcdoc + scale 缩放（不截图，遵循 API 契约 §2.2）
 * - emit.select：应用主题（父组件负责改 front-matter + 重渲染）
 * - emit.preview / preview-end：hover 临时试穿（父组件不监听也安全）
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { ThemeMeta } from '../types'

const props = defineProps<{
  /** 已注册的全部主题（内置 + 我的） */
  themes: ThemeMeta[]
  /** 当前 front-matter theme */
  current: string
  /** 当前 deck 内容（可选；M1 缩略图主要走 render） */
  markdown?: string
  /** 按主题渲染当前 deck 前 1–3 页；返回 {html, css}，不含 <html> 壳 */
  render?: (themeName: string) => { html: string; css: string }
}>()

const emit = defineEmits<{
  (e: 'select', name: string): void
  (e: 'preview', name: string): void
  (e: 'preview-end'): void
}>()

/* ---------------- 常量与工具 ---------------- */
const LS_FAV = 'mwb.themeFavorites'
const LS_RECENT = 'mwb.themeRecent'
const RECENT_MAX = 8
/** 内置 6 套的展示顺序（推荐位按此取前 4 套） */
const CURATED_ORDER = ['business-blue', 'tech-dark', 'academic-white', 'minimal-gray', 'magazine', 'gradient-vivid']
/** 分类关键词（与 themes/index.json 的 tags 对应） */
const CATEGORY_RULES: Array<{ key: string; re: RegExp }> = [
  { key: '商务', re: /商务|汇报|评审|正式|蓝/ },
  { key: '科技', re: /科技|技术|代码|发布|编程|架构/ },
  { key: '学术', re: /学术|答辩|课程|论文|教育|教学|讲义/ },
  { key: '极简', re: /极简|通用|简约|克制|留白|灰/ },
  { key: '创意', re: /创意|杂志|编辑|路演|渐变|活力|设计|运营|品牌/ },
]

function readLS(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
function writeLS(key: string, value: string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 隐私模式下忽略 */
  }
}
function categoryOf(t: ThemeMeta): string {
  if (t.source === 'user') return '我的'
  const text = [t.displayName || '', ...(t.tags || [])].join(' ')
  for (const rule of CATEGORY_RULES) if (rule.re.test(text)) return rule.key
  return '其他'
}
/** 无 render 时的占位色板（按名称哈希，稳定且不联网） */
function paletteOf(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  const h2 = (h + 48) % 360
  return `linear-gradient(135deg, hsl(${h} 62% 42%), hsl(${h2} 68% 56%))`
}

/* ---------------- 状态 ---------------- */
const search = ref('')
const activeTab = ref('推荐')
const favorites = ref<string[]>(readLS(LS_FAV))
const recent = ref<string[]>(readLS(LS_RECENT))
const gridRef = ref<HTMLElement | null>(null)
const searchRef = ref<HTMLInputElement | null>(null)
/** name → iframe srcdoc（缓存；markdown 变化时失效） */
const thumbs = reactive<Record<string, string>>({})
const failed = reactive<Record<string, boolean>>({})
const focusIndex = ref(0)
const isPreviewing = ref(false)
const previewingName = ref('')
let previewTimer = 0
let io: IntersectionObserver | null = null
const cardEls = new Map<string, HTMLElement>()

/* ---------------- 主题排序 / 分类 / 过滤 ---------------- */
const orderedThemes = computed<ThemeMeta[]>(() => {
  const list = [...(props.themes || [])]
  const rank = (t: ThemeMeta): number => {
    const i = CURATED_ORDER.indexOf(t.name)
    if (i >= 0) return i
    if (t.name === 'default' || t.name === 'gaia' || t.name === 'uncover') {
      return 100 + ['default', 'gaia', 'uncover'].indexOf(t.name)
    }
    return 50
  }
  return list.sort(
    (a, b) => rank(a) - rank(b) || (a.displayName || a.name).localeCompare(b.displayName || b.name, 'zh-CN'),
  )
})

const recommended = computed<ThemeMeta[]>(() => {
  const curated = orderedThemes.value.filter((t) => CURATED_ORDER.includes(t.name))
  if (curated.length) return curated.slice(0, 4)
  return orderedThemes.value.slice(0, 4)
})

function inTab(t: ThemeMeta, tab: string): boolean {
  if (tab === '全部') return true
  if (tab === '推荐') return recommended.value.some((r) => r.name === t.name)
  if (tab === '收藏') return favorites.value.includes(t.name)
  if (tab === '最近') return recent.value.includes(t.name)
  return categoryOf(t) === tab
}

function inSearch(t: ThemeMeta): boolean {
  const q = search.value.trim().toLowerCase()
  if (!q) return true
  return [t.name, t.displayName || '', ...(t.tags || [])].join(' ').toLowerCase().includes(q)
}

const filteredThemes = computed<ThemeMeta[]>(() => {
  let list = orderedThemes.value.filter((t) => inTab(t, activeTab.value) && inSearch(t))
  if (activeTab.value === '最近') {
    list = [...list].sort((a, b) => recent.value.indexOf(a.name) - recent.value.indexOf(b.name))
  }
  return list
})

interface TabItem {
  key: string
  label: string
  count: number
}

const tabs = computed<TabItem[]>(() => {
  const all = orderedThemes.value
  const items: TabItem[] = [
    { key: '推荐', label: '推荐', count: recommended.value.length },
    { key: '全部', label: '全部', count: all.length },
  ]
  const catOrder = ['商务', '科技', '学术', '极简', '创意', '我的', '其他']
  const counts = new Map<string, number>()
  for (const t of all) {
    const c = categoryOf(t)
    counts.set(c, (counts.get(c) || 0) + 1)
  }
  for (const key of catOrder) {
    const count = counts.get(key) || 0
    if (count > 0) items.push({ key, label: key, count })
  }
  items.push({
    key: '收藏',
    label: '★ 收藏',
    count: favorites.value.filter((n) => all.some((t) => t.name === n)).length,
  })
  items.push({
    key: '最近',
    label: '最近使用',
    count: recent.value.filter((n) => all.some((t) => t.name === n)).length,
  })
  return items
})

/* ---------------- 缩略图渲染（iframe srcdoc + scale，不截图） ---------------- */
function buildSrcdoc(html: string, css: string): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#fff;overflow:hidden;}
.marpit>svg{display:block!important;width:1280px!important;height:720px!important;}
${css}
</style></head><body>${html}</body></html>`
}

function applyScale(cardEl: HTMLElement): void {
  const thumb = cardEl.querySelector('.tg-thumb') as HTMLElement | null
  if (!thumb) return
  const scale = thumb.clientWidth > 0 ? thumb.clientWidth / 1280 : 0.17
  thumb.style.setProperty('--tg-scale', String(scale))
}

function renderThumb(name: string): void {
  if (thumbs[name] || failed[name] || !props.render) return
  try {
    const out = props.render(name)
    if (!out || typeof out.html !== 'string' || typeof out.css !== 'string') {
      failed[name] = true
      return
    }
    thumbs[name] = buildSrcdoc(out.html, out.css)
    void nextTick(() => {
      const el = cardEls.get(name)
      if (el) applyScale(el)
    })
  } catch {
    failed[name] = true
  }
}

function setCardEl(name: string, el: Element | null): void {
  if (el instanceof HTMLElement) {
    cardEls.set(name, el)
    if (io) io.observe(el)
  } else {
    const prev = cardEls.get(name)
    if (prev && io) io.unobserve(prev)
    cardEls.delete(name)
  }
}

function rebuildObserving(): void {
  if (!io) return
  io.disconnect()
  for (const [name, el] of cardEls) {
    io.observe(el)
    if (el.isConnected) renderThumb(name)
  }
}

function invalidateThumbs(): void {
  for (const k of Object.keys(thumbs)) delete thumbs[k]
  for (const k of Object.keys(failed)) delete failed[k]
  void nextTick(rebuildObserving)
}

/* ---------------- 交互：选择 / 收藏 / hover 试穿 ---------------- */
function rememberRecent(name: string): void {
  recent.value = [name, ...recent.value.filter((n) => n !== name)].slice(0, RECENT_MAX)
  writeLS(LS_RECENT, recent.value)
}

function choose(t: ThemeMeta): void {
  if (!t) return
  stopPreview()
  rememberRecent(t.name)
  emit('select', t.name)
}

function toggleFavorite(name: string): void {
  favorites.value = favorites.value.includes(name)
    ? favorites.value.filter((n) => n !== name)
    : [...favorites.value, name]
  writeLS(LS_FAV, favorites.value)
}

function startPreview(t: ThemeMeta): void {
  if (!props.render) return
  window.clearTimeout(previewTimer)
  previewTimer = window.setTimeout(() => {
    if (previewingName.value === t.name) return
    previewingName.value = t.name
    isPreviewing.value = true
    emit('preview', t.name)
  }, 140)
}

function stopPreview(): void {
  window.clearTimeout(previewTimer)
  if (!isPreviewing.value) return
  isPreviewing.value = false
  previewingName.value = ''
  emit('preview-end')
}

/* ---------------- 键盘：↑↓ 轮播 / Enter 应用 / Esc 结束试穿 ---------------- */
function moveFocus(delta: number): void {
  const list = filteredThemes.value
  if (!list.length) return
  focusIndex.value = (focusIndex.value + delta + list.length) % list.length
  const t = list[focusIndex.value]
  if (t) {
    const el = cardEls.get(t.name)
    el?.scrollIntoView({ block: 'nearest' })
    renderThumb(t.name)
  }
}

function onGlobalKeydown(e: KeyboardEvent): void {
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault()
    moveFocus(1)
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault()
    moveFocus(-1)
  } else if (e.key === 'Enter') {
    const t = filteredThemes.value[focusIndex.value]
    if (t) {
      e.preventDefault()
      choose(t)
    }
  } else if (e.key === 'Escape') {
    stopPreview()
  }
}

function onWindowResize(): void {
  for (const el of cardEls.values()) applyScale(el)
}

/* ---------------- 生命周期 ---------------- */
function syncFocusToCurrent(): void {
  const idx = filteredThemes.value.findIndex((t) => t.name === props.current)
  focusIndex.value = idx >= 0 ? idx : 0
}

onMounted(() => {
  io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const el = entry.target as HTMLElement
          const name = el.dataset.themeName
          if (name) renderThumb(name)
        }
      }
    },
    { root: gridRef.value, rootMargin: '160px' },
  )
  void nextTick(() => {
    rebuildObserving()
    syncFocusToCurrent()
    searchRef.value?.focus()
  })
  window.addEventListener('keydown', onGlobalKeydown, true)
  window.addEventListener('resize', onWindowResize)
})

onBeforeUnmount(() => {
  window.clearTimeout(previewTimer)
  io?.disconnect()
  io = null
  window.removeEventListener('keydown', onGlobalKeydown, true)
  window.removeEventListener('resize', onWindowResize)
})

watch(
  () => props.markdown,
  () => invalidateThumbs(),
)
watch(orderedThemes, () => {
  void nextTick(() => {
    rebuildObserving()
    syncFocusToCurrent()
  })
})
watch(filteredThemes, () => {
  if (focusIndex.value >= filteredThemes.value.length) focusIndex.value = 0
  void nextTick(rebuildObserving)
})
watch(activeTab, () => {
  stopPreview()
  focusIndex.value = 0
})
watch(search, () => {
  focusIndex.value = 0
})
</script>

<template>
  <div class="theme-gallery">
    <div class="tg-toolbar">
      <div class="tg-search-wrap">
        <span class="tg-search-icon" aria-hidden="true">⌕</span>
        <input ref="searchRef" v-model="search" class="tg-search" type="search" placeholder="搜索主题（名称 / 标签）" />
        <button v-if="search" class="tg-search-clear" type="button" title="清空搜索" @click="search = ''">✕</button>
      </div>
      <div class="tg-tabs" role="tablist">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          type="button"
          role="tab"
          class="tg-tab"
          :class="{ active: activeTab === tab.key }"
          :aria-selected="activeTab === tab.key"
          @click="activeTab = tab.key"
        >
          {{ tab.label }}<span class="tg-tab-count">{{ tab.count }}</span>
        </button>
      </div>
    </div>

    <div ref="gridRef" class="tg-grid" role="listbox" :aria-label="`主题画廊，共 ${filteredThemes.length} 套`">
      <button
        v-for="(t, i) in filteredThemes"
        :key="t.name"
        :ref="(el) => setCardEl(t.name, el as Element | null)"
        type="button"
        role="option"
        class="tg-card"
        :class="{
          current: t.name === current,
          focused: i === focusIndex,
          previewing: isPreviewing && t.name === previewingName,
        }"
        :data-theme-name="t.name"
        :aria-selected="t.name === current"
        :title="t.description || `${t.displayName || t.name}：点击应用到整份演示文稿`"
        @click="choose(t)"
        @mouseenter="startPreview(t)"
        @mouseleave="stopPreview"
        @focus="focusIndex = i"
      >
        <div class="tg-thumb" :style="!thumbs[t.name] ? { backgroundImage: paletteOf(t.name) } : undefined">
          <iframe
            v-if="thumbs[t.name]"
            class="tg-frame"
            :srcdoc="thumbs[t.name]"
            sandbox=""
            scrolling="no"
            tabindex="-1"
            aria-hidden="true"
            loading="lazy"
          />
          <span v-else class="tg-thumb-label">{{ t.displayName || t.name }}</span>
          <span v-if="failed[t.name]" class="tg-thumb-error" title="该主题的缩略图渲染失败，点击仍可应用">预览不可用</span>
          <span v-if="t.name === current" class="tg-current-badge">当前</span>
        </div>

        <div class="tg-meta">
          <span class="tg-name">{{ t.displayName || t.name }}</span>
          <span v-if="t.source === 'user'" class="tg-user-badge">我的</span>
          <button
            type="button"
            class="tg-fav"
            :class="{ on: favorites.includes(t.name) }"
            :title="favorites.includes(t.name) ? '取消收藏该主题' : '收藏该主题'"
            :aria-label="favorites.includes(t.name) ? '取消收藏' : '收藏'"
            @click.stop="toggleFavorite(t.name)"
          >
            ★
          </button>
        </div>
        <div class="tg-tags">
          <span v-for="tag in (t.tags || []).slice(0, 3)" :key="tag" class="tg-tag">{{ tag }}</span>
          <span v-if="t.size && t.size[0]" class="tg-tag tg-tag-size">{{ t.size[0].split(' ')[0] }}</span>
        </div>
      </button>

      <div v-if="!filteredThemes.length" class="tg-empty">
        <p>没有匹配的主题{{ search ? `：“${search}”` : '' }}</p>
        <button v-if="search" class="btn btn-ghost btn-sm" type="button" @click="search = ''">清空搜索</button>
      </div>
    </div>

    <div class="tg-hint">
      <span>点击卡片立即应用（可撤销）</span>
      <span class="tg-hint-keys">
        <kbd>↑</kbd><kbd>↓</kbd> 切换 · <kbd>Enter</kbd> 应用 · <kbd>Esc</kbd> 结束试穿
      </span>
    </div>
  </div>
</template>

<style scoped>
.theme-gallery {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  padding: 14px 18px 10px;
  gap: 12px;
}

/* ---------- 搜索 / 分类 ---------- */
.tg-toolbar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 0 0 auto;
}
.tg-search-wrap {
  position: relative;
  display: flex;
  align-items: center;
}
.tg-search-icon {
  position: absolute;
  left: 11px;
  color: var(--mwb-text-weak, #64748b);
  font-size: 16px;
  pointer-events: none;
}
.tg-search {
  width: 100%;
  padding: 9px 34px 9px 32px;
  border: 1px solid var(--mwb-border, #e2e8f0);
  border-radius: 10px;
  font-size: 13px;
  color: var(--mwb-text, #1e293b);
  background: var(--mwb-bg, #f4f6fb);
  outline: none;
}
.tg-search:focus {
  border-color: var(--mwb-primary, #4f46e5);
  background: #fff;
}
.tg-search-clear {
  position: absolute;
  right: 8px;
  border: 0;
  background: transparent;
  color: var(--mwb-text-weak, #64748b);
  cursor: pointer;
  font-size: 12px;
  padding: 4px;
}
.tg-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tg-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 11px;
  border: 1px solid var(--mwb-border, #e2e8f0);
  border-radius: 999px;
  background: #fff;
  color: var(--mwb-text-weak, #64748b);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.12s ease;
}
.tg-tab:hover {
  border-color: var(--mwb-border-strong, #cbd5e1);
  color: var(--mwb-text, #1e293b);
}
.tg-tab.active {
  background: var(--mwb-primary-soft, #eef2ff);
  border-color: var(--mwb-primary, #4f46e5);
  color: var(--mwb-primary, #4f46e5);
  font-weight: 600;
}
.tg-tab-count {
  font-size: 11px;
  opacity: 0.7;
}

/* ---------- 卡片网格 ---------- */
.tg-grid {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
  gap: 14px;
  align-content: start;
  padding: 2px 2px 8px;
  outline: none;
}
.tg-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--mwb-border, #e2e8f0);
  border-radius: 12px;
  background: #fff;
  cursor: pointer;
  text-align: left;
  transition:
    border-color 0.12s ease,
    box-shadow 0.12s ease,
    transform 0.12s ease;
}
.tg-card:hover {
  border-color: var(--mwb-border-strong, #cbd5e1);
  box-shadow: var(--mwb-shadow, 0 8px 28px rgba(15, 23, 42, 0.1));
  transform: translateY(-1px);
}
.tg-card.focused {
  border-color: var(--mwb-primary, #4f46e5);
  box-shadow: 0 0 0 2px var(--mwb-primary-soft, #eef2ff);
}
.tg-card.current {
  border-color: var(--mwb-primary, #4f46e5);
}

/* 缩略图：iframe 1280×720 按容器宽度 scale，不截图 */
.tg-thumb {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border-radius: 8px;
  background: #eef2f7;
  background-size: cover;
}
.tg-frame {
  position: absolute;
  top: 0;
  left: 0;
  width: 1280px;
  height: 720px;
  border: 0;
  transform: scale(var(--tg-scale, 0.17));
  transform-origin: top left;
  pointer-events: none;
  background: #fff;
}
.tg-thumb-label {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
}
.tg-thumb-error {
  position: absolute;
  left: 6px;
  bottom: 6px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(15, 23, 42, 0.6);
  color: #fff;
  font-size: 10px;
}
.tg-current-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--mwb-primary, #4f46e5);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
}

/* 卡片元信息 */
.tg-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.tg-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--mwb-text, #1e293b);
  font-size: 13px;
  font-weight: 600;
}
.tg-user-badge {
  flex: 0 0 auto;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--mwb-primary-soft, #eef2ff);
  color: var(--mwb-primary, #4f46e5);
  font-size: 10px;
}
.tg-fav {
  flex: 0 0 auto;
  border: 0;
  background: transparent;
  color: #cbd5e1;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 3px;
  border-radius: 4px;
}
.tg-fav:hover {
  color: #f59e0b;
}
.tg-fav.on {
  color: #f59e0b;
}
.tg-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-height: 18px;
}
.tg-tag {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--mwb-bg, #f4f6fb);
  color: var(--mwb-text-weak, #64748b);
  font-size: 10px;
  white-space: nowrap;
}
.tg-tag-size {
  background: #f1f5f9;
}

.tg-empty {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 48px 0;
  color: var(--mwb-text-weak, #64748b);
  font-size: 13px;
}

/* ---------- 底部提示 ---------- */
.tg-hint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex: 0 0 auto;
  padding-top: 4px;
  border-top: 1px solid var(--mwb-border, #e2e8f0);
  color: var(--mwb-text-weak, #64748b);
  font-size: 11px;
}
.tg-hint-keys {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  white-space: nowrap;
}
.tg-hint kbd {
  display: inline-block;
  min-width: 16px;
  padding: 0 4px;
  border: 1px solid var(--mwb-border-strong, #cbd5e1);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: #fff;
  color: var(--mwb-text, #1e293b);
  font-family: inherit;
  font-size: 10px;
  text-align: center;
}
</style>
