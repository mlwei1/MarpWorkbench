<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { app, ensureBootstrap, loadBrowser, reloadSettings, toast } from '../stores/app'
import * as API from '../api'
import { readableError } from '../api/errors'
import { formatDateTime } from '../utils/format'

const form = reactive({
  workspaceRoot: '',
  defaultTheme: 'default',
  autosaveMs: 800,
  idleExitMinutes: 10,
})
const saving = ref(false)
const shuttingDown = ref(false)
const shutdownDone = ref(false)

onMounted(async () => {
  await ensureBootstrap()
  if (app.ready) {
    await reloadSettings()
    syncForm()
    if (!app.browser) await loadBrowser()
  }
})

function syncForm(): void {
  if (!app.settings) return
  form.workspaceRoot = app.settings.workspaceRoot
  form.defaultTheme = app.settings.defaultTheme
  form.autosaveMs = app.settings.autosaveMs
  form.idleExitMinutes = app.settings.idleExitMinutes
}

async function save(): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    const next = await API.putSettings({
      defaultTheme: form.defaultTheme,
      idleExitMinutes: form.idleExitMinutes,
    })
    app.settings = next
    syncForm()
    toast('设置已保存', 'success')
  } catch (err) {
    toast(`保存设置失败：${readableError(err)}`, 'error')
  } finally {
    saving.value = false
  }
}

function copyPath(): void {
  navigator.clipboard
    ?.writeText(form.workspaceRoot)
    .then(() => toast('路径已复制', 'success'))
    .catch(() => toast('复制失败，请手动复制', 'error'))
}

async function detectBrowser(): Promise<void> {
  try {
    await loadBrowser()
    const b = app.browser
    if (!b) {
      toast('无法获取浏览器信息', 'error')
      return
    }
    toast(
      b.usable
        ? `导出可用：${b.preferred === 'chrome' ? 'Chrome' : 'Edge'}${b.chrome ? `（Chrome: ${b.chrome}）` : ''}`
        : '未检测到可用的 Chrome/Edge，导出将不可用',
      b.usable ? 'success' : 'error',
      5000,
    )
  } catch (err) {
    toast(readableError(err), 'error')
  }
}

async function shutdownApp(): Promise<void> {
  if (!window.confirm('退出 MarpWorkbench？\n本地服务将停止，已保存内容不受影响。')) return
  shuttingDown.value = true
  try {
    await API.shutdown()
    shutdownDone.value = true
  } catch (err) {
    toast(`退出失败：${readableError(err)}`, 'error')
    shuttingDown.value = false
  }
}
</script>

<template>
  <div class="page">
    <header class="topbar">
      <div class="topbar-left">
        <router-link class="btn btn-ghost btn-sm" to="/">← 工作区</router-link>
        <span class="brand brand-small">设置</span>
        <span v-if="app.mock" class="badge badge-mock">MOCK</span>
      </div>
      <div class="topbar-right">
        <router-link class="btn btn-ghost btn-sm" to="/settings" v-if="false" />
      </div>
    </header>

    <main class="settings-main">
      <div v-if="shutdownDone" class="center-panel">
        <h2>服务已退出</h2>
        <p class="muted">可以关闭此页面了。重新启动 MarpWorkbench.exe 即可再次使用。</p>
      </div>

      <template v-else-if="app.ready">
        <section class="card settings-card">
          <h2>工作区</h2>
          <div class="settings-row">
            <label>数据目录</label>
            <div class="settings-value">
              <code class="path">{{ form.workspaceRoot }}</code>
              <button class="btn btn-ghost btn-sm" @click="copyPath">复制</button>
            </div>
          </div>
          <p class="muted small">演示文稿、导出文件、自定义主题都保存在这个目录。便携模式下会使用 exe 同目录的 data\。</p>
        </section>

        <section class="card settings-card">
          <h2>编辑与保存</h2>
          <div class="settings-row">
            <label for="default-theme">新演示文稿默认主题</label>
            <select id="default-theme" v-model="form.defaultTheme" class="settings-select">
              <option v-for="t in app.themes" :key="t.name" :value="t.name">{{ t.displayName }}</option>
              <option v-if="!app.themes.some((t) => t.name === form.defaultTheme)" :value="form.defaultTheme">
                {{ form.defaultTheme }}（未加载）
              </option>
            </select>
          </div>
          <div class="settings-row">
            <label>自动保存</label>
            <span class="settings-static">{{ form.autosaveMs }} ms 防抖 + 30 秒强制保存</span>
          </div>
          <div class="settings-row">
            <label for="idle-exit">空闲自动退出</label>
            <select id="idle-exit" v-model.number="form.idleExitMinutes" class="settings-select">
              <option :value="5">5 分钟</option>
              <option :value="10">10 分钟</option>
              <option :value="30">30 分钟</option>
              <option :value="0">从不</option>
            </select>
          </div>
          <div class="settings-actions">
            <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存设置' }}</button>
          </div>
        </section>

        <section class="card settings-card">
          <h2>导出</h2>
          <div class="settings-row">
            <label>本机浏览器</label>
            <div class="settings-value">
              <span v-if="app.browser?.usable">
                可用 · 优先 {{ app.browser.preferred === 'chrome' ? 'Chrome' : 'Edge' }}
              </span>
              <span v-else class="error-text">未检测到 Chrome / Edge</span>
              <button class="btn btn-ghost btn-sm" @click="detectBrowser">重新检测</button>
            </div>
          </div>
          <ul class="browser-paths muted small">
            <li v-if="app.browser?.chrome">Chrome: {{ app.browser.chrome }}</li>
            <li v-if="app.browser?.edge">Edge: {{ app.browser.edge }}</li>
          </ul>
        </section>

        <section class="card settings-card">
          <h2>应用</h2>
          <div class="settings-row">
            <label>版本</label>
            <span class="settings-static">{{ app.health?.app || 'MarpWorkbench' }} v{{ app.health?.version || '—' }}</span>
          </div>
          <div class="settings-row">
            <label>启动时间</label>
            <span class="settings-static">{{ formatDateTime(app.health?.startedAt) }}</span>
          </div>
          <div class="settings-actions">
            <button class="btn btn-danger" :disabled="shuttingDown" @click="shutdownApp">
              {{ shuttingDown ? '正在退出…' : '退出 MarpWorkbench' }}
            </button>
          </div>
        </section>
      </template>

      <div v-else class="center-panel">
        <div class="spinner" />
        <p>正在连接本地服务…</p>
      </div>
    </main>
  </div>
</template>
