<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CodeMirrorEditor from '../editor/CodeMirrorEditor.vue'
import EditorToolbar from '../insert/EditorToolbar.vue'
import PropertyInspector from '../inspector/PropertyInspector.vue'
import PreviewPane from '../preview/PreviewPane.vue'
import type { EditorApi, FormatCommand } from '../editor/types'
import {
  app,
  ensureBootstrap,
  refreshThemes,
  themeDisplayName,
  themeExists,
  toast,
} from '../stores/app'
import * as API from '../api'
import { ApiError, readableError } from '../api/errors'
import { renderer } from '../marp/renderer'
import { resolveDeckAssetsInHtml, resolveDeckAssetsInHtmlSync, resolveDeckAssetsInMarkdownSync } from '../marp/assets'
import {
  getMarkdownTheme,
  insertAtPageStart,
  pageStartLine,
  setMarkdownTheme,
  slideIndexAtLine,
} from '../marp/frontmatter'
import {
  ExportPanelAsync,
  ImageInsertDialogAsync,
  SlideNavigatorAsync,
  TableInsertDialogAsync,
  ThemeGalleryAsync,
  loadPasteDrop,
} from '../integrations/optionalComponents'
import type { DeckDetail, RenderResult } from '../types'
import { formatTime } from '../utils/format'

const route = useRoute()
const router = useRouter()

const deckId = computed(() => decodeURIComponent(String(route.params.id || '')))
const deck = ref<DeckDetail | null>(null)
const content = ref('')
const rev = ref('')
const loading = ref(true)
const loadError = ref('')
const saving = ref(false)
const dirty = ref(false)
const savedAt = ref<Date | null>(null)
const conflict = ref(false)
const cursorLine = ref(1)
const page = ref(1)
const pageCount = ref(1)
const preview = ref<RenderResult | null>(null)
const previewError = ref('')
const exportOpen = ref(false)
const galleryOpen = ref(false)
const themeEditorName = ref<string | null>(null)
const themeOverride = ref<string | null>(null)
const editorRef = ref<EditorApi | null>(null)
const editorPane = ref<HTMLElement>()
const warnedFallback = ref('')
const deckAssets = ref<{ path: string; url: string }[]>([])
const resolvedHtml = ref('')
const resolvedMarkdown = ref('')
let assetResolveToken = 0

// M2 左侧栏 / 右侧属性栏（localStorage 记忆折叠状态）
const leftOpen = ref(localStorage.getItem('mwb.edit.leftOpen') !== '0')
const rightOpen = ref(localStorage.getItem('mwb.edit.rightOpen') !== '0')
// M2 对话框
const imageDialogOpen = ref(false)
const imageMode = ref<'image' | 'background'>('image')
const tableDialogOpen = ref(false)

let renderTimer: number | undefined
let saveTimer: number | undefined
let forceTimer: number | undefined
let detachPasteDrop: (() => void) | null = null

const title = computed(() => deck.value?.name || '加载中…')
const currentTheme = computed(() => getMarkdownTheme(content.value) || 'default')
const effectiveTheme = computed(() => themeOverride.value || currentTheme.value)
const ready = computed(() => !loading.value && !loadError.value && !!deck.value)
const canExport = computed(() => !!ExportPanelAsync)
const canImageInsert = computed(() => !!ImageInsertDialogAsync)
const canTableInsert = computed(() => !!TableInsertDialogAsync)

// ---------------- 渲染 ----------------
function scheduleRender(delay = 140): void {
  window.clearTimeout(renderTimer)
  renderTimer = window.setTimeout(doRender, delay)
}

function doRender(): void {
  if (!renderer.isReady) return
  try {
    const result = renderer.render(content.value, themeOverride.value ? { theme: themeOverride.value } : {})
    preview.value = result
    void resolvePreviewAssets(result.html)
    pageCount.value = Math.max(1, result.comments.length)
    previewError.value = ''
    if (result.fallback && warnedFallback.value !== effectiveTheme.value) {
      warnedFallback.value = effectiveTheme.value
      toast(`主题「${themeDisplayName(effectiveTheme.value)}」未加载，预览已回退 default（front-matter 未改动）`, 'info', 3600)
    }
  } catch (err) {
    previewError.value = readableError(err)
  }
}

/** 把渲染结果里的 assets/x.png 预解析成 data URL（预览/缩略图共用，避免 iframe 相对路径 404） */
async function resolvePreviewAssets(html: string): Promise<void> {
  const token = ++assetResolveToken
  try {
    const next = await resolveDeckAssetsInHtml(html, deck.value?.id, deckAssets.value)
    if (token === assetResolveToken) {
      resolvedHtml.value = next
      resolvedMarkdown.value = resolveDeckAssetsInMarkdownSync(content.value, deck.value?.id)
    }
  } catch {
    if (token === assetResolveToken) resolvedHtml.value = html
  }
}

function onContentUpdate(value: string): void {
  content.value = value
  dirty.value = true
  scheduleSave()
  scheduleRender()
}

function onCursorLine(line: number): void {
  cursorLine.value = line
  page.value = slideIndexAtLine(content.value, line)
}

// ---------------- 保存 ----------------
function scheduleSave(): void {
  dirty.value = true
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => void saveNow(), 800)
}

async function saveNow(): Promise<void> {
  if (!deck.value || saving.value) return
  window.clearTimeout(saveTimer)
  saving.value = true
  try {
    const res = await API.saveDeck(deck.value.id, content.value, rev.value)
    rev.value = res.rev
    savedAt.value = new Date(res.savedAt)
    dirty.value = false
    conflict.value = false
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      conflict.value = true
      toast('保存冲突：该演示文稿已在其他地方修改', 'error', 5000)
    } else {
      toast(`保存失败：${readableError(err)}`, 'error', 5000)
    }
  } finally {
    saving.value = false
  }
}

async function overwriteSave(): Promise<void> {
  if (!deck.value || saving.value) return
  saving.value = true
  try {
    const res = await API.saveDeck(deck.value.id, content.value)
    rev.value = res.rev
    savedAt.value = new Date(res.savedAt)
    dirty.value = false
    conflict.value = false
    toast('已强制覆盖保存', 'success')
  } catch (err) {
    toast(`保存失败：${readableError(err)}`, 'error')
  } finally {
    saving.value = false
  }
}

// ---------------- 主题 ----------------
function applyTheme(name: string): void {
  if (!themeExists(name)) {
    toast(`主题「${name}」不可用`, 'error')
    return
  }
  const next = setMarkdownTheme(content.value, name)
  if (next === content.value) {
    galleryOpen.value = false
    return
  }
  themeOverride.value = null
  content.value = next
  dirty.value = true
  scheduleSave()
  scheduleRender(0)
  galleryOpen.value = false
  themeEditorName.value = null
  toast(`已应用主题：${themeDisplayName(name)}`, 'success')
}

function onThemeSelect(ev: Event): void {
  applyTheme((ev.target as HTMLSelectElement).value)
}

function previewTheme(name: string): void {
  themeOverride.value = name
  doRender()
}

function endPreviewTheme(): void {
  if (!themeOverride.value) return
  themeOverride.value = null
  doRender()
}

function onThemesChanged(): void {
  refreshThemes()
    .then(() => doRender())
    .catch((err) => toast(`刷新主题列表失败：${readableError(err)}`, 'error'))
}

async function openThemeEditor(name: string): Promise<void> {
  if (!ThemeGalleryAsync) {
    toast('主题画廊组件尚未就绪', 'info')
    return
  }
  themeEditorName.value = name
  galleryOpen.value = true
}

function closeGallery(): void {
  galleryOpen.value = false
  themeEditorName.value = null
}

/** ThemeGallery 缩略图渲染：按主题渲染当前 deck，返回 {html, css} */
function renderForGallery(themeName: string): { html: string; css: string } {
  const r = renderer.renderWithTheme(resolvedMarkdown.value || content.value, themeName)
  // 缩略图 iframe 是相对路径基准，命中缓存时把 assets 换成 data URL，避免 404/漏图
  return { html: resolveDeckAssetsInHtmlSync(r.html, deck.value?.id), css: r.css }
}

/** ExportPanel 用：当前内容 + 当前主题的渲染结果 */
function renderForExport(): { html: string; css: string; comments: string[] } {
  const r = renderer.render(content.value)
  return { html: r.html, css: r.css, comments: r.comments }
}

function openExport(): void {
  if (!canExport.value) {
    toast('导出面板组件尚未就绪（export-eng 开发中），稍后自动可用', 'info')
    return
  }
  exportOpen.value = true
}

// ---------------- 属性面板 / 工具栏 / 大纲（M2） ----------------
function onInspectorUpdate(md: string): void {
  if (md === content.value) return
  content.value = md
  dirty.value = true
  scheduleSave()
  // 属性面板改动后立即重渲染（不需要等编辑器光标）
  scheduleRender(60)
}

function onToolbarFormat(cmd: FormatCommand): void {
  editorRef.value?.format(cmd)
}

function onJump(nextPage: number, line?: number): void {
  const p = Math.min(Math.max(1, nextPage), pageCount.value)
  page.value = p
  const targetLine = line ?? pageStartLine(content.value, p)
  editorRef.value?.setCursor(targetLine)
  editorRef.value?.scrollToLine(targetLine)
}

function toggleLeft(): void {
  leftOpen.value = !leftOpen.value
  localStorage.setItem('mwb.edit.leftOpen', leftOpen.value ? '1' : '0')
}

function toggleRight(): void {
  rightOpen.value = !rightOpen.value
  localStorage.setItem('mwb.edit.rightOpen', rightOpen.value ? '1' : '0')
}

// ---------------- 图片 / 表格插入（M2） ----------------
function openImageDialog(mode: 'image' | 'background' = 'image'): void {
  if (!canImageInsert.value) {
    toast('图片插入器尚未就绪（export-eng 开发中）', 'info')
    return
  }
  imageMode.value = mode
  imageDialogOpen.value = true
}

function onImageInsert(result: { snippet: string; mode: 'image' | 'background' }): void {
  if (!result?.snippet) return
  if (result.mode === 'background') {
    content.value = insertAtPageStart(content.value, page.value, result.snippet)
    dirty.value = true
    scheduleSave()
    scheduleRender(0)
  } else {
    editorRef.value?.insertText(result.snippet, { block: true })
  }
  imageDialogOpen.value = false
  toast(result.mode === 'background' ? '已插入背景图' : '已插入图片', 'success')
}

function onTableInsert(snippet: string): void {
  if (!snippet) return
  tableDialogOpen.value = false
  editorRef.value?.insertText(snippet, { block: true })
  toast('已插入表格', 'success')
}

// 粘贴 / 拖拽图片快捷路径（export-eng 的 pasteDrop.ts，文件未就绪时安全跳过）
async function attachPasteDrop(): Promise<void> {
  if (!loadPasteDrop || !editorPane.value) return
  try {
    const mod = await loadPasteDrop()
    if (!mod.attachImagePasteDrop) return
    detachPasteDrop = mod.attachImagePasteDrop(editorPane.value, {
      onFiles: async (files: File[]) => {
        const images = files.filter((f) => /^image\//.test(f.type))
        if (!images.length || !deck.value) return
        for (const file of images) {
          try {
            const asset = await API.uploadAsset(deck.value.id, file)
            deckAssets.value = [...deckAssets.value.filter((a) => a.path !== asset.path), { path: asset.path, url: asset.url }]
            // marp-core 4.4 不支持 ![w:60%]（百分比不生效），用 export-eng 的 pasteImageSnippet 换算成 px
            const snippet = mod.pasteImageSnippet?.(asset.path) ?? `![w:768px](${asset.path})`
            editorRef.value?.insertText(snippet, { block: true })
            toast(`图片已上传：${asset.path}`, 'success')
          } catch (err) {
            toast(`图片上传失败：${readableError(err)}`, 'error', 5000)
          }
        }
      },
    })
  } catch (err) {
    console.warn('[pasteDrop] 加载失败', err)
  }
}

// ---------------- deck 生命周期 ----------------
async function loadDeck(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const d = await API.getDeck(deckId.value)
    deck.value = d
    content.value = d.content
    rev.value = d.rev
    deckAssets.value = d.assets || []
    savedAt.value = d.updatedAt ? new Date(d.updatedAt) : null
    localStorage.setItem('mwb.lastDeckId', d.id)
    dirty.value = false
    conflict.value = false
    scheduleRender(0)
  } catch (err) {
    loadError.value = readableError(err)
  } finally {
    loading.value = false
  }
}

async function renameDeck(): Promise<void> {
  if (!deck.value) return
  const name = window.prompt('重命名演示文稿：', deck.value.name)
  if (!name || !name.trim() || name.trim() === deck.value.name) return
  try {
    const res = await API.renameDeck(deck.value.id, name.trim())
    deck.value = { ...deck.value, id: res.id, name: res.name }
    localStorage.setItem('mwb.lastDeckId', res.id)
    if (res.id !== deckId.value) await router.replace(`/edit/${encodeURIComponent(res.id)}`)
    toast('已重命名', 'success')
  } catch (err) {
    toast(readableError(err), 'error')
  }
}

// ---------------- 快捷键 / 离开提示 ----------------
function onKeydown(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey
  if (!mod) return
  const key = e.key.toLowerCase()
  if (key === 's') {
    e.preventDefault()
    e.stopPropagation()
    void saveNow()
  } else if (key === 'p') {
    e.preventDefault()
    e.stopPropagation()
    openExport()
  } else if (key === 'b') {
    // Ctrl+B 加粗（CodeMirror 默认不处理，交给工具栏逻辑）
    const target = e.target as HTMLElement | null
    if (target?.closest('.cm-editor')) {
      e.preventDefault()
      editorRef.value?.format('bold')
    }
  }
}

function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (!dirty.value) return
  e.preventDefault()
  e.returnValue = ''
}

onMounted(async () => {
  await ensureBootstrap()
  if (!app.ready) {
    loadError.value = app.bootError || '本地服务未就绪'
    loading.value = false
    return
  }
  if (!app.themesLoaded) await refreshThemes()
  await loadDeck()
  document.addEventListener('keydown', onKeydown, true)
  window.addEventListener('beforeunload', onBeforeUnload)
  forceTimer = window.setInterval(() => {
    if (dirty.value && !saving.value) void saveNow()
  }, 30000)
  await attachPasteDrop()
})

onBeforeUnmount(() => {
  window.clearTimeout(renderTimer)
  window.clearTimeout(saveTimer)
  window.clearInterval(forceTimer)
  document.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('beforeunload', onBeforeUnload)
  detachPasteDrop?.()
  detachPasteDrop = null
})

watch(deckId, () => {
  if (deck.value && deckId.value !== deck.value.id) void loadDeck()
})
</script>

<template>
  <div class="page editor-page">
    <header class="topbar editor-topbar">
      <div class="topbar-left">
        <router-link class="btn btn-ghost btn-sm" to="/" title="返回工作区">← 工作区</router-link>
        <button class="doc-title" :title="`重命名：${title}`" @click="renameDeck">{{ title }}</button>
        <span v-if="app.mock" class="badge badge-mock">MOCK</span>
        <span v-if="saving" class="status status-saving">保存中…</span>
        <span v-else-if="dirty" class="status status-dirty">未保存</span>
        <span v-else-if="savedAt" class="status status-saved">已保存 {{ formatTime(savedAt) }}</span>
      </div>

      <div class="topbar-right">
        <button class="btn btn-ghost btn-sm" :class="{ active: leftOpen }" title="显示/隐藏大纲栏" @click="toggleLeft">
          ◧ 大纲
        </button>
        <button class="btn btn-ghost btn-sm" :class="{ active: rightOpen }" title="显示/隐藏属性面板" @click="toggleRight">
          属性 ◨
        </button>
        <label class="theme-select-wrap" title="切换主题（改 front-matter theme 并重新渲染）">
          <span class="theme-select-label">主题</span>
          <select class="theme-select" :value="currentTheme" @change="onThemeSelect">
            <option v-for="t in app.themes" :key="t.name" :value="t.name">{{ t.displayName }}</option>
            <option v-if="!app.themes.some((t) => t.name === currentTheme)" :value="currentTheme">
              {{ currentTheme }}（未加载）
            </option>
          </select>
        </label>
        <button v-if="ThemeGalleryAsync" class="btn btn-ghost btn-sm" @click="galleryOpen = true">主题画廊</button>
        <button class="btn btn-secondary btn-sm" :disabled="!ready" @click="void saveNow()">保存</button>
        <button
          class="btn btn-primary btn-sm"
          :disabled="!ready"
          :title="canExport ? '导出（Ctrl+P）' : '导出面板组件尚未就绪'"
          @click="openExport"
        >
          导出
        </button>
        <router-link class="btn btn-ghost btn-sm" to="/settings" title="设置">⚙</router-link>
      </div>
    </header>

    <!-- 格式工具栏（M2） -->
    <EditorToolbar
      v-if="ready"
      :disabled="!ready"
      @format="onToolbarFormat"
      @open-image="openImageDialog('image')"
      @open-table="tableDialogOpen = true"
      @undo="editorRef?.undo()"
      @redo="editorRef?.redo()"
    />

    <div v-if="conflict" class="conflict-banner">
      <span>⚠️ 该演示文稿已在其他地方被修改，当前编辑内容尚未保存。</span>
      <button class="btn btn-sm btn-secondary" @click="loadDeck">重新加载（丢弃我的修改）</button>
      <button class="btn btn-sm btn-primary" @click="overwriteSave">强制覆盖保存</button>
    </div>

    <div v-if="loading" class="center-panel editor-loading">
      <div class="spinner" />
      <p>正在打开演示文稿…</p>
    </div>

    <div v-else-if="loadError" class="center-panel error-panel">
      <h2>无法打开</h2>
      <p class="error-text">{{ loadError }}</p>
      <router-link class="btn btn-secondary" to="/">返回工作区</router-link>
    </div>

    <main v-else class="editor-body" :class="{ 'left-closed': !leftOpen, 'right-closed': !rightOpen }">
      <!-- 左栏：大纲 / 幻灯片缩略图（outline-eng） -->
      <aside v-show="leftOpen" class="side-panel side-left">
        <div class="side-head">
          <span>大纲 / 幻灯片</span>
          <button class="btn btn-ghost btn-sm" title="折叠左栏" @click="toggleLeft">«</button>
        </div>
        <div class="side-body">
          <SlideNavigatorAsync
            v-if="SlideNavigatorAsync && preview"
            :markdown="content"
            :html="resolvedHtml || preview.html"
            :css="preview.css"
            :page-count="pageCount"
            :current-page="page"
            :width="preview.width"
            :height="preview.height"
            @jump="onJump"
          />
          <div v-else class="side-placeholder">
            <p>大纲/缩略图组件加载中…</p>
            <p class="muted small">（outline-eng 提供；文件就绪后自动出现，可先折叠左栏）</p>
          </div>
        </div>
      </aside>

      <!-- 中间：编辑器 + 预览 -->
      <section class="editor-center">
        <div class="editor-split">
          <section ref="editorPane" class="editor-pane">
            <div class="pane-head">
              <span>Markdown</span>
              <span class="muted small">{{ content.length }} 字符 · {{ pageCount }} 页</span>
            </div>
            <CodeMirrorEditor
              ref="editorRef"
              :model-value="content"
              @update:model-value="onContentUpdate"
              @cursor-line="onCursorLine"
            />
          </section>

          <section class="preview-pane-host">
            <PreviewPane
              v-if="preview"
              :html="resolvedHtml || preview.html"
              :css="preview.css"
              :page="page"
              :width="preview.width"
              :height="preview.height"
              :deck-id="deck?.id"
              :assets="deckAssets"
              @page-count="(n) => (pageCount = n)"
            />
            <div v-else-if="previewError" class="preview-error">
              <h3>预览渲染失败</h3>
              <p class="error-text">{{ previewError }}</p>
            </div>
            <div v-else class="center-panel">
              <div class="spinner" />
              <p>正在渲染预览…</p>
            </div>
          </section>
        </div>
      </section>

      <!-- 右栏：属性面板（frontend-core） -->
      <aside v-show="rightOpen" class="side-panel side-right">
        <PropertyInspector
          :markdown="content"
          :current-page="page"
          :page-count="pageCount"
          :themes="app.themes"
          :current-theme="currentTheme"
          @update="onInspectorUpdate"
          @open-gallery="galleryOpen = true"
          @open-theme-editor="openThemeEditor"
          @pick-background="openImageDialog('background')"
        />
      </aside>
    </main>

    <footer v-if="ready" class="statusbar">
      <span>第 {{ page }} / {{ pageCount }} 页</span>
      <span>rev {{ rev ? rev.slice(0, 8) : '—' }}</span>
      <span class="muted">Ctrl+S 保存 · Ctrl+P 导出 · Ctrl+B 加粗</span>
      <span v-if="themeOverride" class="statusbar-preview">
        试穿主题：{{ themeDisplayName(themeOverride) }}
        <button class="btn btn-ghost btn-sm" @click="endPreviewTheme">结束试穿</button>
      </span>
      <span class="statusbar-right">{{ app.health?.app || '' }} v{{ app.health?.version || '' }}</span>
    </footer>

    <!-- 导出面板（export-eng） -->
    <div v-if="exportOpen" class="modal-mask" @click.self="exportOpen = false">
      <div class="modal-panel export-panel-host">
        <div class="modal-head">
          <h2>导出</h2>
          <button class="btn btn-ghost btn-sm" @click="exportOpen = false">关闭</button>
        </div>
        <ExportPanelAsync
          v-if="ExportPanelAsync"
          :deck-id="deck?.id || deckId"
          :title="title"
          :markdown="content"
          :render="renderForExport"
          @close="exportOpen = false"
          @done="(fileName: string) => toast(`导出完成：${fileName}`, 'success')"
        />
        <p v-else class="muted">导出面板组件尚未就绪。</p>
      </div>
    </div>

    <!-- 主题画廊（themes） -->
    <div v-if="galleryOpen && ThemeGalleryAsync" class="modal-mask" @click.self="closeGallery">
      <div class="modal-panel gallery-panel">
        <div class="modal-head">
          <h2>主题画廊</h2>
          <button class="btn btn-ghost btn-sm" @click="closeGallery">关闭</button>
        </div>
        <ThemeGalleryAsync
          :themes="app.themes"
          :current="currentTheme"
          :markdown="resolvedMarkdown || content"
          :render="renderForGallery"
          :initial-edit-theme="themeEditorName || undefined"
          @select="applyTheme"
          @preview="previewTheme"
          @preview-end="endPreviewTheme"
          @changed="onThemesChanged"
        />
      </div>
    </div>

    <!-- 图片插入器（export-eng，自包含 modal） -->
    <ImageInsertDialogAsync
      v-if="imageDialogOpen && ImageInsertDialogAsync"
      :deck-id="deck?.id || deckId"
      :markdown="content"
      :current-page="page"
      :initial-mode="imageMode"
      @insert="onImageInsert"
      @close="imageDialogOpen = false"
    />

    <!-- 表格插入器（export-eng，自包含 modal） -->
    <TableInsertDialogAsync
      v-if="tableDialogOpen && TableInsertDialogAsync"
      :markdown="content"
      :current-page="page"
      @insert="onTableInsert"
      @close="tableDialogOpen = false"
    />
  </div>
</template>
