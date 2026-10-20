// M2 主题编辑器入口验证（真实 exe）：属性面板「编辑主题」→ 画廊 → ThemeEditor
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const req = createRequire(path.join(repoRoot, 'spike/marp/package.json'))
const puppeteer = req('puppeteer-core')
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const shotDir = path.join(os.tmpdir(), 'mwb-theme-editor')
fs.mkdirSync(shotDir, { recursive: true })

const base = process.argv[2]
const token = process.argv[3]
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
page.setDefaultTimeout(30000)
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))

async function main() {
  await page.goto(`${base}/?token=${token}`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('.deck-item', { timeout: 20000 })
  await page.click('.deck-item .deck-main')
  await page.waitForSelector('.cm-content', { timeout: 20000 })
  await page.waitForSelector('.inspector', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 2500))

  // 点属性面板「编辑主题」
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.inspector button')].find((b) => b.textContent?.trim() === '编辑主题')
    if (!btn) return false
    btn.click()
    return true
  })
  if (!clicked) throw new Error('未找到属性面板「编辑主题」按钮')
  await new Promise((r) => setTimeout(r, 3000))

  const state = await page.evaluate(() => {
    const gallery = document.querySelector('.gallery-panel')
    const text = document.body.innerText || ''
    return {
      galleryOpen: !!gallery,
      hasThemeEditor: !!document.querySelector('.theme-editor, .te-root, [class*="theme-editor"], .css-editor, textarea'),
      textareaCount: document.querySelectorAll('textarea').length,
      textHints: ['主题编辑器', '保存主题', 'CSS'].filter((t) => text.includes(t)),
      topText: text.slice(0, 200),
    }
  })
  await page.screenshot({ path: path.join(shotDir, 'theme-editor.png') })
  console.log(JSON.stringify({ state, errors, screenshot: path.join(shotDir, 'theme-editor.png') }, null, 2))
  await browser.close()
  if (!state.galleryOpen) process.exitCode = 1
}

main().catch(async (e) => {
  console.error('验证失败：', e)
  await browser.close().catch(() => {})
  process.exit(1)
})
