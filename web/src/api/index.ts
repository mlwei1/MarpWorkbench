import { api, apiBlob, apiText } from './client'
import type {
  BrowserInfo,
  DeckDetail,
  HealthInfo,
  RecentItem,
  Settings,
  ThemeMeta,
  WorkspaceInfo,
} from '../types'

// ---------- 健康 / 生命周期 ----------
export const getHealth = () => api<HealthInfo>('/health')
export const shutdown = () => api<{ ok: boolean }>('/shutdown', { method: 'POST' })
export const getBrowser = () => api<BrowserInfo>('/browser')

// ---------- 设置 ----------
export const getSettings = () => api<Settings>('/settings')
export const putSettings = (patch: Partial<Settings>) =>
  api<Settings>('/settings', { method: 'PUT', body: JSON.stringify(patch) })

// ---------- 工作区 / deck ----------
export const getWorkspace = () => api<WorkspaceInfo>('/workspace')
export const createDeck = (payload: { name?: string; template?: 'blank' | 'title' | 'sample' }) =>
  api<{ id: string; name: string; content: string; rev: string }>('/decks', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
export const getDeck = (id: string) => api<DeckDetail>(`/decks/${encodeURIComponent(id)}`)
export const saveDeck = (id: string, content: string, ifRev?: string) =>
  api<{ rev: string; savedAt: string }>(`/decks/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(ifRev ? { content, ifRev } : { content }),
  })
export const renameDeck = (id: string, name: string) =>
  api<{ id: string; name: string }>(`/decks/${encodeURIComponent(id)}/rename`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
export const deleteDeck = (id: string) =>
  api<{ ok: boolean }>(`/decks/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const getRecent = () => api<RecentItem[]>('/recent')

// ---------- 主题 ----------
export const getThemes = () => api<{ themes: ThemeMeta[] }>('/themes')
export const getThemeCss = (name: string) => apiText(`/themes/${encodeURIComponent(name)}/css`)
export const createTheme = (css: string, fileName?: string) =>
  api<ThemeMeta>('/themes', {
    method: 'POST',
    body: JSON.stringify(fileName ? { css, fileName } : { css }),
  })
export const saveTheme = (name: string, css: string) =>
  api<ThemeMeta>(`/themes/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify({ css }),
  })
export const deleteTheme = (name: string) =>
  api<{ ok: boolean }>(`/themes/${encodeURIComponent(name)}`, { method: 'DELETE' })

// ---------- 资源（图片/附件，M2） ----------
export interface UploadedAsset {
  path: string
  url: string
  bytes: number
}

/** 上传图片到 deck assets（multipart，字段名 file；不要手写 Content-Type） */
export async function uploadAsset(deckId: string, file: File | Blob, fileName?: string): Promise<UploadedAsset> {
  const form = new FormData()
  const name = fileName || (file instanceof File ? file.name : 'image.png')
  form.append('file', file, name)
  return api<UploadedAsset>(`/decks/${encodeURIComponent(deckId)}/assets`, { method: 'POST', body: form })
}

/** 下载 deck 资产为 Blob（图片预览用；带 token） */
export async function fetchDeckAssetBlob(deckId: string, fileName: string): Promise<Blob> {
  return apiBlob(`/decks/${encodeURIComponent(deckId)}/assets/${encodeURIComponent(fileName)}`)
}
