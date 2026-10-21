#!/usr/bin/env node
/**
 * M3.1 验收（Lead）：预览滚动稳定 + 全屏播放（方向键翻页）。
 *
 * 覆盖：
 *  1) 12 页 deck，光标在末尾连续打字：预览 iframe 不回到顶部、不来回跳（采样 scrollY）
 *  2) 大纲跳页仍正常滚动
 *  3) 「▶ 全屏播放」打开：起始页正确；→/↓/Home/End/← 切页；Esc 退出
 *  4) 无 JS 错误；截图输出 spike/visual-m3fix/<ts>/
 *
 * 用法：node scripts/visual-e2e-m3fix.mjs
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
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
const shotDir = join(ROOT, 'spike/visual-m3fix', stamp)
mkdirSync(shotDir, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'mwb-m3fix-'))
const child = spawn(exe, [], { env: { ...process.env, MWB_DATA_DIR: dataDir, MWB_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
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

const pages = []
for (let i = 1; i <= 12; i++) {
  pages.push('---', '', `## 第 ${i} 页`, '', `- 内容 ${i}-1`, `- 内容 ${i}-2`, '')
}
const MD = ['---', 'marp: true', 'theme: business-blue', 'paginate: true', 'size: 16:9', '---', '', '# 滚动与全屏测试', '', '## 目录', '', '- 共 12 页', '', ...pages].join('\n')

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
    return { status: res.status, json }
  }
  const created = await api('/decks', { method: 'POST', body: JSON.stringify({ name: 'M3.1-滚动-全屏', template: 'blank' }) })
  const id = created.json?.id
  await api(`/decks/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ content: MD }) })
  check('创建 13 页测试 deck', !!id)

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
  await sleep(3000)

  // 预览 iframe 滚动信息（同源 srcdoc，可直接访问 contentWindow）
  const getPreviewScroll = async () =>
    page.evaluate(() => {
      const f = document.querySelector('iframe.preview-frame')
      if (!f || !f.contentWindow) return null
      const w = f.contentWindow
      const doc = w.document
      const max = Math.max(1, doc.documentElement.scrollHeight - w.innerHeight)
      const top = w.scrollY || doc.documentElement.scrollTop || 0
      const slides = [...doc.querySelectorAll('svg[data-marpit-svg]')].length
      return { top, max, ratio: top / max, slides }
    })

  const initial = await getPreviewScroll()
  check('预览加载 13 页', !!initial && initial.slides === 13, JSON.stringify(initial))

  // 光标移到文档末尾：点编辑区后 Ctrl+End
  await page.click('.cm-editor .cm-content')
  await sleep(200)
  await page.keyboard.down('Control')
  await page.keyboard.press('End')
  await page.keyboard.up('Control')
  await sleep(2500)
  const atEnd = await getPreviewScroll()
  check('光标到末尾后预览在底部', !!atEnd && atEnd.ratio > 0.6, JSON.stringify(atEnd))
  await page.screenshot({ path: join(shotDir, '01-at-end.png') })

  // 在末尾连续打字，采样 preview scrollTop
  const samples = []
  const sampler = setInterval(async () => {
    const s = await getPreviewScroll().catch(() => null)
    if (s) samples.push(s.ratio)
  }, 120)
  await page.keyboard.type(' continuous typing at the end of document ', { delay: 45 })
  await sleep(2200)
  clearInterval(sampler)
  const maxRatio = Math.max(...samples, 0)
  const minRatio = Math.min(...samples, 1)
  const topReturns = samples.filter((r) => r < 0.3).length
  check('打字时预览不回到顶部', minRatio > 0.5 && topReturns === 0, `samples=${samples.length} min=${minRatio.toFixed(2)} max=${maxRatio.toFixed(2)} topReturns=${topReturns}`)
  check('打字时预览不来回跳（波动小）', maxRatio - minRatio < 0.35, `波动=${(maxRatio - minRatio).toFixed(2)}`)
  await page.screenshot({ path: join(shotDir, '02-typing-stable.png') })

  // 内容确实更新（防抖保存后从 API 读）
  await sleep(1200)
  const saved = await api(`/decks/${encodeURIComponent(id)}`)
  check('打字内容已保存', (saved.json?.content || '').includes('continuous typing at the end'), '')

  // 大纲跳页仍正常
  const jumpOk = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.sn-outline-item')]
    const target = items.find((el) => el.textContent.includes('第 1 页'))
    if (!target) return false
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  })
  await sleep(1200)
  const atFirst = await getPreviewScroll()
  check('大纲跳到第 1 页（预览回到顶部）', jumpOk && !!atFirst && atFirst.ratio < 0.2, JSON.stringify(atFirst))

  const jump5 = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.sn-outline-item')]
    const target = items.find((el) => el.textContent.includes('第 5 页'))
    if (!target) return false
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  })
  await sleep(1200)
  const at5 = await getPreviewScroll()
  check('大纲跳到第 5 页', jump5 && !!at5 && at5.ratio > 0.2 && at5.ratio < 0.6, JSON.stringify(at5))

  // 中段编辑：光标在第 5 页内打字，预览不应跳回顶部/跳走
  const clickMid = await page.evaluate(() => {
    const lines = [...document.querySelectorAll('.cm-line')]
    const line = lines.find((l) => l.textContent.includes('第 5 页'))
    if (!line) return false
    line.scrollIntoView({ block: 'center' })
    const r = line.getBoundingClientRect()
    window.__mwbMidPoint = { x: r.x + 40, y: r.y + r.height / 2 }
    return true
  })
  if (clickMid) {
    const mid = await page.evaluate(() => window.__mwbMidPoint)
    await page.mouse.click(mid.x, mid.y)
    await sleep(1800)
    const before = await getPreviewScroll()
    const midSamples = []
    const midSampler = setInterval(async () => {
      const s = await getPreviewScroll().catch(() => null)
      if (s) midSamples.push(s.ratio)
    }, 120)
    await page.keyboard.type(' typed in the middle ')
    await sleep(1800)
    clearInterval(midSampler)
    const minMid = Math.min(...midSamples, 1)
    const maxMid = Math.max(...midSamples, 0)
    check(
      '中段编辑：预览位置保持稳定',
      !!before && midSamples.length > 3 && minMid > 0.2 && Math.abs(minMid - before.ratio) < 0.2 && maxMid - minMid < 0.25,
      `before=${before?.ratio.toFixed(2)} min=${minMid.toFixed(2)} max=${maxMid.toFixed(2)} n=${midSamples.length}`,
    )
  } else {
    check('中段编辑：预览位置保持稳定', false, '未找到第 5 页标题行')
  }

  // ---- 全屏播放 ----
  const openPlayer = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => /全屏播放/.test(b.textContent) || /全屏播放/.test(b.getAttribute('title') || '') || /全屏播放/.test(b.getAttribute('aria-label') || ''),
    )
    if (!btn) return false
    btn.click()
    return true
  })
  await page.waitForSelector('.mwb-player', { timeout: 15000 }).catch(() => {})
  await sleep(1500)
  const playerInfo = async () =>
    page.evaluate(() => {
      const p = document.querySelector('.mwb-player')
      if (!p) return null
      const hud = p.querySelector('.mwb-player-hud, .player-hud, [data-player-hud]')?.textContent || p.innerText
      return { dataPage: p.getAttribute('data-page'), hud: hud.replace(/\s+/g, ' ').slice(0, 80) }
    })
  const p0 = await playerInfo()
  check('全屏播放打开', openPlayer && !!p0, JSON.stringify(p0))
  await page.screenshot({ path: join(shotDir, '03-player.png') })

  const keySteps = []
  const press = async (key, expectPage) => {
    await page.keyboard.press(key)
    await sleep(450)
    const info = await playerInfo()
    const pageNo = Number(info?.dataPage || NaN)
    keySteps.push({ key, expectPage, pageNo })
    return pageNo === expectPage
  }
  const startPage = Number(p0?.dataPage || 1)
  const ok1 = await press('ArrowRight', startPage + 1)
  const ok2 = await press('ArrowDown', startPage + 2)
  const ok3 = await press('ArrowLeft', startPage + 1)
  const okEnd = await press('End', 13)
  const okHome = await press('Home', 1)
  check('全屏播放：方向键/Home/End 翻页', ok1 && ok2 && ok3 && okEnd && okHome, JSON.stringify(keySteps))
  await page.screenshot({ path: join(shotDir, '04-player-keys.png') })

  await page.keyboard.press('Escape')
  await sleep(900)
  const playerGone = await page.evaluate(() => !document.querySelector('.mwb-player'))
  check('Esc 退出全屏播放', playerGone)

  const jsErrors = errors.filter((e) => !/Failed to load resource/.test(e))
  check('无前端 JS 错误', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '))
  log(`\n截图目录: ${shotDir}`)
} catch (e) {
  check('M3.1 E2E 执行', false, String(e?.stack || e))
} finally {
  if (browser) await browser.close().catch(() => {})
  child.kill()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n[M3.1-E2E] ${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
}
