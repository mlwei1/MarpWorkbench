<script setup lang="ts">
/**
 * 图片插入对话框（M2，owner: export-eng；契约 docs/UI_CONTRACT_M2.md §2.3）
 *
 * props: { deckId, markdown, currentPage, initialMode? }
 * emits: insert({snippet, mode:'image'|'background'}) / close
 *
 * 能力：
 * - 选择文件 / 拖拽 / Ctrl+V 粘贴 → POST /api/decks/:id/assets（field: file）→ 相对路径 assets/x.png
 * - 普通图片：宽度 原图/25/50/75/100%（marp-core 不支持百分比 → 换算成 px，仍是标准 Marp 语法）
 * - 背景图：整页 / 左 / 右（占比 20–70%）+ 适配 cover/contain/fit + 透明度/模糊/灰度
 * - 对话框内实时预览「插入到当前页后」的效果：渲染候选 md → 隐藏其他页 → 图片资产内联成 dataURL → 独立 iframe
 *   （样式完全隔离，不污染主界面）
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { renderer } from '../marp/renderer'
import {
  buildImageSnippet,
  composePreviewMarkdown,
  countPages,
  pageAtLine,
  replaceImageAt,
  type BgFit,
  type BgLayout,
  type ImageMode,
  type ParsedImage,
} from './compose'
import {
  ASSET_ACCEPT,
  fetchAssetDataUrl,
  inlineDeckAssetUrls,
  isSupportedImage,
  uploadAsset,
  type UploadedAsset,
} from './upload'
import { localizeRemoteImages, proxyImageUrl, proxyRemoteImagesInHtml } from './remoteImages'

const props = withDefaults(
  defineProps<{
    deckId: string
    markdown: string
    currentPage: number
    initialMode?: ImageMode
    /** M3 编辑模式：传入 parseImageAtLine 的结果即可原位编辑 */
    initialImage?: ParsedImage | null
  }>(),
  { initialMode: 'image', initialImage: null }
)

const emit = defineEmits<{
  insert: [
    result: {
      snippet: string
      mode: ImageMode
      /** 编辑模式：原位替换信息（父组件用 replaceImageAt 替换） */
      edit?: { line: number; start: number; end: number }
    },
  ]
  close: []
}>()

// ---------------- 状态 ----------------
/** 编辑模式（由父组件传入 initialImage 决定） */
const editing = computed(() => !!props.initialImage && !!props.initialImage.raw)
const initialImage = computed(() => props.initialImage || null)

const mode = ref<ImageMode>(
  props.initialImage?.kind ?? (props.initialMode === 'background' ? 'background' : 'image')
)
const assetPath = ref<string | null>(props.initialImage?.path || null)
const fileName = ref('')
const previewThumb = ref('')
const pathInput = ref('')
const uploadError = ref('')
const warnText = ref('')
const uploading = ref(false)
const localizing = ref(false)

const widthMode = ref<string>('50') // '' = 原图；25/50/75/100
const bgLayout = ref<BgLayout>('full')
const bgRatio = ref(40)
const fit = ref<BgFit>('cover')
const transparency = ref(0) // 0 = 不透明（不写 opacity）
const blur = ref(0)
const grayscale = ref(false)
/** 原图里 UI 不认识的修饰符（vertical/brightness 等），编辑保存时透传 */
const extraModifiers = ref<string[]>([])

const dragActive = ref(false)
const fileInput = ref<HTMLInputElement>()
const previewFrame = ref<HTMLIFrameElement>()
const previewBox = ref<HTMLElement>()
const previewSrcdoc = ref('')
const previewScale = ref(0.4)
const previewError = ref('')
const rendererReady = ref(false)
const slideWidth = ref(1280)
const pageCount = ref(1)
const cache = new Map<string, UploadedAsset>()

let previewSeq = 0
let previewTimer: ReturnType<typeof setTimeout> | null = null
let resizeObserver: ResizeObserver | null = null

// ---------------- 派生 ----------------
const currentPageSafe = computed(() => Math.min(Math.max(props.currentPage || 1, 1), Math.max(pageCount.value, 1)))

/** 编辑模式下该图片所在页（预览用） */
const editPage = computed(() => {
  if (!initialImage.value) return 1
  try {
    return pageAtLine(props.markdown || '', initialImage.value.line)
  } catch {
    return currentPageSafe.value
  }
})

const dialogTitle = computed(() => (editing.value ? '编辑图片' : '插入图片'))
const primaryLabel = computed(() => (editing.value ? '保存修改' : '插入图片'))

/** 把 ParsedImage 的修饰符预填到各控件（M3 编辑模式） */
function applyParsedImage(image: ParsedImage | null): void {
  if (!image) return
  mode.value = image.kind
  assetPath.value = image.path
  fileName.value = image.path.split('/').pop() || image.path
  bgLayout.value = image.kind === 'background' ? image.bgLayout : 'full'
  bgRatio.value = Math.min(70, Math.max(20, Math.round(image.bgRatio || 40)))
  fit.value = image.fit || 'cover'
  transparency.value =
    image.opacity != null ? Math.min(100, Math.max(0, Math.round((1 - image.opacity) * 100))) : 0
  blur.value = Math.min(10, Math.max(0, Math.round(image.blur || 0)))
  grayscale.value = !!image.grayscale
  extraModifiers.value = [...(image.extraModifiers || [])]
  widthMode.value = percentToWidthMode(image)
}

/** px / 百分比宽度 → 下拉选项（25/50/75/100），差距过大时回退「原图」 */
function percentToWidthMode(image: ParsedImage): string {
  let percent = image.widthPercent
  if (percent == null && image.widthPx != null && image.widthPx > 0) {
    const base = slideWidth.value > 0 ? slideWidth.value : 1280
    percent = (image.widthPx / base) * 100
  }
  if (percent == null) return ''
  const options = [25, 50, 75, 100]
  let best = options[0]
  for (const opt of options) if (Math.abs(opt - percent) < Math.abs(best - percent)) best = opt
  return Math.abs(best - percent) <= 12 ? String(best) : ''
}

applyParsedImage(props.initialImage || null)

const snippet = computed<string>(() => {
  if (!assetPath.value) return ''
  const percent = mode.value === 'image' && widthMode.value !== '' ? Number(widthMode.value) : null
  return buildImageSnippet({
    path: assetPath.value,
    mode: mode.value,
    widthPercent: percent,
    slideWidth: slideWidth.value,
    bgLayout: bgLayout.value,
    bgRatio: bgRatio.value,
    fit: fit.value,
    transparency: transparency.value,
    blur: blur.value,
    grayscale: grayscale.value,
    alt: editing.value ? initialImage.value?.alt : undefined,
    extraModifiers: extraModifiers.value,
  })
})

const canInsert = computed(() => !!snippet.value && !uploading.value && !localizing.value)

const insertHint = computed(() => {
  if (editing.value && initialImage.value) {
    return `将原位替换第 ${initialImage.value.line} 行的图片（不新增行）`
  }
  return mode.value === 'background'
    ? `将插入到第 ${currentPageSafe.value} 页页首（页面级背景）`
    : '将插入到编辑器光标位置'
})

const previewStyle = computed(() => ({
  width: '1280px',
  height: '720px',
  transform: `scale(${previewScale.value})`,
  transformOrigin: 'top left',
}))

const previewWrapStyle = computed(() => ({
  height: `${Math.round(720 * previewScale.value)}px`,
}))

// ---------------- 上传 ----------------
function pickFile(): void {
  if (uploading.value) return
  fileInput.value?.click()
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) await handleFile(file)
}

function cacheKey(file: File): string {
  return `${file.name}::${file.size}::${file.lastModified}`
}

async function handleFile(file: File): Promise<void> {
  uploadError.value = ''
  warnText.value = ''
  if (!isSupportedImage(file)) {
    uploadError.value = '只支持 PNG / JPG / GIF / WebP / SVG 图片'
    return
  }
  const key = cacheKey(file)
  const cached = cache.get(key)
  if (cached) {
    assetPath.value = cached.path
    fileName.value = file.name
    previewThumb.value = await readAsDataUrl(file)
    return
  }
  uploading.value = true
  try {
    const asset = await uploadAsset(props.deckId, file)
    cache.set(key, asset)
    assetPath.value = asset.path
    fileName.value = file.name
    previewThumb.value = await readAsDataUrl(file)
  } catch (err: any) {
    uploadError.value = String(err?.message || err)
  } finally {
    uploading.value = false
  }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => resolve('')
    reader.readAsDataURL(file)
  })
}

async function usePathInput(): Promise<void> {
  const value = pathInput.value.trim()
  uploadError.value = ''
  warnText.value = ''
  if (!value) {
    uploadError.value = '请输入图片路径'
    return
  }
  if (/^https?:\/\//i.test(value)) {
    // 网络图片：先尝试下载到本地 assets/（服务端 localize-images），失败回退原 URL
    localizing.value = true
    try {
      const result = await localizeRemoteImages(props.deckId, `![mwb](${value})`)
      const mapped = result.mapping?.[value]
      if (mapped) {
        assetPath.value = mapped
        fileName.value = mapped.split('/').pop() || mapped
        previewThumb.value = (await fetchAssetDataUrl(props.deckId, mapped)) || ''
        warnText.value = '已下载到本地 assets/（离线可用）'
        return
      }
      const reason = result.failed?.[0]?.reason || '下载失败'
      warnText.value = `未能下载到本地（${reason}）；将插入原 URL，预览/导出时联网显示`
    } catch (err: any) {
      warnText.value = `未能下载到本地（${String(err?.message || err)}）；将插入原 URL，预览/导出时联网显示`
    } finally {
      localizing.value = false
    }
    assetPath.value = value
    fileName.value = value.split('/').pop() || value
    previewThumb.value = proxyImageUrl(value)
    return
  }
  if (!/^assets\//.test(value) && !/^(data:|blob:)/i.test(value)) {
    warnText.value = '建议使用 assets/ 下的相对路径（随 deck 一起保存）'
  }
  assetPath.value = value
  fileName.value = value.split('/').pop() || value
  previewThumb.value = (await fetchAssetDataUrl(props.deckId, value)) || ''
}

// ---------------- 预览 ----------------
function schedulePreview(delay = 140): void {
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = setTimeout(() => {
    previewTimer = null
    void buildPreview()
  }, delay)
}

function buildDoc(html: string, css: string, page: number): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;width:1280px;height:720px;overflow:hidden;background:#fff}
${css}
div.marpit>svg{position:absolute!important;left:0;top:0;width:1280px!important;height:720px!important;margin:0!important;display:none!important}
div.marpit>svg:nth-child(${page}){display:block!important}
</style></head><body>${html}</body></html>`
}

async function buildPreview(): Promise<void> {
  if (!rendererReady.value) return
  const seq = ++previewSeq
  previewError.value = ''
  try {
    const base = props.markdown || '# 预览\n\n（当前 deck 为空）'
    let candidate = base
    let page = currentPageSafe.value
    if (editing.value && initialImage.value) {
      // 编辑模式：在原位置替换后预览（不新增行）
      candidate = replaceImageAt(base, initialImage.value, snippet.value || initialImage.value.raw)
      page = editPage.value
    } else if (snippet.value) {
      const composed = composePreviewMarkdown(props.markdown || '', snippet.value, mode.value, currentPageSafe.value)
      candidate = composed.markdown
      page = composed.page
    }
    const rendered = renderer.render(candidate)
    // 网络图片：预览时经同源代理显示（iframe 内不能带 header，代理允许 query token）
    let html = proxyRemoteImagesInHtml(rendered.html)
    const inline = await inlineDeckAssetUrls(html, props.deckId)
    if (seq !== previewSeq) return
    if (inline.failed.length) {
      previewError.value = `有 ${inline.failed.length} 张图片未能加载（请确认 deck 中已上传对应资产）`
    }
    html = inline.content
    const doc = buildDoc(html, rendered.css, page)
    if (doc !== previewSrcdoc.value) previewSrcdoc.value = doc
  } catch (err: any) {
    if (seq === previewSeq) previewError.value = String(err?.message || err)
  }
}

function onPreviewLoad(): void {
  const doc = previewFrame.value?.contentDocument
  if (!doc?.body) return
  try {
    renderer.applyBrowserHelper(doc.body)
  } catch {
    /* ignore */
  }
}

function updateScale(): void {
  const width = previewBox.value?.clientWidth || 0
  if (width > 40) previewScale.value = Math.min(1, (width - 2) / 1280)
}

// ---------------- 交互 ----------------
const dragDepth = ref(0)

function onDragEnter(event: DragEvent): void {
  if (!hasImageItems(event)) return
  dragDepth.value++
  dragActive.value = true
}
function onDragOver(event: DragEvent): void {
  if (!hasImageItems(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  dragActive.value = true
}
function onDragLeave(event: DragEvent): void {
  if (!hasImageItems(event)) return
  dragDepth.value = Math.max(0, dragDepth.value - 1)
  if (dragDepth.value === 0) dragActive.value = false
}
function hasImageItems(event: DragEvent): boolean {
  const dt = event.dataTransfer
  if (!dt) return false
  const items = Array.from(dt.items || [])
  if (items.length) {
    return items.some((it) => it.kind === 'file' && (!it.type || it.type.startsWith('image/')))
  }
  return Array.from(dt.types || []).includes('Files')
}
async function onDrop(event: DragEvent): Promise<void> {
  const files = Array.from(event.dataTransfer?.files || []).filter(isSupportedImage)
  dragDepth.value = 0
  dragActive.value = false
  if (!files.length) return
  event.preventDefault()
  await handleFile(files[0])
}

function onPaste(event: ClipboardEvent): void {
  const files: File[] = []
  const data = event.clipboardData
  if (!data) return
  for (const item of Array.from(data.items || [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file && isSupportedImage(file)) files.push(file)
  }
  if (!files.length) files.push(...Array.from(data.files || []).filter(isSupportedImage))
  if (!files.length) return
  event.preventDefault()
  void handleFile(files[0])
}

function doInsert(): void {
  if (!canInsert.value) return
  const edit =
    editing.value && initialImage.value
      ? { line: initialImage.value.line, start: initialImage.value.start, end: initialImage.value.end }
      : undefined
  emit('insert', { snippet: snippet.value, mode: mode.value, ...(edit ? { edit } : {}) })
  emit('close')
}

function requestClose(): void {
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    requestClose()
  }
}

watch([snippet, mode, () => props.markdown], () => schedulePreview(), { flush: 'post' })
watch(currentPageSafe, () => schedulePreview(0))

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('paste', onPaste)
  resizeObserver = new ResizeObserver(() => updateScale())
  if (previewBox.value) resizeObserver.observe(previewBox.value)
  try {
    await renderer.init()
    rendererReady.value = true
    const base = props.markdown || ''
    const rendered = renderer.render(base || '# 空')
    slideWidth.value = rendered.width || 1280
    pageCount.value = countPages(base || '')
    // 编辑模式：按真实页宽重新换算宽度选项 + 加载当前图片缩略图
    if (initialImage.value) {
      applyParsedImage(initialImage.value)
      const path = initialImage.value.path
      if (/^https?:\/\//i.test(path)) {
        previewThumb.value = proxyImageUrl(path)
      } else {
        previewThumb.value = (await fetchAssetDataUrl(props.deckId, path)) || ''
      }
    }
    updateScale()
    schedulePreview(0)
  } catch (err: any) {
    previewError.value = `渲染器初始化失败：${err?.message || err}`
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('paste', onPaste)
  if (previewTimer) clearTimeout(previewTimer)
  resizeObserver?.disconnect()
  resizeObserver = null
})
</script>

<template>
  <div class="modal-mask" @click.self="requestClose">
    <div class="modal-panel insert-panel">
      <div class="modal-head">
        <h2>{{ dialogTitle }}</h2>
        <div class="head-actions">
          <span v-if="editing && initialImage" class="muted small">第 {{ initialImage.line }} 行</span>
          <span class="muted small">第 {{ currentPageSafe }} / {{ pageCount }} 页</span>
          <button class="btn btn-ghost btn-sm" type="button" @click="requestClose">关闭</button>
        </div>
      </div>

      <div class="insert-body">
        <!-- 左：来源 + 选项 -->
        <section class="insert-col options">
          <div class="block">
            <div class="block-title">1. 选择图片</div>
            <div
              class="dropzone"
              :class="{ active: dragActive, busy: uploading }"
              role="button"
              tabindex="0"
              @click="pickFile"
              @keydown.enter.prevent="pickFile"
              @dragenter.prevent="onDragEnter"
              @dragover="onDragOver"
              @dragleave="onDragLeave"
              @drop.prevent="onDrop"
            >
              <template v-if="uploading || localizing">
                <div class="spinner" />
                <span>{{ localizing ? '正在下载到本地…' : '上传中…' }}</span>
              </template>
              <template v-else-if="previewThumb || assetPath">
                <img v-if="previewThumb" class="thumb" :src="previewThumb" alt="已选图片预览" />
                <div class="thumb-meta">
                  <strong>{{ fileName || assetPath }}</strong>
                  <code class="small">{{ assetPath }}</code>
                  <span class="muted small">{{ editing ? '当前图片 · 点击可更换' : '点击可重新选择' }}</span>
                </div>
              </template>
              <template v-else>
                <div class="drop-icon">🖼️</div>
                <div>点击选择图片，或拖拽 / Ctrl+V 粘贴</div>
                <div class="muted small">PNG / JPG / GIF / WebP / SVG · ≤20MB · 保存到 deck 的 assets/</div>
              </template>
            </div>
            <input ref="fileInput" type="file" :accept="ASSET_ACCEPT" hidden @change="onFileChange" />

            <div class="path-row">
              <input
                v-model="pathInput"
                class="text-input"
                type="text"
                placeholder="或输入相对路径 assets/photo.png / 在线 URL"
                @keydown.enter.prevent="usePathInput"
              />
              <button class="btn btn-ghost btn-sm" type="button" @click="usePathInput">使用</button>
            </div>
            <p v-if="uploadError" class="error-text small">{{ uploadError }}</p>
            <p v-if="warnText" class="warn-text small">{{ warnText }}</p>
            <p v-if="editing" class="muted small">
              保存后原位替换第 {{ initialImage?.line }} 行的图片，不会新增行。
            </p>
          </div>

          <div class="block">
            <div class="block-title">2. 用法</div>
            <div class="seg">
              <button
                class="seg-btn"
                :class="{ active: mode === 'image' }"
                type="button"
                @click="mode = 'image'"
              >
                普通图片
              </button>
              <button
                class="seg-btn"
                :class="{ active: mode === 'background' }"
                type="button"
                @click="mode = 'background'"
              >
                背景图
              </button>
            </div>

            <template v-if="mode === 'image'">
              <label class="field">
                <span class="field-label">宽度</span>
                <select v-model="widthMode" class="select">
                  <option value="">原图</option>
                  <option value="25">25%</option>
                  <option value="50">50%</option>
                  <option value="75">75%</option>
                  <option value="100">100%</option>
                </select>
              </label>
              <p class="muted small tip">
                Marp 不支持百分比宽度，已按当前页面宽度（{{ slideWidth }}px）换算成 px，语法仍可拷回 VS Code。
              </p>
            </template>

            <template v-else>
              <label class="field">
                <span class="field-label">位置</span>
                <div class="seg small-seg">
                  <button
                    class="seg-btn"
                    :class="{ active: bgLayout === 'full' }"
                    type="button"
                    @click="bgLayout = 'full'"
                  >
                    整页
                  </button>
                  <button
                    class="seg-btn"
                    :class="{ active: bgLayout === 'left' }"
                    type="button"
                    @click="bgLayout = 'left'"
                  >
                    左侧
                  </button>
                  <button
                    class="seg-btn"
                    :class="{ active: bgLayout === 'right' }"
                    type="button"
                    @click="bgLayout = 'right'"
                  >
                    右侧
                  </button>
                </div>
              </label>
              <label v-if="bgLayout !== 'full'" class="field">
                <span class="field-label">占比 {{ bgRatio }}%</span>
                <input v-model.number="bgRatio" type="range" min="20" max="70" step="5" />
              </label>
              <label class="field">
                <span class="field-label">适配</span>
                <select v-model="fit" class="select">
                  <option value="cover">cover（覆盖，默认）</option>
                  <option value="contain">contain（完整显示）</option>
                  <option value="fit">fit（适应）</option>
                </select>
              </label>
            </template>
          </div>

          <details class="block advanced">
            <summary>高级：透明度 / 模糊 / 灰度</summary>
            <label class="field">
              <span class="field-label">透明度 {{ transparency }}%</span>
              <input v-model.number="transparency" type="range" min="0" max="100" step="5" />
            </label>
            <label class="field">
              <span class="field-label">模糊 {{ blur }}px</span>
              <input v-model.number="blur" type="range" min="0" max="10" step="1" />
            </label>
            <label class="check">
              <input v-model="grayscale" type="checkbox" />
              <span>灰度（grayscale）</span>
            </label>
          </details>
        </section>

        <!-- 右：实时预览 -->
        <section class="insert-col preview">
          <div class="block-title">
            <template v-if="editing">预览：编辑后（第 {{ editPage }} 页，原位替换）</template>
            <template v-else>预览：插入到第 {{ currentPageSafe }} 页后的效果</template>
            <span v-if="!assetPath" class="muted small">（选择图片后显示）</span>
          </div>
          <div ref="previewBox" class="preview-box" :style="previewWrapStyle">
            <iframe
              ref="previewFrame"
              class="preview-frame"
              title="插入效果预览"
              :srcdoc="previewSrcdoc"
              :style="previewStyle"
              @load="onPreviewLoad"
            />
            <div v-if="!previewSrcdoc" class="preview-empty muted">预览加载中…</div>
          </div>
          <p v-if="previewError" class="error-text small">{{ previewError }}</p>

          <div class="snippet-box">
            <div class="snippet-head">
              <span>将写入的 Markdown</span>
              <span class="muted small">{{ mode === 'background' ? '页面级背景' : '行内图片' }}</span>
            </div>
            <code class="snippet">{{ snippet || '（请先选择图片）' }}</code>
          </div>
          <p class="muted small">
            <template v-if="editing">保存后仅替换该图片语法，前后文与行尾换行保持不变。</template>
            <template v-else>预览仅显示当前页；实际插入位置：普通图片 = 光标处，背景图 = 当前页页首。</template>
          </p>
        </section>
      </div>

      <div class="insert-foot">
        <span class="muted small">{{ insertHint }}</span>
        <div class="foot-actions">
          <button class="btn btn-ghost" type="button" @click="requestClose">取消</button>
          <button class="btn btn-primary" type="button" :disabled="!canInsert" @click="doInsert">
            {{ primaryLabel }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.insert-panel {
  width: min(1060px, 96vw);
  height: min(760px, 92vh);
  font-family: 'Microsoft YaHei', 'Segoe UI', sans-serif;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.insert-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(320px, 400px) minmax(0, 1fr);
  gap: 0;
  overflow: hidden;
}
.insert-col {
  min-height: 0;
  padding: 16px 18px;
  overflow-y: auto;
}
.insert-col.options {
  border-right: 1px solid var(--mwb-border);
  background: #fbfcfe;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.insert-col.preview {
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: #f4f6fb;
}
.block-title {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 8px;
}
.dropzone {
  border: 2px dashed var(--mwb-border-strong);
  border-radius: 12px;
  background: #fff;
  padding: 14px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 132px;
  text-align: center;
  cursor: pointer;
  color: var(--mwb-text);
  transition: border-color 0.15s, background 0.15s;
}
.dropzone:hover,
.dropzone:focus-visible {
  border-color: #93c5fd;
  outline: none;
}
.dropzone.active {
  border-color: var(--mwb-primary);
  background: var(--mwb-primary-soft);
}
.dropzone.busy {
  cursor: progress;
}
.drop-icon {
  font-size: 26px;
}
.thumb {
  max-width: 100%;
  max-height: 96px;
  border-radius: 8px;
  object-fit: contain;
  background: #f1f5f9;
}
.thumb-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: center;
  max-width: 100%;
}
.thumb-meta strong {
  font-size: 12px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.path-row {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.text-input {
  flex: 1;
  min-width: 0;
  height: 30px;
  border: 1px solid var(--mwb-border-strong);
  border-radius: 8px;
  padding: 0 10px;
  font-size: 12px;
  background: #fff;
  color: var(--mwb-text);
}
.text-input:focus {
  outline: none;
  border-color: var(--mwb-primary);
}
.seg {
  display: inline-flex;
  border: 1px solid var(--mwb-border);
  border-radius: 9px;
  overflow: hidden;
  background: #fff;
}
.seg-btn {
  height: 30px;
  padding: 0 14px;
  border: 0;
  border-right: 1px solid var(--mwb-border);
  background: transparent;
  color: var(--mwb-text);
  font-size: 12px;
  cursor: pointer;
}
.seg-btn:last-child {
  border-right: 0;
}
.seg-btn.active {
  background: var(--mwb-primary-soft);
  color: var(--mwb-primary);
  font-weight: 600;
}
.small-seg .seg-btn {
  padding: 0 10px;
}
.field {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  font-size: 12px;
}
.field-label {
  width: 84px;
  flex: 0 0 auto;
  color: var(--mwb-text-weak);
}
.field input[type='range'] {
  flex: 1;
  min-width: 0;
  accent-color: var(--mwb-primary);
}
.select {
  height: 30px;
  border: 1px solid var(--mwb-border-strong);
  border-radius: 8px;
  background: #fff;
  color: var(--mwb-text);
  font-size: 12px;
  padding: 0 6px;
  flex: 1;
  min-width: 0;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 12px;
}
.advanced summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 4px;
}
.tip {
  margin: 8px 0 0;
}
.preview-box {
  position: relative;
  width: 100%;
  overflow: hidden;
  border-radius: 10px;
  border: 1px solid var(--mwb-border);
  background: #fff;
  box-shadow: 0 2px 10px rgba(15, 23, 42, 0.06);
  flex: 0 0 auto;
}
.preview-frame {
  border: 0;
  display: block;
  background: #fff;
}
.preview-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}
.snippet-box {
  border: 1px solid var(--mwb-border);
  border-radius: 10px;
  background: #fff;
  overflow: hidden;
}
.snippet-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  border-bottom: 1px solid var(--mwb-border);
  font-size: 12px;
  color: var(--mwb-text-weak);
  background: #fbfcfe;
}
.snippet {
  display: block;
  padding: 10px;
  font-size: 12px;
  color: #0f172a;
  word-break: break-all;
  white-space: pre-wrap;
}
.insert-foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 18px;
  border-top: 1px solid var(--mwb-border);
}
.foot-actions {
  display: flex;
  gap: 8px;
}
.warn-text {
  color: #b45309;
}
.spinner {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 3px solid #e0e7ff;
  border-top-color: var(--mwb-primary);
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 900px) {
  .insert-body {
    grid-template-columns: 1fr;
    overflow-y: auto;
  }
  .insert-col {
    overflow: visible;
  }
  .insert-col.options {
    border-right: 0;
    border-bottom: 1px solid var(--mwb-border);
  }
}
</style>
