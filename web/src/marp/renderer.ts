/**
 * marp-core 浏览器渲染层（前端唯一渲染源，契约 §2.2）
 *
 * - 构建期由 scripts/build-marp-browser.mjs 产出 /marp-core.browser.js
 *   全局：window.MarpCoreBundle.MarpCore = { Marp, browser }
 * - 单例 Marp 实例；主题用 themeSet.add(css) 注册（服务端 /api/themes/:name/css 的 CSS）
 * - script:false + 手动 browser()（innerHTML 不执行内联脚本，实测坑）
 * - 离线：math 默认 mathjax；katexFontPath 指向本地 /katex/fonts/；emoji 关闭 twemoji；
 *   渲染结果再做一次外链清洗（去掉 http(s) @import / url()）。
 */
import type { RenderResult } from '../types'
import { getMarkdownTheme, setMarkdownTheme } from './frontmatter'

export interface MarpCoreModule {
  Marp: any
  browser: (target?: ParentNode) => any
}

let corePromise: Promise<MarpCoreModule> | null = null

export function loadMarpCore(): Promise<MarpCoreModule> {
  const existing = (window as any).MarpCoreBundle?.MarpCore as MarpCoreModule | undefined
  if (existing?.Marp) return Promise.resolve(existing)
  if (!corePromise) {
    corePromise = new Promise<MarpCoreModule>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = '/marp-core.browser.js'
      script.async = true
      script.onload = () => {
        const core = (window as any).MarpCoreBundle?.MarpCore as MarpCoreModule | undefined
        if (core?.Marp) resolve(core)
        else reject(new Error('marp-core.browser.js 已加载，但未暴露 MarpCoreBundle.MarpCore'))
      }
      script.onerror = () => {
        corePromise = null
        reject(new Error('无法加载 /marp-core.browser.js —— 请先运行 `pnpm run build:marp`'))
      }
      document.head.appendChild(script)
    })
  }
  return corePromise
}

const EXTERNAL_IMPORT_RE = /@import\s+(?:url\(\s*)?(?:['"]?)https?:\/\/[^;]*;?/gi
const EXTERNAL_URL_RE = /url\(\s*(?:['"]?)https?:\/\/[^)]*\)/gi

/** 去掉 CSS 里的外网依赖（离线验收要求 0 外网请求） */
export function sanitizeCss(css: string): string {
  return css.replace(EXTERNAL_IMPORT_RE, '').replace(EXTERNAL_URL_RE, 'none')
}

/** 去掉渲染结果里的 <script>（iframe sandbox 之外的第二道防线） */
export function sanitizeHtml(html: string): string {
  return html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
}

// ============================================================
// Mermaid 集成（M3，模块由 mermaid-eng 提供；未就绪时安全跳过）
// 契约：docs/UI_CONTRACT_M3.md §1.2/§1.3
// - 只识别 ```mermaid / ```mmd（marp-core 输出 <code class="language-mermaid">）
// - 无 mermaid 的 deck 不加载 mermaid bundle（懒加载，懒 import 模块）
// ============================================================

export interface MermaidModule {
  hasMermaid?: (html: string) => boolean
  renderMermaidInHtml?: (html: string) => Promise<string>
  applyMermaidCacheSync?: (html: string) => string
}

type MermaidLoader = () => Promise<MermaidModule>

// glob 目录下所有可能的入口文件；模块文件尚未落盘时返回 {}，不会导致 build 失败
const mermaidModules = import.meta.glob('../mermaid/*.{ts,js,mjs}') as Record<string, MermaidLoader>

function pickMermaidLoader(): MermaidLoader | null {
  const preferred = [
    '../mermaid/index.ts',
    '../mermaid/index.js',
    '../mermaid/index.mjs',
    '../mermaid/mermaid.ts',
    '../mermaid/main.ts',
  ]
  for (const key of preferred) {
    if (mermaidModules[key]) return mermaidModules[key]
  }
  return null
}

const MERMAID_MARKUP_RE = /language-(?:mermaid|mmd)\b|class="[^"]*mermaid\b/
export function hasMermaidMarkup(html: string): boolean {
  return MERMAID_MARKUP_RE.test(html || '')
}

export interface RenderOutput extends RenderResult {
  usedTheme: string
  fallback: boolean
}

export class MarpRenderer {
  private marp: any = null
  private core: MarpCoreModule | null = null
  private initPromise: Promise<void> | null = null
  private mermaidModule: MermaidModule | null = null
  private mermaidLoader: MermaidLoader | null | undefined = undefined
  private mermaidPromise: Promise<MermaidModule | null> | null = null

  init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.doInit()
    return this.initPromise
  }

  private async doInit(): Promise<void> {
    this.core = await loadMarpCore()
    this.marp = new this.core.Marp({
      html: true,
      script: false,
      minifyCSS: true,
      // 默认 MathJax（离线无字体依赖）；用户显式 math: katex 时用本地字体
      math: { lib: 'mathjax', katexFontPath: '/katex/fonts/' },
      // 不用 twemoji CDN（离线要求）
      emoji: { shortcode: true, unicode: false },
    })
  }

  get isReady(): boolean {
    return !!this.marp
  }

  get coreModule(): MarpCoreModule | null {
    return this.core
  }

  hasTheme(name: string): boolean {
    return !!this.marp?.themeSet?.has(name)
  }

  registerTheme(name: string, css: string): boolean {
    if (!this.marp) return false
    const clean = sanitizeCss(css)
    // 主题元信息既可能是单行 /* @theme x */，也可能是多行注释
    // （主题文件普遍写成 /*\n * @theme x\n */），因此不能用 ^/*\s*@theme 的严格匹配。
    if (!/[/*][\s\S]{0,300}?@theme\s+[A-Za-z0-9_-]+/.test(clean)) {
      console.warn(`[marp] 主题 ${name} 的 CSS 缺少 /* @theme */ 元信息，已跳过`)
      return false
    }
    try {
      this.marp.themeSet.add(clean)
      return true
    } catch (err) {
      console.warn(`[marp] 主题 ${name} 注册失败`, err)
      return false
    }
  }

  listRegisteredThemes(): { name: string; meta: Record<string, any> }[] {
    if (!this.marp) return []
    return [...this.marp.themeSet.themes()].map((t: any) => ({
      name: t.name as string,
      meta: { ...(t.meta as Record<string, any>) },
    }))
  }

  getThemeCss(name: string): string | null {
    const theme = this.marp?.themeSet?.get(name)
    return theme?.css ?? null
  }

  /**
   * 渲染 Markdown 为 {html, css, comments, width, height}。
   * options.theme：临时覆盖 front-matter 的 theme（用于主题画廊试穿）。
   * 主题未注册时回退 default 并标记 fallback（不修改用户内容）。
   */
  render(markdown: string, options: { theme?: string } = {}): RenderOutput {
    if (!this.marp) throw new Error('渲染器尚未初始化')
    let md = markdown
    const requested = options.theme || getMarkdownTheme(md) || 'default'
    let usedTheme = requested
    let fallback = false

    if (!this.hasTheme(requested)) {
      usedTheme = 'default'
      fallback = requested !== 'default'
      md = setMarkdownTheme(md, 'default')
    } else if (options.theme && getMarkdownTheme(md) !== options.theme) {
      md = setMarkdownTheme(md, options.theme)
    }

    const res = this.marp.render(md)
    const html = sanitizeHtml(res.html as string)
    const css = sanitizeCss(res.css as string)
    const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(html)
    const width = vb ? Math.round(parseFloat(vb[1])) : 1280
    const height = vb ? Math.round(parseFloat(vb[2])) : 720
    const comments: string[] = (res.comments as string[][]).map((arr) => arr.join('\n').trim())
    return { html, css, comments, width, height, usedTheme, fallback }
  }

  /** 主题画廊缩略图：按指定主题渲染当前 deck（不改动前后文） */
  renderWithTheme(markdown: string, theme: string): RenderOutput {
    return this.render(markdown, { theme })
  }

  // ---------------- Mermaid（M3） ----------------

  private async ensureMermaid(): Promise<MermaidModule | null> {
    if (this.mermaidModule) return this.mermaidModule
    if (!this.mermaidPromise) {
      this.mermaidPromise = (async () => {
        if (this.mermaidLoader === undefined) this.mermaidLoader = pickMermaidLoader()
        if (!this.mermaidLoader) return null
        try {
          const mod = await this.mermaidLoader()
          this.mermaidModule = mod
          return mod
        } catch (err) {
          console.warn('[marp] mermaid 模块加载失败，已跳过图表渲染', err)
          this.mermaidLoader = null
          return null
        }
      })()
    }
    return this.mermaidPromise
  }

  /**
   * 异步渲染：同步 render + mermaid 代码块 → SVG（懒加载模块；无 mermaid 的 deck 不加载）。
   * 任何一步失败都回退到同步结果，保证编辑器可用。
   */
  async renderAsync(markdown: string, options: { theme?: string } = {}): Promise<RenderOutput> {
    const base = this.render(markdown, options)
    if (!hasMermaidMarkup(base.html)) return base
    const mod = await this.ensureMermaid()
    if (!mod?.renderMermaidInHtml) return base
    try {
      const html = await mod.renderMermaidInHtml(base.html)
      return { ...base, html: sanitizeHtml(html) }
    } catch (err) {
      console.warn('[marp] mermaid 渲染失败（保留代码块）', err)
      return base
    }
  }

  /** 同步路径（画廊缩略图等）：用已渲染过的 mermaid 缓存替换代码块；缓存未命中保持原样 */
  applyMermaidCacheSync(html: string): string {
    if (!html || !hasMermaidMarkup(html) || !this.mermaidModule?.applyMermaidCacheSync) return html
    try {
      return this.mermaidModule.applyMermaidCacheSync(html)
    } catch (err) {
      console.warn('[marp] mermaid 缓存替换失败', err)
      return html
    }
  }

  /** mermaid 模块是否已加载（e2e/调试用） */
  get mermaidReady(): boolean {
    return !!this.mermaidModule
  }

  /** 应用 marp-core 浏览器 helper（SVG polyfill / auto-scaling / 自定义元素） */
  applyBrowserHelper(target: ParentNode): boolean {
    try {
      this.core?.browser(target)
      return true
    } catch (err) {
      console.warn('[marp] browser() helper 执行失败', err)
      return false
    }
  }
}

export const renderer = new MarpRenderer()
