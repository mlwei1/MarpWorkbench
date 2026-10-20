/**
 * 网络图片（老 Markdown 里的 `![](https://…)`）前端工具（M3，owner: export-eng）
 *
 * 背景：预览 iframe CSP 只允许 self/data/blob，离线要求 0 外网请求；服务端提供
 * `GET /api/proxy/image?url=…&token=…` 代理显示 + `POST /api/decks/:id/localize-images`
 * 一键下载到 deck assets（契约 docs/UI_CONTRACT_M3.md §2.1/§2.2）。
 *
 * 本模块负责：
 * - 检测/替换 markdown 里的网络图片
 * - 代理 URL 生成（自带 token，供 PreviewPane / 对话框预览用）
 * - 一键本地化（调服务端接口 → 返回替换后的 markdown）
 * - 导出前把 html 里 http(s) 图片经代理取回成 dataURL 内联（file:// 打印页无法联网取图）
 */

import { apiUrl, getToken, isMockMode } from '../api/client'
import { findImageTokens } from './compose'

export interface RemoteImageRef {
  url: string
  /** markdown 里 URL 的字符 range（不含两侧括号） */
  start: number
  end: number
}

export interface LocalizeFailed {
  url: string
  reason: string
}

export interface LocalizeResult {
  markdown: string
  /** 成功本地化的张数 */
  localized: number
  mapping: Record<string, string>
  failed: LocalizeFailed[]
}

const HTTP_URL_RE = /^https?:\/\//i

/** 找出 markdown 里所有 http(s) 图片（普通图与背景图；跳过代码围栏） */
export function findRemoteImages(markdown: string): RemoteImageRef[] {
  const md = String(markdown ?? '')
  const out: RemoteImageRef[] = []
  for (const token of findImageTokens(md)) {
    if (!HTTP_URL_RE.test(token.path)) continue
    const rel = token.raw.indexOf(token.path)
    const start = token.start + (rel >= 0 ? rel : 0)
    out.push({ url: token.path, start, end: start + token.path.length })
  }
  // 去重（同 URL 多处出现只返回一次；替换逻辑按 URL 全局替换）
  const seen = new Set<string>()
  return out.filter((ref) => {
    if (seen.has(ref.url)) return false
    seen.add(ref.url)
    return true
  })
}

/** 把 markdown 里的网络图片 URL 按 mapping 替换为本地路径（同时处理 URL 编码形式） */
export function replaceRemoteImages(markdown: string, mapping: Record<string, string>): string {
  let out = String(markdown ?? '')
  if (!mapping) return out
  const keys = Object.keys(mapping).sort((a, b) => b.length - a.length)
  for (const key of keys) {
    const value = mapping[key]
    if (!key || !value || key === value) continue
    const variants = new Set<string>([key])
    try {
      variants.add(encodeURI(key))
    } catch {
      /* ignore */
    }
    for (const variant of variants) {
      if (!variant) continue
      out = out.split(variant).join(value)
    }
  }
  return out
}

/**
 * 生成图片代理 URL（**自带 token**，同源；iframe 内 <img src> 可直接用）。
 * 服务端仅对 /api/proxy/image 允许 query token 鉴权。
 */
export function proxyImageUrl(url: string): string {
  const token = getToken() || ''
  return apiUrl(`/proxy/image?url=${encodeURIComponent(String(url || ''))}&token=${encodeURIComponent(token)}`)
}

/** 文本里是否有网络图片引用（markdown 图片语法 或 html 的 src/background-image） */
export function hasRemoteImageRefs(text: string): boolean {
  const content = String(text || '')
  if (!/https?:\/\//i.test(content)) return false
  if (findRemoteImages(content).length > 0) return true
  return collectHtmlRemoteUrls(content).length > 0
}

/** 统计 markdown 里网络图片数量 */
export function countRemoteImages(markdown: string): number {
  return findRemoteImages(markdown).length
}

// ---------------------------------------------------------------------------
// HTML 内的远程图片（预览代理 / 导出内联）
// ---------------------------------------------------------------------------

interface UrlMatch {
  /** html 里原样出现的字符串（可能是 &amp; 转义） */
  raw: string
  /** 还原后的真实 URL（用于 fetch） */
  decoded: string
}

const HTML_SRC_RE = /(\bsrc\s*=\s*["'])(https?:\/\/[^"']+?)(["'])/gi
// background-image:url(...) 里的引号在 HTML 序列化后可能是 &quot; / &#39;；
// 非贪婪匹配 + 显式终止符，避免把 &quot; 吞进 URL
const HTML_URL_FN_RE = /(url\(\s*(?:["']|&quot;|&#39;)?)(https?:\/\/[^"')\s]+?)(?:(?:["']|&quot;|&#39;)?\s*\))/gi

function collectHtmlRemoteUrls(html: string): UrlMatch[] {
  const out: UrlMatch[] = []
  const seen = new Set<string>()
  const collect = (raw: string): void => {
    const decoded = raw.replace(/&amp;/g, '&')
    if (!HTTP_URL_RE.test(decoded) || seen.has(decoded)) return
    seen.add(decoded)
    out.push({ raw, decoded })
  }
  for (const m of String(html || '').matchAll(HTML_SRC_RE)) collect(m[2])
  for (const m of String(html || '').matchAll(HTML_URL_FN_RE)) collect(m[2])
  return out
}

/**
 * 同步把 html 里 http(s) 图片换成代理 URL（供 PreviewPane/对话框预览注入 iframe 前使用）。
 * 不修改 <a href> 等普通链接。
 */
export function proxyRemoteImagesInHtml(html: string): string {
  let out = String(html || '')
  if (!/https?:\/\//i.test(out)) return out
  for (const match of collectHtmlRemoteUrls(out)) {
    const proxy = proxyImageUrl(match.decoded)
    if (match.raw !== proxy) out = out.split(match.raw).join(proxy)
    if (match.decoded !== match.raw && match.decoded !== proxy) out = out.split(match.decoded).join(proxy)
  }
  return out
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('读取远程图片失败'))
    reader.readAsDataURL(blob)
  })
}

const remoteDataUrlCache = new Map<string, string>()

/**
 * 导出前内联 html 里的 http(s) 图片：经 `/api/proxy/image`（token 在 query）取回 → dataURL。
 * 失败不抛错（返回 failed，调用方提示，导出继续）。
 */
export async function inlineRemoteImageDataUrls(
  html: string,
  onProgress?: (done: number, total: number) => void
): Promise<{ content: string; inlined: number; failed: { url: string; reason: string }[] }> {
  const text = String(html || '')
  if (!/https?:\/\//i.test(text)) return { content: text, inlined: 0, failed: [] }
  const matches = collectHtmlRemoteUrls(text)
  if (!matches.length) return { content: text, inlined: 0, failed: [] }

  let content = text
  let inlined = 0
  const failed: { url: string; reason: string }[] = []
  let done = 0
  for (const match of matches) {
    const cached = remoteDataUrlCache.get(match.decoded)
    let dataUrl = cached || ''
    if (!dataUrl) {
      if (isMockMode()) {
        failed.push({ url: match.decoded, reason: 'Mock 模式不支持远程图片代理' })
        done++
        onProgress?.(done, matches.length)
        continue
      }
      try {
        const res = await fetch(proxyImageUrl(match.decoded))
        if (!res.ok) {
          let message = `HTTP ${res.status}`
          try {
            const body = await res.json()
            if (body?.error?.message) message = body.error.message
          } catch {
            /* ignore */
          }
          throw new Error(message)
        }
        const blob = await res.blob()
        dataUrl = await blobToDataUrl(blob)
        if (dataUrl) remoteDataUrlCache.set(match.decoded, dataUrl)
      } catch (err: any) {
        const raw = String(err?.message || err)
        // 非浏览器环境（Node 测试）或页面异常时，fetch 相对 URL 会报 "Failed to parse URL" → 归一为可读中文
        const reason = /Failed to parse URL|invalid URL/i.test(raw)
          ? '无法连接本地服务，请确认 MarpWorkbench 仍在运行'
          : raw
        failed.push({ url: match.decoded, reason })
        done++
        onProgress?.(done, matches.length)
        continue
      }
    }
    if (dataUrl) {
      content = content.split(match.raw).join(dataUrl)
      if (match.decoded !== match.raw) content = content.split(match.decoded).join(dataUrl)
      inlined++
    }
    done++
    onProgress?.(done, matches.length)
  }
  return { content, inlined, failed }
}

/** 清空远程 dataURL 缓存（测试/切换 deck 时可调用） */
export function clearRemoteImageCache(): void {
  remoteDataUrlCache.clear()
}

// ---------------------------------------------------------------------------
// 一键本地化
// ---------------------------------------------------------------------------

function readableHttpError(status: number, body: any): string {
  if (status === 404) return '服务端网络图片本地化接口尚未就绪（请更新 MarpWorkbench 后重试）'
  if (status === 401 || status === 403) return '本地服务鉴权失败，请重新从应用入口打开页面'
  const msg = body?.error?.message
  const detail = body?.error?.detail
  if (msg) return detail ? `${msg}：${detail}` : msg
  return `本地化失败（HTTP ${status}）`
}

/**
 * 一键本地化 markdown 里的网络图片：
 * 调服务端 `POST /api/decks/:id/localize-images`（body {urls}）→ 返回映射 → 替换 markdown。
 * 不修改文件，由调用方保存替换后的 markdown；接口未就绪时给可读错误。
 */
export async function localizeRemoteImages(deckId: string, markdown: string): Promise<LocalizeResult> {
  const md = String(markdown ?? '')
  const refs = findRemoteImages(md)
  const urls = [...new Set(refs.map((r) => r.url))]
  if (!urls.length) return { markdown: md, localized: 0, mapping: {}, failed: [] }
  if (!deckId) throw new Error('当前 deck 未就绪，无法下载网络图片')
  if (isMockMode()) {
    return {
      markdown: md,
      localized: 0,
      mapping: {},
      failed: urls.map((url) => ({ url, reason: 'Mock 模式不支持网络图片本地化' })),
    }
  }

  const token = getToken() || ''
  let res: Response
  try {
    res = await fetch(apiUrl(`/decks/${encodeURIComponent(deckId)}/localize-images`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-MWB-Token': token } : {}) },
      body: JSON.stringify({ urls }),
    })
  } catch {
    throw new Error('无法连接本地服务，请确认 MarpWorkbench 仍在运行')
  }
  let body: any = null
  try {
    body = await res.json()
  } catch {
    /* ignore */
  }
  if (!res.ok) throw new Error(readableHttpError(res.status, body))

  const mapping: Record<string, string> = {}
  if (body?.mapping && typeof body.mapping === 'object') {
    for (const [url, path] of Object.entries(body.mapping)) {
      if (typeof path === 'string' && path) mapping[url] = path
    }
  }
  const failed: LocalizeFailed[] = Array.isArray(body?.failed)
    ? body.failed
        .filter((f: any) => f && typeof f.url === 'string')
        .map((f: any) => ({ url: f.url, reason: String(f.reason || '下载失败') }))
    : []
  const next = replaceRemoteImages(md, mapping)
  return { markdown: next, localized: Object.keys(mapping).length, mapping, failed }
}
