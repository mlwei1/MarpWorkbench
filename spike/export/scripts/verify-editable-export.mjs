/**
 * M4 可编辑 PPTX 真实端到端验收（owner: export-eng，集成侧）
 *
 * 前提：release exe 已包含最新 web/dist（含 `web/src/export/editable/**` 与导出面板集成）。
 * 流程：启动 exe（临时数据目录）→ API 建 13 页 deck（中文标题/列表/代码/表格/背景图/Mermaid/备注）
 *       → 真实 Chrome 打开编辑器 → 导出面板 → 选「PPTX 可编辑（Beta）」→ 导出 → 等下载
 *       → 解包校验：页数、sldSz、每页背景 blipFill、notes 文本、a:t 文本集合、a:tbl 表格对象、run 字体
 *       → 结果面板文案统计校验（N 页 · 文本框 M · 表格 K）
 *
 * 用法：node spike/export/scripts/verify-editable-export.mjs
 * 产物：out/m4-editable-*.pptx、out/m4-editable-report.json、out/m4-editable-panel.png / m4-editable-done.png
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const REPO = path.resolve(ROOT, '..', '..')
const outDir = path.join(ROOT, 'out')
fs.mkdirSync(outDir, { recursive: true })
const EXE = path.join(REPO, 'server', 'target', 'release', 'MarpWorkbench.exe')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail: String(detail).slice(0, 500) })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`)
  return ok
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function killTree(pid) {
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* ignore */
  }
}

async function waitListen(child, timeoutMs = 40000) {
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => (stdout += d.toString()))
  child.stderr.on('data', (d) => (stderr += d.toString()))
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const mUrl = stdout.match(/MWB_LISTEN_URL=(\S+)/)
    const mTok = stdout.match(/MWB_TOKEN=(\S+)/)
    if (mUrl && mTok) return { base: mUrl[1].replace(/\/$/, ''), token: mTok[1] }
    await sleep(120)
  }
  throw new Error(`等待服务启动超时 stdout=${stdout.slice(-400)} stderr=${stderr.slice(-400)}`)
}

async function api(base, token, route, init = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-MWB-Token': token, ...(init.headers || {}) }
  const res = await fetch(base + '/api' + route, { ...init, headers })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* ignore */
  }
  return { status: res.status, json, text }
}

/** 13 页样例：中文标题、列表、代码、表格、背景图、Mermaid、每页备注 */
function buildDeckMarkdown() {
  const pages = []
  pages.push(
    ['# MarpWorkbench 可编辑导出', '## Beta 验收 · 中文标题', '这是封面页正文。'].join('\n') +
      '\n\n<!-- 第 1 页备注：可编辑 PPTX 封面验收。 -->'
  )
  pages.push(
    ['## 中文与列表', '', '- 第一项：文字可编辑', '- 第二项：列表转文本对象', '- 第三项：加粗 **可编辑**'].join('\n') +
      '\n\n<!-- 第 2 页备注：列表页。 -->'
  )
  pages.push(
    [
      '## 代码块',
      '',
      '```js',
      'const marp = new Marp()',
      'const { html } = marp.render(markdown)',
      'console.log(html.length)',
      '```'
    ].join('\n') + '\n\n<!-- 第 3 页备注：代码页。 -->'
  )
  pages.push(
    [
      '## 表格',
      '',
      '| 能力 | 可编辑 |',
      '| --- | --- |',
      '| 文字 | 是 |',
      '| 表格 | 是 |',
      '| 背景 | 否 |'
    ].join('\n') + '\n\n<!-- 第 4 页备注：表格页。 -->'
  )
  pages.push(
    ['![bg left:40%](assets/test-bg.png)', '', '## 背景图页', '', '背景在左侧，正文可编辑。'].join('\n') +
      '\n\n<!-- 第 5 页备注：背景图页。 -->'
  )
  pages.push(
    ['```mermaid', 'graph LR', 'A[开始] --> B[结束]', '```', '', '## Mermaid 页'].join('\n') +
      '\n\n<!-- 第 6 页备注：Mermaid 页。 -->'
  )
  for (let i = 7; i <= 13; i++) {
    pages.push(`# 第 ${i} 页\n\n中文段落 ${i}：用于验证页数、背景底图与备注。\n\n<!-- 第 ${i} 页备注：note-${i} -->`)
  }
  return ['---', 'marp: true', 'theme: business-blue', 'paginate: true', 'size: 16:9', '---', '', pages.join('\n\n---\n\n')].join('\n')
}

function inspectPptx(pptxPath) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-pptx-inspect-'))
  try {
    const zip = path.join(work, 'deck.zip')
    fs.copyFileSync(pptxPath, zip)
    const res = spawnSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -Path '${zip}' -DestinationPath '${path.join(work, 'x')}' -Force`],
      { encoding: 'utf8' }
    )
    if (res.status !== 0) throw new Error(`解压失败: ${res.stderr || res.stdout}`)
    const x = path.join(work, 'x')
    const slidesDir = path.join(x, 'ppt', 'slides')
    const notesDir = path.join(x, 'ppt', 'notesSlides')
    const slideFiles = fs.existsSync(slidesDir)
      ? fs
          .readdirSync(slidesDir)
          .filter((f) => /^slide\d+\.xml$/.test(f))
          .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]))
      : []
    const presXml = fs.readFileSync(path.join(x, 'ppt', 'presentation.xml'), 'utf8')
    const sldSz = /<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(presXml)
    const notesFiles = fs.existsSync(notesDir)
      ? fs
          .readdirSync(notesDir)
          .filter((f) => /^notesSlide\d+\.xml$/.test(f))
          .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]))
      : []
    const notesTexts = notesFiles.map((f) => fs.readFileSync(path.join(notesDir, f), 'utf8'))
    let allText = ''
    let tableCount = 0
    let slideWithBg = 0
    let runWithFont = 0
    for (const f of slideFiles) {
      const xml = fs.readFileSync(path.join(slidesDir, f), 'utf8')
      allText += [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join('') + '\n'
      tableCount += (xml.match(/<a:tbl>/g) || []).length
      if (/<p:bg>[\s\S]*?<a:blipFill/.test(xml) || /<p:bg>[\s\S]*?r:embed/.test(xml)) slideWithBg++
      runWithFont += (xml.match(/<a:rPr[^>]*?(?:sz|typeface)=/g) || []).length
    }
    const notesAll = notesTexts.join('\n')
    const notesPlain = [...notesAll.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join(' ')
    return {
      slideCount: slideFiles.length,
      sldSz: sldSz ? { cx: sldSz[1], cy: sldSz[2], inches: `${(Number(sldSz[1]) / 914400).toFixed(3)} x ${(Number(sldSz[2]) / 914400).toFixed(3)}` } : null,
      slideWithBg,
      tableCount,
      runWithFont,
      allText,
      notesCount: notesFiles.length,
      notesPlain
    }
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

let child = null
let browser = null
let dataDir = null
let downloadDir = null
try {
  if (!fs.existsSync(EXE)) throw new Error('release exe 不存在（先 pnpm run build）')
  const editableDir = path.join(REPO, 'web', 'src', 'export', 'editable')
  check('editable 模块已存在（web/src/export/editable/**）', fs.existsSync(editableDir), editableDir)

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwb-m4-e2e-'))
  child = spawn(EXE, [], {
    env: { ...process.env, MWB_DATA_DIR: dataDir, MWB_NO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const { base, token } = await waitListen(child)
  check('真实 exe 启动', true, base)

  const created = await api(base, token, '/decks', {
    method: 'POST',
    body: JSON.stringify({ name: 'M4 可编辑 PPTX 验收', template: 'blank' })
  })
  const deckId = created.json?.id
  check('创建 deck', created.status === 200 && !!deckId, deckId)

  // 上传背景图（multipart）
  const form = new FormData()
  form.append('file', new Blob([PNG_1PX], { type: 'image/png' }), 'test-bg.png')
  const upload = await fetch(`${base}/api/decks/${encodeURIComponent(deckId)}/assets`, {
    method: 'POST',
    headers: { 'X-MWB-Token': token },
    body: form
  })
  check('上传背景图资产', upload.ok, `status=${upload.status}`)

  const markdown = buildDeckMarkdown()
  const saved = await api(base, token, `/decks/${encodeURIComponent(deckId)}`, {
    method: 'PUT',
    body: JSON.stringify({ content: markdown })
  })
  check('保存 13 页 deck', saved.status === 200, `pages=${(markdown.match(/^---$/gm) || []).length}`)

  // 真实浏览器
  const puppeteer = (await import('puppeteer-core')).default
  downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwb-m4-dl-'))
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--disable-gpu', '--no-first-run', '--window-size=1500,980'],
    defaultViewport: { width: 1500, height: 980 }
  })
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)))
  const cdp = await page.createCDPSession()
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir })

  await page.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.goto(`${base}/edit/${encodeURIComponent(deckId)}`, { waitUntil: 'networkidle2', timeout: 120000 })
  await page.waitForSelector('.editor-toolbar', { timeout: 60000 })
  await sleep(1500)

  // 打开导出面板
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    const btn = btns.find((b) => (b.textContent || '').trim() === '导出')
    btn?.click()
  })
  await page.waitForSelector('.mwb-export-panel', { timeout: 30000 })
  await sleep(800)
  await page.screenshot({ path: path.join(outDir, 'm4-editable-panel.png') })
  const cards = await page.$$eval('.mwb-export-panel .fmt', (els) =>
    els.map((el) => (el.querySelector('strong')?.textContent || '').trim())
  )
  check('导出面板出现「PPTX 可编辑」格式卡', cards.some((c) => c.includes('可编辑')), JSON.stringify(cards))

  // 选可编辑格式
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.mwb-export-panel .fmt')]
    const card = cards.find((el) => (el.textContent || '').includes('可编辑'))
    card?.click()
  })
  await sleep(400)
  const hint = await page.$eval('.mwb-export-panel .mwb-export-hint', (el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
  check('可编辑格式说明包含边界（背景/图片/Mermaid/页码为底图）', /底图/.test(hint) && /Beta/.test(hint), hint.slice(0, 160))

  // 点导出
  await page.click('.mwb-export-panel .mwb-export-foot .primary')
  const t0 = Date.now()
  let doneText = ''
  let sawProgress = ''
  for (let i = 0; i < 300; i++) {
    await sleep(400)
    const state = await page.evaluate(() => {
      const panel = document.querySelector('.mwb-export-panel')
      if (!panel) return { gone: true }
      return {
        result: panel.querySelector('.mwb-export-result.ok pre')?.textContent || '',
        error: panel.querySelector('.mwb-export-result.err .msg')?.textContent || '',
        detail: panel.querySelector('.mwb-export-result.err .detail')?.textContent || '',
        progress: panel.querySelector('.mwb-export-progress p')?.textContent || ''
      }
    })
    if (state.progress) sawProgress = state.progress
    if (state.result) {
      doneText = state.result
      break
    }
    if (state.error) {
      throw new Error(`导出失败：${state.error}${state.detail ? ' / ' + state.detail : ''}（最后进度：${sawProgress}）`)
    }
  }
  const exportMs = Date.now() - t0
  check('可编辑 PPTX 导出完成（面板显示统计）', /可编辑/.test(doneText), doneText.replace(/\n/g, ' ').slice(0, 200))
  await page.screenshot({ path: path.join(outDir, 'm4-editable-done.png') })
  const statMatch = /(\d+)\s*页.*?文本框\s*(\d+).*?表格\s*(\d+)/.exec(doneText.replace(/\n/g, ' '))
  check(
    '结果文案含「N 页 · 文本框 M · 表格 K」且页数=13',
    !!statMatch && Number(statMatch[1]) === 13,
    JSON.stringify(statMatch && { pages: statMatch[1], texts: statMatch[2], tables: statMatch[3] })
  )

  // 等下载文件
  let pptxPath = ''
  for (let i = 0; i < 100; i++) {
    const files = fs.readdirSync(downloadDir).filter((f) => f.endsWith('.pptx'))
    if (files.length) {
      const f = path.join(downloadDir, files[0])
      const st = fs.statSync(f)
      if (st.size > 0) {
        await sleep(800)
        if (fs.statSync(f).size === st.size) {
          pptxPath = f
          break
        }
      }
    }
    await sleep(300)
  }
  check('浏览器下载得到 .pptx 文件', !!pptxPath, pptxPath && `${path.basename(pptxPath)} ${fs.statSync(pptxPath).size} B`)
  check('文件名含「-可编辑.pptx」', pptxPath ? path.basename(pptxPath).includes('-可编辑.pptx') : false, pptxPath ? path.basename(pptxPath) : '')
  if (pptxPath) {
    const dst = path.join(outDir, 'm4-editable.pptx')
    fs.copyFileSync(pptxPath, dst)
    const info = inspectPptx(dst)
    check('解包：13 页', info.slideCount === 13, `slides=${info.slideCount}`)
    check('解包：sldSz ≈ 13.333×7.5in', info.sldSz && Math.abs(Number(info.sldSz.cx) - 12192000) <= 2000 && Math.abs(Number(info.sldSz.cy) - 6858000) <= 2000, JSON.stringify(info.sldSz))
    check('解包：每页有背景图 blipFill', info.slideWithBg === 13, `slidesWithBg=${info.slideWithBg}`)
    check('解包：包含 <a:tbl> 表格对象', info.tableCount >= 1, `tables=${info.tableCount}`)
    check('解包：文本层可提取（中文标题/列表/代码/表格表头）', ['MarpWorkbench 可编辑导出', '第一项', 'const marp', '能力'].every((s) => info.allText.includes(s)), JSON.stringify(info.allText.replace(/\s+/g, ' ').slice(0, 200)))
    check('解包：备注写入（含 note-13）', /note-13/.test(info.notesPlain) && info.notesCount >= 13, `notes=${info.notesCount}`)
    check('解包：run 含字体/字号样式', info.runWithFont >= 2, `runWithFont=${info.runWithFont}`)
    check(
      '体积/耗时在预算内（参考 ≤25MB / ≤60s；实际见下）',
      fs.statSync(dst).size <= 25 * 1024 * 1024,
      `pptx=${(fs.statSync(dst).size / 1024 / 1024).toFixed(2)}MB, exportMs=${exportMs}`
    )
    check('导出耗时 ≤120s（本机含 13 页截图+组装）', exportMs <= 120000, `${exportMs}ms`)
  }
  check('无页面 JS 错误', pageErrors.length === 0, pageErrors.join(' ; '))

  await api(base, token, '/shutdown', { method: 'POST' }).catch(() => null)
  await sleep(800)
} catch (err) {
  check('M4 可编辑 E2E 执行', false, String(err?.stack || err))
} finally {
  try {
    await browser?.close()
  } catch {
    /* ignore */
  }
  if (child) killTree(child.pid)
  for (const d of [dataDir, downloadDir]) {
    if (!d) continue
    try {
      // 保留下载产物已复制到 out/，临时目录删除
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  const failed = checks.filter((c) => !c.ok)
  fs.writeFileSync(
    path.join(outDir, 'm4-editable-report.json'),
    JSON.stringify({ ok: failed.length === 0, checks }, null, 2)
  )
  console.log(`\n[m4-editable] ${checks.length - failed.length}/${checks.length} 通过`)
  if (failed.length) process.exit(1)
}
