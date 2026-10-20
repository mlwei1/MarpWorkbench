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

export interface RenderOutput extends RenderResult {
  usedTheme: string
  fallback: boolean
}

export class MarpRenderer {
  private marp: any = null
  private core: MarpCoreModule | null = null
  private initPromise: Promise<void> | null = null

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
