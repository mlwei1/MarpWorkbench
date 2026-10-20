#!/usr/bin/env node
/**
 * M2 视觉/交互验收（Lead 用）：真实 exe（内嵌资源）+ 系统 Chrome + puppeteer-core。
 *
 * 覆盖：
 *  - 格式工具栏 / 左大纲栏 / 右属性栏存在
 *  - 大纲树：标题层级/页码/点击跳页
 *  - 幻灯片缩略图 tab：点击跳页
 *  - 属性面板：尺寸 4:3、页码开关、页眉、全局 class、本页 class、未知 front-matter 字段保留
 *  - 图片插入器：上传 PNG → 背景图左 40% → 插入 → 标准 Marp 语法 + 资产落盘
 *  - 表格插入器：3×3 → 插入 GFM 表格
 *  - 主题画廊：≥15 套（12 自制 + 3 内置）→ 导入外部 .css → 出现在「我的主题」
 *  - 主题编辑器：新建主题打开、CSS/预览/名称校验
 *  - 无前端 JS 错误、无外网请求
 *  - 截图输出到 spike/visual/m2-<时间戳>/
 *
 * 用法：node scripts/visual-e2e-m2.mjs [--keep]
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve('.')
const args = process.argv.slice(2)
const keep = args.includes('--keep')
const require = createRequire(join(ROOT, 'spike/marp/package.json'))
const puppeteer = require('puppeteer-core')

const exe = join(ROOT, 'server/target/release/MarpWorkbench.exe')
const chrome = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))
if (!existsSync(exe) || !chrome) {
  console.error(`缺少 exe(${exe}) 或 Chrome/Edge`)
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const shotDir = join(ROOT, 'spike/visual-m2', stamp)
mkdirSync(shotDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'mwb-m2-'))
const env = { ...process.env, MWB_DATA_DIR: dataDir, MWB_NO_OPEN: '1' }
const child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => (out += d))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const log = (...a) => console.log(...a)
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
  return ok
}

async function waitBase() {
  for (let i = 0; i < 400; i++) {
    const mUrl = out.match(/MWB_LISTEN_URL=(\S+)/)
    const mTok = out.match(/MWB_TOKEN=(\S+)/)
    if (mUrl && mTok) return { base: mUrl[1], token: mTok[1] }
    await sleep(100)
  }
  throw new Error('服务启动超时: ' + out.slice(-800))
}

const MD = `---
marp: true
theme: business-blue
paginate: true
size: 16:9
header: 'M2 演示'
footer: 'MarpWorkbench'
author: 张三
---

<!-- _class: lead -->

# M2 视觉验收

## 属性面板 / 大纲 / 插入器

---

## 为什么选 Marp

- 内容与版式分离，专注写作

- 版本可控，纯文本

---

## 主题画廊

| 主题 | 场景 |
| --- | --- |
| 商务蓝 | 汇报 |

---

## 代码也好看

\`\`\`js
const deck = render(markdown)
exportDeck({ format: 'pptx', deck })
\`\`\`
`

let browser
try {
  const { base, token } = await waitBase()
  check('exe 启动（内嵌资源）', true, base)

  const api = async (path, init = {}) => {
    const res = await fetch(`${base}/api${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'X-MWB-Token': token, ...(init.headers || {}) },
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* ignore */
    }
    return { status: res.status, json, text }
  }
  const getDeckMd = async (id) => (await api(`/decks/${encodeURIComponent(id)}`)).json?.content || ''

  // 建 deck + 上传一张图片（供图片插入器使用）
  const created = await api('/decks', { method: 'POST', body: JSON.stringify({ name: 'M2-验收-演示', template: 'blank' }) })
  const id = created.json?.id
  check('新建 deck', created.status === 200 && !!id, id)
  const saved = await api(`/decks/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ content: MD }) })
  check('保存 M2 样例内容', saved.status === 200, `rev=${saved.json?.rev}`)

  // 上传 fixture 图片（直接调资产接口，模拟插入器上传路径）
  const imgBuf = readFileSync(join(ROOT, 'scripts/fixtures/test-photo.png'))
  const form = new FormData()
  form.append('file', new Blob([imgBuf], { type: 'image/png' }), 'test-photo.png')
  const up = await fetch(`${base}/api/decks/${encodeURIComponent(id)}/assets`, {
    method: 'POST',
    headers: { 'X-MWB-Token': token },
    body: form,
  })
  const upJson = await up.json().catch(() => null)
  check('资产上传接口（multipart）', up.status === 200 && !!upJson?.path, JSON.stringify(upJson))
  const assetPath = upJson?.path

  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: 'new',
    args: ['--window-size=1680,1050', '--force-device-scale-factor=1', '--hide-scrollbars'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1680, height: 1050 })
  const errors = []
  const resource404 = []
  const externalRequests = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('response', (res) => {
    if (res.status() === 404) {
      let frameUrl = ''
      try {
        frameUrl = res.frame()?.url() || ''
      } catch {
        /* ignore */
      }
      resource404.push(`${res.url()} [frame=${frameUrl}] [${res.request().resourceType()}]`)
    }
  })
  page.on('request', (req) => {
    const u = req.url()
    if (!/^(https?:)\/\/(127\.0\.0\.1|localhost)/.test(u) && !u.startsWith('data:') && !u.startsWith('blob:')) {
      externalRequests.push(u)
    }
  })

  const clickText = async (text, { root = 'body', exact = false } = {}) =>
    page.evaluate(
      ({ text, root, exact }) => {
        const scope = document.querySelector(root) || document.body
        const btns = [...scope.querySelectorAll('button, a, .chip, .sn-outline-item, .tg-card')]
        const el = btns.find((b) => (exact ? b.textContent.trim() === text : b.textContent.includes(text)))
        if (!el) return false
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        return true
      },
      { text, root, exact },
    )

  // ---- 打开编辑器 ----
  await page.goto(`${base}/edit/${encodeURIComponent(id)}?token=${token}`, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForFunction(() => document.querySelectorAll('iframe').length > 0, { timeout: 30000 })
  await sleep(2500)
  const slideCount = await page.evaluate(() => {
    const f = [...document.querySelectorAll('iframe')].find((x) => x.classList.contains('preview-frame') || !x.classList.contains('sn-thumb-frame-el'))
    try {
      return (f || document.querySelector('iframe')).contentDocument.querySelectorAll('svg[data-marpit-svg]').length
    } catch {
      return -1
    }
  })
  check('预览渲染 4 页', slideCount === 4, `slides=${slideCount}`)
  await page.screenshot({ path: join(shotDir, '01-editor-m2.png') })

  check('格式工具栏存在', (await page.$('.editor-toolbar')) != null)
  check('左侧大纲栏存在', (await page.$('.slide-navigator')) != null)
  check('右侧属性面板存在', (await page.$('.inspector')) != null)

  // ---- 大纲 ----
  const outlineCount = await page.$$eval('.sn-outline-item', (els) => els.length)
  check('大纲解析出标题（≥4）', outlineCount >= 4, `items=${outlineCount}`)
  const jumped = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.sn-outline-item')]
    // 找页码为 2 的条目
    const target = items.find((el) => /\b2\b/.test(el.querySelector('.sn-outline-page')?.textContent || ''))
    if (!target) return false
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  })
  await sleep(1200)
  const pageText = await page.evaluate(() => document.querySelector('.statusbar')?.textContent || '')
  check('大纲点击跳页（第 2 页）', jumped && /第\s*2\s*\/\s*4\s*页/.test(pageText), pageText.slice(0, 40))
  await page.screenshot({ path: join(shotDir, '02-outline.png') })

  // ---- 幻灯片缩略图 tab ----
  const tabOk = await page.evaluate(() => {
    const t = [...document.querySelectorAll('.sn-tab')].find((x) => x.textContent.includes('幻灯片'))
    if (!t) return false
    t.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  })
  await sleep(2000)
  const thumbInfo = await page.evaluate(() => {
    const thumbs = [...document.querySelectorAll('.sn-thumb')]
    const t = thumbs[2]
    if (t) t.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return { count: thumbs.length }
  })
  await sleep(1200)
  const pageText2 = await page.evaluate(() => document.querySelector('.statusbar')?.textContent || '')
  check('缩略图 tab 出现并点击跳页（第 3 页）', tabOk && thumbInfo.count > 0 && /第\s*3\s*\/\s*4\s*页/.test(pageText2), `thumbs=${thumbInfo.count} ${pageText2.slice(0, 30)}`)
  await page.screenshot({ path: join(shotDir, '03-thumbnails.png') })

  // ---- 属性面板交互 ----
  // 尺寸 4:3
  const sizeOk = await page.evaluate(() => {
    const group = [...document.querySelectorAll('.inspector-group')].find((g) => g.textContent.includes('幻灯片尺寸'))
    const btn = group && [...group.querySelectorAll('button')].find((b) => b.textContent.trim() === '4:3')
    if (!btn) return false
    btn.click()
    return true
  })
  await sleep(300)
  // 页码关闭
  const paginateOk = await page.evaluate(() => {
    const group = [...document.querySelectorAll('.inspector-group')].find((g) => g.textContent.trim().startsWith('页码'))
    const cb = group && group.querySelector('input[type=checkbox]')
    if (!cb) return false
    cb.click()
    return true
  })
  // 页眉输入（失焦/回车生效）
  const headerOk = await page.evaluate(() => {
    const group = [...document.querySelectorAll('.inspector-group')].find((g) => g.textContent.includes('页眉'))
    const input = group && group.querySelector('input.inspector-input[type=text]')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'M2 页眉测试')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    input.blur()
    return true
  })
  // 全局 class：lead
  const globalClassOk = await page.evaluate(() => {
    const group = [...document.querySelectorAll('.inspector-group')].find((g) => g.textContent.includes('全局 class'))
    const chip = group && [...group.querySelectorAll('.chip')].find((c) => c.textContent.trim() === 'lead')
    if (!chip) return false
    chip.click()
    return true
  })
  // 本页 class：center
  const pageClassOk = await page.evaluate(() => {
    const group = [...document.querySelectorAll('.inspector-group')].find((g) => g.textContent.includes('本页 class'))
    const chip = group && [...group.querySelectorAll('.chip')].find((c) => c.textContent.trim() === 'center')
    if (!chip) return false
    chip.click()
    return true
  })
  await sleep(2200)
  const mdAfter = await getDeckMd(id)
  check('属性：尺寸改为 4:3', sizeOk && /size:\s*4:3/.test(mdAfter))
  check(
    '属性：页码全局关闭',
    paginateOk && (/paginate:\s*false/.test(mdAfter) || !/^paginate:/m.test(mdAfter)),
    mdAfter.match(/^paginate:.*$/m)?.[0] || '(已移除=默认关闭)',
  )
  check('属性：页眉写入 front-matter', headerOk && /header:\s*['"]?M2 页眉测试/.test(mdAfter))
  check('属性：全局 class=lead', globalClassOk && /^class:\s*.*lead/m.test(mdAfter))
  check('属性：本页 class=center 指令', pageClassOk && /<!--\s*_class:\s*center/.test(mdAfter))
  check('属性：未知字段 author 保留', /^author:\s*张三/m.test(mdAfter))
  const vb4x3 = await page.evaluate(() => {
    const f = document.querySelector('.preview-frame') || document.querySelector('iframe')
    try {
      const svg = f.contentDocument.querySelector('svg[data-marpit-svg]')
      return svg ? svg.getAttribute('viewBox') : ''
    } catch {
      return ''
    }
  })
  check('属性：预览切到 4:3（viewBox 960×720）', /960\s+720/.test(vb4x3 || ''), vb4x3 || '')
  await page.screenshot({ path: join(shotDir, '04-inspector-applied.png') })

  // 属性面板滚动到背景图区域截图
  await page.evaluate(() => {
    const body = document.querySelector('.inspector-body')
    if (body) body.scrollTop = body.scrollHeight
  })
  await sleep(500)
  await page.screenshot({ path: join(shotDir, '05-inspector-bottom.png') })

  // ---- 图片插入器（背景图左 40%） ----
  const toolbarImageOk = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.editor-toolbar button')].find((b) => b.textContent.includes('图片'))
    if (!btn) return false
    btn.click()
    return true
  })
  await page.waitForSelector('.modal-panel', { timeout: 15000 })
  await sleep(800)
  const dialogFile = await page.$('.modal-panel input[type=file]')
  if (dialogFile) await dialogFile.uploadFile(join(ROOT, 'scripts/fixtures/test-photo.png'))
  await sleep(2000)
  const bgModeOk = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('.modal-panel')].find((d) => d.textContent.includes('插入图片'))
    if (!dialog) return false
    const bg = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '背景图')
    if (!bg) return false
    bg.click()
    return true
  })
  await sleep(400)
  const leftOk = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('.modal-panel')].find((d) => d.textContent.includes('插入图片'))
    const left = dialog && [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '左侧')
    if (!left) return false
    left.click()
    return true
  })
  await sleep(300)
  const ratioOk = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('.modal-panel')].find((d) => d.textContent.includes('插入图片'))
    const sliding = dialog && [...dialog.querySelectorAll('label')].find((l) => l.textContent.includes('占比'))
    const range = sliding && sliding.querySelector('input[type=range]')
    if (!range) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(range, '40')
    range.dispatchEvent(new Event('input', { bubbles: true }))
    range.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })
  await sleep(1500)
  await page.screenshot({ path: join(shotDir, '06-image-dialog-bg.png') })
  const insertImgOk = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('.modal-panel')].find((d) => d.textContent.includes('插入图片'))
    const btn = dialog && [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '插入图片')
    if (!btn) return false
    btn.click()
    return true
  })
  await sleep(2200)
  const mdAfterImg = await getDeckMd(id)
  check(
    '图片插入器：插入背景图（左侧 40%）',
    toolbarImageOk && bgModeOk && leftOk && ratioOk && insertImgOk && /!\[bg[^\]]*left:40%[^\]]*\]\(assets\//.test(mdAfterImg),
    mdAfterImg.match(/!\[bg[^\]]*\]\([^)]*\)/)?.[0] || '',
  )

  // ---- 表格插入器（3×3） ----
  const toolbarTableOk = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.editor-toolbar button')].find((b) => b.textContent.includes('表格'))
    if (!btn) return false
    btn.click()
    return true
  })
  await page.waitForSelector('.table-panel', { timeout: 15000 })
  await sleep(500)
  const gridOk = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.table-panel .grid-cell')]
    const target = cells[2 * 12 + 2] // 第 3 行第 3 列
    if (!target) return false
    target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    target.click()
    return true
  })
  await sleep(800)
  await page.screenshot({ path: join(shotDir, '07-table-dialog.png') })
  const insertTableOk = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.table-panel button')].find((b) => b.textContent.trim() === '插入表格')
    if (!btn) return false
    btn.click()
    return true
  })
  await sleep(2200)
  const mdAfterTable = await getDeckMd(id)
  const tableLines = mdAfterTable.split(/\r?\n/).filter((l) => /^\|/.test(l))
  check('表格插入器：插入 3×3 GFM 表格', toolbarTableOk && gridOk && insertTableOk && tableLines.length >= 4, `tableLines=${tableLines.length}`)

  // ---- 主题画廊 15 套 ----
  const galleryOpenOk = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.topbar button')].find((b) => b.textContent.trim() === '主题画廊')
    if (!btn) return false
    btn.click()
    return true
  })
  await page.waitForSelector('.tg-grid', { timeout: 15000 })
  await sleep(2500)
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('.tg-tab')].find((t) => t.textContent.trim().startsWith('全部'))
    if (tab) tab.click()
  })
  await sleep(1500)
  const themeCards = await page.$$eval('.tg-card[data-theme-name]', (els) => els.length)
  check('主题画廊 15 套（12 自制 + 3 内置）', galleryOpenOk && themeCards >= 15, `cards=${themeCards}`)
  await page.screenshot({ path: join(shotDir, '08-gallery-15.png') })

  // 导入外部 CSS 主题
  const importBtnOk = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.tg-actions button')].find((b) => b.textContent.includes('导入主题'))
    if (!btn) return false
    btn.click()
    return true
  })
  await sleep(500)
  const themeFileInput = await page.$('.tg-file-input')
  if (themeFileInput) await themeFileInput.uploadFile(join(ROOT, 'scripts/fixtures/user-theme.css'))
  await sleep(2500)
  const imported = (await api('/themes')).json?.themes?.some((t) => t.name === 'm2-e2e-theme')
  check('主题导入：弹出文件选择并成功导入', importBtnOk && !!imported, imported ? 'm2-e2e-theme 已在 API' : '未找到')
  await sleep(800)
  await page.screenshot({ path: join(shotDir, '09-gallery-imported.png') })

  // ---- 主题编辑器（新建） ----
  const newThemeOk = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.tg-actions button')].find((b) => b.textContent.includes('新建主题'))
    if (!btn) return false
    btn.click()
    return true
  })
  await sleep(2000)
  const editorInfo = await page.evaluate(() => {
    const editor = document.querySelector('.theme-editor')
    if (!editor) return null
    const ta = editor.querySelector('.te-textarea')
    const name = editor.querySelector('.te-name')
    const preview = editor.querySelector('.te-preview-frame')
    return { hasTextarea: !!ta, cssLen: ta ? ta.value.length : 0, name: name ? name.value : '', preview: !!preview }
  })
  check('主题编辑器：打开并带 CSS/预览', newThemeOk && !!editorInfo?.hasTextarea && editorInfo.cssLen > 20 && editorInfo.preview, JSON.stringify(editorInfo || {}))
  await page.screenshot({ path: join(shotDir, '10-theme-editor.png') })
  await page.evaluate(() => {
    const editor = document.querySelector('.theme-editor')
    const close = editor && [...editor.querySelectorAll('button')].find((b) => b.textContent.trim() === '关闭')
    if (close) close.click()
  })
  await sleep(600)
  // 关闭画廊
  await page.keyboard.press('Escape')
  await sleep(500)

  const jsErrors = errors.filter((e) => !/Failed to load resource/.test(e))
  check('无前端 JS 错误', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '))
  check('无 404 资源', resource404.length === 0, resource404.slice(0, 5).join(' | '))
  check('无外网请求', externalRequests.length === 0, externalRequests.slice(0, 3).join(' | '))
  log(`\n截图目录: ${shotDir}`)
  log(`数据目录: ${dataDir}`)
} catch (e) {
  check('M2 E2E 执行', false, String(e?.stack || e))
} finally {
  if (browser) await browser.close().catch(() => {})
  child.kill()
  if (!keep) {
    // 保留截图；数据目录交给系统临时目录，不主动删（便于排查时 --keep）
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n[M2-E2E] ${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
}
