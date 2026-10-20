#!/usr/bin/env node
/**
 * M1 视觉/交互自检（Lead 用）
 * - 启动 MarpWorkbench.exe（隔离数据目录、不自动开浏览器）
 * - 通过 API 建一份含中文/代码/表格/备注的 4 页 deck
 * - 用系统 Chrome + puppeteer-core 打开真实 UI：首页 → 编辑器 → 主题画廊 → 切主题 → 导出面板
 * - 截图到 spike/visual/<时间戳>/，并输出 DOM 断言结果
 *
 * 用法：node scripts/visual-e2e.mjs
 * 依赖：spike/marp/node_modules/puppeteer-core（调研阶段已安装；不新增根依赖）
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve('.')
const args = process.argv.slice(2)
const require = createRequire(join(ROOT, 'spike/marp/package.json'))
const puppeteer = require('puppeteer-core')
const exe = join(ROOT, 'server/target/release/MarpWorkbench.exe')
const chrome = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))
if (!existsSync(exe) || !chrome) {
  console.error(`缺少 exe(${exe}) 或 Chrome/Edge(${chrome})`)
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const shotDir = join(ROOT, 'spike/visual', stamp)
mkdirSync(shotDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'mwb-vis-'))
const embedded = args.includes('--embedded')
const env = { ...process.env, MWB_DATA_DIR: dataDir, MWB_NO_OPEN: '1' }
if (!embedded) {
  env.MWB_WEB_DIR = join(ROOT, 'web/dist')
  env.MWB_THEMES_DIR = join(ROOT, 'themes')
}
const child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => (out += d))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitBase() {
  for (let i = 0; i < 300; i++) {
    const mUrl = out.match(/MWB_LISTEN_URL=(\S+)/)
    const mTok = out.match(/MWB_TOKEN=(\S+)/)
    if (mUrl && mTok) return { base: mUrl[1], token: mTok[1] }
    await sleep(100)
  }
  throw new Error('启动超时: ' + out.slice(-500))
}
const log = (...a) => console.log(...a)
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

const MD = `---
marp: true
theme: business-blue
paginate: true
size: 16:9
header: 'MarpWorkbench 演示'
footer: 'M1 骨架验证'
---

<!-- _class: lead -->

# 用 Markdown 做一份好看的 PPT

**MarpWorkbench** · 左编辑 / 右预览 / 一键换主题 / 导出 PPTX

---

## 为什么选 Marp

- 内容与版式分离，专注写作
- 版本可控，纯文本
- 一次编写，多端导出

<!-- 讲稿备注：这里强调"专注内容" --> 

---

## 主题画廊

点一下主题，全 deck 立即换装（≤300ms）

| 主题 | 场景 |
| --- | --- |
| 商务蓝 | 汇报 |
| 科技深色 | 技术分享 |
| 学术白 | 答辩 |

---

## 代码也好看

\`\`\`js
const deck = render(markdown)
exportDeck({ format: 'pptx', deck })
\`\`\`

> 4 页 demo · 中文 / 代码 / 表格 / 引用全覆盖
`

const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--window-size=1600,1000', '--force-device-scale-factor=1', '--hide-scrollbars'] })
try {
  const { base, token } = await waitBase()
  check('服务启动', true, base)
  const api = async (path, init = {}) => {
    const res = await fetch(`${base}/api${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'X-MWB-Token': token, ...(init.headers || {}) } })
    return { status: res.status, json: await res.json().catch(() => null) }
  }
  const created = await api('/decks', { method: 'POST', body: JSON.stringify({ name: '演示-产品原型', template: 'blank' }) })
  const id = created.json?.id
  check('新建中文名 deck', created.status === 200 && !!id, id)
  const saved = await api(`/decks/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ content: MD }) })
  check('保存中文内容', saved.status === 200, `rev=${saved.json?.rev}`)
  const read = await api(`/decks/${encodeURIComponent(id)}`)
  check('读回内容一致（UTF-8）', read.json?.content === MD)

  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000 })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })

  // 首页
  await page.goto(`${base}/?token=${token}`, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForFunction(() => document.body.innerText.includes('MarpWorkbench'), { timeout: 20000 })
  await page.waitForFunction(() => document.body.innerText.includes('演示-产品原型'), { timeout: 15000 }).catch(() => {})
  await sleep(800)
  await page.screenshot({ path: join(shotDir, '01-home.png') })
  const deckNameOk = await page.evaluate(() => document.body.innerText.includes('演示-产品原型'))
  check('首页显示中文 deck 名', deckNameOk)

  // 编辑器
  await page.goto(`${base}/edit/${encodeURIComponent(id)}?token=${token}`, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForFunction(() => document.querySelectorAll('iframe').length > 0, { timeout: 20000 })
  await sleep(2500)
  const slideCount = await page.evaluate(() => {
    const f = document.querySelector('iframe')
    try {
      return f.contentDocument.querySelectorAll('svg[data-marpit-svg]').length
    } catch {
      return -1
    }
  })
  await page.screenshot({ path: join(shotDir, '02-editor.png') })
  check('预览渲染 4 页', slideCount === 4, `slides=${slideCount}`)

  // 主题画廊
  const galleryBtn = await page.$('::-p-text(主题画廊)')
  if (galleryBtn) {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '主题画廊')
      b?.click()
    })
    await sleep(2800)
    await page.screenshot({ path: join(shotDir, '03-gallery.png') })
    // 切到「全部」分类，检查所有主题卡片都能出现
    await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('.tg-tab')]
      const all = tabs.find((t) => t.textContent.trim().startsWith('全部'))
      all?.click()
    })
    await sleep(1200)
    const cards = await page.evaluate(() => document.querySelectorAll('.tg-card[data-theme-name]').length)
    check('主题画廊「全部」卡片数 ≥ 9', cards >= 9, `cards=${cards}`)
    // 检查缩略图是否真的按主题区分（不是全部回退 default）：iframe 用 srcdoc 承载渲染结果
    const thumbSigs = await page.evaluate(() =>
      [...document.querySelectorAll('.tg-card[data-theme-name]')].map((c) => {
        const f = c.querySelector('.tg-frame')
        const len = (f?.getAttribute('srcdoc') || '').length
        return c.getAttribute('data-theme-name') + ':' + len
      }),
    )
    check('画廊缩略图按主题渲染（srcdoc 有内容）', thumbSigs.every((s) => Number(s.split(':')[1]) > 1000), thumbSigs.slice(0, 3).join(','))
    await page.screenshot({ path: join(shotDir, '03b-gallery-all.png') })
    const tech = await page.$('.tg-card[data-theme-name="tech-dark"]')
    if (tech) {
      await tech.click({ delay: 30 }).catch(() => page.evaluate(() => document.querySelector('.tg-card[data-theme-name="tech-dark"]')?.click()))
      await sleep(2000)
      await page.screenshot({ path: join(shotDir, '04-theme-tech-dark.png') })
      const fm = await api(`/decks/${encodeURIComponent(id)}`)
      check('切换主题写回 front-matter', /theme:\s*tech-dark/.test(fm.json?.content || ''), '')
    } else {
      check('存在 tech-dark 主题卡片', false)
    }
    await page.keyboard.press('Escape')
    await sleep(600)
  } else {
    check('主题画廊按钮存在', false)
  }

  // 导出面板 + 真实导出 PPTX（验证整条前端→服务端→pptxgenjs 链路）
  const downloadDir = join(shotDir, 'downloads')
  mkdirSync(downloadDir, { recursive: true })
  const cdp = await page.createCDPSession()
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir })
  const clicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === '导出')
    if (btns[0]) {
      btns[0].click()
      return true
    }
    return false
  })
  await sleep(1500)
  await page.screenshot({ path: join(shotDir, '05-export-panel.png') })
  const panelOpen = await page.evaluate(() => !!document.querySelector('.mwb-export-panel'))
  check('导出面板可见', clicked && panelOpen)
  if (panelOpen) {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.mwb-export-panel button')].find((x) => /导出 PPTX/.test(x.textContent))
      b?.click()
    })
    const deadline = Date.now() + 120000
    let file = null
    while (Date.now() < deadline) {
      await sleep(1000)
      const files = readdirSync(downloadDir).filter((f) => f.endsWith('.pptx') && statSync(join(downloadDir, f)).size > 1000)
      if (files.length) {
        file = files[0]
        break
      }
      const err = await page.evaluate(() => document.querySelector('.mwb-export-panel')?.innerText.match(/失败[^\n]*/)?.[0] || '')
      if (err) throw new Error('导出失败: ' + err)
    }
    check('真实导出 PPTX（前端组装）', !!file, file ? `${file} ${statSync(join(downloadDir, file)).size}B` : '超时')
    if (file) {
      const buf = readFileSync(join(downloadDir, file))
      check('PPTX 文件头为 ZIP(PK)', buf.subarray(0, 2).toString('latin1') === 'PK')
    }
    await page.screenshot({ path: join(shotDir, '06-export-done.png') })
  }

  check('无前端 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '))
  log(`\n截图目录: ${shotDir}`)
  log(`数据目录: ${dataDir}`)
} catch (e) {
  check('视觉自检执行', false, String(e?.stack || e))
} finally {
  await browser.close().catch(() => {})
  await fetch(`${'http://127.0.0.1:1'}/`).catch(() => {})
  child.kill()
  const failed = results.filter((r) => !r.ok)
  log(`\n[visual-e2e] ${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
}
