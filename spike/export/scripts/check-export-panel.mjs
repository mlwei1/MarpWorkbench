/**
 * 导出面板快速检查（Vite dev + mock，无需后端）：
 * - 面板能打开、无 JS 错误
 * - editable 模块缺失时格式卡数量=3（可编辑卡隐藏）；存在时=4 且含「PPTX 可编辑」
 * 用法：node spike/export/scripts/check-export-panel.mjs [--expect-editable=0|1]
 * 前置：$env:MWB_DEV_PORT='5194'; pnpm --dir web dev（另开终端）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const outDir = path.join(ROOT, 'out')
fs.mkdirSync(outDir, { recursive: true })
const BASE = process.env.MWB_UI_BASE || 'http://localhost:5194'
const expectArg = process.argv.find((a) => a.startsWith('--expect-editable='))
const expectEditable = expectArg ? Number(expectArg.split('=')[1]) : null
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + String(detail).slice(0, 240) : ''}`)
  return ok
}

// 等 dev server
let ready = false
for (let i = 0; i < 120; i++) {
  try {
    const res = await fetch(BASE + '/')
    if (res.ok) {
      ready = true
      break
    }
  } catch {
    /* retry */
  }
  await sleep(500)
}
if (!ready) {
  console.error('dev server 未就绪：', BASE)
  process.exit(2)
}

const puppeteer = (await import('puppeteer-core')).default
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--disable-gpu', '--no-first-run', '--window-size=1400,900'],
  defaultViewport: { width: 1400, height: 900 }
})
try {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)))
  await page.goto(`${BASE}/?mock=1`, { waitUntil: 'networkidle2', timeout: 120000 })
  await page.waitForSelector('.deck-main', { timeout: 60000 })
  await page.click('.deck-main')
  await page.waitForSelector('.editor-toolbar', { timeout: 60000 })
  await sleep(1200)

  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    const btn = btns.find((b) => (b.textContent || '').trim() === '导出')
    btn?.click()
  })
  await page.waitForSelector('.mwb-export-panel', { timeout: 30000 })
  await sleep(700)
  const cards = await page.$$eval('.mwb-export-panel .fmt strong', (els) => els.map((el) => (el.textContent || '').trim()))
  const hasEditable = cards.some((c) => c.includes('可编辑'))
  check('导出面板打开', cards.length > 0, JSON.stringify(cards))
  if (expectEditable === 0) {
    check('editable 模块缺失时隐藏「PPTX 可编辑」卡（共 3 张）', cards.length === 3 && !hasEditable, JSON.stringify(cards))
  } else if (expectEditable === 1) {
    check('editable 模块就绪时出现「PPTX 可编辑」卡（共 4 张）', cards.length === 4 && hasEditable, JSON.stringify(cards))
  } else {
    check('格式卡数量为 3 或 4', cards.length === 3 || cards.length === 4, JSON.stringify(cards))
  }
  const footLabel = await page.$eval('.mwb-export-panel .mwb-export-foot .primary', (el) => (el.textContent || '').trim())
  check('底部按钮文案正常', /导出/.test(footLabel), footLabel)
  await page.screenshot({ path: path.join(outDir, 'export-panel-cards.png') })
  check('无页面 JS 错误', pageErrors.length === 0, pageErrors.join(' ; '))
} finally {
  await browser.close()
  const failed = results.filter((r) => !r.ok)
  fs.writeFileSync(path.join(outDir, 'export-panel-check.json'), JSON.stringify({ ok: failed.length === 0, results }, null, 2))
  console.log(`\n[check-export-panel] ${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) process.exit(1)
}
