// ---------- 工作区 / deck（契约 §1.3） ----------
export interface DeckMeta {
  id: string
  name: string
  updatedAt: string
  createdAt: string
  bytes: number
  pages: number | null
}

export interface DeckDetail {
  id: string
  name: string
  content: string
  rev: string
  updatedAt: string
  assets: { path: string; url: string }[]
}

export interface RecentItem {
  id: string
  name: string
  updatedAt: string
}

export interface WorkspaceInfo {
  root: string
  decks: DeckMeta[]
}

// ---------- 设置 / 健康 ----------
export interface Settings {
  workspaceRoot: string
  defaultTheme: string
  autosaveMs: number
  idleExitMinutes: number
  locale: string
}

export interface HealthInfo {
  ok: boolean
  app: string
  version: string
  pid: number
  port: number
  workspaceRoot: string
  startedAt: string
}

export interface BrowserInfo {
  chrome?: string
  edge?: string
  usable: boolean
  preferred: 'chrome' | 'edge' | null
}

// ---------- 主题（契约 §1.5 / §3） ----------
export interface ThemeMeta {
  name: string
  displayName: string
  source: 'builtin' | 'user'
  tags: string[]
  author?: string
  description?: string
  size?: string[]
  autoScaling?: boolean
  /** 是否还需要 GET /api/themes/:name/css 拉取 CSS（内置 marp 主题可 false） */
  css?: boolean
}

// ---------- 渲染 ----------
export interface RenderResult {
  html: string
  css: string
  comments: string[]
  width: number
  height: number
}

// ---------- 通用错误体（契约 §0.3） ----------
export interface ApiErrorBody {
  error: { code: string; message: string; detail?: string }
}
