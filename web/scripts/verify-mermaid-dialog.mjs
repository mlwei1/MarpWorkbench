/**
 * M5.0 Mermaid 图表对话框自测（marp-tech）
 * - 10 类示例逐个点击，预览必须真实渲染出 svg 且无错误
 * - 尺寸 xl → 插入后 Markdown 含 %% mwb-size: xl，预览 svg max-height:640px
 * - 光标进入块 → 编辑模式 → 自定义 70% 保存 → 原位替换（块数不变、无重复指令、max-width:70%）
 * - Esc 关闭
 *
 * 用法：node web/scripts/verify-mermaid-dialog.mjs --url http://127.0.0.1:8895 --token <token>
 * 前置：pnpm --dir web build
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
  console.error('用法：node web/scripts/verify-mermaid-dialog.mjs --url <base> --token <token>')
  process.exit(2)
}

const shotDir = path.join(os.tmpdir(), 'mwb-verify-mermaid')
fs.mkdirSync(shotDir, { recursive: true })

const report = { steps: [], types: [], errors: [], screenshots: [] }
function step(name, ok, detail) {
  report.steps.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
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

const TYPE_NAMES = {
  flowchart: '流程图',
  sequence: '时序图',
  class: '类图',
  state: '状态图',
  er: '实体关系图',
  gantt: '甘特图',
  pie: '饼图',
  mindmap: '思维导图',
  timeline: '时间线',
  journey: '用户旅程',
}

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
  const created = await api('/decks', { method: 'POST', body: JSON.stringify({ name: 'M5-Mermaid-Dialog-Test', template: 'blank' }) })
  const deckId = created.json?.id
  if (!deckId) throw new Error('创建 deck 失败')
  step('创建测试 deck', true, deckId)

  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1680, height: 1050 })
  page.setDefaultTimeout(40000)
  page.on('pageerror', (e) => report.errors.push(`pageerror: ${String(e).slice(0, 400)}`))
  page.on('console', (m) => {
    if (m.type() === 'error') report.errors.push(`console.error: ${m.text().slice(0, 400)}`)
  })

  await page.goto(`${baseUrl}/?token=${token}`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('.deck-item', { timeout: 30000 })
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.deck-item')]
    const item = items.find((el) => (el.textContent || '').includes('M5-Mermaid-Dialog-Test'))
    item?.querySelector('.deck-main')?.click()
  })
  await page.waitForSelector('.cm-content', { timeout: 30000 })
  await page.waitForSelector('.preview-frame', { timeout: 30000 })
  await sleep(1500)
  step('编辑器就绪', true)

  const readMd = () => page.evaluate(() => window.__mwbEditorView?.state?.doc?.toString?.() || '')

  // ---------- 1. 打开对话框 ----------
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.editor-toolbar button')].find((b) => (b.textContent || '').includes('图表'))
    btn?.click()
  })
  await page.waitForSelector('.mwb-mermaid-dialog', { timeout: 15000 })
  const cardCount = await page.$$eval('button.mwb-mermaid-type', (els) => els.length)
  step('对话框打开 + 10 个类型卡', cardCount === 10, `cards=${cardCount}`)
  step('标题为「插入 Mermaid 图表」', (await page.$eval('.mwb-mermaid-dialog .modal-head h2', (el) => el.textContent || '')).includes('插入 Mermaid 图表'))

  // 等首图预览（首次加载 mermaid bundle ~3-5s）
  await page
    .waitForFunction(
      () => {
        const box = document.querySelector('.mwb-mermaid-preview')
        if (!box || box.classList.contains('mwb-mermaid-preview-error')) return false
        return !!box.querySelector('svg')
      },
      { timeout: 45000 },
    )
    .catch(() => null)
  const firstPreview = await page.evaluate(() => {
    const box = document.querySelector('.mwb-mermaid-preview')
    return { hasSvg: !!box?.querySelector('svg'), error: !!box?.classList.contains('mwb-mermaid-preview-error') }
  })
  step('首图预览渲染出 SVG', firstPreview.hasSvg && !firstPreview.error, JSON.stringify(firstPreview))
  await page.screenshot({ path: path.join(shotDir, '01-dialog.png') })
  report.screenshots.push(path.join(shotDir, '01-dialog.png'))

  // ---------- 2. 10 类示例逐个渲染 ----------
  for (const key of Object.keys(TYPE_NAMES)) {
    await page.click(`button.mwb-mermaid-type[data-type="${key}"]`)
    await sleep(120)
    const before = await page.$eval('textarea.mwb-mermaid-code', (el) => el.value)
    const typeOk = await page
      .waitForFunction(
        (expectedKey) => {
          const box = document.querySelector('.mwb-mermaid-preview')
          if (!box) return false
          if (box.classList.contains('mwb-mermaid-preview-error')) return true
          return !!box.querySelector('svg')
        },
        { timeout: 25000 },
        key,
      )
      .then(() => true)
      .catch(() => false)
    await sleep(250)
    const state = await page.evaluate(() => {
      const box = document.querySelector('.mwb-mermaid-preview')
      return {
        hasSvg: !!box?.querySelector('svg'),
        error: !!box?.classList.contains('mwb-mermaid-preview-error'),
        errorText: (box?.textContent || '').slice(0, 180),
      }
    })
    const syntaxOk = /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|mindmap|timeline|journey)/m.test(before)
    report.types.push({ key, syntaxOk, ...state })
    step(`示例「${TYPE_NAMES[key]}」预览正常`, typeOk && state.hasSvg && !state.error && syntaxOk, state.error ? state.errorText : 'svg=1')
  }

  // ---------- 3. 时序图 + xl 尺寸插入 ----------
  await page.click('button.mwb-mermaid-type[data-type="sequence"]')
  await sleep(300)
  await page.select('select.mwb-mermaid-size', 'xl')
  await sleep(400)
  const taXl = await page.$eval('textarea.mwb-mermaid-code', (el) => el.value)
  step('尺寸选择 xl 后代码框含指令', /^%% mwb-size: xl$/m.test(taXl), taXl.split('\n')[0])
  await page.click('button.primary')
  await page.waitForSelector('.mwb-mermaid-dialog', { timeout: 10000, hidden: true }).catch(() => null)
  await sleep(2500)
  const mdInserted = await readMd()
  const insertedBlocks = (mdInserted.match(/```mermaid/g) || []).length
  step(
    '插入 Markdown 含 fence + xl 指令 + sequenceDiagram',
    insertedBlocks === 1 && /%% mwb-size: xl/.test(mdInserted) && /sequenceDiagram/.test(mdInserted),
    `blocks=${insertedBlocks}`,
  )
  await page.waitForFunction(
    () => {
      const doc = document.querySelector('.preview-frame')?.contentDocument
      return !!doc?.querySelector('.mwb-mermaid svg')
    },
    { timeout: 30000 },
  ).catch(() => null)
  const xlStyle = await page.evaluate(() => {
    const doc = document.querySelector('.preview-frame')?.contentDocument
    const svg = doc?.querySelector('.mwb-mermaid svg')
    return svg?.getAttribute('style') || ''
  })
  step('预览 SVG 应用 xl 尺寸（max-height:640px）', /max-height:\s*640px/.test(xlStyle), xlStyle.slice(0, 200))
  await page.screenshot({ path: path.join(shotDir, '02-inserted.png') })
  report.screenshots.push(path.join(shotDir, '02-inserted.png'))

  // ---------- 4. 编辑模式：光标进块 → 自定义 70% → 保存 ----------
  const mdNow = await readMd()
  const openLine = mdNow.split('\n').findIndex((l) => l.trim().startsWith('```mermaid')) + 1
  await page.evaluate((line) => {
    const view = window.__mwbEditorView
    const doc = view.state.doc
    const pos = doc.line(Math.min(Math.max(1, line), doc.lines)).from
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
    view.focus()
  }, openLine + 2)
  await sleep(300)
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.editor-toolbar button')].find((b) => (b.textContent || '').includes('图表'))
    btn?.click()
  })
  await page.waitForSelector('.mwb-mermaid-dialog', { timeout: 15000 })
  const editTitle = await page.$eval('.mwb-mermaid-dialog .modal-head h2', (el) => el.textContent || '')
  step('光标在块内 → 编辑模式标题', editTitle.includes('编辑 Mermaid 图表'), editTitle)
  const taEdit = await page.$eval('textarea.mwb-mermaid-code', (el) => el.value)
  step('编辑模式预填代码与尺寸', /sequenceDiagram/.test(taEdit) && /%% mwb-size: xl/.test(taEdit), taEdit.split('\n')[0])
  const presetVal = await page.$eval('select.mwb-mermaid-size', (el) => el.value)
  step('编辑模式尺寸预填 xl', presetVal === 'xl', presetVal)

  await page.select('select.mwb-mermaid-size', 'custom')
  await page.waitForSelector('input.mwb-mermaid-custom', { timeout: 5000 })
  await page.evaluate(() => {
    const input = document.querySelector('input.mwb-mermaid-custom')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '70')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await sleep(600)
  const taCustom = await page.$eval('textarea.mwb-mermaid-code', (el) => el.value)
  step('自定义 70% 写入代码框', /^%% mwb-size: 70%$/m.test(taCustom), taCustom.split('\n')[0])
  await page.click('button.primary')
  await page.waitForSelector('.mwb-mermaid-dialog', { timeout: 10000, hidden: true }).catch(() => null)
  await sleep(2500)
  const mdEdited = await readMd()
  const editedBlocks = (mdEdited.match(/```mermaid/g) || []).length
  const directiveCount = (mdEdited.match(/%% mwb-size:/g) || []).length
  step('编辑保存后原位替换（块数不变）', editedBlocks === 1, `blocks=${editedBlocks}`)
  step('无重复尺寸指令', directiveCount === 1 && /%% mwb-size: 70%/.test(mdEdited), `directives=${directiveCount}`)
  await page.waitForFunction(
    () => {
      const doc = document.querySelector('.preview-frame')?.contentDocument
      const svg = doc?.querySelector('.mwb-mermaid svg')
      return !!svg && /max-width:\s*70%/.test(svg.getAttribute('style') || '')
    },
    { timeout: 30000 },
  ).catch(() => null)
  const customStyle = await page.evaluate(() => {
    const doc = document.querySelector('.preview-frame')?.contentDocument
    return doc?.querySelector('.mwb-mermaid svg')?.getAttribute('style') || ''
  })
  step('预览 SVG 应用 70% 尺寸', /max-width:\s*70%/.test(customStyle), customStyle.slice(0, 200))
  await page.screenshot({ path: path.join(shotDir, '03-edited.png') })
  report.screenshots.push(path.join(shotDir, '03-edited.png'))

  // ---------- 5. 错误路径：非法语法显示 .mwb-mermaid-preview-error ----------
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.editor-toolbar button')].find((b) => (b.textContent || '').includes('图表'))
    btn?.click()
  })
  await page.waitForSelector('.mwb-mermaid-dialog', { timeout: 15000 })
  await page.click('button.mwb-mermaid-type[data-type="flowchart"]')
  await sleep(300)
  await page.evaluate(() => {
    const ta = document.querySelector('textarea.mwb-mermaid-code')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, 'graph LR\n  A[未闭合')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const errorShown = await page
    .waitForFunction(
      () => !!document.querySelector('.mwb-mermaid-preview.mwb-mermaid-preview-error'),
      { timeout: 25000 },
    )
    .then(() => true)
    .catch(() => false)
  step('非法语法显示 .mwb-mermaid-preview-error', errorShown)
  await page.click('button.mwb-mermaid-type[data-type="flowchart"]')
  const recovered = await page
    .waitForFunction(
      () => {
        const box = document.querySelector('.mwb-mermaid-preview')
        return !!box && !box.classList.contains('mwb-mermaid-preview-error') && !!box.querySelector('svg')
      },
      { timeout: 25000 },
    )
    .then(() => true)
    .catch(() => false)
  step('重新选示例后预览恢复', recovered)

  // ---------- 6. 取消 / Esc 关闭 ----------
  await page.click('button.mwb-mermaid-cancel')
  await sleep(500)
  step('取消按钮关闭对话框', !(await page.$('.mwb-mermaid-dialog')))
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.editor-toolbar button')].find((b) => (b.textContent || '').includes('图表'))
    btn?.click()
  })
  await page.waitForSelector('.mwb-mermaid-dialog', { timeout: 15000 })
  await page.keyboard.press('Escape')
  await sleep(500)
  const dialogGone = !(await page.$('.mwb-mermaid-dialog'))
  step('Esc 关闭对话框', dialogGone)

  step('无页面 JS 错误', report.errors.length === 0, report.errors.slice(0, 3).join(' | ') || '0')
  await browser.close()
  fs.writeFileSync(path.join(shotDir, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`\n截图/报告：${shotDir}`)
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
