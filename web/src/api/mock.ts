/**
 * 纯前端 Mock API（后端未就绪 / `pnpm dev` 单跑时使用）
 * 覆盖契约 §1.1–1.5；导出接口明确报错，避免假装成功。
 * 数据保存在 localStorage（key: mwb.mock.v1），刷新不丢。
 */
import type { DeckMeta, HealthInfo, RecentItem, Settings, ThemeMeta } from '../types'
import { ApiError } from './errors'
import { blankTemplate, sampleTemplate, titleTemplate } from '../marp/templates'

const KEY = 'mwb.mock.v1'
const MOCK_ROOT = 'C:\\Users\\<mock>\\Documents\\MarpWorkbench'

interface MockDeck {
  id: string
  name: string
  content: string
  rev: string
  createdAt: string
  updatedAt: string
}

interface MockState {
  decks: MockDeck[]
  recent: string[]
  settings: Settings
}

function now(): string {
  return new Date().toISOString()
}

function hash(text: string): string {
  let h = 2166136261 >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return (h >>> 0).toString(16).padStart(8, '0').repeat(2).slice(0, 16)
}

function createInitialState(): MockState {
  const content = sampleTemplate('default')
  const deck: MockDeck = {
    id: 'welcome',
    name: '欢迎使用 MarpWorkbench',
    content,
    rev: hash(content),
    createdAt: now(),
    updatedAt: now(),
  }
  return {
    decks: [deck],
    recent: [deck.id],
    settings: {
      workspaceRoot: MOCK_ROOT,
      defaultTheme: 'default',
      autosaveMs: 800,
      idleExitMinutes: 10,
      locale: 'zh-CN',
    },
  }
}

function load(): MockState {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as MockState
  } catch {
    /* ignore */
  }
  const state = createInitialState()
  save(state)
  return state
}

function save(state: MockState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* ignore */
  }
}

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 40 + Math.random() * 90))
}

function nextId(state: MockState, name: string, currentId?: string): string {
  const base =
    name
      .trim()
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'untitled'
  if (base === currentId) return base
  let candidate = base
  let i = 2
  while (state.decks.some((d) => d.id === candidate && d.id !== currentId)) {
    candidate = `${base}-${i++}`
  }
  return candidate
}

function metaOf(deck: MockDeck): DeckMeta {
  return {
    id: deck.id,
    name: deck.name,
    updatedAt: deck.updatedAt,
    createdAt: deck.createdAt,
    bytes: new TextEncoder().encode(deck.content).length,
    pages: null,
  }
}

function findDeck(state: MockState, id: string): MockDeck {
  const deck = state.decks.find((d) => d.id === id)
  if (!deck) throw new ApiError('NOT_FOUND', `找不到演示文稿：${id}`, 404)
  return deck
}

const MOCK_THEMES: ThemeMeta[] = [
  { name: 'default', displayName: 'Default（内置）', source: 'builtin', tags: ['内置', '通用'], css: false },
  { name: 'gaia', displayName: 'Gaia（内置）', source: 'builtin', tags: ['内置', '经典'], css: false },
  { name: 'uncover', displayName: 'Uncover（内置）', source: 'builtin', tags: ['内置', '极简'], css: false },
]

function segments(path: string): { parts: string[] } {
  const clean = path.split('?')[0]
  return { parts: clean.split('/').filter(Boolean).map(decodeURIComponent) }
}

export async function mockRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  await delay()
  const method = (init.method || 'GET').toUpperCase()
  const body = init.body ? JSON.parse(String(init.body)) : undefined
  const { parts } = segments(path)
  const state = load()

  // GET /health
  if (method === 'GET' && parts[0] === 'health') {
    const health: HealthInfo = {
      ok: true,
      app: 'MarpWorkbench (mock)',
      version: '0.1.0-mock',
      pid: 0,
      port: 0,
      workspaceRoot: state.settings.workspaceRoot,
      startedAt: now(),
    }
    return health as T
  }
  if (method === 'POST' && parts[0] === 'shutdown') return { ok: true } as T
  if (method === 'GET' && parts[0] === 'browser') {
    return { chrome: 'Chrome（mock）', edge: undefined, usable: true, preferred: 'chrome' } as T
  }

  // settings
  if (parts[0] === 'settings') {
    if (method === 'GET') return state.settings as T
    if (method === 'PUT') {
      state.settings = { ...state.settings, ...(body as Partial<Settings>) }
      save(state)
      return state.settings as T
    }
  }

  // workspace / recent
  if (method === 'GET' && parts[0] === 'workspace') {
    const decks = [...state.decks]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(metaOf)
    return { root: state.settings.workspaceRoot, decks } as T
  }
  if (method === 'GET' && parts[0] === 'recent') {
    const items: RecentItem[] = state.recent
      .map((id) => state.decks.find((d) => d.id === id))
      .filter((d): d is MockDeck => !!d)
      .slice(0, 20)
      .map((d) => ({ id: d.id, name: d.name, updatedAt: d.updatedAt }))
    return items as T
  }

  // themes
  if (method === 'GET' && parts[0] === 'themes' && parts.length === 1) {
    return { themes: MOCK_THEMES } as T
  }

  // decks
  if (parts[0] === 'decks') {
    if (method === 'POST' && parts.length === 1) {
      const template = (body?.template || 'blank') as 'blank' | 'title' | 'sample'
      const name = (body?.name as string) || (template === 'sample' ? '示例演示' : '未命名演示文稿')
      const theme = state.settings.defaultTheme
      const content = template === 'sample' ? sampleTemplate(theme) : template === 'title' ? titleTemplate(theme) : blankTemplate(theme)
      const deck: MockDeck = {
        id: nextId(state, name),
        name,
        content,
        rev: hash(content),
        createdAt: now(),
        updatedAt: now(),
      }
      state.decks.push(deck)
      state.recent = [deck.id, ...state.recent.filter((id) => id !== deck.id)].slice(0, 20)
      save(state)
      return { id: deck.id, name: deck.name, content: deck.content, rev: deck.rev } as T
    }

    const id = parts[1]
    if (!id) throw new ApiError('BAD_REQUEST', '缺少 deck id', 400)

    if (method === 'GET' && parts.length === 2) {
      const deck = findDeck(state, id)
      return {
        id: deck.id,
        name: deck.name,
        content: deck.content,
        rev: deck.rev,
        updatedAt: deck.updatedAt,
        assets: [],
      } as T
    }

    if (method === 'PUT' && parts.length === 2) {
      const deck = findDeck(state, id)
      const nextContent = String(body?.content ?? '')
      const ifRev = body?.ifRev as string | undefined
      if (ifRev && ifRev !== deck.rev) {
        throw new ApiError('CONFLICT', '该演示文稿已在其他地方修改，请重新加载后再保存', 409)
      }
      deck.content = nextContent
      deck.rev = hash(nextContent)
      deck.updatedAt = now()
      state.recent = [deck.id, ...state.recent.filter((x) => x !== deck.id)].slice(0, 20)
      save(state)
      return { rev: deck.rev, savedAt: deck.updatedAt } as T
    }

    if (method === 'POST' && parts[2] === 'rename') {
      const deck = findDeck(state, id)
      const name = String(body?.name || '').trim() || deck.name
      const newId = nextId(state, name, deck.id)
      deck.name = name
      deck.id = newId
      deck.updatedAt = now()
      state.recent = state.recent.map((x) => (x === id ? newId : x))
      save(state)
      return { id: deck.id, name: deck.name } as T
    }

    if (method === 'DELETE' && parts.length === 2) {
      findDeck(state, id)
      state.decks = state.decks.filter((d) => d.id !== id)
      state.recent = state.recent.filter((x) => x !== id)
      save(state)
      return { ok: true } as T
    }
  }

  // 导出：mock 模式明确失败（不假装成功）
  if (parts[0] === 'export') {
    throw new ApiError('EXPORT_FAILED', 'Mock 模式没有真实导出服务：请启动 Rust 服务后使用导出', 503)
  }

  throw new ApiError('NOT_FOUND', `Mock API 未实现：${method} ${path}`, 404)
}

export async function mockText(path: string): Promise<string> {
  await delay()
  if (/^\/themes\/[^/]+\/css$/.test(path.split('?')[0])) {
    return '/* mock: 该主题 CSS 由真实服务提供 */'
  }
  throw new ApiError('NOT_FOUND', `Mock API 未实现：${path}`, 404)
}
