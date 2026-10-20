import { reactive } from 'vue'
import type { BrowserInfo, HealthInfo, RecentItem, Settings, ThemeMeta, WorkspaceInfo } from '../types'
import * as API from '../api'
import { isMockMode } from '../api/client'
import { readableError } from '../api/errors'
import { renderer } from '../marp/renderer'

export const app = reactive({
  ready: false,
  booting: false,
  bootError: '',
  mock: isMockMode(),
  health: null as HealthInfo | null,
  settings: null as Settings | null,
  workspace: null as WorkspaceInfo | null,
  recent: [] as RecentItem[],
  browser: null as BrowserInfo | null,
  themes: [] as ThemeMeta[],
  themesLoaded: false,
})

// ---------------- Toast ----------------
export interface ToastItem {
  id: number
  text: string
  type: 'info' | 'success' | 'error'
}
export const toasts = reactive<ToastItem[]>([])
let toastSeq = 1

export function toast(text: string, type: ToastItem['type'] = 'info', duration = 3200): void {
  const id = toastSeq++
  toasts.push({ id, text, type })
  window.setTimeout(() => {
    const i = toasts.findIndex((t) => t.id === id)
    if (i >= 0) toasts.splice(i, 1)
  }, duration)
}

// ---------------- 主题 ----------------
const BUILTIN_THEME_INFO: Record<string, { displayName: string; tags: string[] }> = {
  default: { displayName: 'Default（内置）', tags: ['内置', '通用'] },
  gaia: { displayName: 'Gaia（内置）', tags: ['内置', '经典'] },
  uncover: { displayName: 'Uncover（内置）', tags: ['内置', '极简'] },
}

function mergeThemes(apiThemes: ThemeMeta[]): ThemeMeta[] {
  const registered = renderer.listRegisteredThemes()
  const byName = new Map(apiThemes.map((t) => [t.name, t]))
  const result: ThemeMeta[] = registered.map((r) => {
    const meta = byName.get(r.name)
    const builtin = BUILTIN_THEME_INFO[r.name]
    return {
      name: r.name,
      displayName: meta?.displayName || builtin?.displayName || r.name,
      tags: meta?.tags || builtin?.tags || [],
      source: meta?.source || 'builtin',
      author: meta?.author,
      description: meta?.description,
      size: (r.meta.size as string[]) || undefined,
      autoScaling: r.meta['auto-scaling'] === 'true' || r.meta['auto-scaling'] === true,
      css: false,
    }
  })
  // 服务端列出、但注册失败的 user 主题也展示（提示用）
  for (const t of apiThemes) {
    if (!result.some((r) => r.name === t.name)) result.push(t)
  }
  return result
}

export async function refreshThemes(): Promise<void> {
  await renderer.init()
  let apiThemes: ThemeMeta[] = []
  try {
    apiThemes = (await API.getThemes()).themes
  } catch (err) {
    console.warn('[themes] 拉取主题列表失败', readableError(err))
  }
  for (const t of apiThemes) {
    if (renderer.hasTheme(t.name)) continue
    try {
      // 注意：ThemeMeta.css 语义 =「服务端是否内联 CSS」（契约 §1.5）。
      // M1 服务端统一返回 false，CSS 需通过 GET /api/themes/:name/css 单独拉取；
      // 不能因为 css === false 就跳过，否则自定义主题永远注册不进来（会回退 default）。
      const css = await API.getThemeCss(t.name)
      renderer.registerTheme(t.name, css)
    } catch (err) {
      console.warn(`[themes] 拉取主题 ${t.name} 的 CSS 失败`, readableError(err))
    }
  }
  app.themes = mergeThemes(apiThemes)
  app.themesLoaded = true
}

export function themeExists(name: string | null | undefined): boolean {
  return !!name && app.themes.some((t) => t.name === name)
}

/** 新 deck 默认主题：settings.defaultTheme → business-blue → default */
export function defaultTheme(): string {
  const wanted = app.settings?.defaultTheme
  if (wanted && themeExists(wanted)) return wanted
  if (themeExists('business-blue')) return 'business-blue'
  return 'default'
}

export function themeDisplayName(name: string): string {
  return app.themes.find((t) => t.name === name)?.displayName || name
}

// ---------------- Bootstrap ----------------
let bootstrapPromise: Promise<void> | null = null

export function ensureBootstrap(): Promise<void> {
  if (!bootstrapPromise) bootstrapPromise = bootstrap()
  return bootstrapPromise
}

async function bootstrap(): Promise<void> {
  if (app.ready) return
  app.mock = isMockMode()
  app.booting = true
  try {
    const [health, settings] = await Promise.all([API.getHealth(), API.getSettings()])
    app.health = health
    app.settings = settings
    await renderer.init()
    await Promise.all([reloadWorkspace(), loadBrowser(), refreshThemes()])
    app.ready = true
  } catch (err) {
    app.bootError = readableError(err)
    console.error('[bootstrap] 初始化失败', err)
  } finally {
    app.booting = false
  }
}

export async function reloadWorkspace(): Promise<void> {
  const [workspace, recent] = await Promise.all([API.getWorkspace(), API.getRecent()])
  app.workspace = workspace
  app.recent = recent
}

export async function loadBrowser(): Promise<void> {
  try {
    app.browser = await API.getBrowser()
  } catch {
    app.browser = null
  }
}

export async function reloadSettings(): Promise<void> {
  app.settings = await API.getSettings()
}
