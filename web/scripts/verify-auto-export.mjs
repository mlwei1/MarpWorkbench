/**
 * M5.1 前端 autoExport 自测（marp-tech）
 * - `?autoExport=pptx-editable` → 无需点击自动导出并下载 .pptx
 * - 普通访问不带参数 → 不自动打开/导出；手动导出照常可用
 * - 非法 autoExport 值被忽略
 *
 * 用法：node web/scripts/verify-auto-export.mjs --url http://127.0.0.1:8894 --token <token>
 * 前置：pnpm --dir web build；真实 exe 已启动（MWB_WEB_DIR=<repo>/web/dist）
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const workDir = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const argValue = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : null)
const baseUrl = argValue('--url')
const token = argValue('--token')
if (!baseUrl || !token) {
  console.error('用法：node web/scripts/verify-auto-export.mjs --url <base> --token <token>')
  process.exit(2)
}

function loadPuppeteer() {
  for (const pkg of [path.join(workDir, 'package.json'), path.join(repoRoot, 'spike', 'marp', 'package.json')]) {
    try {
      return createRequire(pkg)('puppeteer-core')
    } catch {
      /* next */
    }
  }
  throw new Error('找不到 puppeteer-core')
}
const chrome = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const report = { steps: [], errors: [], screenshots: [] }
function step(name, ok, detail) {
  report.steps.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const workTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mwb-autoexport-'))
const downloadDir = path.join(workTmp, 'downloads')
const profileDir = path.join(workTmp, 'profile')
fs.mkdirSync(downloadDir, { recursive: true })

function listDownloads(ext) {
  if (!fs.existsSync(downloadDir)) return []
  return fs
    .readdirSync(downloadDir)
    .filter((f) => f.toLowerCase().endsWith(ext) && !f.endsWith('.crdownload'))
    .map((f) => ({ file: f, size: fs.statSync(path.join(downloadDir, f)).size }))
}

async function waitForDownload(ext, timeoutMs, previousNames = []) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = listDownloads(ext).filter((f) => !previousNames.includes(f.file))
    if (found.length) return found[0]
    await sleep(300)
  }
  return null
}

const DECK_MD = `---
marp: true
theme: business-blue
paginate: true
size: 16:9
---

# CLI 自动导出测试

## 第一页

- 条目 A
- 条目 B

---

## 第二页

| 列 1 | 列 2 |
| --- | --- |
| 数据 A | 数据 B |

<!-- 这是第二页的演讲者备注 -->

---

## 第三页

Mermaid 与中文混排：

\`\`\`mermaid
graph LR
  A[开始] --> B[结束]
\`\`\`
`

async function main() {
  const puppeteer = loadPuppeteer()
  if (!chrome) throw new Error('未找到 Chrome/Edge')

  const api = async (p, init = {}) => {
    const res = await fetch(`${baseUrl}/api${p}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'X-MWB-Token': token, ...(init.headers || {}) },
    })
    return { status: res.status, json: await res.json().catch(() => null) }
  }
  const created = await api('/decks', { method: 'POST', body: JSON.stringify({ name: 'AutoExport-Test', template: 'blank' }) })
  const deckId = created.json?.id
  if (!deckId) throw new Error('创建 deck 失败')
  const saved = await api(`/decks/${encodeURIComponent(deckId)}`, { method: 'PUT', body: JSON.stringify({ content: DECK_MD }) })
  if (saved.status !== 200) throw new Error('写入 deck 失败')
  step('创建测试 deck（3 页 + Mermaid + 备注）', true, deckId)

  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    userDataDir: profileDir,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none', '--disable-features=DownloadBubble'],
  })
  // 下载行为：CDP 指定下载目录（headless Chrome 的 a[download] 会直接保存）
  try {
    const browserSession = await browser.target().createCDPSession()
    await browserSession.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true })
  } catch (err) {
    console.warn('Browser.setDownloadBehavior 失败：', String(err))
  }

  const page = await browser.newPage()
  await page.setViewport({ width: 1680, height: 1050 })
  page.setDefaultTimeout(40000)
  page.on('pageerror', (e) => report.errors.push(`pageerror: ${String(e).slice(0, 400)}`))
  page.on('console', (m) => {
    if (m.type() === 'error') report.errors.push(`console.error: ${m.text().slice(0, 400)}`)
  })
  try {
    await page.createCDPSession()
      .then((s) => s.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir }))
      .catch(() => {})
  } catch {
    /* ignore */
  }

  const editorUrl = `${baseUrl}/edit/${encodeURIComponent(deckId)}?token=${encodeURIComponent(token)}&autoExport=pptx-editable`

  // ---------- 1. 自动导出（无需点击） ----------
  await page.goto(editorUrl, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForSelector('.mwb-export-panel', { timeout: 30000 })
  const autoState = await page.evaluate(() => ({
    sessionCleared: sessionStorage.getItem('mwb.autoExport') === null,
    urlCleared: !location.search.includes('autoExport'),
    activeFormat: (document.querySelector('.mwb-export-panel .fmt.active strong')?.textContent || '').trim(),
    stageVisible: !!document.querySelector('.mwb-export-panel'),
  }))
  step('deck 就绪后自动打开导出面板', autoState.stageVisible)
  step('自动格式 = PPTX 可编辑', autoState.activeFormat.includes('可编辑'), autoState.activeFormat)
  step('sessionStorage autoExport 已消费清除', autoState.sessionCleared)
  step('地址栏 autoExport 参数已清除（刷新不会重复导出）', autoState.urlCleared)

  const editableFile = await waitForDownload('.pptx', 150000)
  step('无点击自动下载 .pptx', !!editableFile && editableFile.size > 20 * 1024, editableFile ? `${editableFile.file} / ${editableFile.size}B` : '未出现下载文件')
  const autoResult = await page
    .waitForFunction(
      () => {
        const el = document.querySelector('.mwb-export-result.ok')
        return el ? el.textContent || '' : ''
      },
      { timeout: 30000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => '')
  step('自动导出完成结果展示', /已下载/.test(String(autoResult)), String(autoResult).replace(/\s+/g, ' ').slice(0, 140))
  await page.screenshot({ path: path.join(workTmp, '01-auto-export.png') })
  report.screenshots.push(path.join(workTmp, '01-auto-export.png'))

  // ---------- 2. 普通访问：不自动打开/导出；手动导出照常 ----------
  const page2 = await browser.newPage()
  await page2.setViewport({ width: 1680, height: 1050 })
  page2.setDefaultTimeout(40000)
  page2.on('pageerror', (e) => report.errors.push(`pageerror(manual): ${String(e).slice(0, 400)}`))
  await page2.goto(`${baseUrl}/edit/${encodeURIComponent(deckId)}?token=${encodeURIComponent(token)}`, { waitUntil: 'networkidle2' })
  await page2.waitForSelector('.cm-content', { timeout: 30000 })
  await sleep(2500)
  const autoOpened = !!(await page2.$('.mwb-export-panel'))
  const filesBeforeManual = listDownloads('.pptx').map((f) => f.file)
  step('普通访问不自动打开导出面板', !autoOpened)
  step('普通访问不产生自动下载', filesBeforeManual.length === 1, `files=${filesBeforeManual.join(',')}`)

  await page2.evaluate(() => {
    const btn = [...document.querySelectorAll('.editor-topbar button')].find((b) => (b.textContent || '').trim().includes('导出'))
    btn?.click()
  })
  await page2.waitForSelector('.mwb-export-panel', { timeout: 15000 })
  const manualFormat = await page2.evaluate(() =>
    (document.querySelector('.mwb-export-panel .fmt.active strong')?.textContent || '').trim(),
  )
  step('手动打开面板默认 PPTX 图片版', manualFormat === 'PPTX', manualFormat)
  await page2.waitForSelector('.mwb-export-foot .primary', { timeout: 10000 })
  await page2.click('.mwb-export-foot .primary')
  const manualFile = await waitForDownload('.pptx', 120000, filesBeforeManual)
  step('手动导出 PPTX 图片版可下载', !!manualFile && manualFile.size > 20 * 1024, manualFile ? `${manualFile.file} / ${manualFile.size}B` : '未出现下载文件')
  await page2.screenshot({ path: path.join(workTmp, '02-manual-export.png') })
  report.screenshots.push(path.join(workTmp, '02-manual-export.png'))

  // ---------- 3. 非法 autoExport 值被忽略 ----------
  const page3 = await browser.newPage()
  await page3.goto(`${baseUrl}/edit/${encodeURIComponent(deckId)}?token=${encodeURIComponent(token)}&autoExport=docx`, {
    waitUntil: 'networkidle2',
  })
  await page3.waitForSelector('.cm-content', { timeout: 30000 })
  await sleep(3000)
  const badState = await page3.evaluate(() => ({
    panel: !!document.querySelector('.mwb-export-panel'),
    stored: sessionStorage.getItem('mwb.autoExport'),
  }))
  step('非法 autoExport 被忽略（不保存/不打开）', !badState.panel && badState.stored === null, JSON.stringify(badState))

  step('无页面 JS 错误', report.errors.length === 0, report.errors.slice(0, 3).join(' | ') || '0')
  await browser.close()
  fs.writeFileSync(path.join(workTmp, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`\n截图/报告：${workTmp}`)
  if (report.steps.some((s) => !s.ok)) {
    console.error('\n❌ 有失败项')
    process.exitCode = 1
  } else {
    console.log('\n✅ 全部通过')
  }
}

main().catch((err) => {
  console.error('验证异常：', err)
  process.exitCode = 1
  setTimeout(() => process.exit(1), 500)
})
