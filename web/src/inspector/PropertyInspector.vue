<script setup lang="ts">
/**
 * 属性面板（owner: frontend-core / marp-tech，契约 §2.2）
 * 所有操作只生成标准 Marp Markdown：front-matter 字段 / 页首 `<!-- _key: value -->` / 图片指令。
 * 只改目标字段，保留未知字段与顺序（由 marp/frontmatter.ts 保证）。
 */
import { computed, ref, watch } from 'vue'
import type { ThemeMeta } from '../types'
import {
  buildImageDirective,
  getFrontMatterData,
  getPageBackground,
  getSlideDirective,
  replaceImageDirective,
  setFrontMatterField,
  setSlideDirective,
} from '../marp/frontmatter'

const props = defineProps<{
  markdown: string
  currentPage: number
  pageCount: number
  themes: ThemeMeta[]
  currentTheme: string
}>()

const emit = defineEmits<{
  update: [markdown: string]
  openGallery: []
  openThemeEditor: [name: string]
  pickBackground: []
}>()

const CLASSLIST = ['lead', 'invert', 'center'] as const
const ADAPTS = ['cover', 'contain', 'fit'] as const

const fm = computed(() => getFrontMatterData(props.markdown))
const themeValue = computed(() => props.currentTheme || fm.value.theme || 'default')
const sizeValue = computed(() => (fm.value.size || '16:9').trim())
const paginateOn = computed(() => String(fm.value.paginate ?? '').toLowerCase() === 'true')
const pagePaginate = computed(() => getSlideDirective(props.markdown, props.currentPage, 'paginate') || '')
const globalClass = computed(() => fm.value.class || '')
const globalClassList = computed(() => globalClass.value.split(/\s+/).filter(Boolean))
const pageClass = computed(() => getSlideDirective(props.markdown, props.currentPage, 'class') || '')
const pageBg = computed(() => getPageBackground(props.markdown, props.currentPage))

const headerInput = ref('')
const footerInput = ref('')
const pageHeaderInput = ref('')
const pageFooterInput = ref('')
const customClassInput = ref('')
const customPageClassInput = ref('')

const hasPageHeader = computed(() => getSlideDirective(props.markdown, props.currentPage, 'header') !== null)
const hasPageFooter = computed(() => getSlideDirective(props.markdown, props.currentPage, 'footer') !== null)

const pageBgAdapt = computed(() => {
  if (!pageBg.value) return 'cover'
  return (ADAPTS as readonly string[]).find((m) => pageBg.value?.modifiers.includes(m)) || 'cover'
})
const pageBgOpacity = computed(() => {
  const m = pageBg.value?.modifiers.find((x) => /^opacity\s*:/.test(x))
  if (!m) return 100
  const n = parseFloat(m.split(':')[1])
  return Number.isFinite(n) ? Math.round(n * 100) : 100
})
const pageBgName = computed(() => {
  const p = pageBg.value?.path || ''
  const parts = p.split('/')
  return parts[parts.length - 1] || p
})
const pageBgSide = computed(() => {
  if (!pageBg.value) return ''
  const side = pageBg.value.modifiers.find((m) => /^left(:|$)/.test(m) || /^right(:|$)/.test(m))
  if (!side) return '整页背景'
  const dir = side.startsWith('left') ? '左侧' : '右侧'
  const ratio = side.split(':')[1]
  return `${dir}${ratio ? ` ${ratio}` : ''}`
})

watch(
  () => [props.markdown, props.currentPage] as const,
  () => syncFromMarkdown(),
  { immediate: true },
)

function syncFromMarkdown(): void {
  headerInput.value = fm.value.header || ''
  footerInput.value = fm.value.footer || ''
  pageHeaderInput.value = getSlideDirective(props.markdown, props.currentPage, 'header') || ''
  pageFooterInput.value = getSlideDirective(props.markdown, props.currentPage, 'footer') || ''
}

function patch(fn: (md: string) => string): void {
  const next = fn(props.markdown)
  if (next !== props.markdown) emit('update', next)
}

function setFm(key: string, value: string | null): void {
  patch((md) => setFrontMatterField(md, key, value))
}

function setSlide(key: string, value: string | null): void {
  patch((md) => setSlideDirective(md, props.currentPage, key, value))
}

function ensureMarp(): void {
  patch((md) => setFrontMatterField(md, 'marp', 'true'))
}

// ---------- 主题 ----------
function onThemeChange(ev: Event): void {
  setFm('theme', (ev.target as HTMLSelectElement).value)
}

// ---------- 尺寸 / 页码 ----------
function setSize(size: '16:9' | '4:3'): void {
  setFm('size', size)
}

function togglePaginate(): void {
  setFm('paginate', paginateOn.value ? null : 'true')
}

function onPagePaginateChange(ev: Event): void {
  const v = (ev.target as HTMLSelectElement).value
  setSlide('paginate', v === '' ? null : v)
}

// ---------- 页眉 / 页脚 ----------
function applyHeader(): void {
  setFm('header', headerInput.value.trim() || null)
}
function applyFooter(): void {
  setFm('footer', footerInput.value.trim() || null)
}
function clearHeader(): void {
  headerInput.value = ''
  pageHeaderInput.value = ''
  patch((md) => setFrontMatterField(setSlideDirective(md, props.currentPage, 'header', null), 'header', null))
}
function clearFooter(): void {
  footerInput.value = ''
  pageFooterInput.value = ''
  patch((md) => setFrontMatterField(setSlideDirective(md, props.currentPage, 'footer', null), 'footer', null))
}
function togglePageHeader(ev: Event): void {
  const on = (ev.target as HTMLInputElement).checked
  if (on) {
    const initial = headerInput.value.trim() || '页眉'
    pageHeaderInput.value = initial
    setSlide('header', initial)
  } else {
    pageHeaderInput.value = ''
    setSlide('header', null)
  }
}
function togglePageFooter(ev: Event): void {
  const on = (ev.target as HTMLInputElement).checked
  if (on) {
    const initial = footerInput.value.trim() || '页脚'
    pageFooterInput.value = initial
    setSlide('footer', initial)
  } else {
    pageFooterInput.value = ''
    setSlide('footer', null)
  }
}
function applyPageHeader(): void {
  setSlide('header', pageHeaderInput.value.trim() || null)
}
function applyPageFooter(): void {
  setSlide('footer', pageFooterInput.value.trim() || null)
}

// ---------- class ----------
function toggleGlobalClass(cls: string): void {
  const list = [...globalClassList.value]
  const i = list.indexOf(cls)
  if (i >= 0) list.splice(i, 1)
  else list.push(cls)
  setFm('class', list.length ? list.join(' ') : null)
}
function addCustomClass(): void {
  const extra = customClassInput.value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!extra.length) return
  const list = [...new Set([...globalClassList.value, ...extra])]
  customClassInput.value = ''
  setFm('class', list.join(' '))
}
function setPageClass(cls: string): void {
  setSlide('class', pageClass.value === cls ? null : cls)
}
function addCustomPageClass(): void {
  const v = customPageClassInput.value.trim()
  if (!v) return
  customPageClassInput.value = ''
  setSlide('class', v)
}
function clearPageClass(): void {
  setSlide('class', null)
}

// ---------- 背景图 ----------
function updateBgModifiers(modifiers: string[]): void {
  const bg = pageBg.value
  if (!bg) return
  const raw = buildImageDirective(bg.path, modifiers)
  patch((md) => replaceImageDirective(md, bg.offset, raw))
}
function setBgAdapt(adapt: string): void {
  const bg = pageBg.value
  if (!bg) return
  const modifiers = bg.modifiers.filter((m) => !(ADAPTS as readonly string[]).includes(m))
  modifiers.push(adapt)
  updateBgModifiers(modifiers)
}
function setBgOpacity(pct: number): void {
  const bg = pageBg.value
  if (!bg) return
  const modifiers = bg.modifiers.filter((m) => !/^opacity\s*:/.test(m))
  if (pct < 100) {
    const value = String(Math.round(pct) / 100).replace(/^0/, '')
    modifiers.push(`opacity:${value}`)
  }
  updateBgModifiers(modifiers)
}
function removeBg(): void {
  const bg = pageBg.value
  if (!bg) return
  patch((md) => replaceImageDirective(md, bg.offset, null))
}
function onOpacityInput(ev: Event): void {
  setBgOpacity(Number((ev.target as HTMLInputElement).value))
}
</script>

<template>
  <aside class="inspector">
    <div class="inspector-head">
      <span>属性</span>
      <span class="muted small">第 {{ currentPage }} / {{ pageCount }} 页</span>
    </div>

    <div class="inspector-body">
      <div v-if="!markdown.trim()" class="inspector-empty">
        <p>空演示文稿</p>
        <button class="btn btn-secondary btn-sm" @click="ensureMarp">补齐 Marp 基础设置</button>
      </div>

      <!-- 主题 -->
      <section class="inspector-group">
        <h3>主题</h3>
        <div class="field-row">
          <select class="inspector-select" :value="themeValue" title="切换主题" @change="onThemeChange">
            <option v-for="t in themes" :key="t.name" :value="t.name">{{ t.displayName }}</option>
            <option v-if="!themes.some((t) => t.name === themeValue)" :value="themeValue">
              {{ themeValue }}（未加载）
            </option>
          </select>
        </div>
        <div class="field-row btn-row">
          <button class="btn btn-ghost btn-sm" @click="emit('openGallery')">主题画廊</button>
          <button class="btn btn-ghost btn-sm" @click="emit('openThemeEditor', themeValue)">编辑主题</button>
        </div>
      </section>

      <!-- 尺寸 -->
      <section class="inspector-group">
        <h3>幻灯片尺寸</h3>
        <div class="seg">
          <button class="seg-btn" :class="{ active: sizeValue === '16:9' }" @click="setSize('16:9')">16:9</button>
          <button class="seg-btn" :class="{ active: sizeValue === '4:3' }" @click="setSize('4:3')">4:3</button>
        </div>
      </section>

      <!-- 页码 -->
      <section class="inspector-group">
        <h3>页码</h3>
        <label class="toggle-row">
          <input type="checkbox" :checked="paginateOn" @change="togglePaginate" />
          <span>显示页码（全局）</span>
        </label>
        <div class="field-row">
          <span class="field-label">仅本页</span>
          <select class="inspector-select" :value="pagePaginate" @change="onPagePaginateChange">
            <option value="">默认</option>
            <option value="true">显示</option>
            <option value="false">隐藏</option>
          </select>
        </div>
      </section>

      <!-- 页眉 -->
      <section class="inspector-group">
        <h3>页眉</h3>
        <div class="field-row">
          <input
            v-model="headerInput"
            class="inspector-input"
            type="text"
            placeholder="例如：2024 年度汇报"
            @change="applyHeader"
            @keydown.enter="applyHeader"
          />
          <button class="btn btn-ghost btn-sm" title="清空页眉" @click="clearHeader">清空</button>
        </div>
        <label class="toggle-row">
          <input type="checkbox" :checked="hasPageHeader" @change="togglePageHeader" />
          <span>仅本页单独设置</span>
        </label>
        <div v-if="hasPageHeader" class="field-row">
          <input
            v-model="pageHeaderInput"
            class="inspector-input"
            type="text"
            placeholder="本页页眉"
            @change="applyPageHeader"
            @keydown.enter="applyPageHeader"
          />
        </div>
      </section>

      <!-- 页脚 -->
      <section class="inspector-group">
        <h3>页脚</h3>
        <div class="field-row">
          <input
            v-model="footerInput"
            class="inspector-input"
            type="text"
            placeholder="例如：MarpWorkbench"
            @change="applyFooter"
            @keydown.enter="applyFooter"
          />
          <button class="btn btn-ghost btn-sm" title="清空页脚" @click="clearFooter">清空</button>
        </div>
        <label class="toggle-row">
          <input type="checkbox" :checked="hasPageFooter" @change="togglePageFooter" />
          <span>仅本页单独设置</span>
        </label>
        <div v-if="hasPageFooter" class="field-row">
          <input
            v-model="pageFooterInput"
            class="inspector-input"
            type="text"
            placeholder="本页页脚"
            @change="applyPageFooter"
            @keydown.enter="applyPageFooter"
          />
        </div>
      </section>

      <!-- 全局 class -->
      <section class="inspector-group">
        <h3>全局 class <span class="muted small">（所有页）</span></h3>
        <div class="chips">
          <button
            v-for="cls in CLASSLIST"
            :key="cls"
            class="chip"
            :class="{ active: globalClassList.includes(cls) }"
            @click="toggleGlobalClass(cls)"
          >
            {{ cls }}
          </button>
        </div>
        <div class="field-row">
          <input v-model="customClassInput" class="inspector-input" type="text" placeholder="自定义 class（空格分隔）" @keydown.enter="addCustomClass" />
          <button class="btn btn-ghost btn-sm" @click="addCustomClass">添加</button>
        </div>
      </section>

      <!-- 本页 class -->
      <section class="inspector-group">
        <h3>本页 class <span class="muted small">（第 {{ currentPage }} 页）</span></h3>
        <div class="chips">
          <button
            v-for="cls in CLASSLIST"
            :key="cls"
            class="chip"
            :class="{ active: pageClass === cls }"
            @click="setPageClass(cls)"
          >
            {{ cls }}
          </button>
        </div>
        <div class="field-row">
          <input v-model="customPageClassInput" class="inspector-input" type="text" placeholder="自定义本页 class" @keydown.enter="addCustomPageClass" />
          <button class="btn btn-ghost btn-sm" @click="addCustomPageClass">设置</button>
          <button class="btn btn-ghost btn-sm" :disabled="!pageClass" @click="clearPageClass">清除</button>
        </div>
      </section>

      <!-- 背景图 -->
      <section class="inspector-group">
        <h3>本页背景图</h3>
        <div v-if="pageBg" class="bg-card">
          <div class="bg-title">🖼 {{ pageBgName }}</div>
          <div class="muted small">{{ pageBgSide }}</div>
          <div class="field-row">
            <span class="field-label">适配</span>
            <div class="seg">
              <button
                v-for="a in ADAPTS"
                :key="a"
                class="seg-btn"
                :class="{ active: pageBgAdapt === a }"
                @click="setBgAdapt(a)"
              >
                {{ a }}
              </button>
            </div>
          </div>
          <div class="field-row">
            <span class="field-label">透明度 {{ pageBgOpacity }}%</span>
            <input
              class="inspector-range"
              type="range"
              min="0"
              max="100"
              step="5"
              :value="pageBgOpacity"
              @change="onOpacityInput"
            />
          </div>
          <div class="field-row btn-row">
            <button class="btn btn-ghost btn-sm" @click="emit('pickBackground')">更换背景图</button>
            <button class="btn btn-ghost btn-sm danger" @click="removeBg">移除背景图</button>
          </div>
        </div>
        <div v-else>
          <p class="muted small">当前页没有背景图。背景图会铺满整页（可左/右占比、透明、适配）。</p>
          <button class="btn btn-secondary btn-sm" @click="emit('pickBackground')">选择背景图</button>
        </div>
      </section>

      <section class="inspector-group">
        <h3>高级</h3>
        <p class="muted small">
          属性面板只修改对应的 front-matter / Marp 指令，未知字段和注释保留，可直接拷回 VS Code。
          需要更高自由度时可编辑左侧源码。
        </p>
        <button class="btn btn-ghost btn-sm" @click="emit('openThemeEditor', themeValue)">打开主题编辑器</button>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.inspector {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--mwb-surface, #fff);
  border-left: 1px solid var(--mwb-border, #e2e8f0);
  overflow: hidden;
}
.inspector-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 32px;
  padding: 0 12px;
  border-bottom: 1px solid var(--mwb-border, #e2e8f0);
  background: #fbfcfe;
  font-size: 12px;
  color: var(--mwb-text-weak, #64748b);
  flex: 0 0 auto;
}
.inspector-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 12px 32px;
}
.inspector-group {
  padding: 10px 0 12px;
  border-bottom: 1px solid #f1f5f9;
}
.inspector-group:last-child {
  border-bottom: 0;
}
.inspector-group h3 {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--mwb-text, #1e293b);
}
.field-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}
.btn-row {
  flex-wrap: wrap;
}
.field-label {
  font-size: 12px;
  color: var(--mwb-text-weak, #64748b);
  flex: 0 0 auto;
  white-space: nowrap;
}
.inspector-select,
.inspector-input {
  width: 100%;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--mwb-border-strong, #cbd5e1);
  border-radius: 7px;
  font-size: 12px;
  background: #fff;
  color: var(--mwb-text, #1e293b);
  outline: none;
}
.inspector-select:focus,
.inspector-input:focus {
  border-color: var(--mwb-primary, #4f46e5);
  box-shadow: 0 0 0 2px rgba(79, 70, 229, 0.12);
}
.field-row > .inspector-select {
  flex: 1;
}
.toggle-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--mwb-text, #1e293b);
  cursor: pointer;
}
.seg {
  display: inline-flex;
  border: 1px solid var(--mwb-border-strong, #cbd5e1);
  border-radius: 8px;
  overflow: hidden;
}
.seg-btn {
  border: 0;
  background: #fff;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  color: var(--mwb-text-weak, #64748b);
}
.seg-btn + .seg-btn {
  border-left: 1px solid var(--mwb-border, #e2e8f0);
}
.seg-btn.active {
  background: var(--mwb-primary-soft, #eef2ff);
  color: var(--mwb-primary, #4f46e5);
  font-weight: 600;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  border: 1px solid var(--mwb-border-strong, #cbd5e1);
  background: #fff;
  color: var(--mwb-text-weak, #64748b);
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
}
.chip.active {
  background: var(--mwb-primary-soft, #eef2ff);
  border-color: #c7d2fe;
  color: var(--mwb-primary, #4f46e5);
  font-weight: 600;
}
.bg-card {
  border: 1px solid var(--mwb-border, #e2e8f0);
  border-radius: 8px;
  padding: 8px;
  background: #fafbff;
}
.bg-title {
  font-size: 12px;
  font-weight: 600;
  word-break: break-all;
}
.inspector-range {
  flex: 1;
  min-width: 0;
}
.inspector-empty {
  padding: 20px 4px;
  text-align: center;
  color: var(--mwb-text-weak, #64748b);
  font-size: 12px;
}
.danger {
  color: var(--mwb-danger, #dc2626);
}
.small {
  font-size: 11px;
}
</style>
