/**
 * 把 marp 渲染结果里的相对图片路径（`assets/x.png`）解析成 data URL。
 *
 * 为什么需要：Marp 的图片/背景图在 HTML 里是相对路径（`<img src="assets/x.png">`、
 * `<figure style="background-image:url('assets/x.png')">`），而预览 iframe（srcdoc）与
 * 缩略图 iframe 的基准 URL 是应用路由 `/edit/<id>`，浏览器会按 `/edit/assets/...` 请求 → 404。
 * 在把 html 交给 iframe 之前统一替换掉，可避免 404、闪烁，并让缩略图里也能看到上传图片。
 *
 * 用 data URL 而不是 blob URL：缩略图 iframe 是 sandbox（opaque origin），data: 最稳。
 */
import { fetchDeckAssetBlob } from '../api'

const cache = new Map<string, string>()

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'))
    reader.readAsDataURL(blob)
  })
}

const ASSET_RE = /assets\/[^"'()<>\s&]+/g

export async function resolveDeckAssetsInHtml(
  html: string,
  deckId?: string,
  known?: { path: string; url: string }[],
): Promise<string> {
  if (!deckId || !html || !html.includes('assets/')) return html
  const paths = new Set<string>()
  for (const m of html.matchAll(ASSET_RE)) paths.add(m[0])
  if (!paths.size) return html

  let next = html
  for (const path of paths) {
    const fileName = path.split('/').filter(Boolean).pop() || path
    const key = `${deckId}:${fileName}`
    let url = cache.get(key)
    if (!url) {
      const knownAsset = known?.find((a) => a.path === path || a.path.endsWith(`/${fileName}`))
      if (knownAsset?.url?.startsWith('data:')) url = knownAsset.url
    }
    if (!url) {
      try {
        const blob = await fetchDeckAssetBlob(deckId, fileName)
        url = await blobToDataUrl(blob)
        cache.set(key, url)
      } catch {
        continue // 资产不存在时保持原样（渲染端会显示占位/破图）
      }
    }
    next = next.split(path).join(url)
  }
  return next
}

export function clearDeckAssetCache(): void {
  cache.clear()
}

/**
 * 同步版本：只用已缓存的 data URL 替换（缓存未命中时保留原路径）。
 * 用于画廊缩略图等同步渲染路径——主预览先把资产解析进缓存后，缩略图即可直接命中。
 */
export function resolveDeckAssetsInHtmlSync(html: string, deckId?: string): string {
  if (!deckId || !html || !html.includes('assets/')) return html
  let next = html
  for (const m of html.matchAll(ASSET_RE)) {
    const path = m[0]
    const fileName = path.split('/').filter(Boolean).pop() || path
    const url = cache.get(`${deckId}:${fileName}`)
    if (url) next = next.split(path).join(url)
  }
  return next
}

/** 同步替换 Markdown 里的资产路径（画廊/主题编辑器预览用；依赖已解析缓存） */
export function resolveDeckAssetsInMarkdownSync(markdown: string, deckId?: string): string {
  if (!deckId || !markdown || !markdown.includes('assets/')) return markdown
  let next = markdown
  for (const m of markdown.matchAll(ASSET_RE)) {
    const path = m[0]
    const fileName = path.split('/').filter(Boolean).pop() || path
    const url = cache.get(`${deckId}:${fileName}`)
    if (url) next = next.split(path).join(url)
  }
  return next
}
