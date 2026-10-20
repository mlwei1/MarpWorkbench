<script setup lang="ts">
/**
 * 网络图片提示条（M3，owner: export-eng；契约 docs/UI_CONTRACT_M3.md §2.2）
 *
 * 检测当前 markdown 里的 `![](https://…)`（含 `![bg …](https://…)`）：
 * 「下载到本地」→ 调服务端 POST /api/decks/:id/localize-images → 替换为 assets/ 相对路径后
 * emit `localized`（父组件替换内容 + 保存 + 重渲染）；「忽略」→ 按 deckId + URL 集合 hash 记 localStorage。
 *
 * 样式自包含（scoped）；由 EditView 挂在编辑器顶部（marp-tech 集成）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { findRemoteImages, localizeRemoteImages, type LocalizeFailed } from './remoteImages'

const props = defineProps<{
  deckId?: string
  markdown: string
}>()

const emit = defineEmits<{
  localized: [payload: { markdown: string; localized: number; failed: LocalizeFailed[] }]
}>()

const localizing = ref(false)
const errorText = ref('')
const failedList = ref<LocalizeFailed[]>([])
const ignoredDigest = ref('')

const remoteUrls = computed(() => findRemoteImages(props.markdown || '').map((r) => r.url))
const digest = computed(() => digestOf(remoteUrls.value))
const ignoreStorageKey = computed(() => `mwb.remoteImages.ignored.${props.deckId || 'default'}`)
const visible = computed(
  () => remoteUrls.value.length > 0 && ignoredDigest.value !== digest.value
)

function digestOf(urls: string[]): string {
  const text = [...new Set(urls)].sort().join('\n')
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return `${(hash >>> 0).toString(36)}-${text.length}`
}

function loadIgnored(): void {
  try {
    ignoredDigest.value = localStorage.getItem(ignoreStorageKey.value) || ''
  } catch {
    ignoredDigest.value = ''
  }
}

function ignore(): void {
  try {
    localStorage.setItem(ignoreStorageKey.value, digest.value)
  } catch {
    /* localStorage 不可用（隐私模式等）时仅本次隐藏 */
  }
  ignoredDigest.value = digest.value
  errorText.value = ''
}

async function downloadToLocal(): Promise<void> {
  if (localizing.value || !remoteUrls.value.length) return
  errorText.value = ''
  failedList.value = []
  localizing.value = true
  try {
    const result = await localizeRemoteImages(props.deckId || '', props.markdown)
    failedList.value = result.failed
    if (result.localized > 0) {
      emit('localized', {
        markdown: result.markdown,
        localized: result.localized,
        failed: result.failed,
      })
    }
    if (!result.localized && result.failed.length) {
      errorText.value = `下载失败：${result.failed[0]?.reason || '未知原因'}`
    } else if (result.failed.length) {
      errorText.value = `已下载 ${result.localized} 张，另有 ${result.failed.length} 张失败（见下方）`
    }
  } catch (err: any) {
    errorText.value = String(err?.message || err)
  } finally {
    localizing.value = false
  }
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const name = parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname
    return name.length > 36 ? `${name.slice(0, 33)}…` : name
  } catch {
    return url.length > 36 ? `${url.slice(0, 33)}…` : url
  }
}

onMounted(loadIgnored)
watch(ignoreStorageKey, loadIgnored)
</script>

<template>
  <div v-if="visible" class="mwb-remote-banner" role="status">
    <span class="banner-icon" aria-hidden="true">🌐</span>
    <div class="banner-main">
      <div class="banner-line">
        <strong>检测到 {{ remoteUrls.length }} 张网络图片</strong>
        <span class="muted">下载到本地后，离线也能查看、导出更可靠</span>
      </div>
      <div v-if="localizing" class="banner-line muted">
        <span class="spinner" /> 正在下载到本地…（共 {{ remoteUrls.length }} 张）
      </div>
      <div v-if="errorText" class="banner-line error-text">{{ errorText }}</div>
      <ul v-if="failedList.length && !localizing" class="failed-list">
        <li v-for="item in failedList.slice(0, 5)" :key="item.url" :title="item.url">
          {{ shortUrl(item.url) }} — {{ item.reason }}
        </li>
        <li v-if="failedList.length > 5" class="muted">…另有 {{ failedList.length - 5 }} 张失败</li>
      </ul>
    </div>
    <div class="banner-actions">
      <button
        class="btn btn-secondary btn-sm"
        type="button"
        :disabled="localizing"
        @click="downloadToLocal"
      >
        {{ localizing ? '下载中…' : '下载到本地' }}
      </button>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="localizing" @click="ignore">
        忽略
      </button>
    </div>
  </div>
</template>

<style scoped>
.mwb-remote-banner {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 14px;
  background: #fffbeb;
  border-bottom: 1px solid #fde68a;
  color: #78350f;
  font-size: 12.5px;
  flex: 0 0 auto;
}
.banner-icon {
  font-size: 16px;
  line-height: 20px;
}
.banner-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.banner-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.banner-line .muted {
  color: #92400e;
  opacity: 0.8;
}
.banner-line.error-text {
  color: #b91c1c;
  word-break: break-word;
}
.failed-list {
  margin: 2px 0 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: 12px;
  color: #92400e;
}
.failed-list li {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.banner-actions {
  display: flex;
  gap: 6px;
  flex: 0 0 auto;
}
.spinner {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 2px solid #fde68a;
  border-top-color: #b45309;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
