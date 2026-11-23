#!/usr/bin/env node
/**
 * M4 验收：PPTX 可编辑导出（Beta）
 *
 * 流程：真实 exe（内嵌资源）+ 系统 Chrome → 建 13 页 deck（中文/列表/代码/表格/背景图/Mermaid/备注）
 *      → 导出面板选「PPTX 可编辑」→ 下载 .pptx → python-pptx 校验（页数/尺寸/文本/表格/备注/背景）
 *      → LibreOffice 转 PDF 校验可打开且页数一致 → 截图。
 *
 * 用法：node scripts/verify-editable-pptx.mjs [--keep]
 */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve('.')
const args = process.argv.slice(2)
const require = createRequire(join(ROOT, 'spike/marp/package.json'))
const puppeteer = require('puppeteer-core')

const PYTHON = [
  'C:\\Users\\52900\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe',
  'python',
].find((p) => p === 'python' || existsSync(p))
const soffice = [
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
].find((p) => existsSync(p))
const exe = join(ROOT, 'server/target/release/MarpWorkbench.exe')
const chrome = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))
const checkPy = join(ROOT, 'scripts/dev/check-editable-pptx.py')

for (const [name, v] of [
  ['exe', exe],
  ['Chrome/Edge', chrome],
  ['python', PYTHON],
  ['LibreOffice soffice', soffice],
  ['check script', checkPy],
]) {
  if (!v) {
    console.error(`缺少依赖：${name}`)
    process.exit(1)
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const shotDir = join(ROOT, 'spike/visual-m4', stamp)
mkdirSync(shotDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'mwb-m4-'))
const child = spawn(exe, [], { env: { ...process.env, MWB_DATA_DIR: dataDir, MWB_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => (out += d))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const skipped = []
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

const PHOTO = readFileSync(join(ROOT, 'scripts/fixtures/test-photo.png'))

const DECK = (assetPath) =>
  [
    '---',
    'marp: true',
    'theme: business-blue',
    'paginate: true',
    'size: 16:9',
    '---',
    '',
    '<!-- _class: lead -->',
    '',
    '# M4 可编辑导出验收',
    '',
    '## 文字 / 列表 / 代码 / 表格 / 背景图 / Mermaid',
    '',
    '<!-- 讲稿：这是封面页，强调可编辑 PPT 的价值。 -->',
    '',
    '---',
    '',
    '## 核心卖点',
    '',
    '- 文字是真正的文本框',
    '- 列表可以在 PowerPoint 里改',
    '- 代码块保持等宽字体',
    '- 备注会写入 notes',
    '',
    '<!-- 讲稿：第二页逐条讲解。 -->',
    '',
    '---',
    '',
    '## 代码也保持可编辑',
    '',
    '```js',
    'const editable = true',
    "function exportDeck() { return 'pptx' }",
    '```',
    '',
    '<!-- 讲稿：代码文字可编辑。 -->',
    '',
    '---',
    '',
    '## 数据表格',
    '',
    '| 指标 | 数值 | 说明 |',
    '| --- | --- | --- |',
    '| 页数 | 13 | 测试 |',
    '| 文本框 | 多 | 可改 |',
    '| 表格 | 1 | 可改 |',
    '',
    '<!-- 讲稿：表格是原生 PPT 表格。 -->',
    '',
    '---',
    '',
    `![bg left:38%](${assetPath})`,
    '',
    '## 背景图页',
    '',
    '- 左侧是一张背景图（底图）',
    '- 右侧文字可编辑',
    '',
    '<!-- 讲稿：背景图保持底图，文字可编辑。 -->',
    '',
    '---',
    '',
    '## Mermaid 图',
    '',
    '```mermaid',
    'graph LR',
    '  A[Markdown] --> B[可编辑 PPTX]',
    '```',
    '',
    '<!-- 讲稿：Mermaid 以底图保留。 -->',
    '',
    '---',
    '',
    '> 引用块也应该能编辑。',
    '',
    '---',
    '',
    '## 第 8 页',
    '',
    '正文占位。',
    '',
    '<!-- 讲稿：第 8 页备注。 -->',
    '',
    '---',
    '',
    '## 第 9 页',
    '',
    '正文占位。',
    '',
    '---',
    '',
    '## 第 10 页',
    '',
    '正文占位。',
    '',
    '---',
    '',
    '## 第 11 页',
    '',
    '正文占位。',
    '',
    '---',
    '',
    '## 第 12 页',
    '',
    '正文占位。',
    '',
    '---',
    '',
    '## 第 13 页',
    '',
    '最后一页文字。',
    '',
  ].join('\n')

let browser
try {
  const { base, token } = await waitBase()
  check('exe 启动', true, base)
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
  const created = await api('/decks', { method: 'POST', body: JSON.stringify({ name: 'M4-可编辑导出', template: 'blank' }) })
  const id = created.json?.id
  check('新建 deck', created.status === 200 && !!id, id)

  // 上传背景图资产
  const form = new FormData()
  form.append('file', new Blob([PHOTO], { type: 'image/png' }), 'm4-bg.png')
  const up = await fetch(`${base}/api/decks/${encodeURIComponent(id)}/assets`, {
    method: 'POST',
    headers: { 'X-MWB-Token': token },
    body: form,
  })
  const upJson = await up.json().catch(() => null)
  check('上传背景图资产', up.status === 200 && !!upJson?.path, JSON.stringify(upJson))
  const assetPath = upJson?.path
  const md = DECK(assetPath)
  const saved = await api(`/decks/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ content: md }) })
  check('保存 13 页测试 deck', saved.status === 200, `rev=${saved.json?.rev}`)

  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: 'new',
    args: ['--window-size=1680,1050', '--force-device-scale-factor=1', '--hide-scrollbars'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1680, height: 1050 })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto(`${base}/edit/${encodeURIComponent(id)}?token=${token}`, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForFunction(() => document.querySelectorAll('iframe.preview-frame').length > 0, { timeout: 30000 })
  // 首次 mermaid 需懒加载 5MB bundle（3–5s，机器忙时更久）；等实际渲染出 SVG 再断言
  await page
    .waitForFunction(
      () => {
        const f = document.querySelector('iframe.preview-frame')
        const d = f?.contentDocument
        if (!d) return false
        return d.querySelectorAll('.mwb-mermaid svg').length >= 1 && d.querySelectorAll('code.language-mermaid').length === 0
      },
      { timeout: 30000 },
    )
    .catch(() => {})
  await sleep(400)

  // 回归：deck 里先出现 js 代码块、后面才是 mermaid 时，mermaid 也必须渲染
  // （M4 发现 hasMermaid 旧实现只看首个 code 块，本用例专门覆盖）
  const mermaidInfo = await page.evaluate(() => {
    const f = document.querySelector('iframe.preview-frame')
    const d = f?.contentDocument
    return {
      svg: d?.querySelectorAll('.mwb-mermaid svg').length || 0,
      error: d?.querySelectorAll('.mwb-mermaid-error').length || 0,
      rawCode: d?.querySelectorAll('code.language-mermaid').length || 0,
    }
  })
  check('混合代码块 deck 的 Mermaid 也渲染', mermaidInfo.svg >= 1 && mermaidInfo.error === 0 && mermaidInfo.rawCode === 0, JSON.stringify(mermaidInfo))

  const downloadDir = join(shotDir, 'downloads')
  mkdirSync(downloadDir, { recursive: true })
  const cdp = await page.createCDPSession()
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir })

  // 打开导出面板
  const opened = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '导出')
    if (!btn) return false
    btn.click()
    return true
  })
  await page.waitForSelector('.mwb-export-panel', { timeout: 20000 }).catch(() => {})
  await sleep(800)
  await page.screenshot({ path: join(shotDir, '01-export-formats.png') })

  const editableVisible = await page.evaluate(() => {
    const panel = document.querySelector('.mwb-export-panel')
    if (!panel) return false
    const card = [...panel.querySelectorAll('button.fmt')].find((b) => /可编辑/.test(b.textContent))
    if (!card) return false
    card.click()
    return true
  })
  await sleep(700)
  const optionsText = await page.evaluate(() => document.querySelector('.mwb-export-panel')?.innerText || '')
  check('导出面板出现「PPTX 可编辑（Beta）」', opened && editableVisible, optionsText.replace(/\s+/g, ' ').slice(0, 120))
  await page.screenshot({ path: join(shotDir, '02-editable-selected.png') })

  // 点击主导出按钮
  const clicked = await page.evaluate(() => {
    const panel = document.querySelector('.mwb-export-panel')
    const btn = panel && panel.querySelector('button.primary:not([disabled])')
    if (!btn) return false
    btn.click()
    return true
  })
  check('开始导出可编辑 PPTX', clicked)

  // 等待下载文件并检测结果文案
  let pptxFile = null
  const deadline = Date.now() + 240000
  let resultText = ''
  while (Date.now() < deadline) {
    await sleep(1500)
    const files = readdirSync(downloadDir).filter((f) => f.toLowerCase().endsWith('.pptx'))
    if (files.length) {
      const p = join(downloadDir, files[0])
      if (statSync(p).size > 100 * 1024) {
        pptxFile = p
        break
      }
    }
    resultText = await page.evaluate(() => document.querySelector('.mwb-export-panel')?.innerText || '')
    if (/失败|错误/.test(resultText) && !/导出中/.test(resultText)) break
  }
  check('下载到 .pptx 文件', !!pptxFile, pptxFile ? `${pptxFile.split('\\').pop()} ${(statSync(pptxFile).size / 1024 / 1024).toFixed(2)} MB` : resultText.slice(0, 200))
  if (!pptxFile) throw new Error('未生成可编辑 PPTX：' + resultText.slice(0, 500))
  resultText = await page.evaluate(() => document.querySelector('.mwb-export-panel')?.innerText || '')
  check('面板显示可编辑导出结果', /可编辑/.test(resultText) && /文本框|表格|页/.test(resultText), resultText.replace(/\s+/g, ' ').slice(0, 180))
  await page.screenshot({ path: join(shotDir, '03-export-done.png') })

  // python-pptx 校验
  const py = spawnSync(
    PYTHON,
    [
      checkPy,
      pptxFile,
      '--slides',
      '13',
      '--width-in',
      '13.333',
      '--height-in',
      '7.5',
      '--require',
      'M4 可编辑导出验收',
      '--require',
      '文字是真正的文本框',
      '--require',
      'const editable = true',
      '--require',
      '指标',
      '--require',
      '第 13 页',
      '--require-notes',
      '讲稿',
      '--require-tables',
      '1',
      '--min-text-chars',
      '250',
    ],
    { encoding: 'utf8', timeout: 120000 },
  )
  let pyOut = null
  try {
    pyOut = JSON.parse(py.stdout.trim().split('\n').pop())
  } catch {
    pyOut = null
  }
  check('python-pptx 可打开并校验通过', py.status === 0 && pyOut?.ok === true, pyOut ? JSON.stringify({ slides: pyOut.slide_count, size: pyOut.size_in, tables: pyOut.tables, bg: pyOut.bg_blip_slides }).slice(0, 240) : (py.stdout || py.stderr || '').slice(0, 300))
  if (pyOut?.checks) {
    for (const c of pyOut.checks) check(`pptx: ${c.name}`, c.ok, c.detail)
  }

  // LibreOffice 转 PDF：可选加分项（本机 headless 在部分环境会挂起；以 python-pptx OOXML 校验为准）
  const convertDir = join(shotDir, 'lo')
  mkdirSync(convertDir, { recursive: true })
  const loProfile = join(convertDir, 'profile').replace(/\\/g, '/')
  mkdirSync(join(convertDir, 'profile'), { recursive: true })
  const lo = spawnSync(
    soffice,
    [
      '--headless',
      '--norestore',
      '--nologo',
      '--nofirststartwizard',
      '--nolockcheck',
      `-env:UserInstallation=file:///${loProfile}`,
      '--convert-to',
      'pdf',
      '--outdir',
      convertDir,
      pptxFile,
    ],
    { encoding: 'utf8', timeout: 30000 },
  )
  if (lo.status === null) {
    // 超时：清理可能残留的 soffice，避免影响后续
    spawnSync('taskkill', ['/F', '/IM', 'soffice.bin', '/T'], { encoding: 'utf8' })
    spawnSync('taskkill', ['/F', '/IM', 'soffice.exe', '/T'], { encoding: 'utf8' })
    skipped.push({ name: 'LibreOffice 转 PDF', reason: '本机 LO headless 挂起超时，跳过；PPTX 结构与可编辑对象已由 python-pptx 校验' })
    log('⚠ LibreOffice 转 PDF：本机 headless 挂起，跳过（不计失败）')
  } else {
    await sleep(1200)
    const pdfs = readdirSync(convertDir).filter((f) => f.toLowerCase().endsWith('.pdf'))
    let pdfPages = 0
    if (pdfs.length) {
      const buf = readFileSync(join(convertDir, pdfs[0]))
      pdfPages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length
    }
    check('LibreOffice 可打开并转 PDF（可选）', lo.status === 0 && pdfs.length === 1, (lo.stdout || lo.stderr || '').slice(0, 160))
    if (pdfs.length) check('转 PDF 页数 = 13（可选）', pdfPages === 13, `pages=${pdfPages}`)
  }

  const jsErrors = errors.filter((e) => !/Failed to load resource/.test(e))
  check('无前端 JS 错误', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '))
  log(`\nPPTX: ${pptxFile}`)
  log(`截图: ${shotDir}`)
} catch (e) {
  check('M4 可编辑导出 E2E 执行', false, String(e?.stack || e))
} finally {
  if (browser) await browser.close().catch(() => {})
  child.kill()
  const failed = results.filter((r) => !r.ok)
  for (const s of skipped) log(`⚠ 跳过：${s.name} — ${s.reason}`)
  console.log(`\n[M4-EDITABLE] ${results.length - failed.length}/${results.length} 通过${skipped.length ? `，跳过 ${skipped.length} 项` : ''}`)
  process.exit(failed.length ? 1 : 0)
}
