/**
 * Mermaid 图表渲染模块 —— 公共入口（契约 §1.2）
 *
 * 职责边界：只负责「把 marp 渲染出的 HTML 里的 ```mermaid / ```mmd 代码块换成内联 SVG」。
 * marp-core 的 render/renderer.ts/EditView 集成由 frontend-core 负责；本模块没有任何 npm 依赖
 * （mermaid 5MB 只以 IIFE 形式懒加载 /mermaid.browser.js，绝不进 Vite 主 bundle）。
 *
 * 用法（marp-tech 集成）：
 *   import { hasMermaid, renderMermaidInHtml, applyMermaidCacheSync, renderMermaidPreview } from '../mermaid'
 *   const html2 = hasMermaid(html) ? await renderMermaidInHtml(html) : html
 *   // 画廊缩略图等同步路径（主预览已热缓存）：
 *   const thumbHtml = applyMermaidCacheSync(html)
 *   // 插入/编辑对话框实时预览（单个代码块 → 清理后的 SVG，不写缓存）：
 *   const svg = await renderMermaidPreview(code)
 *
 * 尺寸（M5 契约 `docs/UI_CONTRACT_M5_MERMAID.md` §1）：
 *   - 默认取消 mermaid 自然宽度上限 → 小图放大到容器宽度（用户反馈"图太小"的修复）；
 *   - 代码块前 5 行内可写 `%% mwb-size: s|m|l|xl|70%|900px`（见 size.ts）；
 *   - 渲染两条路径都会 parseMermaidSize(block.code) 后传给 cleanupMermaidSvg。
 *
 * 缓存：hash(code) = sha1(code)（同步实现见 hash.ts）→ mermaid 原始 SVG 模板（render id 已占位化，
 *   尺寸样式在输出时按指令套用）。
 *   - 异步路径命中缓存直接复用（主题画廊/重复渲染不重复 mermaid.render）；
 *   - 同步路径只替换已缓存块，未命中保留代码块（不抛错）；
 *   - 输出时再套上新的唯一 id（同一代码块出现多次也不会重复 DOM id）。
 */
import { createMermaidRenderId, loadMermaid, renderMermaidSvg, resetMermaidLoaderForTest } from './bundle'
import { sha1Hex } from './hash'
import {
  buildMermaidErrorBlock,
  buildMermaidWrapper,
  cleanupMermaidSvg,
  findMermaidBlocks,
  hasMermaid,
  materializeMermaidSvg,
  replaceMermaidBlocks,
  templateizeMermaidSvg,
} from './replace'
import { parseMermaidSize } from './size'
import type { MermaidBlock } from './types'

export { hasMermaid } from './replace'
export { loadMermaid } from './bundle'
export { MERMAID_BUNDLE_URL, MERMAID_INIT_CONFIG } from './bundle'
export { MERMAID_SVG_MAX_HEIGHT_PX } from './replace'
export {
  findMermaidSizeDirective,
  getMermaidSizeOptions,
  MERMAID_SIZE_SCAN_LINES,
  parseMermaidSize,
  parseMermaidSizeValue,
  serializeMermaidSize,
  stripMermaidSizeDirective,
} from './size'
export type { MermaidSize, MermaidSizePreset } from './size'
export type { MermaidBlock } from './types'

/** hash(code) → mermaid 原始 SVG 模板（render id 已占位化；尺寸样式在输出时套用） */
const svgCache = new Map<string, string>()
/** 上限防止极端场景（大量不同 mermaid 块）内存无界增长 */
const MAX_CACHE_ENTRIES = 500

function cacheGet(code: string): string | undefined {
  return svgCache.get(sha1Hex(code))
}

function cacheSet(code: string, cleanedSvg: string): void {
  if (svgCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = svgCache.keys().next().value
    if (oldest !== undefined) svgCache.delete(oldest)
  }
  svgCache.set(sha1Hex(code), cleanedSvg)
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || String(err)
  return String(err ?? '未知错误')
}

/**
 * 把 HTML 里的 mermaid/mmd 代码块替换为内联 SVG（异步）。
 * - 无 mermaid → 原样返回（不加载任何资源）；
 * - 单块失败 → 保留该代码块 + `<div class="mwb-mermaid-error">图表渲染失败：…</div>`，其余块照常渲染；
 * - bundle 加载失败 → 所有块降级为「代码块 + 提示」，不抛错（预览绝不白屏）。
 */
export async function renderMermaidInHtml(html: string): Promise<string> {
  if (!html || !hasMermaid(html)) return html
  const blocks = findMermaidBlocks(html)
  if (!blocks.length) return html

  const failAll = (message: string): string =>
    replaceMermaidBlocks(html, blocks, (block) => buildMermaidErrorBlock(block.raw, message))

  // 先确认 bundle 可用（加载失败时统一降级，避免每块都重复等一次加载）
  try {
    await loadMermaid()
  } catch (err) {
    return failAll(`Mermaid 组件加载失败：${errorMessage(err)}`)
  }

  // 逐块渲染（串行，mermaid 内部也是队列）；结果先收集，再一次性切片替换
  const results = new Map<MermaidBlock, { template?: string; error?: string }>()
  for (const block of blocks) {
    const cached = cacheGet(block.code)
    if (cached) {
      results.set(block, { template: cached })
      continue
    }
    try {
      const renderId = createMermaidRenderId()
      const svg = await renderMermaidSvg(renderId, block.code)
      // 缓存模板：id 占位，输出时再换唯一 id（同一代码块出现多次也不会撞 id）；
      // 尺寸样式不缓存，输出时按 parseMermaidSize(block.code) 生成（见 cleanupMermaidSvg）
      const template = templateizeMermaidSvg(svg, renderId)
      cacheSet(block.code, template)
      results.set(block, { template })
    } catch (err) {
      // 单块失败：保留原代码块 + 可读提示，不影响其它块
      results.set(block, { error: errorMessage(err) })
    }
  }

  return replaceMermaidBlocks(html, blocks, (block) => {
    const result = results.get(block)
    if (!result) return null
    if (result.error) return buildMermaidErrorBlock(block.raw, result.error)
    if (!result.template) return buildMermaidErrorBlock(block.raw, 'Mermaid 渲染结果为空')
    const svg = cleanupMermaidSvg(materializeMermaidSvg(result.template, createMermaidRenderId()), parseMermaidSize(block.code))
    return buildMermaidWrapper(sha1Hex(block.code), svg)
  })
}

/**
 * 同步版本：只用已缓存的 SVG 替换（画廊缩略图/主题编辑器预览等同步渲染路径）。
 * 缓存未命中的块保留原代码块（不报错）；主预览渲染后缓存已热即可全部命中。
 */
export function applyMermaidCacheSync(html: string): string {
  if (!html || !hasMermaid(html)) return html
  const blocks = findMermaidBlocks(html)
  if (!blocks.length) return html
  return replaceMermaidBlocks(html, blocks, (block) => {
    const template = cacheGet(block.code)
    if (!template) return null
    const svg = cleanupMermaidSvg(materializeMermaidSvg(template, createMermaidRenderId()), parseMermaidSize(block.code))
    return buildMermaidWrapper(sha1Hex(block.code), svg)
  })
}

/**
 * 供「图表插入/编辑」对话框做实时预览（契约 M5 §1.3）：
 * 渲染单个 mermaid 代码块为清理后的 `<svg>` 字符串；不写全局缓存（预览代码频繁变化，缓存无意义且会污染）。
 * - 无代码 → 抛「Mermaid 代码为空」；
 * - bundle 加载失败 / 语法错误 → 抛带中文前缀的可读 Error（对话框显示错误提示用）。
 */
export async function renderMermaidPreview(code: string): Promise<string> {
  const source = String(code ?? '')
  if (!source.trim()) throw new Error('Mermaid 代码为空，无法预览')
  try {
    const renderId = createMermaidRenderId()
    const svg = await renderMermaidSvg(renderId, source)
    return cleanupMermaidSvg(svg, parseMermaidSize(source))
  } catch (err) {
    throw new Error(`Mermaid 渲染失败：${errorMessage(err)}`)
  }
}

/** 清空 hash(code) → SVG 缓存（deck 切换/资源刷新时调用；不影响已渲染 DOM） */
export function clearMermaidCache(): void {
  svgCache.clear()
}

/** 测试用：清缓存 + 重置懒加载状态（bundle 已注入的 script 无法卸载，会重新探测全局） */
export function resetMermaidForTest(): void {
  svgCache.clear()
  resetMermaidLoaderForTest()
}

/** （测试/诊断）当前缓存条目数 */
export function mermaidCacheSize(): number {
  return svgCache.size
}
