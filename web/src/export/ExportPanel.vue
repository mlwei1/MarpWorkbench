<script setup lang="ts">
/**
 * 导出面板（export-eng 负责；契约 docs/API_CONTRACT.md §1.6 / §2.4）
 *
 * props 与 frontend-core 约定（2026-10-20 已互发消息确认）：
 *   { deckId: string, title: string, markdown: string,
 *     render: () => { html: string; css: string; comments: string[] },
 *     width?: number, height?: number, theme?: string }
 * emit: close（关闭面板）、done(fileName)（导出完成，供上层 toast）
 *
 * 通道：
 *   PDF  = POST /api/export/pdf（服务端 Chrome/Edge 无头打印，矢量文本）
 *   HTML = POST /api/export/html（单文件，离线双击可播）
 *   PPTX = POST /api/export/capture（CDP 原生截图 2x）→ pptxgenjs（13.333×7.5in 图片版 + notes）
 *          CDP 不可用 → 服务端返回 fallback 标记 → 本组件用 html-to-image 快速版并标注
 *
 * 截图格式自适应（Lead 2026-10-20 建议）：页数 ≤10 用 PNG（无损）；>10 用 JPEG q90
 * （实测 2x PNG 渐变主题约 2.1s/页，30 页会超 30s 预算；JPEG 约 0.42s/页且目检无可见糊化）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getToken, isMockMode } from '../api/client'
import { hasDeckAssetRefs, inlineDeckAssetUrls } from '../insert/upload'
import { hasRemoteImageRefs, inlineRemoteImageDataUrls } from '../insert/remoteImages'
import type { RenderResult } from '../types'

interface Props {
  deckId: string
  title: string
  markdown: string
  /** M3：EditView.renderForExport 返回「同步对象 + thenable」，导出前 await 拿含 mermaid 的最终 html */
  render: () => RenderResult | Promise<RenderResult>
  width?: number
  height?: number
  theme?: string
  /** M5.1 CLI：由 `?autoExport=` 传入时，页数就绪后自动触发一次导出（不依赖用户点击） */
  autoExportFormat?: Format
}
const props = withDefaults(defineProps<Props>(), { width: 1280, height: 720 })
const emit = defineEmits<{ close: []; done: [fileName: string] }>()

type Format = 'pptx' | 'pptx-editable' | 'pdf' | 'html'
type Stage = 'idle' | 'preparing' | 'capturing' | 'assembling' | 'downloading' | 'done' | 'error'

/**
 * M4：PPTX 可编辑（Beta）模块（owner: editable-ppt-eng，写 `./editable/**`）。
 * 用 import.meta.glob 懒加载：模块文件不存在时返回 {} → 隐藏该格式卡（构建不会被阻塞），
 * 模块出现后重新构建即自动启用。
 */
const editableModules = import.meta.glob('./editable/index.ts') as Record<
  string,
  () => Promise<EditableModuleAPI | { default: EditableModuleAPI }>
>
const editableLoader = Object.values(editableModules)[0] || null
const editableAvailable = !!editableLoader

interface EditableModuleAPI {
  measureDeckForEditablePptx: (
    html: string,
    css: string,
    opts: { width: number; height: number; comments?: string[]; title?: string }
  ) => Promise<{
    layouts: any[]
    backgroundHtml: string
    backgroundCss: string
    pageCount: number
    width: number
    height: number
    stats?: { textBlocks?: number; tables?: number; runs?: number }
  }>
  assembleEditablePptx: (
    deck: any,
    backgrounds: string[],
    opts: {
      title?: string
      pptxgenjs: any
      comments?: string[]
      onProgress?: (pct: number, label: string) => void
    }
  ) => Promise<{ blob: Blob; stats?: { slides?: number; textBlocks?: number; tables?: number; bytes?: number } }>
}

const format = ref<Format>('pptx')
const stage = ref<Stage>('idle')
const progress = ref(0)
const progressText = ref('')
const errorText = ref('')
const errorDetail = ref('')
const resultText = ref('')
const copyTip = ref('')
const fallbackMode = ref(false)
const browserName = ref('')

const busy = computed(() => !['idle', 'done', 'error'].includes(stage.value))
const mockMode = isMockMode()

/** 页面尺寸：优先 props，其次从 render html 的 viewBox 推断（render 可能是 thenable，同步属性可用） */
const pageSize = computed(() => {
  try {
    const res = props.render() as any
    if (typeof res?.html === 'string') {
      const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(res.html)
      if (m) return { width: Math.round(parseFloat(m[1])), height: Math.round(parseFloat(m[2])) }
    }
  } catch {
    /* ignore */
  }
  return { width: props.width, height: props.height }
})

const slideCount = computed(() => {
  try {
    const res = props.render() as any
    if (typeof res?.html !== 'string') return 0
    return (res.html.match(/data-marpit-svg/g) || []).length
  } catch {
    return 0
  }
})

const fileNamePreview = computed(() => {
  const stem = sanitizeFileName(props.title || '演示文稿')
  if (format.value === 'pptx-editable') return `${stem}-可编辑.pptx`
  const ext = format.value === 'pdf' ? 'pdf' : format.value === 'html' ? 'html' : 'pptx'
  return `${stem}.${ext}`
})

/** 按钮/结果文案用的格式名（pptx-editable 不能 toUpperCase 成 PPTX-EDITABLE） */
const formatLabel = computed(() => {
  if (format.value === 'pptx-editable') return 'PPTX 可编辑'
  return format.value.toUpperCase()
})

const captureFormat = computed<'png' | 'jpeg'>(() => (slideCount.value <= 10 ? 'png' : 'jpeg'))

// M5.1 CLI：autoExport 自动导出（只触发一次；普通手动导出不受影响）
const autoTriggered = ref(false)
let autoExportTimer: number | undefined
let stopAutoWatch: (() => void) | null = null

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  if (props.autoExportFormat) {
    format.value = props.autoExportFormat
    // slideCount 变化时尝试触发；另有 150ms 轮询兜底（防止 render 异步/首帧竞态）
    stopAutoWatch = watch(slideCount, () => maybeAutoExport(), { immediate: true })
    autoExportTimer = window.setInterval(maybeAutoExport, 150)
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.clearInterval(autoExportTimer)
  autoExportTimer = undefined
  stopAutoWatch?.()
  stopAutoWatch = null
})

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && !busy.value) emit('close')
}

function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '')
  return cleaned || '演示文稿'
}

function tokenHeader(): Record<string, string> {
  const token = getToken()
  return token ? { 'X-MWB-Token': token } : {}
}

/** 统一 fetch：JSON + token + 中文可读错误 */
async function apiJson<T>(path: string, body: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...tokenHeader() },
      body: JSON.stringify(body)
    })
  } catch {
    throw new Error('无法连接本地 MarpWorkbench 服务，请确认程序仍在运行')
  }
  let json: any = null
  try {
    json = await res.json()
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const msg = json?.error?.message || `导出失败（HTTP ${res.status}）`
    const detail = json?.error?.detail || ''
    throw new Error(detail ? `${msg}：${detail}` : msg)
  }
  return json as T
}

async function fetchBlob(path: string): Promise<Blob> {
  let res: Response
  try {
    res = await fetch(path, { headers: tokenHeader() })
  } catch {
    throw new Error('无法下载导出文件：本地服务连接中断')
  }
  if (!res.ok) {
    let msg = `下载失败（HTTP ${res.status}）`
    try {
      const body = await res.json()
      if (body?.error?.message) msg = body.error.message
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }
  return await res.blob()
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取截图数据失败'))
    reader.readAsDataURL(blob)
  })
}

/** 触发浏览器下载 */
function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

async function renderPayload() {
  // M3：render 可能是 thenable（EditView 用它返回 mermaid 渲染后的 html）
  const res = (await Promise.resolve(props.render())) as RenderResult | null
  if (!res || !res.html) throw new Error('渲染结果为空：请先输入内容再导出')
  return {
    html: res.html,
    css: res.css || '',
    title: props.title || '演示文稿',
    width: pageSize.value.width,
    height: pageSize.value.height,
    comments: res.comments || []
  }
}

/** 导出前把图片资源内联成 dataURL：
 *  ① deck 资产（assets/x.png）—— 打印页走 file://，无法带 token 取图；
 *  ② 网络图片（http(s)://）—— 经 /api/proxy/image 取回（离线/打印页不能联网）。
 *  失败不阻断导出，记录到 lastAssetWarning 在结果面板提示。 */
let lastAssetWarning = ''
async function prepareAssets<T extends { html: string }>(payload: T): Promise<T> {
  lastAssetWarning = ''
  const warnings: string[] = []
  let html = payload.html

  if (hasDeckAssetRefs(html)) {
    progressText.value = '正在准备图片资源（内联到导出页）…'
    try {
      const res = await inlineDeckAssetUrls(html, props.deckId, (done, total) => {
        progressText.value = `正在准备图片资源（${done}/${total}）…`
      })
      if (res.failed.length) {
        const names = res.failed.slice(0, 2).join('、') + (res.failed.length > 2 ? '…' : '')
        warnings.push(`有 ${res.failed.length} 张本地图片未能读取（导出中可能缺失）：${names}`)
      }
      html = res.content
    } catch (err: any) {
      warnings.push(`本地图片内联失败：${String(err?.message || err)}`)
    }
  }

  if (hasRemoteImageRefs(html)) {
    progressText.value = '正在通过本地代理内联网络图片…'
    try {
      const remote = await inlineRemoteImageDataUrls(html, (done, total) => {
        progressText.value = `正在内联网络图片（${done}/${total}）…`
      })
      html = remote.content
      if (remote.failed.length) {
        const first = remote.failed[0]
        warnings.push(
          `有 ${remote.failed.length} 张网络图片未能下载（导出中可能缺失）：${first?.reason || '网络不可达'}`
        )
      }
    } catch (err: any) {
      warnings.push(`网络图片内联失败：${String(err?.message || err)}`)
    }
  }

  if (warnings.length) lastAssetWarning = warnings.join('；')
  return { ...payload, html }
}

function resetState() {
  errorText.value = ''
  errorDetail.value = ''
  resultText.value = ''
  progress.value = 0
  progressText.value = ''
  fallbackMode.value = false
  browserName.value = ''
  lastAssetWarning = ''
}

async function startExport() {
  if (busy.value || mockMode) return
  resetState()
  stage.value = 'preparing'
  try {
    if (format.value === 'pptx-editable') await exportEditablePptx()
    else if (format.value === 'pdf') await exportPdf()
    else if (format.value === 'html') await exportHtml()
    else await exportPptx()
    stage.value = 'done'
  } catch (err: any) {
    stage.value = 'error'
    const msg = String(err?.message || err)
    const idx = msg.indexOf('：')
    if (idx > 0) {
      errorText.value = msg.slice(0, idx)
      errorDetail.value = msg.slice(idx + 1)
    } else {
      errorText.value = msg
    }
  }
}

/**
 * M5.1 CLI：页数就绪后只触发一次自动导出。
 * - 由 autoExportFormat 驱动（CLI 打开 `?autoExport=` 时 → 面板自动导出 → saveBlob 下载）
 * - 防重复/竞态：autoTriggered + watch/immediate + 150ms 轮询兜底；普通手动导出不会调用本函数
 */
function maybeAutoExport(): void {
  if (!props.autoExportFormat || autoTriggered.value || mockMode) return
  if (slideCount.value <= 0) return
  autoTriggered.value = true
  window.clearInterval(autoExportTimer)
  autoExportTimer = undefined
  format.value = props.autoExportFormat
  void startExport()
}

async function exportPdf() {
  progress.value = 15
  progressText.value = '正在生成打印页…'
  const payload = await prepareAssets(await renderPayload())
  progress.value = 35
  progressText.value = '正在调用本机 Chrome/Edge 打印（通常 2–8 秒）…'
  const r = await apiJson<{ fileUrl: string; bytes: number; pages: number; ms: number; browser: string }>(
    '/api/export/pdf',
    { ...payload, comments: undefined }
  )
  browserName.value = r.browser
  progress.value = 80
  progressText.value = '正在下载 PDF…'
  const blob = await fetchBlob(r.fileUrl)
  const fileName = fileNamePreview.value
  saveBlob(blob, fileName)
  progress.value = 100
  progressText.value = '完成'
  resultText.value = `PDF 已下载：${fileName}（${r.pages} 页 / ${fmtBytes(r.bytes)} / ${r.ms} ms，浏览器：${r.browser}）`
  if (lastAssetWarning) resultText.value += `\n注意：${lastAssetWarning}`
  emit('done', fileName)
}

async function exportHtml() {
  progress.value = 25
  progressText.value = '正在生成单文件 HTML…'
  const payload = await prepareAssets(await renderPayload())
  const r = await apiJson<{ fileUrl: string; bytes: number; ms: number }>('/api/export/html', payload)
  progress.value = 75
  progressText.value = '正在下载 HTML…'
  const blob = await fetchBlob(r.fileUrl)
  const fileName = fileNamePreview.value
  saveBlob(blob, fileName)
  progress.value = 100
  progressText.value = '完成'
  resultText.value = `HTML 已下载：${fileName}（${fmtBytes(r.bytes)} / ${r.ms} ms，双击可离线播放）`
  if (lastAssetWarning) resultText.value += `\n注意：${lastAssetWarning}`
  emit('done', fileName)
}

async function exportPptx() {
  const render = await prepareAssets(await renderPayload())
  const count = slideCount.value
  if (!count) throw new Error('没有可导出的幻灯片：请用 --- 分页')

  // 1) 服务端 CDP 截图（质量主通道）
  progress.value = 8
  progressText.value = `正在截图第 1/${count} 页…（${captureFormat.value === 'png' ? 'PNG 无损' : 'JPEG 高质量'} 2x）`
  stage.value = 'capturing'
  const capture = await apiJson<{
    images: { index: number; url: string; w: number; h: number }[]
    ms: number
    fallback: boolean
    mode: string
    reason?: string
  }>('/api/export/capture', {
    html: render.html,
    css: render.css,
    width: render.width,
    height: render.height,
    scale: 2,
    slideCount: count,
    format: captureFormat.value
  })
  progress.value = 55

  let images: { dataUrl: string }[] = []
  if (!capture.fallback && capture.images.length > 0) {
    fallbackMode.value = false
    progressText.value = `正在读取 ${capture.images.length} 张截图…`
    for (const img of capture.images) {
      const blob = await fetchBlob(img.url)
      images.push({ dataUrl: await blobToDataUrl(blob) })
    }
  } else {
    // 2) 降级：浏览器端 html-to-image（保真稍差，主题渐变/代码高亮背景可能丢失）
    fallbackMode.value = true
    progressText.value = '原生截图不可用，正在用浏览器快速截图降级…（主题保真度会略降）'
    images = await captureWithHtmlToImage(render, count)
  }

  // 3) pptxgenjs 组装：13.333×7.5in 图片版，每页背景图 + 备注
  stage.value = 'assembling'
  progress.value = 72
  progressText.value = '正在组装 PPTX（每页位图 + 演讲者备注）…'
  const pptx = await assemblePptx(images, render.comments || [])
  progress.value = 92
  progressText.value = '正在下载 PPTX…'
  stage.value = 'downloading'
  const fileName = fileNamePreview.value
  await pptx.writeFile({ fileName })
  progress.value = 100
  progressText.value = '完成'
  const modeText = fallbackMode.value ? '降级截图版（快速版）' : 'CDP 原生长截图版'
  resultText.value = `PPTX 已下载：${fileName}（${images.length} 页 / 16:9 / 图片版，${modeText}；不可逐字编辑，但版式与预览一致）`
  if (fallbackMode.value && capture.reason) resultText.value += `\n降级原因：${capture.reason}`
  if (lastAssetWarning) resultText.value += `\n注意：${lastAssetWarning}`
  emit('done', fileName)
}

/**
 * M4：PPTX 可编辑（Beta）。
 * 原理：背景层 = 页面高清截图（文字透明 / 表格隐藏），前景层 = 从 DOM 计算样式提取的
 * 文本/表格对象（真正的 PowerPoint 文本/表格），备注写 notes。
 * 实现模块：`./editable/index`（owner: editable-ppt-eng），本函数只做编排/资源/下载/进度。
 */
async function exportEditablePptx() {
  const payload = await prepareAssets(await renderPayload())
  const count = slideCount.value || 0
  if (!count) throw new Error('没有可导出的幻灯片：请用 --- 分页')

  progress.value = 6
  progressText.value = '正在加载可编辑导出模块…'
  const mod = await loadEditableModule()

  progress.value = 12
  progressText.value = '正在测量版式（提取文本/表格对象）…'
  const measured = await mod.measureDeckForEditablePptx(payload.html, payload.css, {
    width: payload.width,
    height: payload.height,
    comments: payload.comments,
    title: payload.title
  })
  const pageCount = Number(measured?.pageCount) || count
  if (!measured?.backgroundHtml || !measured?.backgroundCss) {
    throw new Error('可编辑导出：未能生成背景页（measure 结果缺少 backgroundHtml/backgroundCss）；可改用「PPTX 图片版」')
  }
  // 背景尺寸用 measure 实测的 deck 尺寸（4:3=960×720 / 16:9=1280×720），避免 4:3 被按 1280 裁剪
  const bgWidth = Number(measured?.width) > 0 ? Number(measured.width) : payload.width
  const bgHeight = Number(measured?.height) > 0 ? Number(measured.height) : payload.height
  if (pageCount !== count) {
    // 不阻断，但记录（布局数量以 measure 为准）
    console.warn(`[export] 可编辑 PPTX 页数不一致：render=${count} measure=${pageCount}`)
  }

  // 1) 背景截图（文字透明/表格隐藏；复用 /api/export/capture 的 CDP 原生截图）
  stage.value = 'capturing'
  const bgFormat: 'png' | 'jpeg' = pageCount <= 10 ? 'png' : 'jpeg'
  progress.value = 20
  progressText.value = `正在生成高清背景（共 ${pageCount} 页，${bgFormat === 'png' ? 'PNG 无损' : 'JPEG 高质量'} 2x）…`
  const capture = await apiJson<{
    images: { index: number; url: string; w: number; h: number }[]
    ms: number
    fallback: boolean
    mode: string
    reason?: string
  }>('/api/export/capture', {
    html: measured.backgroundHtml,
    css: measured.backgroundCss,
    width: bgWidth,
    height: bgHeight,
    scale: 2,
    slideCount: pageCount,
    format: bgFormat
  })
  if (capture.fallback) {
    throw new Error(`背景生成失败：原生截图不可用（${capture.reason || 'CDP 不可用'}）；可改用「PPTX 图片版」`)
  }
  const sortedImages = [...(capture.images || [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  if (sortedImages.length !== pageCount) {
    throw new Error(
      `背景数量不匹配（期望 ${pageCount} 张，实际 ${sortedImages.length} 张）；可改用「PPTX 图片版」`
    )
  }
  progress.value = 34
  progressText.value = `正在读取 ${sortedImages.length} 张背景…`
  const backgrounds: string[] = []
  for (let i = 0; i < sortedImages.length; i++) {
    const blob = await fetchBlob(sortedImages[i].url)
    backgrounds.push(await blobToDataUrl(blob))
    progress.value = 34 + Math.round(((i + 1) / sortedImages.length) * 14)
  }

  // 2) 组装：背景 dataURL + 文本/表格 shape + notes
  stage.value = 'assembling'
  progress.value = 50
  progressText.value = '正在组装可编辑 PPTX（文本/表格对象 + 背景底图）…'
  const pptxgenModule: any = await import('pptxgenjs')
  const PptxGenJS: any = pptxgenModule?.default || pptxgenModule?.PptxGenJS || pptxgenModule
  const assembled = await mod.assembleEditablePptx(measured, backgrounds, {
    title: payload.title,
    pptxgenjs: PptxGenJS,
    comments: payload.comments,
    onProgress: (pct: number, label: string) => {
      const safe = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0
      progress.value = Math.max(progress.value, 50 + Math.round(safe * 0.42))
      if (label) progressText.value = String(label)
    }
  })
  const blob: Blob | undefined = assembled?.blob
  if (!blob || typeof (blob as Blob).size !== 'number' || !(blob as Blob).size) {
    throw new Error('可编辑导出：组装结果缺少有效 PPTX 数据；可改用「PPTX 图片版」')
  }

  // 3) 下载
  stage.value = 'downloading'
  progress.value = 94
  progressText.value = '正在下载可编辑 PPTX…'
  const fileName = fileNamePreview.value
  saveBlob(blob as Blob, fileName)
  progress.value = 100
  progressText.value = '完成'
  const stats: any = assembled?.stats || {}
  const textBlocks = Number(stats.textBlocks ?? measured?.stats?.textBlocks ?? 0)
  const tables = Number(stats.tables ?? measured?.stats?.tables ?? 0)
  resultText.value = `可编辑 PPTX 已下载：${fileName}（${pageCount} 页 · 文本框 ${textBlocks} · 表格 ${tables} · 可编辑；背景/图片/Mermaid/页码为底图，Beta）`
  if (lastAssetWarning) resultText.value += `\n注意：${lastAssetWarning}`
  emit('done', fileName)
}

/** 懒加载 `./editable/index`（缺失/接口不全/加载失败都转成可读错误） */
async function loadEditableModule(): Promise<EditableModuleAPI> {
  if (!editableLoader) {
    throw new Error('「PPTX 可编辑（Beta）」模块未就绪（请更新 MarpWorkbench）；可先用「PPTX」图片版导出')
  }
  let raw: any
  try {
    raw = await editableLoader()
  } catch (err: any) {
    throw new Error(`可编辑导出模块加载失败：${String(err?.message || err)}；可改用「PPTX」图片版`)
  }
  const api: any = raw?.measureDeckForEditablePptx ? raw : raw?.default
  if (
    !api ||
    typeof api.measureDeckForEditablePptx !== 'function' ||
    typeof api.assembleEditablePptx !== 'function'
  ) {
    throw new Error(
      '可编辑导出模块接口不完整（缺少 measureDeckForEditablePptx / assembleEditablePptx）；可改用「PPTX」图片版'
    )
  }
  return api as EditableModuleAPI
}

/** 用 pptxgenjs 组装图片版 PPTX（与 marp-cli --pptx 同思路） */async function assemblePptx(images: { dataUrl: string }[], comments: string[]): Promise<any> {
  const mod: any = await import('pptxgenjs')
  const PptxGenJS: any = mod?.default || mod?.PptxGenJS || mod
  const pptx = new PptxGenJS()
  pptx.author = 'MarpWorkbench'
  pptx.company = 'MarpWorkbench'
  pptx.title = props.title || '演示文稿'
  // 必须用 1280/96 而不是 13.333，否则 sldSz 不是精确 12192000（非标准 16:9）
  pptx.defineLayout({ name: 'MWB', width: 1280 / 96, height: 720 / 96 })
  pptx.layout = 'MWB'
  images.forEach((img, i) => {
    const slide = pptx.addSlide()
    slide.background = { data: img.dataUrl }
    const note = comments[i] || ''
    if (note) slide.addNotes(note)
  })
  return pptx
}

/**
 * 降级通道：html-to-image 逐页 2x 截图。
 * 注意：捕获容器必须放在可见坐标（负坐标会输出全白图，见 marp-tech 实测）。
 */
async function captureWithHtmlToImage(
  render: { html: string; css: string },
  count: number
): Promise<{ dataUrl: string }[]> {
  const mod: any = await import('html-to-image')
  const toPng: (node: HTMLElement, opts?: any) => Promise<string> = mod?.toPng || mod?.default?.toPng
  if (typeof toPng !== 'function') throw new Error('html-to-image 加载失败，无法降级截图')

  const style = document.createElement('style')
  style.textContent = render.css
  document.head.appendChild(style)

  const holder = document.createElement('div')
  holder.style.cssText =
    'position:fixed;left:0;top:0;width:1280px;height:720px;overflow:hidden;background:#fff;z-index:99999;pointer-events:none'
  holder.innerHTML = render.html
  document.body.appendChild(holder)
  const slides = [...holder.querySelectorAll('svg[data-marpit-svg]')]
  const images: { dataUrl: string }[] = []
  try {
    for (let i = 0; i < slides.length; i++) {
      const wrap = document.createElement('div')
      wrap.className = 'marpit'
      wrap.style.cssText = 'width:1280px;height:720px;margin:0;padding:0'
      wrap.appendChild(slides[i].cloneNode(true))
      holder.innerHTML = ''
      holder.appendChild(wrap)
      progressText.value = `浏览器快速截图 ${i + 1}/${slides.length}…`
      progress.value = 55 + Math.round(((i + 1) / Math.max(1, slides.length)) * 15)
      await new Promise((r) => setTimeout(r, 20))
      images.push({ dataUrl: await toPng(holder, { pixelRatio: 2, backgroundColor: '#ffffff', skipFonts: true }) })
    }
  } finally {
    holder.remove()
    style.remove()
  }
  if (!images.length) throw new Error(`浏览器快速截图失败（期望 ${count} 页）`)
  return images
}

function fmtBytes(n: number): string {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

async function copyPathTip() {
  try {
    await navigator.clipboard.writeText('导出文件已保存到浏览器下载目录；也可用「打开所在文件夹」入口（M2）')
    copyTip.value = '已复制提示'
  } catch {
    copyTip.value = '复制失败，请手动查看下载目录'
  }
  setTimeout(() => (copyTip.value = ''), 2000)
}

function close() {
  if (!busy.value) emit('close')
}
</script>

<template>
  <!-- 注意：外层弹窗（遮罩/标题栏）由 frontend-core 的 EditView 提供；本组件只渲染面板内容，
       避免双重 modal。Esc 关闭与点遮罩关闭由外层负责，这里保留 footer 关闭按钮。 -->
  <div class="mwb-export-panel" role="dialog" aria-modal="true" aria-label="导出">
    <div class="mwb-export-body">
        <div class="mwb-export-meta">
          <div><span class="k">文件</span><span class="v">{{ title || '未命名演示' }}</span></div>
          <div><span class="k">页数</span><span class="v">{{ slideCount }} 页 · {{ pageSize.width }}×{{ pageSize.height }}</span></div>
          <div><span class="k">文件名</span><span class="v">{{ fileNamePreview }}</span></div>
        </div>

        <div v-if="mockMode" class="mwb-export-note warn">
          当前是 Mock 模式（未连接 Rust 服务），无法真实导出。请启动 MarpWorkbench.exe 后从应用页面打开。
        </div>

        <div class="mwb-export-formats" role="radiogroup" aria-label="导出格式">
          <button
            type="button"
            class="fmt"
            :class="{ active: format === 'pptx' }"
            :disabled="busy"
            @click="format = 'pptx'"
          >
            <strong>PPTX</strong>
            <span>图片版 · 16:9 · 备注写入（推荐；版式与预览一致）</span>
            <em>默认</em>
          </button>
          <button
            v-if="editableAvailable"
            type="button"
            class="fmt"
            :class="{ active: format === 'pptx-editable' }"
            :disabled="busy"
            :title="'Beta：文字/表格可在 PowerPoint 编辑；背景、图片、Mermaid、页码为高清底图'"
            @click="format = 'pptx-editable'"
          >
            <strong>PPTX 可编辑</strong>
            <span>文字/表格可在 PowerPoint 编辑；背景、图片、Mermaid、页码为高清底图</span>
            <i class="beta">Beta</i>
          </button>
          <button
            type="button"
            class="fmt"
            :class="{ active: format === 'pdf' }"
            :disabled="busy"
            @click="format = 'pdf'"
          >
            <strong>PDF</strong>
            <span>矢量文本 · 可搜索复制 · 1280×720 精确页面（960×540pt）</span>
          </button>
          <button
            type="button"
            class="fmt"
            :class="{ active: format === 'html' }"
            :disabled="busy"
            @click="format = 'html'"
          >
            <strong>HTML</strong>
            <span>单文件 · 离线双击可播 · 键盘翻页</span>
          </button>
        </div>

        <p class="mwb-export-hint">
          <template v-if="format === 'pptx-editable'">
            可编辑版为 <strong>Beta</strong>：文字、列表、代码、表格是真正的 PowerPoint 对象，可选中修改；
            背景、装饰图、图片、Mermaid、页码是高清底图（不可编辑）。字体在目标机缺失时 PowerPoint 会自动替换。
          </template>
          <template v-else-if="format === 'pptx'">
            PPTX 为图片版（不可逐字编辑）以保证 100% 版式保真；演讲者备注会写入 notes。
            本次截图格式：{{ captureFormat === 'png' ? 'PNG 无损（≤10 页）' : 'JPEG 高质量（>10 页，速度更快）' }}。
          </template>
          <template v-else-if="format === 'pdf'">
            PDF 为矢量文本（可搜索复制），页面精确 1280×720；主题/渐变/中文字体保持与预览一致。
          </template>
          <template v-else>HTML 为离线单文件（双击即播，←/→ 翻页），可再打印为 PDF。</template>
        </p>

        <div v-if="busy" class="mwb-export-progress">
          <div class="bar"><i :style="{ width: progress + '%' }" /></div>
          <p>{{ progressText }}</p>
        </div>

        <div v-if="stage === 'done'" class="mwb-export-result ok">
          <pre>{{ resultText }}</pre>
          <p class="sub">文件已通过浏览器下载保存。若未看到文件，请检查下载栏/下载目录。</p>
          <button type="button" class="link" @click="copyPathTip">如何找到导出文件？</button>
          <span v-if="copyTip" class="tip">{{ copyTip }}</span>
        </div>

        <div v-if="stage === 'error'" class="mwb-export-result err">
          <p class="msg">{{ errorText }}</p>
          <p v-if="errorDetail" class="detail">{{ errorDetail }}</p>
          <p v-if="format === 'pptx-editable'" class="sub">
            可编辑版为 Beta：若持续失败，请在上方切换为「PPTX」（图片版）导出——版式 100% 保真但文字不可编辑。
          </p>
          <p v-else class="sub">可重试；若持续失败，请检查本机 Chrome/Edge 是否可用（设置页可查看浏览器探测结果）。</p>
        </div>
      </div>

      <footer class="mwb-export-foot">
        <button type="button" class="ghost" :disabled="busy" @click="close">关闭</button>
        <button type="button" class="primary" :disabled="busy || mockMode || !slideCount" @click="startExport">
          {{ busy ? '导出中…' : `导出 ${formatLabel}` }}
        </button>
      </footer>
  </div>
</template>

<style scoped>
/* 外层遮罩/标题栏由 EditView 的 modal 提供；这里只负责面板内部布局 */
.mwb-export-panel {
  width: 100%;
  min-width: 420px;
  min-height: 0;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  background: #ffffff;
  color: #1f2430;
  font: 14px/1.55 'Microsoft YaHei', 'Segoe UI', sans-serif;
}
.mwb-export-body {
  padding: 16px 20px;
  overflow-y: auto;
}
.mwb-export-meta {
  display: grid;
  gap: 4px;
  margin-bottom: 14px;
  padding: 10px 12px;
  background: #f7f9fc;
  border: 1px solid #eef1f6;
  border-radius: 10px;
}
.mwb-export-meta .k {
  display: inline-block;
  width: 56px;
  color: #8a93a6;
}
.mwb-export-meta .v {
  color: #2b3242;
  word-break: break-all;
}
.mwb-export-formats {
  display: grid;
  gap: 8px;
  margin-bottom: 12px;
}
.fmt {
  position: relative;
  text-align: left;
  padding: 10px 12px;
  border: 1px solid #e3e8f0;
  border-radius: 10px;
  background: #fff;
  cursor: pointer;
  display: grid;
  gap: 2px;
  font: inherit;
  color: inherit;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.fmt strong {
  font-size: 15px;
}
.fmt span {
  color: #66708a;
  font-size: 12.5px;
}
.fmt em {
  position: absolute;
  right: 10px;
  top: 10px;
  font-style: normal;
  font-size: 11px;
  color: #1d6ff2;
  background: #e9f1ff;
  border-radius: 999px;
  padding: 1px 8px;
}
/* M4：可编辑 PPTX 的 Beta 徽标（黄色，区别于默认徽标） */
.fmt i.beta {
  position: absolute;
  right: 10px;
  top: 10px;
  font-style: normal;
  font-size: 11px;
  font-weight: 600;
  color: #92400e;
  background: #fef3c7;
  border: 1px solid #fde68a;
  border-radius: 999px;
  padding: 0 8px;
  line-height: 18px;
}
.fmt:hover:not(:disabled) {
  border-color: #b9c8e0;
}
.fmt.active {
  border-color: #1d6ff2;
  box-shadow: 0 0 0 2px rgba(29, 111, 242, 0.15);
}
.fmt:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}
.mwb-export-hint {
  margin: 0 0 12px;
  color: #66708a;
  font-size: 12.5px;
}
.mwb-export-note.warn {
  margin-bottom: 12px;
  padding: 8px 12px;
  border-radius: 8px;
  background: #fff7e6;
  border: 1px solid #ffe2b3;
  color: #7a5200;
  font-size: 13px;
}
.mwb-export-progress .bar {
  height: 6px;
  background: #edf0f5;
  border-radius: 999px;
  overflow: hidden;
}
.mwb-export-progress .bar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #1d6ff2, #4f9bff);
  border-radius: 999px;
  transition: width 0.2s;
}
.mwb-export-progress p {
  margin: 8px 0 0;
  color: #4a5468;
  font-size: 13px;
}
.mwb-export-result {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
}
.mwb-export-result.ok {
  background: #effaf3;
  border: 1px solid #c9ecd7;
  color: #1c6b3c;
}
.mwb-export-result.err {
  background: #fff2f2;
  border: 1px solid #ffd1d1;
  color: #a12a2a;
}
.mwb-export-result pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font: inherit;
}
.mwb-export-result .msg {
  margin: 0;
  font-weight: 600;
}
.mwb-export-result .detail {
  margin: 6px 0 0;
  color: #7a3333;
  font-size: 12.5px;
  word-break: break-all;
}
.mwb-export-result .sub {
  margin: 6px 0 0;
  opacity: 0.85;
  font-size: 12.5px;
}
.mwb-export-result .link {
  margin-top: 6px;
  border: 0;
  background: transparent;
  color: #1d6ff2;
  cursor: pointer;
  padding: 0;
  font: inherit;
}
.mwb-export-result .tip {
  margin-left: 8px;
  font-size: 12px;
}
.mwb-export-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid #edf0f5;
}
.mwb-export-foot button {
  font: inherit;
  padding: 8px 18px;
  border-radius: 8px;
  cursor: pointer;
  border: 1px solid transparent;
}
.mwb-export-foot .ghost {
  background: #fff;
  border-color: #dce2ec;
  color: #3a4356;
}
.mwb-export-foot .ghost:hover:not(:disabled) {
  background: #f5f7fb;
}
.mwb-export-foot .primary {
  background: #1d6ff2;
  color: #fff;
}
.mwb-export-foot .primary:hover:not(:disabled) {
  background: #1a63da;
}
.mwb-export-foot button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
