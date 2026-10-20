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
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { getToken, isMockMode } from '../api/client'
import { hasDeckAssetRefs, inlineDeckAssetUrls } from '../insert/upload'
import type { RenderResult } from '../types'

interface Props {
  deckId: string
  title: string
  markdown: string
  render: () => RenderResult
  width?: number
  height?: number
  theme?: string
}
const props = withDefaults(defineProps<Props>(), { width: 1280, height: 720 })
const emit = defineEmits<{ close: []; done: [fileName: string] }>()

type Format = 'pptx' | 'pdf' | 'html'
type Stage = 'idle' | 'preparing' | 'capturing' | 'assembling' | 'downloading' | 'done' | 'error'

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

/** 页面尺寸：优先 props，其次从 render html 的 viewBox 推断 */
const pageSize = computed(() => {
  try {
    const res = props.render()
    const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(res.html || '')
    if (m) return { width: Math.round(parseFloat(m[1])), height: Math.round(parseFloat(m[2])) }
  } catch {
    /* ignore */
  }
  return { width: props.width, height: props.height }
})

const slideCount = computed(() => {
  try {
    const res = props.render()
    return (res.html.match(/data-marpit-svg/g) || []).length
  } catch {
    return 0
  }
})

const fileNamePreview = computed(() => {
  const stem = sanitizeFileName(props.title || '演示文稿')
  const ext = format.value === 'pptx' ? 'pptx' : format.value === 'pdf' ? 'pdf' : 'html'
  return `${stem}.${ext}`
})

const captureFormat = computed<'png' | 'jpeg'>(() => (slideCount.value <= 10 ? 'png' : 'jpeg'))

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
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

function renderPayload() {
  const res = props.render()
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

/** 导出前把 deck 内图片资产（assets/x.png）内联成 dataURL：
 *  PDF/PPTX 的打印页走 file://，无法带 token 解析相对资产路径；HTML 单文件也需要自包含。
 *  失败不阻断导出，记录到 lastAssetWarning 在结果里提示。 */
let lastAssetWarning = ''
async function prepareAssets<T extends { html: string }>(payload: T): Promise<T> {
  lastAssetWarning = ''
  if (!hasDeckAssetRefs(payload.html)) return payload
  progressText.value = '正在准备图片资源（内联到导出页）…'
  try {
    const res = await inlineDeckAssetUrls(payload.html, props.deckId, (done, total) => {
      progressText.value = `正在准备图片资源（${done}/${total}）…`
    })
    if (res.failed.length) {
      const names = res.failed.slice(0, 2).join('、') + (res.failed.length > 2 ? '…' : '')
      lastAssetWarning = `有 ${res.failed.length} 张本地图片未能读取（导出中可能缺失）：${names}`
    }
    return { ...payload, html: res.content }
  } catch (err: any) {
    lastAssetWarning = `图片内联失败：${String(err?.message || err)}`
    return payload
  }
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
    if (format.value === 'pdf') await exportPdf()
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

async function exportPdf() {
  progress.value = 15
  progressText.value = '正在生成打印页…'
  const payload = await prepareAssets(renderPayload())
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
  const payload = await prepareAssets(renderPayload())
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
  const render = await prepareAssets(renderPayload())
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

/** 用 pptxgenjs 组装图片版 PPTX（与 marp-cli --pptx 同思路） */
async function assemblePptx(images: { dataUrl: string }[], comments: string[]): Promise<any> {
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
          PPTX 为图片版（不可逐字编辑）以保证 100% 版式保真；演讲者备注会写入 notes。
          <template v-if="format === 'pptx'">
            本次截图格式：{{ captureFormat === 'png' ? 'PNG 无损（≤10 页）' : 'JPEG 高质量（>10 页，速度更快）' }}。
          </template>
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
          <p class="sub">可重试；若持续失败，请检查本机 Chrome/Edge 是否可用（设置页可查看浏览器探测结果）。</p>
        </div>
      </div>

      <footer class="mwb-export-foot">
        <button type="button" class="ghost" :disabled="busy" @click="close">关闭</button>
        <button type="button" class="primary" :disabled="busy || mockMode || !slideCount" @click="startExport">
          {{ busy ? '导出中…' : `导出 ${format.toUpperCase()}` }}
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
