// spike 测试入口：把 editable 模块暴露到 window，供 puppeteer 调用（esbuild 打包，TS→IIFE）
import { measureDeckForEditablePptx, assembleEditablePptx } from '../../../web/src/export/editable/index'
import { renderMermaidInHtml } from '../../../web/src/mermaid/index'

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(binary)
}

;(window as any).__MwbHarness = {
  /** 可选：把 ```mermaid 代码块渲染成内联 SVG（模拟 EditView.renderForExport 的 Mermaid 步骤） */
  renderMermaid: async (html: string) => {
    const started = performance.now()
    const next = await renderMermaidInHtml(html)
    return { html: next, ms: performance.now() - started, changed: next !== html }
  },
  measure: async (html: string, css: string, opts: any) => {
    const started = performance.now()
    const deck = await measureDeckForEditablePptx(html, css, opts)
    return { deck, ms: performance.now() - started }
  },
  assemble: async (deck: any, backgrounds: string[], opts: any) => {
    const PptxGenJS = (window as any).PptxGenJS
    if (!PptxGenJS) throw new Error('window.PptxGenJS 未加载（/pptxgen.bundle.js）')
    const progressLog: { pct: number; label: string }[] = []
    const started = performance.now()
    const result = await assembleEditablePptx(deck, backgrounds, {
      title: opts?.title,
      comments: opts?.comments,
      pptxgenjs: PptxGenJS,
      onProgress: (pct: number, label: string) => progressLog.push({ pct, label }),
    })
    const buffer = await result.blob.arrayBuffer()
    return {
      base64: bytesToBase64(new Uint8Array(buffer)),
      stats: result.stats,
      ms: performance.now() - started,
      progressLog,
    }
  },
  version: 'm4-editable-spike-1',
}

;(window as any).__MwbHarness.ready = true
