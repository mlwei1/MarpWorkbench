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
import type { MermaidSize } from './size'

/** <pre …><code …>…</code></pre>（mermaid/mmd 围栏） */
const PRE_CODE_SOURCE = '<pre\\b[^>]*>\\s*<code\\b([^>]*)>([\\s\\S]*?)<\\/code>\\s*<\\/pre>'
const CLASS_ATTR_SOURCE = '\\bclass\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')'
const MERMAID_LANG_RE = /(?:^|\s)language-(?:mermaid|mmd)(?:\s|$)/i

/** 默认最大高度（px）：16:9 slide（1280×720）内容区约 563px，留余量取 560（契约 M5 §1.1） */
export const MERMAID_SVG_MAX_HEIGHT_PX = 560

// 关键：width:100%。Marp 主题的 section 常是 `display:flex; align-items:center` 的纵向布局，
// 子项宽度会 shrink-to-fit；只写 max-width:100% 时 mermaid 会按自然宽度（如 300px）显示，
// 这正是用户反馈"图太小"的根因（M5 验收实测 chartW=300 / slideW=1280）。
const WRAPPER_STYLE = 'display:flex;justify-content:center;align-items:center;width:100%;max-width:100%;margin:8px auto;'
const ERROR_STYLE =
  'font-size:14px;line-height:1.5;color:#b42318;background:#fef3f2;border:1px solid #fecdca;' +
  'border-radius:6px;padding:8px 12px;margin:8px 0;white-space:pre-wrap;word-break:break-word;'

/** 快速判断：html 里是否有 mermaid/mmd 代码块（无则完全不加载 bundle） */
export function hasMermaid(html: string): boolean {
  if (!html || html.indexOf('language-') === -1) return false
  // 必须扫描所有 code 块：deck 里可能先出现 js/ts 代码块，再出现 mermaid（M4 发现的原实现只看首个 code 块）
  const re = new RegExp('<code\\b[^>]*' + CLASS_ATTR_SOURCE + '[^>]*>', 'gi')
  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    if (MERMAID_LANG_RE.test(match[1] ?? match[2] ?? '')) return true
  }
  return false
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
 * 清理 mermaid 输出的 SVG（M5：默认放大 + 支持每图尺寸）。
 *
 * - 去掉固定 px 的 width/height 属性，保留 viewBox（矢量缩放关键）；
 * - 去掉 mermaid 自带的自然宽度上限（旧版保留 max-width:<自然宽度>px，导致 2 节点小图只有 ~300px）；
 * - 默认：`width:100%; height:auto; max-width:100%; max-height:560px` → 小图放大到容器宽度、文字等比放大；
 * - 传入 size 时按契约映射：s=60%/480、m=80%/540、l=100%/560、xl=100%/640、自定义 %/px（max-height 560）；
 * - 样式全部内联（预览 iframe / 打印页 / 导出 HTML 都不依赖应用 CSS）。
 */
export function cleanupMermaidSvg(svg: string, size?: MermaidSize): string {
  const maxWidth = size?.maxWidth || '100%'
  const maxHeightPx = size?.maxHeightPx || MERMAID_SVG_MAX_HEIGHT_PX
  return svg.replace(/<svg\b([^>]*)>/i, (_whole, rawAttrs: string) => {
    let attrs = String(rawAttrs)
    attrs = attrs.replace(/\s(?:width|height)\s*=\s*"(?:\d+(?:\.\d+)?)(?:px)?"/gi, '')
    attrs = attrs.replace(/\sstyle\s*=\s*"(?:[^"]*)"/i, '').replace(/\sstyle\s*=\s*'[^']*'/i, '')
    const style = `display:block;width:100%;height:auto;max-width:${maxWidth};max-height:${maxHeightPx}px;margin:0 auto;`
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
