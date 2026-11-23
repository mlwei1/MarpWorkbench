import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { initToken } from './api/client'
import './styles/main.css'

/**
 * M5.1 CLI 配合：在清理地址栏 query 之前读取 `?autoExport=`（pptx|pptx-editable|pdf|html），
 * 存入 sessionStorage 供 EditView 在 deck 就绪后消费（自动打开导出面板并触发一次导出）。
 * 普通访问没有该参数 → 行为完全不变。
 */
const AUTO_EXPORT_KEY = 'mwb.autoExport'
const AUTO_EXPORT_FORMATS = ['pptx', 'pptx-editable', 'pdf', 'html']

function captureAutoExportFromQuery(): void {
  try {
    const raw = new URLSearchParams(location.search).get('autoExport')
    if (!raw) return
    const format = raw.trim().toLowerCase()
    if (AUTO_EXPORT_FORMATS.includes(format)) sessionStorage.setItem(AUTO_EXPORT_KEY, format)
  } catch {
    /* sessionStorage 不可用（隐私模式等）时忽略 */
  }
}

captureAutoExportFromQuery()

// 启动前置：从 ?token= 读取一次性 token → sessionStorage（地址栏清理放到 router 就绪后做）
initToken()

const app = createApp(App)
app.use(router)
app.mount('#app')

/**
 * 清理一次性 query（token / autoExport）。
 * 必须放在 router.isReady() 之后：vue-router 初始化时会用创建时捕获的 location（含 token/autoExport）
 * 执行一次 replace 写回地址栏，若在 mount 前清理会被它覆盖。
 */
function cleanOneTimeQuery(): void {
  try {
    const params = new URLSearchParams(location.search)
    let changed = false
    for (const key of ['token', 'autoExport']) {
      if (params.has(key)) {
        params.delete(key)
        changed = true
      }
    }
    if (!changed) return
    const search = params.toString()
    history.replaceState(history.state, '', location.pathname + (search ? `?${search}` : '') + location.hash)
  } catch {
    /* ignore */
  }
}

router.isReady().then(cleanOneTimeQuery).catch(cleanOneTimeQuery)
