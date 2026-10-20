/**
 * mermaid bundle 的懒加载与初始化（离线、本地打包、全局 MermaidBundle）
 *
 * - 只有 hasMermaid(html) 为 true 时才会走到这里 → 无 mermaid 的 deck 不加载 5MB bundle（验收 §1.4.4）。
 * - bundle 由 scripts/build-mermaid-bundle.mjs 产出到 web/public/mermaid.browser.js（IIFE，全局 MermaidBundle）。
 * - mermaid 的 render 会做 DOM 测量，因此：
 *   1) 必须等 document.body 可用；
 *   2) 用一个离屏容器承接测量 DOM（不污染页面，也不被 visibility:hidden 影响测量）；
 *   3) 所有 render 串行执行（mermaid v12 内部也是队列，这里再串行一层，避免共享容器竞态）。
 */
import type { MermaidApi } from './types'

export const MERMAID_BUNDLE_URL = '/mermaid.browser.js'

/**
 * mermaid 初始化配置（契约 §1.2 建议值 + 打印实测结论）
 *
 * - startOnLoad:false —— 由我们显式 render，不扫描 DOM
 * - securityLevel:'strict' —— 禁用 click 交互/内联 HTML 注入，离线工具最稳
 * - htmlLabels:false —— 标签用 <text> 绘制（纯矢量）：PDF 打印清晰、可被 pdf 文本层提取；
 *   htmlLabels:true 会走 foreignObject，打印/PPTX 位图链路存在字体渲染风险（实测见 docs/dev/mermaid.md §6）
 * - fontFamily：Windows/macOS 中文系统字体栈，不引用任何网络字体
 * - suppressErrorRendering:true —— 渲染失败不往 document 里插入 mermaid 自带错误图（我们保留代码块 + 中文提示）
 */
export const MERMAID_INIT_CONFIG: Record<string, unknown> = {
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'default',
  htmlLabels: false,
  fontFamily: 'Microsoft YaHei, PingFang SC, Segoe UI, sans-serif',
  flowchart: { useMaxWidth: true },
  sequence: { useMaxWidth: true, wrap: false },
  suppressErrorRendering: true,
}

let loadPromise: Promise<MermaidApi> | null = null
let initialized = false
let measureContainer: HTMLDivElement | null = null
let renderChain: Promise<unknown> = Promise.resolve()
let idCounter = 0

function readBundleGlobal(): MermaidApi | null {
  if (typeof window === 'undefined') return null
  const bundle = window.MermaidBundle
  const api = bundle?.default ?? bundle?.mermaid
  return api && typeof api.render === 'function' ? api : null
}

function ensureInitialized(api: MermaidApi): void {
  if (initialized) return
  api.initialize({ ...MERMAID_INIT_CONFIG })
  initialized = true
}

function waitForBody(): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve()
  if (document.body) return Promise.resolve()
  return new Promise((resolve) => {
    document.addEventListener('DOMContentLoaded', () => resolve(), { once: true })
  })
}

/** 离屏测量容器（mermaid 需要 DOM 计算节点/文本尺寸） */
function getMeasureContainer(): HTMLDivElement | null {
  if (typeof document === 'undefined' || !document.body) return null
  if (!measureContainer || !measureContainer.isConnected) {
    measureContainer = document.createElement('div')
    measureContainer.className = 'mwb-mermaid-measure'
    measureContainer.setAttribute('aria-hidden', 'true')
    // 不写 visibility:hidden / display:none：部分浏览器下 getBBox 会返回 0，导致图尺寸错误
    measureContainer.style.cssText =
      'position:absolute;left:-100000px;top:0;width:1280px;height:auto;overflow:visible;pointer-events:none;opacity:0;'
    document.body.appendChild(measureContainer)
  }
  return measureContainer
}

/** 懒加载 /mermaid.browser.js 并完成 initialize（重复调用复用同一 Promise） */
export function loadMermaidApi(): Promise<MermaidApi> {
  const existing = readBundleGlobal()
  if (existing) {
    ensureInitialized(existing)
    return Promise.resolve(existing)
  }
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('当前环境没有 DOM，无法加载 mermaid'))
  }
  if (!loadPromise) {
    loadPromise = waitForBody().then(
      () =>
        new Promise<MermaidApi>((resolve, reject) => {
          const script = document.createElement('script')
          script.src = MERMAID_BUNDLE_URL
          script.async = true
          script.onload = () => {
            const api = readBundleGlobal()
            if (!api) {
              loadPromise = null
              reject(new Error('mermaid.browser.js 已加载，但未暴露 window.MermaidBundle（请检查构建产物）'))
              return
            }
            try {
              ensureInitialized(api)
              resolve(api)
            } catch (err) {
              loadPromise = null
              reject(err)
            }
          }
          script.onerror = () => {
            loadPromise = null
            reject(new Error('无法加载 /mermaid.browser.js —— 请先运行 `node scripts/build-mermaid-bundle.mjs`'))
          }
          document.head.appendChild(script)
        }),
    )
  }
  return loadPromise
}

/** 契约 API：仅保证 bundle 就绪（首次会下载 ~5MB 的本地 bundle 并初始化） */
export async function loadMermaid(): Promise<void> {
  await loadMermaidApi()
}

export function isMermaidLoaded(): boolean {
  return !!readBundleGlobal()
}

/** 唯一 ID：同页多图互不冲突（mermaid 用 id 生成内部 defs/箭头 marker 的命名空间） */
export function createMermaidRenderId(): string {
  idCounter += 1
  const rand = Math.random().toString(36).slice(2, 8)
  return `mwb-mermaid-${idCounter}-${rand}`
}

/** 串行执行（共享测量容器；mermaid v12 自身也串行，这里再兜一层） */
function enqueueRender<T>(task: () => Promise<T>): Promise<T> {
  const run = renderChain.then(task, task)
  renderChain = run.catch(() => undefined)
  return run
}

/**
 * 渲染一段 mermaid 源码为 SVG 字符串。
 * 失败时抛错（由 renderMermaidInHtml 降级成「保留代码块 + 可读提示」）。
 */
export function renderMermaidSvg(id: string, code: string): Promise<string> {
  return enqueueRender(async () => {
    const api = await loadMermaidApi()
    const container = getMeasureContainer()
    try {
      const result = await api.render(id, code, container ?? undefined)
      const svg = result && typeof result.svg === 'string' ? result.svg : ''
      if (!svg || !svg.includes('<svg')) throw new Error('mermaid.render 未返回 SVG')
      return svg
    } finally {
      if (container) container.innerHTML = ''
    }
  })
}

/** 测试/异常恢复用：清掉加载状态（已注入的 script 无法卸载，但可重新探测全局） */
export function resetMermaidLoaderForTest(): void {
  loadPromise = null
  initialized = false
  renderChain = Promise.resolve()
  idCounter = 0
  if (measureContainer?.isConnected) measureContainer.remove()
  measureContainer = null
}
