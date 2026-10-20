<script setup lang="ts">
/**
 * SlideNavigator —— 左侧「大纲 / 幻灯片」导航（M2 / task-11）
 *
 * 契约：docs/UI_CONTRACT_M2.md §2.1（props/emits 不可随意改）
 *   props  { markdown, html, css, pageCount, currentPage, width, height }
 *   emits  jump(page, line?)
 *
 * 实现要点：
 * - 大纲：`useOutline.ts` 解析标题（跳过 front-matter / 代码围栏 / HTML 注释），层级缩进 + 页码，
 *   当前页标题高亮；点击 emit jump(page, line)（line 为标题行号，父组件用它定位编辑器光标）。
 * - 幻灯片：**每页一个轻量 iframe（sandbox，无脚本）+ 虚拟滚动（只渲染视口附近的页）**，
 *   srcdoc 注入 `css + 该页 svg`，再按面板宽度 `transform: scale()` 缩放显示。
 *   选型理由：主预览已经是 iframe，缩略图必须是独立文档才能保证「主题真实渲染 + 样式隔离」；
 *   每页一个 iframe 让虚拟滚动时同时存活的 iframe 恒定在 ~10 个以内，100 页也不卡；
 *   切走 tab、折叠左栏（父组件 v-show/v-if 使宿主尺寸为 0）、组件卸载时，iframe 全部销毁释放内存。
 *   本方案没有采用「单个隐藏 iframe 注入整 deck + 组件内展示」的原因见 docs/dev/outline.md §3。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import {
  activeHeadingIndex,
  clampPage,
  describeHeading,
  parseOutline,
  type OutlineHeading,
} from './useOutline'

interface Props {
  /** 当前 Markdown 全文 */
  markdown: string
  /** renderer 渲染出的完整 HTML（含全部 <svg data-marpit-svg>） */
  html: string
  /** 对应主题 CSS（含 marp-core 注入样式） */
  css: string
  /** 页数（渲染结果为准） */
  pageCount: number
  /** 当前页，1-based */
  currentPage: number
  /** 幻灯片原始宽度（1280） */
  width: number
  /** 幻灯片原始高度（720） */
  height: number
}

const props = withDefaults(defineProps<Props>(), {
  markdown: '',
  html: '',
  css: '',
  pageCount: 0,
  currentPage: 1,
  width: 1280,
  height: 720,
})

const emit = defineEmits<{
  (e: 'jump', page: number, line?: number): void
}>()

defineOptions({ name: 'SlideNavigator' })

/* ------------------------------------------------------------------ */
/* Tab 状态（记忆到 localStorage，刷新后保持上次的视图）                */
/* ------------------------------------------------------------------ */
type TabKey = 'outline' | 'slides'
const TAB_STORAGE_KEY = 'mwb.slideNav.tab'

function readTab(): TabKey {
  try {
    return window.localStorage.getItem(TAB_STORAGE_KEY) === 'slides' ? 'slides' : 'outline'
  } catch {
    return 'outline'
  }
}

const activeTab = ref<TabKey>(readTab())

function setTab(tab: TabKey): void {
  if (activeTab.value === tab) return
  activeTab.value = tab
  try {
    window.localStorage.setItem(TAB_STORAGE_KEY, tab)
  } catch {
    /* 隐私模式忽略 */
  }
}

/* ------------------------------------------------------------------ */
/* 大纲                                                                */
/* ------------------------------------------------------------------ */
const outlineBody = ref<HTMLElement | null>(null)

const headings = computed<OutlineHeading[]>(() => parseOutline(props.markdown, props.pageCount))

/** 标题页号按页码夹取（渲染页数与本地分页不一致时也不越界） */
const outlineItems = computed<OutlineHeading[]>(() =>
  headings.value.map((h) => ({ ...h, page: clampPage(h.page, props.pageCount) })),
)

/** 最近点击的大纲标题行号：同一页有多个标题时，让用户点的那个保持「活动」高亮 */
const clickedLine = ref(-1)

const activeLine = computed<number>(() => {
  if (!props.markdown.trim()) return -1
  if (clickedLine.value > 0) {
    const hit = outlineItems.value.find((h) => h.line === clickedLine.value)
    // 只在标题仍存在且仍属于当前页时保留点击高亮（用户改用光标/翻页后自动回退到页码推导）
    if (hit && hit.page === safeCurrentPage.value) return hit.line
  }
  const idx = activeHeadingIndex(outlineItems.value, safeCurrentPage.value)
  return idx >= 0 ? outlineItems.value[idx].line : -1
})

const outlineEmpty = computed<'none' | 'no-headings' | 'ok'>(() => {
  if (!props.markdown.trim()) return 'none'
  return outlineItems.value.length ? 'ok' : 'no-headings'
})

function onOutlineClick(item: OutlineHeading): void {
  clickedLine.value = item.line
  emit('jump', clampPage(item.page, props.pageCount), item.line)
}

/* ------------------------------------------------------------------ */
/* 幻灯片缩略图：每页一个 iframe + 虚拟滚动                             */
/* ------------------------------------------------------------------ */
const rootEl = ref<HTMLElement | null>(null)
const listEl = ref<HTMLElement | null>(null)

const PAD = 10
const TOP_PAD = 8
const GAP = 8
const LABEL_HEIGHT = 18
const OVERSCAN = 3

const slideCount = computed<number>(() => Math.max(0, Math.floor(props.pageCount || 0)))
const safeCurrentPage = computed<number>(() =>
  slideCount.value > 0 ? clampPage(props.currentPage, slideCount.value) : 1,
)

/** 真正的空：没有 Markdown 内容 / 没有渲染结果 / 0 页 */
const slidesEmpty = computed<boolean>(
  () => !props.markdown.trim() || !props.html.trim() || slideCount.value <= 0,
)

const safeSlideWidth = computed<number>(() => (props.width > 0 ? props.width : 1280))
const safeSlideHeight = computed<number>(() => (props.height > 0 ? props.height : 720))

interface Metrics {
  /** 列表可视宽度（不含滚动条） */
  width: number
  /** 列表可视高度 */
  height: number
  /** 当前滚动位置 */
  scrollTop: number
}

const metrics = reactive<Metrics>({ width: 0, height: 0, scrollTop: 0 })

/** 缩略图宽度：面板宽度 - 两侧留白（限制在合理区间，避免极端布局算出 0/超大值） */
const thumbWidth = computed<number>(() => {
  const available = metrics.width - PAD * 2
  if (available <= 0) return 160
  return Math.max(96, Math.min(available, 640))
})

const thumbScale = computed<number>(() => thumbWidth.value / safeSlideWidth.value)
const thumbHeight = computed<number>(() =>
  Math.max(54, Math.round(safeSlideHeight.value * thumbScale.value)),
)
const rowHeight = computed<number>(() => thumbHeight.value + LABEL_HEIGHT + GAP)
const spacerHeight = computed<number>(
  () => TOP_PAD + slideCount.value * rowHeight.value + 12,
)

/* ---------------- 把整 deck HTML 拆成每页 HTML（防抖，避免每次输入都解析大 DOM） ---------------- */
const rawSlides = shallowRef<string[]>([])
const slidesVersion = ref(0)
let splitTimer = 0

/**
 * 单页 HTML → iframe srcdoc：主题 CSS + 固定画布尺寸（缩放交给父级 transform）。
 * 注意：marp-core 产出的 CSS 选择器都以 `div.marpit > svg > ...` 作用域限定，
 * 所以拆出来的单个 `<svg>` 必须重新包进 `<div class="marpit">`，否则主题样式不会生效。
 */
function buildSlideDoc(slideHtml: string, css: string, width: number, height: number): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<style>${css}</style>
<style>
html,body{margin:0;padding:0;background:#fff;overflow:hidden;}
html,body{width:${width}px;height:${height}px;}
.marpit{width:${width}px;height:${height}px;}
.marpit>svg,body>svg{display:block!important;width:${width}px!important;height:${height}px!important;margin:0!important;}
</style></head><body><div class="marpit">${slideHtml}</div></body></html>`
}

/**
 * 从整 deck HTML 拆出每页的 `<svg data-marpit-svg>`。
 * 用 DOMParser 而不是正则：Marp 页面里可能有嵌套 svg（MathJax 等），正则容易截断。
 */
function splitDeckHtml(html: string): string[] {
  if (!html || !html.trim()) return []
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const slides = Array.from(doc.querySelectorAll('svg[data-marpit-svg]'))
    if (slides.length) return slides.map((svg) => svg.outerHTML)
    const marpit = doc.querySelector('.marpit')
    if (marpit && marpit.children.length) {
      return Array.from(marpit.children).map((el) => el.outerHTML)
    }
    return [html]
  } catch {
    return [html]
  }
}

function splitNow(): void {
  rawSlides.value = splitDeckHtml(props.html)
  slidesVersion.value++
  void nextTick(() => refreshMetrics())
}

function scheduleSplit(immediate = false): void {
  window.clearTimeout(splitTimer)
  // 小文档（绝大多数 deck）同步拆分，切换 tab 立刻有缩略图；超大 deck 防抖，避免阻塞输入
  if (immediate || props.html.length < 600_000) {
    splitNow()
    return
  }
  splitTimer = window.setTimeout(splitNow, 260)
}

/** 每页的 srcdoc（html/css/画布尺寸变化时重建；iframe 只在字符串变化时重新加载） */
const slideDocs = computed<string[]>(() => {
  void slidesVersion.value
  const css = props.css || ''
  const width = safeSlideWidth.value
  const height = safeSlideHeight.value
  return rawSlides.value.map((slide) => buildSlideDoc(slide, css, width, height))
})

/* ---------------- 虚拟滚动：只渲染视口附近的页 ---------------- */
interface VisibleSlide {
  page: number
  top: number
  doc: string | undefined
}

const visibleSlides = computed<VisibleSlide[]>(() => {
  const count = slideCount.value
  if (count <= 0) return []
  const row = rowHeight.value
  const scrollTop = metrics.scrollTop
  const viewport = metrics.height > 0 ? metrics.height : 600
  const start = Math.max(0, Math.floor((scrollTop - TOP_PAD) / row) - OVERSCAN)
  const end = Math.min(count - 1, Math.ceil((scrollTop + viewport - TOP_PAD) / row) + OVERSCAN)
  const docs = slideDocs.value
  const result: VisibleSlide[] = []
  for (let i = start; i <= end; i++) {
    result.push({
      page: i + 1,
      top: TOP_PAD + i * row,
      doc: docs[i],
    })
  }
  return result
})

function refreshMetrics(): void {
  const root = rootEl.value
  const list = listEl.value
  // 宽度优先用列表自身；列表只在「幻灯片」tab 存在，大纲 tab 下退到根容器（RO 才能提前拿到宽度，
  // 否则首次切到幻灯片 tab 时 spacer 高度会用兜底宽度算错，滚动定位被 clamp）
  const width = list ? list.clientWidth : root ? Math.max(0, root.clientWidth - 2) : 0
  if (width > 0) metrics.width = width
  if (list) {
    metrics.height = list.clientHeight
    metrics.scrollTop = list.scrollTop
  }
}

let scrollRaf = 0
function onListScroll(): void {
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    const el = listEl.value
    if (el) metrics.scrollTop = el.scrollTop
  })
}

/** 把当前页滚到可视区域（已在视野内则不动，避免和用户滚动打架） */
function scrollPageIntoView(page: number, behavior: ScrollBehavior = 'auto'): void {
  const el = listEl.value
  if (!el || slideCount.value <= 0) return
  const row = rowHeight.value
  const targetPage = clampPage(page, slideCount.value)
  const top = TOP_PAD + (targetPage - 1) * row
  const viewTop = el.scrollTop
  const viewBottom = viewTop + el.clientHeight
  if (top >= viewTop && top + row <= viewBottom) return
  const centered = top - Math.max(0, (el.clientHeight - row) / 2)
  el.scrollTo({ top: Math.max(0, centered), behavior })
}

function onThumbClick(page: number): void {
  emit('jump', page)
}

/* ---------------- 响应式尺寸 / 宿主可见性 ---------------- */
let resizeObserver: ResizeObserver | null = null

/**
 * 宿主（父级左栏）是否可见：父组件常用 `v-show` 折叠左栏 → 此时 root 尺寸为 0，
 * 组件自动停止渲染缩略图列表（销毁全部 iframe 释放内存）；展开后自动恢复并滚到当前页。
 */
const hostVisible = ref(true)

function handleResize(): void {
  const root = rootEl.value
  const visible = !!root && root.clientWidth > 0 && root.clientHeight > 0
  if (visible !== hostVisible.value) {
    hostVisible.value = visible
    if (visible) {
      void nextTick(() => {
        refreshMetrics()
        if (activeTab.value === 'slides') scrollPageIntoView(safeCurrentPage.value, 'auto')
      })
    }
    return
  }
  refreshMetrics()
}

/* ------------------------------------------------------------------ */
/* 监听：父组件更新当前页 / 切换 tab / html 变化                       */
/* ------------------------------------------------------------------ */
watch(
  () => props.html,
  () => scheduleSplit(),
)

// 内容被编辑后行号可能变化：清掉「点击高亮」，回退到按当前页推导
watch(
  () => props.markdown,
  () => {
    clickedLine.value = -1
  },
)

watch(
  () => props.pageCount,
  () => {
    void nextTick(() => refreshMetrics())
  },
)

watch(safeCurrentPage, (page) => {
  if (activeTab.value === 'slides') scrollPageIntoView(page, 'smooth')
})

watch(activeTab, async (tab) => {
  if (tab !== 'slides') return
  await nextTick()
  refreshMetrics()
  // refreshMetrics 可能改 metrics.width（触发 rowHeight/spacerHeight 重算），再 flush 一次让
  // DOM 的 spacer 高度与 JS 计算一致，否则 scrollTo 会被旧的 scrollHeight clamp 住
  await nextTick()
  scrollPageIntoView(safeCurrentPage.value, 'auto')
})

/** 大纲：当前页变化时把「活动标题」滚到可视区（block:nearest，尽量不惊动外层滚动） */
watch([activeLine, activeTab], async () => {
  if (activeTab.value !== 'outline' || activeLine.value < 0) return
  await nextTick()
  const host = outlineBody.value
  if (!host) return
  const el = host.querySelector<HTMLElement>(`[data-line="${activeLine.value}"]`)
  el?.scrollIntoView({ block: 'nearest' })
})

/* ------------------------------------------------------------------ */
/* 生命周期：折叠（父组件 v-if 卸载）时自动销毁全部 iframe             */
/* ------------------------------------------------------------------ */
onMounted(() => {
  scheduleSplit(true)
  resizeObserver = new ResizeObserver(() => handleResize())
  if (rootEl.value) resizeObserver.observe(rootEl.value)
  window.addEventListener('resize', handleResize)
  void nextTick(() => {
    refreshMetrics()
    if (activeTab.value === 'slides') scrollPageIntoView(safeCurrentPage.value, 'auto')
  })
})

onBeforeUnmount(() => {
  window.clearTimeout(splitTimer)
  if (scrollRaf) cancelAnimationFrame(scrollRaf)
  scrollRaf = 0
  resizeObserver?.disconnect()
  resizeObserver = null
  window.removeEventListener('resize', handleResize)
})

defineExpose({
  /** 供父组件/自动化验证读取当前 tab */
  getTab: () => activeTab.value,
  setTab,
  scrollPageIntoView,
  /** 自动化验证用的内部状态快照（只读；不参与契约） */
  debugState: () => ({
    tab: activeTab.value,
    metrics: { ...metrics },
    thumbWidth: thumbWidth.value,
    rowHeight: rowHeight.value,
    scrollTop: listEl.value?.scrollTop ?? -1,
    scrollHeight: listEl.value?.scrollHeight ?? -1,
    clientHeight: listEl.value?.clientHeight ?? -1,
    visibleCount: visibleSlides.value.length,
    hostVisible: hostVisible.value,
  }),
})
</script>

<template>
  <aside ref="rootEl" class="slide-navigator" aria-label="演示文稿导航">
    <div class="sn-tabs" role="tablist" aria-label="导航视图">
      <button
        type="button"
        role="tab"
        class="sn-tab"
        :class="{ active: activeTab === 'outline' }"
        :aria-selected="activeTab === 'outline'"
        title="按标题大纲导航（点击跳到标题所在页）"
        @click="setTab('outline')"
      >
        大纲
        <span v-if="outlineItems.length" class="sn-tab-count">{{ outlineItems.length }}</span>
      </button>
      <button
        type="button"
        role="tab"
        class="sn-tab"
        :class="{ active: activeTab === 'slides' }"
        :aria-selected="activeTab === 'slides'"
        title="幻灯片缩略图导航（点击跳到该页）"
        @click="setTab('slides')"
      >
        幻灯片
        <span v-if="slideCount" class="sn-tab-count">{{ slideCount }}</span>
      </button>
    </div>

    <!-- ---------- 大纲 ---------- -->
    <div v-show="activeTab === 'outline'" ref="outlineBody" class="sn-body sn-outline">
      <div v-if="outlineEmpty === 'none'" class="sn-empty">
        <div class="sn-empty-icon" aria-hidden="true">📝</div>
        <p class="sn-empty-title">还没有内容</p>
        <p class="sn-empty-hint">在编辑区输入 Markdown，大纲会按标题自动生成。</p>
      </div>

      <div v-else-if="outlineEmpty === 'no-headings'" class="sn-empty">
        <div class="sn-empty-icon" aria-hidden="true">#</div>
        <p class="sn-empty-title">没有找到标题</p>
        <p class="sn-empty-hint">
          在行首用 <code>#</code> 一级标题、<code>##</code> 二级标题…<br />
          大标题会自动出现在这里，点击即可跳转到对应页。
        </p>
      </div>

      <ul v-else class="sn-outline-list">
        <li v-for="item in outlineItems" :key="`${item.line}-${item.level}`" class="sn-outline-li">
          <button
            type="button"
            class="sn-outline-item"
            :class="{
              current: item.page === safeCurrentPage,
              active: item.line === activeLine,
              [`sn-level-${item.level}`]: true,
            }"
            :data-line="item.line"
            :style="{ paddingLeft: `${PAD + item.indent * 14}px` }"
            :title="describeHeading(item)"
            @click="onOutlineClick(item)"
          >
            <span class="sn-h-badge" aria-hidden="true">H{{ item.level }}</span>
            <span class="sn-outline-text">{{ item.text || '(无标题文本)' }}</span>
            <span class="sn-outline-page" :title="`第 ${item.page} 页`">{{ item.page }}</span>
          </button>
        </li>
      </ul>
    </div>

    <!-- ---------- 幻灯片缩略图 ---------- -->
    <div v-if="activeTab === 'slides' && hostVisible" class="sn-body sn-slides">
      <div v-if="slidesEmpty" class="sn-empty">
        <div class="sn-empty-icon" aria-hidden="true">▭</div>
        <p class="sn-empty-title">还没有幻灯片</p>
        <p class="sn-empty-hint">
          在编辑区用 <code>---</code> 分页；<br />缩略图会按当前主题实时渲染在这里。
        </p>
      </div>

      <div v-else ref="listEl" class="sn-slide-list" @scroll.passive="onListScroll">
        <div class="sn-slide-spacer" :style="{ height: `${spacerHeight}px` }">
          <button
            v-for="item in visibleSlides"
            :key="item.page"
            type="button"
            class="sn-thumb"
            :class="{ current: item.page === safeCurrentPage }"
            :style="{ top: `${item.top}px`, height: `${rowHeight}px` }"
            :aria-current="item.page === safeCurrentPage ? 'page' : undefined"
            :aria-label="`第 ${item.page} 页${item.page === safeCurrentPage ? '（当前页）' : ''}`"
            :title="`跳到第 ${item.page} 页`"
            @click="onThumbClick(item.page)"
          >
            <span class="sn-thumb-frame" :style="{ width: `${thumbWidth}px`, height: `${thumbHeight}px` }">
              <iframe
                v-if="item.doc"
                class="sn-thumb-frame-el"
                :srcdoc="item.doc"
                sandbox=""
                scrolling="no"
                tabindex="-1"
                aria-hidden="true"
                :style="{
                  width: `${safeSlideWidth}px`,
                  height: `${safeSlideHeight}px`,
                  transform: `scale(${thumbScale})`,
                }"
              />
              <span v-else class="sn-thumb-loading">第 {{ item.page }} 页</span>
            </span>
            <span class="sn-thumb-label">
              <span class="sn-thumb-no">{{ item.page }}</span>
              <span class="sn-thumb-text">第 {{ item.page }} 页</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
/* ------------------------------------------------------------------
   根容器：填满父级左栏（父栏需给高度，例如 flex 纵向布局 + min-height:0）
   ------------------------------------------------------------------ */
.slide-navigator {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: var(--mwb-surface, #fff);
  color: var(--mwb-text, #1e293b);
  border-right: 1px solid var(--mwb-border, #e2e8f0);
  overflow: hidden;
  font-size: 13px;
}

/* ---------- Tab ---------- */
.sn-tabs {
  display: flex;
  gap: 2px;
  padding: 8px 8px 0;
  flex: 0 0 auto;
  border-bottom: 1px solid var(--mwb-border, #e2e8f0);
  background: #fbfcfe;
}
.sn-tab {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 30px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-bottom: 0;
  border-radius: 8px 8px 0 0;
  background: transparent;
  color: var(--mwb-text-weak, #64748b);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background 0.12s ease,
    color 0.12s ease;
}
.sn-tab:hover {
  color: var(--mwb-text, #1e293b);
  background: #f1f5f9;
}
.sn-tab.active {
  color: var(--mwb-primary, #4f46e5);
  background: #fff;
  border-color: var(--mwb-border, #e2e8f0);
  margin-bottom: -1px;
}
.sn-tab-count {
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--mwb-primary-soft, #eef2ff);
  color: var(--mwb-primary, #4f46e5);
  font-size: 10px;
  line-height: 16px;
  font-weight: 600;
}
.sn-tab:not(.active) .sn-tab-count {
  background: #f1f5f9;
  color: var(--mwb-text-weak, #64748b);
}

/* ---------- 公共 body ---------- */
.sn-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.sn-outline {
  overflow-y: auto;
  overflow-x: hidden;
}
.sn-slides {
  position: relative;
}

/* ---------- 空态 ---------- */
.sn-empty {
  margin: auto;
  padding: 26px 18px;
  text-align: center;
  color: var(--mwb-text-weak, #64748b);
  max-width: 260px;
}
.sn-empty-icon {
  width: 38px;
  height: 38px;
  margin: 0 auto 10px;
  border-radius: 12px;
  background: var(--mwb-primary-soft, #eef2ff);
  color: var(--mwb-primary, #4f46e5);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 17px;
  font-weight: 700;
}
.sn-empty-title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--mwb-text, #1e293b);
}
.sn-empty-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.65;
}
.sn-empty-hint code {
  background: #eef2ff;
  color: var(--mwb-primary, #4f46e5);
  padding: 1px 5px;
  border-radius: 5px;
  font-size: 11.5px;
}

/* ---------- 大纲列表 ---------- */
.sn-outline-list {
  list-style: none;
  margin: 0;
  padding: 6px 6px 14px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.sn-outline-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 28px;
  padding-top: 4px;
  padding-right: 8px;
  padding-bottom: 4px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--mwb-text, #1e293b);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  transition:
    background 0.1s ease,
    color 0.1s ease;
}
.sn-outline-item:hover {
  background: #f1f5f9;
}
.sn-outline-item.current {
  background: var(--mwb-primary-soft, #eef2ff);
  color: var(--mwb-primary, #4f46e5);
}
.sn-outline-item.active {
  background: var(--mwb-primary, #4f46e5);
  color: #fff;
}
.sn-outline-item.active .sn-h-badge {
  background: rgba(255, 255, 255, 0.22);
  color: #fff;
}
.sn-outline-item.active .sn-outline-page {
  background: rgba(255, 255, 255, 0.22);
  color: #fff;
}
.sn-h-badge {
  flex: 0 0 auto;
  min-width: 20px;
  height: 16px;
  padding: 0 3px;
  border-radius: 4px;
  background: #f1f5f9;
  color: var(--mwb-text-weak, #64748b);
  font-size: 9.5px;
  line-height: 16px;
  text-align: center;
  font-weight: 700;
  letter-spacing: 0.2px;
}
.sn-outline-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 按标题级别给一点视觉层次（缩进由内联 paddingLeft 控制） */
.sn-level-1 .sn-outline-text {
  font-weight: 700;
  font-size: 13px;
}
.sn-level-2 .sn-outline-text {
  font-weight: 600;
}
.sn-level-3 .sn-outline-text,
.sn-level-4 .sn-outline-text,
.sn-level-5 .sn-outline-text,
.sn-level-6 .sn-outline-text {
  color: var(--mwb-text-weak, #64748b);
}
.sn-outline-item.current .sn-outline-text,
.sn-outline-item.active .sn-outline-text {
  color: inherit;
}
.sn-outline-page {
  flex: 0 0 auto;
  min-width: 18px;
  height: 16px;
  padding: 0 4px;
  border-radius: 5px;
  background: #f1f5f9;
  color: var(--mwb-text-weak, #64748b);
  font-size: 10px;
  line-height: 16px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

/* ---------- 缩略图列表 ---------- */
.sn-slide-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  position: relative;
  overscroll-behavior: contain;
}
.sn-slide-spacer {
  position: relative;
  width: 100%;
}
.sn-thumb {
  position: absolute;
  left: 10px;
  right: 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  text-align: left;
  border-radius: 8px;
}
.sn-thumb-frame {
  position: relative;
  display: block;
  overflow: hidden;
  border: 1px solid var(--mwb-border, #e2e8f0);
  border-radius: 7px;
  background: #fff;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.07);
  transition:
    border-color 0.12s ease,
    box-shadow 0.12s ease;
}
.sn-thumb:hover .sn-thumb-frame {
  border-color: var(--mwb-primary, #4f46e5);
  box-shadow: 0 4px 14px rgba(79, 70, 229, 0.18);
}
.sn-thumb.current .sn-thumb-frame {
  border-color: var(--mwb-primary, #4f46e5);
  box-shadow:
    0 0 0 2px var(--mwb-primary, #4f46e5),
    0 4px 14px rgba(79, 70, 229, 0.18);
}
.sn-thumb-frame-el {
  display: block;
  border: 0;
  transform-origin: top left;
  pointer-events: none;
  background: #fff;
}
.sn-thumb-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--mwb-text-weak, #64748b);
  font-size: 12px;
  background: repeating-linear-gradient(135deg, #f8fafc 0 10px, #f1f5f9 10px 20px);
}
.sn-thumb-label {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 18px;
  padding: 0 2px;
  font-size: 11px;
  color: var(--mwb-text-weak, #64748b);
  overflow: hidden;
  white-space: nowrap;
}
.sn-thumb-no {
  flex: 0 0 auto;
  min-width: 18px;
  height: 15px;
  padding: 0 4px;
  border-radius: 5px;
  background: #f1f5f9;
  color: var(--mwb-text-weak, #64748b);
  font-size: 10px;
  line-height: 15px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.sn-thumb.current .sn-thumb-no {
  background: var(--mwb-primary, #4f46e5);
  color: #fff;
}
.sn-thumb-text {
  overflow: hidden;
  text-overflow: ellipsis;
}
.sn-thumb.current .sn-thumb-text {
  color: var(--mwb-primary, #4f46e5);
  font-weight: 600;
}
</style>
