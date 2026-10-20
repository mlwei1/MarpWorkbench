/**
 * marp 渲染结果里的 mermaid 代码块 → 内联 SVG 的替换/清理逻辑。
 *
 * marp-core 4.4.0 对 ```mermaid / ```mmd 围栏的真实输出（spike/mermaid/inspect-marp-html.mjs 实测）：
 *   <pre is="marp-pre" data-auto-scaling="downscale-only"><code class="language-mermaid">graph LR
 *     A --&gt; B
 *   </code></pre>
 * 代码内容是 HTML 实体转义后的纯文本（未知语言不经过 highlight.js token 化），
 * 因此提取 = 去标签（防御性：将来 marp 若加 hljs span 也不会串味）+ 实体反转义。
 */
import type { MermaidBlock } from './types'

/** <pre …><code …>…</code></pre>（mermaid/mmd 围栏） */
const PRE_CODE_SOURCE = '<pre\\b[^>]*>\\s*<code\\b([^>]*)>([\\s\\S]*?)<\\/code>\\s*<\\/pre>'
const CLASS_ATTR_SOURCE = '\\bclass\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')'
const MERMAID_LANG_RE = /(?:^|\s)language-(?:mermaid|mmd)(?:\s|$)/i

/** SVG 在 16:9 slide（1280×720）里的最大高度：避开主题上下 padding，保证不溢出 */
export const MERMAID_SVG_MAX_HEIGHT_PX = 560

const WRAPPER_STYLE = 'display:flex;justify-content:center;align-items:center;max-width:100%;margin:8px auto;'
const ERROR_STYLE =
  'font-size:14px;line-height:1.5;color:#b42318;background:#fef3f2;border:1px solid #fecdca;' +
  'border-radius:6px;padding:8px 12px;margin:8px 0;white-space:pre-wrap;word-break:break-word;'

/** 快速判断：html 里是否有 mermaid/mmd 代码块（无则完全不加载 bundle） */
export function hasMermaid(html: string): boolean {
  if (!html || html.indexOf('language-') === -1) return false
  const re = new RegExp('<code\\b[^>]*' + CLASS_ATTR_SOURCE + '[^>]*>', 'i')
  const match = re.exec(html)
  return !!match && MERMAID_LANG_RE.test(match[1] ?? match[2] ?? '')
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
}

/** HTML 实体反转义（单趟扫描，避免 &amp;lt; 被二次解码） */
export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|nbsp);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    return NAMED_ENTITIES[body] ?? whole
  })
}

/** 从 code 元素的 innerHTML 还原 mermaid 源码（去标签 + 反转义；不 trim，mermaid 容忍首尾空白） */
export function htmlToMermaidCode(innerHtml: string): string {
  const text = innerHtml.replace(/<[^>]*>/g, '')
  return decodeHtmlEntities(text).replace(/\r\n?/g, '\n')
}

/** 找出 html 里所有 mermaid 代码块（返回位置，供切片替换；不修改 html） */
export function findMermaidBlocks(html: string): MermaidBlock[] {
  const re = new RegExp(PRE_CODE_SOURCE, 'gi')
  const classRe = new RegExp(CLASS_ATTR_SOURCE, 'i')
  const blocks: MermaidBlock[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    const attrs = match[1] ?? ''
    const classMatch = classRe.exec(attrs)
    const className = classMatch ? (classMatch[1] ?? classMatch[2] ?? '') : ''
    if (!MERMAID_LANG_RE.test(className)) continue
    blocks.push({
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
      code: htmlToMermaidCode(match[2] ?? ''),
    })
  }
  return blocks
}

function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * 清理 mermaid 输出的 SVG：
 * - 去掉固定 px 的 width/height 属性，保留 viewBox（矢量缩放关键）；
 * - 保留 mermaid 自带的 max-width（= 图的自然尺寸，避免小图被拉伸）；
 * - 强制 width:100%; height:auto; max-height:560px，16:9 slide 内不横向/纵向溢出；
 * - 样式全部内联（预览 iframe / 打印页 / 导出 HTML 都不依赖应用 CSS）。
 */
export function cleanupMermaidSvg(svg: string): string {
  return svg.replace(/<svg\b([^>]*)>/i, (_whole, rawAttrs: string) => {
    let attrs = String(rawAttrs)
    const naturalWidth = /max-width\s*:\s*([\d.]+)px/i.exec(attrs)?.[1]
    attrs = attrs.replace(/\s(?:width|height)\s*=\s*"(?:\d+(?:\.\d+)?)(?:px)?"/gi, '')
    attrs = attrs.replace(/\sstyle\s*=\s*"(?:[^"]*)"/i, '').replace(/\sstyle\s*=\s*'[^']*'/i, '')
    const maxWidth = naturalWidth ? `${naturalWidth}px` : '100%'
    const style = `display:block;width:100%;height:auto;max-width:${maxWidth};max-height:${MERMAID_SVG_MAX_HEIGHT_PX}px;margin:0 auto;`
    return `<svg${attrs} width="100%" style="${style}">`
  })
}

/** 成功替换后的块：<div class="mwb-mermaid" data-mermaid-hash="<sha1(code)>"><svg…></div> */
export function buildMermaidWrapper(hash: string, cleanedSvg: string): string {
  return `<div class="mwb-mermaid" data-mermaid-hash="${escapeHtmlText(hash)}" style="${WRAPPER_STYLE}">${cleanedSvg}</div>`
}

/**
 * mermaid 渲染 id → 占位符：缓存里存的是模板，每次输出再换成新的唯一 id。
 *
 * 为什么：同一份 mermaid 代码在同一个 deck 里出现两次时，缓存命中的两个 SVG 会带着
 * 相同的 id（root id + marker/defs 的派生 id），同文档内重复 id 属非法 HTML，且
 * marker-end="url(#…)" 可能引用到错误的 defs。模板化后每次输出 id 都唯一。
 */
export const MERMAID_ID_TOKEN = '__MWB_MERMAID_ID__'

export function templateizeMermaidSvg(svg: string, renderId: string): string {
  return renderId ? svg.split(renderId).join(MERMAID_ID_TOKEN) : svg
}

export function materializeMermaidSvg(template: string, renderId: string): string {
  return template.split(MERMAID_ID_TOKEN).join(renderId)
}

/** 失败降级块：保留原始代码块 + 可读中文错误提示（不白屏、不影响其它块） */
export function buildMermaidErrorBlock(rawBlock: string, message: string): string {
  const short = String(message || '未知错误')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
  return `${rawBlock}\n<div class="mwb-mermaid-error" role="alert" style="${ERROR_STYLE}">图表渲染失败：${escapeHtmlText(short)}（已保留原始代码块）</div>`
}

/**
 * 通用替换骨架：blocks 里 resolve(block) 返回新 HTML 的块被替换，返回 null 表示保留原块。
 * 同步/异步两条路径共用（renderMermaidInHtml / applyMermaidCacheSync）。
 */
export function replaceMermaidBlocks(
  html: string,
  blocks: MermaidBlock[],
  resolve: (block: MermaidBlock) => string | null,
): string {
  if (!blocks.length) return html
  let out = ''
  let cursor = 0
  let replaced = false
  for (const block of blocks) {
    const replacement = resolve(block)
    if (replacement == null) continue
    out += html.slice(cursor, block.start) + replacement
    cursor = block.end
    replaced = true
  }
  return replaced ? out + html.slice(cursor) : html
}
