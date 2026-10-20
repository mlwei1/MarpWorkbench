import type { ApiErrorBody } from '../types'
import { ApiError } from './errors'

const TOKEN_KEY = 'mwb.token'
let token: string | null = null
let mockMode = false

function params(): URLSearchParams {
  return new URLSearchParams(location.search)
}

/**
 * 启动时调用：读取 ?token= → sessionStorage → 清掉地址栏 token（契约 §2.1）。
 * 同时决定是否启用 mock API：
 *  - URL 带 ?mock=1
 *  - 构建时 VITE_MWB_MOCK=1
 *  - dev（vite）且没有 token（后端未启动时的纯前端开发）
 */
export function initToken(): string | null {
  const p = params()
  const fromUrl = p.get('token')
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl)
    token = fromUrl
    p.delete('token')
    const search = p.toString()
    history.replaceState(null, '', location.pathname + (search ? `?${search}` : '') + location.hash)
  } else {
    token = sessionStorage.getItem(TOKEN_KEY)
  }

  const wantMock =
    params().get('mock') === '1' ||
    import.meta.env.VITE_MWB_MOCK === '1' ||
    (import.meta.env.DEV && !token)
  mockMode = wantMock
  if (mockMode) console.info('[MarpWorkbench] Mock API 模式（未连接 Rust 服务）')
  return token
}

export function getToken(): string | null {
  return token
}

export function setToken(next: string): void {
  token = next
  sessionStorage.setItem(TOKEN_KEY, next)
}

export function isMockMode(): boolean {
  return mockMode
}

/** 统一 API 调用：/api 前缀、X-MWB-Token、错误转 ApiError（契约 §0.3） */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (mockMode) {
    const { mockRequest } = await import('./mock')
    return mockRequest<T>(path, init)
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) || {}),
  }
  if (token) headers['X-MWB-Token'] = token

  let res: Response
  try {
    res = await fetch(`/api${path}`, { ...init, headers })
  } catch {
    throw new ApiError('NETWORK', '无法连接本地 MarpWorkbench 服务，请确认程序仍在运行', 0)
  }

  if (!res.ok) {
    let body: ApiErrorBody | undefined
    try {
      body = (await res.json()) as ApiErrorBody
    } catch {
      /* ignore */
    }
    throw new ApiError(
      body?.error?.code || 'INTERNAL',
      body?.error?.message || `请求失败（HTTP ${res.status}）`,
      res.status,
      body?.error?.detail,
    )
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** 文本响应（如 text/css 的主题 CSS） */
export async function apiText(path: string, init: RequestInit = {}): Promise<string> {
  if (mockMode) {
    const { mockText } = await import('./mock')
    return mockText(path)
  }
  const headers: Record<string, string> = { ...((init.headers as Record<string, string>) || {}) }
  if (token) headers['X-MWB-Token'] = token
  let res: Response
  try {
    res = await fetch(`/api${path}`, { ...init, headers })
  } catch {
    throw new ApiError('NETWORK', '无法连接本地 MarpWorkbench 服务，请确认程序仍在运行', 0)
  }
  if (!res.ok) {
    throw new ApiError('INTERNAL', `请求失败（HTTP ${res.status}）`, res.status)
  }
  return res.text()
}

/** 二进制资源（图片等）的 URL 辅助 */
export function apiUrl(path: string): string {
  return `/api${path}`
}
