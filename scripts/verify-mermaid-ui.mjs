#!/usr/bin/env node
/**
 * M5.0 验收：Mermaid 尺寸选项 + 10 类示例 + 插入/编辑对话框
 *
 * 覆盖：
 *  1) 工具栏「◈ 图表」打开对话框；10 类示例卡逐个预览无错误
 *  2) 选时序图 + 尺寸 xl → 插入：Markdown 含 %% mwb-size: xl，预览 SVG max-height 640
 *  3) 光标在图表内再点图表 → 编辑模式预填；改自定义 70% → 原位替换（仍 1 个块、指令不重复），SVG max-width 70%
 *  4) 默认（auto）插入新图：无尺寸指令，SVG max-width:100%（默认放大）
 *  5) 零 JS 错误 + 截图
 *
 * 用法：node scripts/verify-mermaid-ui.mjs
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs'
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
  console.error(`缺少 exe(${exe}) 或 Chrome/Edge`)
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const shotDir = join(ROOT, 'spike/visual-m5', stamp)
mkdirSync(shotDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'mwb-m5-'))
const child = spawn(exe, [], { env: { ...process.env, MWB_DATA_DIR: dataDir, MWB_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => (out += d))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const skips = []
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

const MD = [
  '---',
  'marp: true',
  'theme: business-blue',
  'paginate: true',
  'size: 16:9',
  '---',
  '',
  '# Mermaid 对话框验收',
  '',
  '## 目录',
  '',
  '- 尺寸、示例、编辑',
  '',
  '---',
  '',
  '## 图表页',
  '',
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
  const created = await api('/decks', { method: 'POST', body: JSON.stringify({ name: 'M5-Mermaid-UI', template: 'blank' }) })
  const id = created.json?.id
  await api(`/decks/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ content: MD }) })
  check('创建测试 deck', created.status === 200 && !!id, id)

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
  await sleep(2500)

  const openChartDialog = async () => {
    const ok = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.editor-toolbar button')].find((b) => /图表/.test(b.textContent))
      if (!btn) return false
      btn.click()
      return true
    })
    await page.waitForSelector('.mwb-mermaid-dialog', { timeout: 15000 }).catch(() => {})
    await sleep(900)
    return ok
  }

  const dialogInfo = async () =>
    page.evaluate(() => {
      const d = document.querySelector('.mwb-mermaid-dialog')
      if (!d) return null
      return {
        title: d.textContent.slice(0, 60),
        types: [...d.querySelectorAll('button.mwb-mermaid-type')].map((b) => b.dataset.type).filter(Boolean),
        code: d.querySelector('textarea.mwb-mermaid-code')?.value || '',
        size: d.querySelector('select.mwb-mermaid-size')?.value || '',
        previewSvg: d.querySelectorAll('.mwb-mermaid-preview svg').length,
        previewError: d.querySelector('.mwb-mermaid-preview-error')?.textContent || '',
        primary: d.querySelector('button.primary')?.textContent?.trim() || '',
      }
    })

  // 先把光标放到文档末尾（模拟正常使用：在内容区插入图表，避免插进 front-matter）
  await page.click('.cm-editor .cm-content')
  await page.keyboard.down('Control')
  await page.keyboard.press('End')
  await page.keyboard.up('Control')
  await sleep(300)

  const opened = await openChartDialog()
  const d0 = await dialogInfo()
  check('打开「◈ 图表」对话框', opened && !!d0, d0?.title)
  if (!d0) throw new Error('图表对话框未出现')
  await page.waitForSelector('.mwb-mermaid-preview svg', { timeout: 25000 }).catch(() => {})
  const expectedTypes = [
    'flowchart',
    'sequence',
    'quadrant',
    'xychart',
    'sankey',
    'radar',
    'treemap',
    'class',
    'state',
    'er',
    'gantt',
    'pie',
    'mindmap',
    'timeline',
    'journey',
    'block',
    'git',
    'c4',
    'kanban',
  ]
  check('19 类示例卡齐全', !!d0 && expectedTypes.every((t) => d0.types.includes(t)), JSON.stringify(d0?.types))
  await sleep(400)
  await page.screenshot({ path: join(shotDir, '01-dialog.png') })

  // 逐个点击 10 类，检查示例代码 + 预览无错误
  const typeResults = []
  for (const t of expectedTypes) {
    await page.evaluate((type) => {
      const d = document.querySelector('.mwb-mermaid-dialog')
      const btn = d?.querySelector(`button.mwb-mermaid-type[data-type="${type}"]`)
      if (btn) btn.click()
    }, t)
    // 首次点击需要等 mermaid bundle 懒加载完成；之后每类 400ms 防抖 + 渲染
    await page
      .waitForFunction(
        (type) => {
          const d = document.querySelector('.mwb-mermaid-dialog')
          if (!d) return false
          return !!d.querySelector('.mwb-mermaid-preview svg') || !!d.querySelector('.mwb-mermaid-preview-error')
        },
        { timeout: 15000 },
        t,
      )
      .catch(() => {})
    await sleep(350)
    const info = await dialogInfo()
    typeResults.push({ t, codeLen: info?.code.length || 0, svg: info?.previewSvg || 0, error: info?.previewError || '' })
  }
  const badTypes = typeResults.filter((r) => r.codeLen < 20 || r.svg < 1 || r.error)
  check('19 类示例均可渲染', badTypes.length === 0, badTypes.length ? JSON.stringify(badTypes.slice(0, 3)) : JSON.stringify(typeResults.map((r) => `${r.t}:${r.svg}svg/${r.codeLen}B`)))

  // 选时序图 + xl，插入
  await page.evaluate(() => {
    const d = document.querySelector('.mwb-mermaid-dialog')
    d?.querySelector('button.mwb-mermaid-type[data-type="sequence"]')?.click()
  })
  await sleep(900)
  await page.select('.mwb-mermaid-size', 'xl')
  await sleep(500)
  const beforeInsert = await dialogInfo()
  check('尺寸下拉可见且可选 xl', beforeInsert?.size === 'xl', JSON.stringify({ size: beforeInsert?.size, primary: beforeInsert?.primary }))
  const inserted = await page.evaluate(() => {
    const d = document.querySelector('.mwb-mermaid-dialog')
    const btn = d?.querySelector('button.primary')
    if (!btn) return false
    btn.click()
    return true
  })
  await sleep(2200)
  const dialogGone = await page.evaluate(() => !document.querySelector('.mwb-mermaid-dialog'))
  check('点击插入后对话框关闭', inserted && dialogGone)
  await page.screenshot({ path: join(shotDir, '02-inserted.png') })

  const readMd = async () => {
    const r = await api(`/decks/${encodeURIComponent(id)}`)
    return r.json?.content || ''
  }
  let md = await readMd()
  check('Markdown 含 sequenceDiagram + 尺寸指令 xl', /```mermaid[\s\S]*sequenceDiagram/.test(md) && md.includes('%% mwb-size: xl'), '')
  const previewSvgInfo = async () =>
    page.evaluate(() => {
      const f = document.querySelector('iframe.preview-frame')
      const svgs = [...(f?.contentDocument?.querySelectorAll('.mwb-mermaid svg') || [])]
      return svgs.map((s) => s.getAttribute('style') || '')
    })
  let svgStyles = await previewSvgInfo()
  check('预览 SVG 使用 xl 尺寸（max-height:640）', svgStyles.some((s) => /max-height:\s*640px/.test(s) && /max-width:\s*100%/.test(s)), JSON.stringify(svgStyles))
  // 实际渲染尺寸（防止样式正确但被 Marp auto-scaling 缩得很小）
  const chartGeom = async () =>
    page.evaluate(() => {
      const f = document.querySelector('iframe.preview-frame')
      const d = f?.contentDocument
      if (!d) return null
      for (const slide of d.querySelectorAll('svg[data-marpit-svg]')) {
        const svg = slide.querySelector('.mwb-mermaid svg')
        if (!svg) continue
        const sr = slide.getBoundingClientRect()
        const cr = svg.getBoundingClientRect()
        return { slideW: Math.round(sr.width), chartW: Math.round(cr.width), chartH: Math.round(cr.height), ratio: +(cr.width / sr.width).toFixed(2) }
      }
      return null
    })
  const geom1 = await chartGeom()
  check('XL 图实际宽度占页面 ≥ 60%', !!geom1 && geom1.ratio >= 0.6, JSON.stringify(geom1))

  // 光标移到 mermaid 块内，再开对话框 → 编辑模式
  const fenceLine = md.slice(0, md.indexOf('```mermaid')).split('\n').length
  const targetLine = fenceLine + 1
  await page.click('.cm-editor .cm-content')
  await page.keyboard.down('Control')
  await page.keyboard.press('Home')
  await page.keyboard.up('Control')
  for (let i = 1; i < targetLine; i++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Home')
  await sleep(300)
  const openedEdit = await openChartDialog()
  const editInfo = await dialogInfo()
  check('光标在图表内打开编辑模式', openedEdit && /编辑/.test(editInfo?.title || ''), JSON.stringify({ title: editInfo?.title?.slice(0, 24), codeLen: editInfo?.code.length }))
  check('编辑模式预填源码与尺寸', !!editInfo && /sequenceDiagram/.test(editInfo.code) && editInfo.size === 'xl', JSON.stringify({ size: editInfo?.size }))
  await page.select('.mwb-mermaid-size', 'custom')
  await sleep(300)
  const customInput = await page.$('input.mwb-mermaid-custom')
  if (customInput) {
    await page.evaluate((el) => {
      el.value = ''
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, customInput)
    await customInput.type('70')
  }
  await sleep(700)
  await page.screenshot({ path: join(shotDir, '03-edit-dialog.png') })
  const saved = await page.evaluate(() => {
    const d = document.querySelector('.mwb-mermaid-dialog')
    const btn = d?.querySelector('button.primary')
    if (!btn) return false
    btn.click()
    return true
  })
  await sleep(2200)
  md = await readMd()
  const fences = (md.match(/```mermaid/g) || []).length
  const directives = (md.match(/%%\s*mwb-size:/g) || []).length
  check('编辑保存为原位替换（仍 1 个块、1 条指令）', saved && fences === 1 && directives === 1 && md.includes('%% mwb-size: 70%'), JSON.stringify({ fences, directives }))
  svgStyles = await previewSvgInfo()
  check('预览 SVG 应用 70% 宽度', svgStyles.some((s) => /max-width:\s*70%/.test(s)), JSON.stringify(svgStyles))
  await page.screenshot({ path: join(shotDir, '04-edited.png') })

  // 默认 auto 插入：新 deck 的空白图表页，避免与已有块/标题互相干扰
  const MD2 = [
    '---',
    'marp: true',
    'theme: business-blue',
    'paginate: true',
    'size: 16:9',
    '---',
    '',
    '# 默认尺寸验收',
    '',
    '---',
    '',
    '## 新图表页',
    '',
    '',
  ].join('\n')
  const created2 = await api('/decks', { method: 'POST', body: JSON.stringify({ name: 'M5-Mermaid-默认尺寸', template: 'blank' }) })
  const id2 = created2.json?.id
  await api(`/decks/${encodeURIComponent(id2)}`, { method: 'PUT', body: JSON.stringify({ content: MD2 }) })
  await page.goto(`${base}/edit/${encodeURIComponent(id2)}?token=${token}`, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForSelector('iframe.preview-frame', { timeout: 30000 })
  await sleep(2500)
  await page.click('.cm-editor .cm-content')
  await page.keyboard.down('Control')
  await page.keyboard.press('End')
  await page.keyboard.up('Control')
  await sleep(300)
  const openedNew = await openChartDialog()
  const newInfo = await dialogInfo()
  const newMode = /插入/.test(newInfo?.title || '') && newInfo?.size === 'auto'
  await page.evaluate(() => {
    const d = document.querySelector('.mwb-mermaid-dialog')
    d?.querySelector('button.primary')?.click()
  })
  await sleep(2400)
  const md2 = (await api(`/decks/${encodeURIComponent(id2)}`)).json?.content || ''
  const fences2 = (md2.match(/```mermaid/g) || []).length
  const hasDirective2 = /%%\s*mwb-size:/.test(md2)
  check('默认 auto 插入（无尺寸指令）', openedNew && newMode && fences2 === 1 && !hasDirective2, JSON.stringify({ fences2, hasDirective2 }))
  const allStyles = await previewSvgInfo()
  check('默认图 SVG 使用 100% 宽度（比旧自然宽度更大）', allStyles.some((s) => /max-width:\s*100%/.test(s)), JSON.stringify(allStyles))
  await page.screenshot({ path: join(shotDir, '05-auto-inserted.png') })

  const jsErrors = errors.filter((e) => !/Failed to load resource/.test(e))
  check('无前端 JS 错误', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '))
  log(`\n截图目录: ${shotDir}`)
} catch (e) {
  check('M5 Mermaid UI E2E 执行', false, String(e?.stack || e))
} finally {
  if (browser) await browser.close().catch(() => {})
  child.kill()
  const failed = results.filter((r) => !r.ok)
  for (const s of skips) log(`⚠ 跳过：${s.name} — ${s.reason}`)
  console.log(`\n[M5-MERMAID-UI] ${results.length - failed.length}/${results.length} 通过${skips.length ? `，跳过 ${skips.length} 项` : ''}`)
  process.exit(failed.length ? 1 : 0)
}
