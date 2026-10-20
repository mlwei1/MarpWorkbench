/**
 * 图片资产上传 / 预览内联（M2，owner: export-eng）
 *
 * 上传：POST /api/decks/:id/assets（multipart，字段 `file`）→ `{path:'assets/x.png', url, bytes}`
 * 预览/导出：`GET /api/decks/:id/assets/:name` 需要 `X-MWB-Token` 头，而 <img src> 无法携带，
 * 因此这里提供「带 token fetch → dataURL 内联」的工具：
 * - 插入对话框预览：把候选 HTML 里的 assets/xxx 换成 dataURL，图片才能在 iframe 里显示；
 * - 导出（PDF/PPTX/HTML）：file:// 打印页无法解析相对资产路径 → 导出前同样内联（见 ExportPanel）。
 *
 * 注意：不依赖 marp-tech 的 api/index.ts（其 uploadAsset 可能稍后才出现），避免构建互相阻塞；
 * token/mock 判定复用 `api/client.ts` 的既有导出（getToken/isMockMode/apiUrl）。
 */
import { isMockMode } from '../api/client'
import { fetchDeckAssetBlob, uploadAsset as apiUploadAsset } from '../api/index'

export interface UploadedAsset {
  path: string
  url: string
  bytes: number
}

export const ASSET_ACCEPT =
  '.png,.jpg,.jpeg,.gif,.webp,.svg,image/png,image/jpeg,image/gif,image/webp,image/svg+xml'

export const MAX_ASSET_BYTES = 20 * 1024 * 1024

const IMAGE_MIME_RE = /^image\/(png|jpe?g|gif|webp|svg\+xml)$/i
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg)$/i

export function isSupportedImage(file: File | null | undefined): boolean {
  if (!file) return false
  if (IMAGE_MIME_RE.test(file.type || '')) return true
  // 部分系统拖拽时 type 为空：用扩展名兜底
  return !file.type && IMAGE_EXT_RE.test(file.name || '')
}

/** Mock 模式下没有后端：用本地 dataURL 模拟资产（仅用于开发预览，不落盘） */
const mockAssets = new Map<string, string>()

function safeMockName(file: File): string {
  const ext = (IMAGE_EXT_RE.exec(file.name)?.[1] || 'png').toLowerCase()
  const base = (file.name || 'image').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)
  return `assets/${base || 'image'}-${Date.now().toString(36)}.${ext}`
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('读取图片文件失败'))
    reader.readAsDataURL(file)
  })
}
/** 上传图片到当前 deck 的 assets/ 目录（服务端会处理重名）。
 *  实现复用 marp-tech 的 `api/index.ts::uploadAsset`（单一实现），
 *  mock 模式下没有后端 → 用本地 dataURL 模拟，保证对话框开发时可用。 */
export async function uploadAsset(deckId: string, file: File): Promise<UploadedAsset> {
  if (!isSupportedImage(file)) {
    throw new Error('只支持 PNG / JPG / GIF / WebP / SVG 图片')
  }
  if (file.size > MAX_ASSET_BYTES) {
    throw new Error(`图片太大（${(file.size / 1024 / 1024).toFixed(1)}MB），最大支持 20MB`)
  }
  if (isMockMode()) {
    // 开发 mock：不请求后端，返回本地 dataURL 供对话框预览
    const dataUrl = await readFileAsDataUrl(file)
    const path = safeMockName(file)
    mockAssets.set(path, dataUrl)
    return { path, url: dataUrl, bytes: file.size }
  }
  try {
    const result = await apiUploadAsset(deckId, file)
    if (!result?.path) throw new Error('上传接口返回异常（缺少 path）')
    return { path: result.path, url: result.url || '', bytes: Number(result.bytes || file.size) }
  } catch (err: any) {
    const message = String(err?.message || err)
    if (/上传失败|图片/.test(message)) throw err
    throw new Error(`图片上传失败：${message}`)
  }
}

const dataUrlCache = new Map<string, string>()

/** 相对资产路径（assets/x.png）→ dataURL（带 token 请求；失败返回 null） */
export async function fetchAssetDataUrl(deckId: string, assetPath: string): Promise<string | null> {
  const rel = String(assetPath || '').trim()
  if (!rel || /^(https?:|data:|blob:)/i.test(rel)) return rel || null
  const name = rel.replace(/^assets\//, '')
  if (!name) return null
  const key = `${deckId}::${rel}`
  const cached = dataUrlCache.get(key)
  if (cached) return cached
  const mock = mockAssets.get(rel)
  if (mock) {
    dataUrlCache.set(key, mock)
    return mock
  }
  if (isMockMode()) return null
  try {
    const blob = await fetchDeckAssetBlob(deckId, name)
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(new Error('读取资产失败'))
      reader.readAsDataURL(blob)
    })
    if (dataUrl) dataUrlCache.set(key, dataUrl)
    return dataUrl
  } catch {
    return null
  }
}

export interface InlineAssetsResult {
  content: string
  inlined: number
  failed: string[]
}

/**
 * 把文本（HTML 或 Markdown）里出现的 `assets/xxx` 引用替换成 dataURL。
 * 用于：对话框预览 iframe、PDF/PPTX/HTML 导出（file:// 页面无法解析相对路径）。
 * 失败路径不阻断导出（failed 返回给调用方提示），已有 data:/http URL 不动。
 */
export async function inlineDeckAssetUrls(
  content: string,
  deckId: string,
  onProgress?: (done: number, total: number) => void
): Promise<InlineAssetsResult> {
  const text = String(content || '')
  const paths = new Set<string>()
  const re = /assets\/[^"'\s)<>&]+/g
  for (const match of text.matchAll(re)) {
    const path = match[0]
    // 排除已经被内联/外链的片段（例如 url(data:...) 里不会命中）
    if (path.endsWith('.') || path.length > 300) continue
    paths.add(path)
  }
  const list = [...paths]
  if (!list.length) return { content: text, inlined: 0, failed: [] }

  let inlined = 0
  const failed: string[] = []
  const replacements = new Map<string, string>()
  let done = 0
  for (const path of list) {
    const decoded = (() => {
      try {
        return decodeURIComponent(path)
      } catch {
        return path
      }
    })()
    const decodedKey = decoded.startsWith('assets/') ? decoded : `assets/${decoded}`
    const dataUrl = (await fetchAssetDataUrl(deckId, path)) || (await fetchAssetDataUrl(deckId, decodedKey))
    done++
    onProgress?.(done, list.length)
    if (!dataUrl) {
      failed.push(path)
      continue
    }
    replacements.set(path, dataUrl)
    replacements.set(encodeURI(path), dataUrl)
    replacements.set(decoded, dataUrl)
    inlined++
  }
  let out = text
  for (const [from, to] of replacements) {
    if (!from || from === to) continue
    out = out.split(from).join(to)
  }
  return { content: out, inlined, failed }
}

/** 判断文本里是否引用了本地资产（用于导出前决定是否内联） */
export function hasDeckAssetRefs(content: string): boolean {
  return /assets\/[^"'\s)<>&]+/.test(String(content || ''))
}

/** 清空缓存（测试或切换 deck 时可用） */
export function clearAssetCache(): void {
  dataUrlCache.clear()
}
