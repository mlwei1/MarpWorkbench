/**
 * useThemes —— 主题元数据 / CSS 加载与注册（themes 成员提供，可选使用）
 *
 * 说明（与 frontend-core 的约定，见 docs/dev/themes.md）：
 * - 前端 marp 实例与主题 CSS 注册由 frontend-core 的 `marp/renderer.ts` 负责；
 *   本文件只是**自包含的备用通道**（不依赖 web/src/api/client.ts）：
 *     · ThemeGallery 缩略图兜底渲染需要 CSS 时用 `loadThemeCss()`
 *     · 独立页面/测试需要一次性注册主题时用 `registerThemesInto(marp)`
 * - 鉴权遵循契约 §2.1：token 存 sessionStorage('mwb.token')，请求头 X-MWB-Token。
 * - M1 的正式数据流仍以 `web/src/api` + `stores/app.ts` 为准；二者结果一致。
 */
import { ref } from 'vue'
import type { ThemeMeta } from '../types'

const TOKEN_KEY = 'mwb.token'

/** 读取当前会话 token（兼容首开 URL 与 sessionStorage） */
export function getToken(): string {
  try {
    const fromUrl = new URL(window.location.href).searchParams.get('token')
    if (fromUrl) return fromUrl
  } catch {
    /* ignore */
  }
  return window.sessionStorage.getItem(TOKEN_KEY) ?? ''
}

async function mwbFetch(path: string): Promise<Response> {
  const res = await fetch(`/api${path}`, {
    headers: { 'X-MWB-Token': getToken() },
  })
  if (!res.ok) {
    let message = `请求失败（HTTP ${res.status}）`
    try {
      const body = (await res.json()) as { error?: { message?: string } }
      if (body?.error?.message) message = body.error.message
    } catch {
      /* ignore */
    }
    throw new Error(message)
  }
  return res
}

/** GET /api/themes → ThemeMeta[] */
export async function loadThemes(): Promise<ThemeMeta[]> {
  const res = await mwbFetch('/themes')
  const data = (await res.json()) as { themes?: ThemeMeta[] }
  return Array.isArray(data.themes) ? data.themes : []
}

/** GET /api/themes/:name/css → CSS 原文 */
export async function loadThemeCss(name: string): Promise<string> {
  const res = await mwbFetch(`/themes/${encodeURIComponent(name)}/css`)
  return await res.text()
}

/**
 * 并发拉取多个主题的 CSS（失败的主题跳过，不抛错）。
 * 返回 name → css 的 Map；供缩略图兜底渲染或一次性注册使用。
 */
export async function loadThemeCssMap(themes: ThemeMeta[]): Promise<Map<string, string>> {
  const targets = themes.filter((t) => t.css !== false)
  const results = await Promise.allSettled(targets.map(async (t) => [t.name, await loadThemeCss(t.name)] as const))
  const map = new Map<string, string>()
  for (const r of results) {
    if (r.status === 'fulfilled') map.set(r.value[0], r.value[1])
  }
  return map
}

/** 最小 marp 实例形状（避免 import marp-core 类型，浏览器包是全局脚本） */
export interface MarpLike {
  themeSet: { add: (css: string) => unknown }
}

export interface RegisterThemesResult {
  registered: string[]
  failed: string[]
}

/** 把 name → css 注册进 marp 实例；返回成功/失败列表（失败不抛错） */
export function registerThemesInto(marp: MarpLike, cssMap: Map<string, string>): RegisterThemesResult {
  const registered: string[] = []
  const failed: string[] = []
  for (const [name, css] of cssMap) {
    try {
      if (!/\/\*\s*@theme\b/i.test(css)) {
        failed.push(name)
        continue
      }
      marp.themeSet.add(css)
      registered.push(name)
    } catch {
      failed.push(name)
    }
  }
  return { registered, failed }
}

/**
 * 组合式便捷封装：
 *   const { themes, loading, error, cssMap, load, loadCss, register } = useThemes()
 * 适合独立页面/测试；工作台页面建议直接用 stores/app.ts 的 refreshThemes()。
 */
export function useThemes() {
  const themes = ref<ThemeMeta[]>([])
  const cssMap = ref(new Map<string, string>())
  const loading = ref(false)
  const error = ref('')

  async function load(): Promise<ThemeMeta[]> {
    loading.value = true
    error.value = ''
    try {
      themes.value = await loadThemes()
      return themes.value
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return []
    } finally {
      loading.value = false
    }
  }

  async function loadCss(name: string): Promise<string> {
    const css = await loadThemeCss(name)
    cssMap.value.set(name, css)
    cssMap.value = new Map(cssMap.value)
    return css
  }

  async function register(marp: MarpLike): Promise<RegisterThemesResult> {
    if (themes.value.length === 0) await load()
    const map = await loadThemeCssMap(themes.value)
    for (const [k, v] of map) cssMap.value.set(k, v)
    cssMap.value = new Map(cssMap.value)
    return registerThemesInto(marp, map)
  }

  return { themes, cssMap, loading, error, load, loadCss, register }
}
