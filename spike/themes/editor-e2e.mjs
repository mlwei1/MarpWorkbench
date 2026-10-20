// M2 主题 UI 端到端验证：真实 exe + Chrome
// 覆盖：主题画廊（12 套）→ 新建主题编辑器（实时预览）→ 另存为副本 → 导入 .css → 清理
// 运行：node spike/themes/editor-e2e.mjs
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve('.')
const require = createRequire(join(ROOT, 'spike/marp/package.json'))
const puppeteer = require('puppeteer-core')
const exe = join(ROOT, 'server/target/release/MarpWorkbench.exe')
const chrome = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))
if (!existsSync(exe) || !chrome) {
  console.error(`缺少 exe(${exe}) 或 Chrome(${chrome})`)
  process.exit(1)
}

const shotDir = join(ROOT, 'spike/themes/shots')
mkdirSync(shotDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'mwb-theme-ui-'))
const childEnv = { ...process.env, MWB_DATA_DIR: dataDir, MWB_NO_OPEN: '1' }
// 默认用磁盘上的 web/dist + themes（改完前端/主题后无需重编 exe，迭代快；加 --embedded 则用内嵌资源）
if (!process.argv.includes('--embedded')) {
  childEnv.MWB_WEB_DIR = join(ROOT, 'web/dist')
  childEnv.MWB_THEMES_DIR = join(ROOT, 'themes')
}
const child = spawn(exe, [], {
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => (out += d))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitBase() {
  for (let i = 0; i < 300; i++) {
    const mUrl = out.match(/MWB_LISTEN_URL=(\S+)/)
    const mTok = out.match(/MWB_TOKEN=(\S+)/)
    if (mUrl && mTok) return { base: mUrl[1].replace(/\/$/, ''), token: mTok[1] }
    await sleep(100)
  }
  throw new Error('启动超时: ' + out.slice(-500))
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`)
}

let browser = null
try {
  const { base, token } = await waitBase()
  const api = async (path, opts = {}) => {
    const res = await fetch(`${base}/api${path}`, {
      ...opts,
      headers: { 'X-MWB-Token': token, ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 200)}`)
    return res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text
  }

  // 1) 建一份含封面/内容页的 deck
  const created = await api('/decks', { method: 'POST', body: JSON.stringify({ name: '主题编辑器验证', template: 'blank' }) })
  const md = `---
marp: true
theme: business-blue
paginate: true
header: 'M2 主题验证'
footer: 'editor-e2e'
---

<!-- _class: lead -->

# 主题编辑器验证

## 新建 / 导入 / 实时预览

---

## 第二页

- 主题画廊 12 套
- 点 ⋯ 可编辑/另存/导出
- @theme 校验
`
  await api(`/decks/${encodeURIComponent(created.id)}`, { method: 'PUT', body: JSON.stringify({ content: md }) })

  // 2) 打开编辑器页面 → 主题画廊
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: 'new',
    args: ['--window-size=1600,1000', '--force-device-scale-factor=1', '--hide-scrollbars', '--no-first-run'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000 })
  const jsErrors = []
  page.on('pageerror', (e) => jsErrors.push(String(e)))
  const themeApiCalls = []
  page.on('response', async (res) => {
    const url = res.url()
    if (url.includes('/api/themes')) {
      let body = ''
      try {
        body = (await res.text()).slice(0, 200)
      } catch {
        /* ignore */
      }
      themeApiCalls.push(`${res.request().method()} ${url.replace(base, '')} → ${res.status()} ${body}`)
    }
  })
  await page.goto(`${base}/edit/${encodeURIComponent(created.id)}?token=${token}`, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForSelector('.topbar', { timeout: 30000 })
  await sleep(800)

  const clickByText = async (selector, text) => {
    const ok = await page.evaluate(
      (sel, t) => {
        const nodes = [...document.querySelectorAll(sel)]
        const el = nodes.find((n) => (n.textContent || '').includes(t))
        if (!el) return false
        el.click()
        return true
      },
      selector,
      text,
    )
    return ok
  }

  await clickByText('button', '主题画廊')
  await page.waitForSelector('.theme-gallery', { timeout: 15000 })
  await sleep(800)
  await clickByText('.tg-tab', '全部')
  await sleep(1200)
  const cardCount = await page.$$eval('.tg-card', (els) => els.length)
  check('画廊打开且卡片渲染（全部 Tab）', cardCount >= 14, `cards=${cardCount}`)
  await page.screenshot({ path: join(shotDir, 'm2-gallery.png') })

  // 3) 新建主题 → 编辑器
  await clickByText('button', '新建主题')
  await page.waitForSelector('.theme-editor', { timeout: 15000 })
  await sleep(1200)
  const editorInfo = await page.evaluate(() => ({
    name: document.querySelector('.te-name')?.value ?? '',
    cssLen: document.querySelector('.te-textarea')?.value?.length ?? 0,
    preview: document.querySelector('.te-preview-frame')?.getAttribute('srcdoc')?.length ?? 0,
    errorText: document.querySelector('.te-error')?.textContent ?? '',
  }))
  check('ThemeEditor 打开（名称/CSS/预览）', editorInfo.name.length > 0 && editorInfo.cssLen > 100, `name=${editorInfo.name} css=${editorInfo.cssLen}B`)
  check('实时预览已渲染', editorInfo.preview > 1000, `srcdoc=${editorInfo.preview}B error=${editorInfo.errorText.trim()}`)
  await page.screenshot({ path: join(shotDir, 'm2-theme-editor.png') })

  // 4) 改名 + 另存为副本（create 流程）
  await page.evaluate(() => {
    const nameEl = document.querySelector('.te-name')
    const ta = document.querySelector('.te-textarea')
    if (nameEl && ta) {
      nameEl.value = 'm2-e2e-theme'
      nameEl.dispatchEvent(new Event('input', { bubbles: true }))
      ta.value = ta.value.replace(/@theme\s+[A-Za-z0-9_-]+/, '@theme m2-e2e-theme')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
  await sleep(900)
  await clickByText('button', '另存为副本')
  await sleep(1500)
  const afterCreate = await api('/themes')
  const createdTheme = afterCreate.themes.find((t) => t.name === 'm2-e2e-theme')
  check('ThemeEditor 保存（另存为副本 → POST /api/themes）', !!createdTheme, `source=${createdTheme?.source}`)
  const editorClosed = (await page.$('.theme-editor')) === null
  check('保存后编辑器关闭并回到画廊', editorClosed, '')

  // 5) 通过文件选择导入 .css（真实 uploadFile，等价用户选择文件）
  const tmpCss = join(dataDir, 'm2-import-theme.css')
  writeFileSync(
    tmpCss,
    `/* @theme m2-import-theme */\n/* @name 导入测试主题 */\n/* @tags 测试,导入 */\n@import 'default';\nsection { background: #ffffff; color: #222222; font-size: 28px; }\n`,
  )
  const fileInput = await page.$('.tg-file-input')
  if (!fileInput) throw new Error('找不到 .tg-file-input')
  await fileInput.uploadFile(tmpCss)
  await sleep(1800)
  console.log('\n[debug] theme API calls:\n' + themeApiCalls.join('\n'))
  console.log(
    '[debug] input files:',
    await page.evaluate(() => document.querySelector('.tg-file-input')?.files?.length ?? -1),
    'notice:',
    await page.evaluate(() => document.querySelector('.tg-notice')?.textContent ?? '(none)'),
  )
  const afterImport = await api('/themes')
  const imported = afterImport.themes.find((t) => t.name === 'm2-import-theme')
  check('导入 .css 主题（POST /api/themes）', !!imported, `displayName=${imported?.displayName}`)
  await clickByText('.tg-tab', '全部')
  await sleep(1000)
  const userBadge = await page.$$eval('.tg-user-badge', (els) => els.length)
  check('画廊出现「我的」徽标', userBadge >= 2, `badges=${userBadge}`)

  // 6) 清理 + JS 错误
  await api('/themes/m2-e2e-theme', { method: 'DELETE' }).catch(() => {})
  await api('/themes/m2-import-theme', { method: 'DELETE' }).catch(() => {})
  check('无前端 JS 错误', jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '))
  console.log(`\n截图：${join(shotDir, 'm2-gallery.png')} / ${join(shotDir, 'm2-theme-editor.png')}`)
} catch (e) {
  check('M2 主题 UI E2E', false, String(e?.message ?? e))
} finally {
  if (browser) await browser.close().catch(() => {})
  child.kill()
  await sleep(300)
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
}
