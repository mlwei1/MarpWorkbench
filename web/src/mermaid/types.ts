/**
 * mermaid 浏览器 bundle 的全局类型（构建产物：web/public/mermaid.browser.js，见 scripts/build-mermaid-bundle.mjs）
 *
 * IIFE 全局：window.MermaidBundle = { default: MermaidApi, mermaid: MermaidApi }
 * 契约 §1.2 约定调用 `await MermaidBundle.default.render(id, code)`。
 */

export interface MermaidRenderResult {
  /** 渲染出的 <svg>…</svg> 字符串 */
  svg: string
  /** 图类型，如 'flowchart' / 'sequence'；旧版本可能没有 */
  diagramType?: string
  /** mermaid 交互绑定函数（我们做静态图，不调用） */
  bindFunctions?: (element: Element) => void
}

export interface MermaidApi {
  initialize(config?: Record<string, unknown>): void
  render(id: string, text: string, container?: Element | string): Promise<MermaidRenderResult>
  parse?(text: string, options?: Record<string, unknown>): unknown
  detectType?(text: string, options?: Record<string, unknown>): string
}

export interface MermaidBundleGlobal {
  default: MermaidApi
  mermaid?: MermaidApi
}

declare global {
  interface Window {
    MermaidBundle?: MermaidBundleGlobal
  }
}

/** 从内部 HTML 中提取 mermaid 代码块的元信息 */
export interface MermaidBlock {
  /** 整个 <pre>…</pre> 在 html 中的起止位置 */
  start: number
  end: number
  /** 原始块 HTML（错误时原样保留） */
  raw: string
  /** HTML 实体反转义后的 mermaid 源码 */
  code: string
}
