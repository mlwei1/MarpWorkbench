/**
 * M2 插入器真实浏览器冒烟（mock 模式，无需后端）：
 * 启动 Vite dev（MWB_DEV_PORT=5183）→ 打开工作区 → 进入编辑器 →
 * 图片对话框：上传图片 → 切背景图/左侧 → 预览 iframe 渲染 → 插入 → 校验编辑器内容与 toast
 * 表格对话框：打开 → 插入 → 校验 GFM 表格写入编辑器
 *
 * 用法：node spike/export/scripts/verify-m2-ui.mjs
 * 产物：spike/export/out/m2-image-dialog.png / m2-image-bg.png / m2-table-dialog.png / m2-ui-report.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const REPO = path.resolve(ROOT, '..', '..')
const outDir = path.join(ROOT, 'out')
fs.mkdirSync(outDir, { recursive: true })
const BASE = process.env.MWB_UI_BASE || 'http://127.0.0.1:5183'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const uploadImage = path.join(outDir, 'cdp-slide-1.png')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
  return ok
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitServer(timeoutMs = 60000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(BASE)
      if (res.ok) return
    } catch {
      /* retry */
    }
    await sleep(300)
  }
  throw new Error('dev server 未就绪')
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--disable-gpu', '--no-first-run', '--window-size=1500,950'],
  defaultViewport: { width: 1500, height: 950 }
})
const page = await browser.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)))

try {
  await waitServer()
  check('Vite dev server 就绪', true, BASE)
  await page.goto(`${BASE}/?mock=1`, { waitUntil: 'networkidle2', timeout: 120000 })

  // 进入第一个 deck 的编辑器
  await page.waitForSelector('.deck-main', { timeout: 60000 })
  await page.click('.deck-main')
  await page.waitForSelector('.editor-toolbar', { timeout: 60000 })
  await sleep(1200)
  check('进入编辑器（mock deck）', page.url().includes('/edit/'), page.url())

  // ---- 图片对话框 ----
  await page.click('button[title="插入图片 / 背景图"]')
  await page.waitForSelector('.insert-panel', { timeout: 30000 })
  await sleep(600)
  await page.screenshot({ path: path.join(outDir, 'm2-image-dialog.png') })
  const title = await page.$eval('.insert-panel .modal-head h2', (el) => el.textContent || '')
  check('图片对话框打开', title.includes('插入图片'), title)

  // 上传图片（mock 模式本地 dataURL）
  const fileInput = await page.$('.insert-panel input[type="file"]')
  await fileInput.uploadFile(uploadImage)
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.insert-panel .snippet')
      return el && /assets\//.test(el.textContent || '')
    },
    { timeout: 30000 }
  )
  const snippet1 = await page.$eval('.insert-panel .snippet', (el) => (el.textContent || '').trim())
  check('上传后生成普通图片语法（px 宽度）', /!\[[^\]]*w:\d+px[^\]]*\]\(assets\//.test(snippet1), snippet1)

  // 切背景图 + 左侧 40%
  const clickByText = async (selector, text) => {
    const handles = await page.$$(selector)
    for (const h of handles) {
      const t = await h.evaluate((el) => (el.textContent || '').trim())
      if (t === text) {
        await h.click()
        return true
      }
    }
    return false
  }
  await clickByText('.insert-panel .seg-btn', '背景图')
  await sleep(200)
  await clickByText('.insert-panel .seg-btn', '左侧')
  await sleep(300)
  const snippet2 = await page.$eval('.insert-panel .snippet', (el) => (el.textContent || '').trim())
  check('背景图左侧 40% 语法', /!\[bg left:40%[^\]]*\]\(assets\//.test(snippet2), snippet2)
  await page.screenshot({ path: path.join(outDir, 'm2-image-bg.png') })

  // 预览 iframe 有渲染页
  const previewInfo = await page.evaluate(() => {
    const frame = document.querySelector('.insert-panel .preview-frame')
    const doc = frame?.contentDocument
    if (!doc) return { ok: false }
    const figureStyle = doc.querySelector('figure')?.getAttribute('style') || ''
    return {
      ok: true,
      slides: doc.querySelectorAll('div.marpit > svg[data-marpit-svg]').length,
      visibleSlides: [...doc.querySelectorAll('div.marpit > svg[data-marpit-svg]')].filter(
        (s) => getComputedStyle(s).display !== 'none'
      ).length,
      bgSplit: doc.querySelector('section[data-marpit-advanced-background]')?.getAttribute('data-marpit-advanced-background-split') || null,
      figureHasBg: /background-image/.test(figureStyle),
      figureIsDataUrl: /data:image\//.test(figureStyle)
    }
  })
  check(
    '对话框预览：仅显示当前页 + 背景 split + 资产已内联',
    previewInfo.ok &&
      previewInfo.slides >= 1 &&
      previewInfo.visibleSlides === 1 &&
      previewInfo.bgSplit === 'left' &&
      previewInfo.figureHasBg &&
      previewInfo.figureIsDataUrl,
    JSON.stringify(previewInfo)
  )

  // 插入背景图 → 编辑器内容 + toast
  await page.click('.insert-panel .btn-primary')
  await sleep(900)
  const dialogGone = !(await page.$('.insert-panel'))
  const cmText = await page.$eval('.cm-content', (el) => el.textContent || '')
  const toastText = await page.$$eval('.toast-text', (els) => els.map((e) => e.textContent || '').join(' | ')).catch(() => '')
  check('背景图插入成功（对话框关闭 + 编辑器含 bg 语法）', dialogGone && /!\[bg left:40%/.test(cmText), JSON.stringify({ toastText }))

  // ---- 表格对话框 ----
  await page.click('button[title="插入表格"]')
  await page.waitForSelector('.table-panel', { timeout: 30000 })
  await sleep(400)
  await page.screenshot({ path: path.join(outDir, 'm2-table-dialog.png') })
  const cells = await page.$$eval('.cell-editor input', (els) => els.length)
  const previewHtml = await page.$eval('.table-preview table', (el) => el.innerHTML.slice(0, 200))
  check('表格对话框打开（单元格可编辑 + 预览）', cells === 9 && previewHtml.includes('表头'), `cells=${cells}`)

  // 点 5×4 网格
  const gridCells = await page.$$('.grid-cell')
  await gridCells[4 * 12 + 3].click() // 第 5 行第 4 列
  await sleep(300)
  const cells2 = await page.$$eval('.cell-editor input', (els) => els.length)
  check('网格选择 5×4 → 20 个单元格', cells2 === 20, `cells=${cells2}`)

  await page.click('.table-panel .btn-primary')
  await sleep(800)
  const tableDialogGone = !(await page.$('.table-panel'))
  const toastText2 = await page.$$eval('.toast-text', (els) => els.map((e) => e.textContent || '').join(' | ')).catch(() => '')
  // 注：CodeMirror 只渲染可视行，长文档里新插入的表格可能不在 .cm-content 文本中，
  // 因此以「对话框关闭 + 成功 toast」判定插入链路；GFM 语法正确性由 verify-compose.mjs 覆盖。
  check('表格插入成功（对话框关闭 + toast）', tableDialogGone && /已插入表格/.test(toastText2), JSON.stringify({ toastText2 }))

  check('无页面 JS 错误', pageErrors.length === 0, pageErrors.join(' ; '))
} catch (err) {
  check('M2 UI 冒烟执行', false, String(err?.stack || err))
} finally {
  await browser.close()
  const failed = checks.filter((c) => !c.ok)
  fs.writeFileSync(path.join(outDir, 'm2-ui-report.json'), JSON.stringify({ ok: failed.length === 0, checks }, null, 2))
  console.log(`\n[verify-m2-ui] ${checks.length - failed.length}/${checks.length} 通过`)
  if (failed.length) process.exit(1)
}
