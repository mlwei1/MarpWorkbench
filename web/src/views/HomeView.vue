<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { app, defaultTheme, ensureBootstrap, reloadWorkspace, toast } from '../stores/app'
import * as API from '../api'
import { ensureMarpDocument } from '../marp/frontmatter'
import { readableError } from '../api/errors'
import { formatBytes, formatDateTime } from '../utils/format'

const router = useRouter()
const busy = ref(false)
const creating = ref('')
const importRef = ref<HTMLInputElement>()
const lastDeckId = ref<string | null>(localStorage.getItem('mwb.lastDeckId'))

const decks = computed(() => app.workspace?.decks ?? [])
const workspaceRoot = computed(() => app.workspace?.root || app.settings?.workspaceRoot || '未连接服务')
const recent = computed(() => app.recent)

onMounted(async () => {
  await ensureBootstrap()
  if (app.ready) {
    try {
      await reloadWorkspace()
    } catch (err) {
      toast(readableError(err), 'error')
    }
  }
})

async function create(template: 'blank' | 'title' | 'sample'): Promise<void> {
  if (busy.value) return
  busy.value = true
  creating.value = template
  try {
    const deck = await API.createDeck({ template })
    toast(`已创建「${deck.name}」`, 'success')
    router.push(`/edit/${encodeURIComponent(deck.id)}`)
  } catch (err) {
    toast(readableError(err), 'error')
  } finally {
    busy.value = false
    creating.value = ''
  }
}

async function openDeck(id: string): Promise<void> {
  router.push(`/edit/${encodeURIComponent(id)}`)
}

function copyPath(): void {
  const text = workspaceRoot.value
  navigator.clipboard
    ?.writeText(text)
    .then(() => toast('工作区路径已复制', 'success'))
    .catch(() => toast('复制失败：请手动选择路径复制', 'error'))
}

async function rename(deck: { id: string; name: string }): Promise<void> {
  const name = window.prompt('重命名演示文稿：', deck.name)
  if (!name || !name.trim() || name.trim() === deck.name) return
  try {
    const renamed = await API.renameDeck(deck.id, name.trim())
    await reloadWorkspace()
    toast(`已重命名为「${renamed.name}」`, 'success')
    if (renamed.id !== deck.id) {
      localStorage.removeItem('mwb.lastDeckId')
    }
  } catch (err) {
    toast(readableError(err), 'error')
  }
}

async function remove(deck: { id: string; name: string }): Promise<void> {
  if (!window.confirm(`删除「${deck.name}」？\n文件会移入 .trash 回收站，不会立即物理删除。`)) return
  try {
    await API.deleteDeck(deck.id)
    await reloadWorkspace()
    toast('已删除到回收站', 'success')
  } catch (err) {
    toast(readableError(err), 'error')
  }
}

function triggerImport(): void {
  importRef.value?.click()
}

async function onImportFile(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const text = await file.text()
    let content = text
    const isMarp = /^\s*---[\s\S]*?marp\s*:\s*true/m.test(content)
    if (!isMarp) {
      const ok = window.confirm('该 Markdown 没有声明 marp: true。\n是否作为演示文稿打开（自动补 front-matter）？')
      if (!ok) return
      content = ensureMarpDocument(content, defaultTheme())
    }
    const name = file.name.replace(/\.md$/i, '') || '导入的演示文稿'
    const created = await API.createDeck({ name, template: 'blank' })
    await API.saveDeck(created.id, content, created.rev)
    toast(`已导入「${name}」`, 'success')
    router.push(`/edit/${encodeURIComponent(created.id)}`)
  } catch (err) {
    toast(readableError(err), 'error')
  }
}
</script>

<template>
  <div class="page">
    <header class="topbar">
      <div class="topbar-left">
        <span class="brand"><span class="brand-mark">M</span> MarpWorkbench</span>
        <span v-if="app.mock" class="badge badge-mock" title="未连接 Rust 服务，使用前端 mock API">MOCK</span>
      </div>
      <div class="topbar-right">
        <router-link class="btn btn-ghost" to="/settings">设置</router-link>
      </div>
    </header>

    <main class="home-main">
      <div v-if="app.booting" class="center-panel">
        <div class="spinner" />
        <p>正在连接本地服务…</p>
      </div>

      <div v-else-if="app.bootError" class="center-panel error-panel">
        <h2>无法初始化</h2>
        <p class="error-text">{{ app.bootError }}</p>
        <p class="muted">请确认 MarpWorkbench 服务已启动；开发模式可直接访问 <code>/?mock=1</code> 使用 mock。</p>
      </div>

      <template v-else>
        <section class="hero">
          <div class="hero-text">
            <h1>写 Markdown，右侧即时预览，一键出 PPTX / PDF</h1>
            <p class="muted">标准 Marp Markdown，随时能拿回 VS Code / marp-cli。</p>
          </div>
          <div class="hero-actions">
            <button class="btn btn-primary btn-lg" :disabled="busy" @click="create('blank')">
              {{ creating === 'blank' ? '创建中…' : '＋ 新建空白' }}
            </button>
            <button class="btn btn-secondary" :disabled="busy" @click="create('sample')">示例演示</button>
            <button class="btn btn-secondary" :disabled="busy" @click="triggerImport">导入 .md</button>
            <input ref="importRef" type="file" accept=".md,.markdown,text/markdown" hidden @change="onImportFile" />
          </div>
        </section>

        <section class="workspace-bar card">
          <div class="workspace-path">
            <span class="label">工作区</span>
            <code class="path">{{ workspaceRoot }}</code>
          </div>
          <div class="workspace-actions">
            <button class="btn btn-ghost btn-sm" @click="copyPath">复制路径</button>
            <button v-if="lastDeckId" class="btn btn-ghost btn-sm" @click="openDeck(lastDeckId)">继续上次编辑</button>
          </div>
        </section>

        <div class="home-columns">
          <section class="decks-panel">
            <div class="section-head">
              <h2>全部演示文稿</h2>
              <span class="muted">{{ decks.length }} 个</span>
            </div>
            <div v-if="!decks.length" class="empty-hint">还没有演示文稿，点上方「新建空白」开始。</div>
            <ul class="deck-list">
              <li v-for="deck in decks" :key="deck.id" class="deck-item card">
                <button class="deck-main" @click="openDeck(deck.id)">
                  <span class="deck-name">{{ deck.name }}</span>
                  <span class="deck-meta">
                    {{ formatDateTime(deck.updatedAt) }} · {{ formatBytes(deck.bytes) }}
                  </span>
                </button>
                <div class="deck-actions">
                  <button class="btn btn-ghost btn-sm" title="重命名" @click.stop="rename(deck)">重命名</button>
                  <button class="btn btn-ghost btn-sm danger" title="删除到回收站" @click.stop="remove(deck)">删除</button>
                </div>
              </li>
            </ul>
          </section>

          <aside class="recent-panel">
            <div class="section-head">
              <h2>最近文件</h2>
            </div>
            <div v-if="!recent.length" class="empty-hint small">暂无最近文件</div>
            <ul class="recent-list">
              <li v-for="item in recent" :key="item.id">
                <button class="recent-item" @click="openDeck(item.id)">
                  <span class="recent-name">{{ item.name }}</span>
                  <span class="recent-time">{{ formatDateTime(item.updatedAt) }}</span>
                </button>
              </li>
            </ul>
          </aside>
        </div>
      </template>
    </main>
  </div>
</template>
