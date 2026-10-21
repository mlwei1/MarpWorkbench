/**
 * M3.1 自测：预览滚动稳定 + 全屏播放（真实服务或 mock）
 *
 * 用法：
 *   node web/scripts/verify-ui-m3fix.mjs --url http://127.0.0.1:8898 --token <token>
 *   或 node web/scripts/verify-ui-m3fix.mjs（自动起 vite preview + mock）
 * 前置：pnpm --dir web build
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { spawn } from 'node:child_process'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const workDir = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const argValue = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : null)
const urlArg = argValue('--url')
const tokenArg = argValue('--token')
const PORT = 5199
const baseUrl = urlArg || `http://127.0.0.1:${PORT}`
const shotDir = path.join(os.tmpdir(), 'mwb-verify-m3fix')
fs.mkdirSync(shotDir, { recursive: true })

const report = { steps: [], samples: [], errors: [], screenshots: [] }
function step(name, ok, detail) {
  report.steps.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const DECK_MD = `---
marp: true
theme: business-blue
paginate: true
---

${Array.from({ length: 12 }, (_, i) => `# 第 ${i + 1} 页\n\n${i === 11 ? '末尾页：在这里连续输入文字测试滚动稳定性。' : `内容 ${i + 1}`}`).join('\n\n---\n\n')}
`

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

function startPreview() {
  const child = spawn('pnpm', ['--dir', path.join(repoRoot, 'web'), 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })
  const log = []
  child.stdout.on('data', (d) => log.push(String(d)))
  child.stderr.on('data', (d) => log.push(String(d)))
  return { child, log }
}
async function waitForServer(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`服务未就绪: ${url}`)
}

async function main() {
  const puppeteer = loadPuppeteer()
  if (!chrome) throw new Error('未找到 Chrome/Edge')
  let server = null
  if (!urlArg) {
    server = startPreview()
    try {
      await waitForServer(baseUrl)
    } catch (err) {
      console.error('preview 启动失败：\n' + server.log.join(''))
      throw err
    }
  }

  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000 })
  page.setDefaultTimeout(40000)
  page.on('pageerror', (e) => report.errors.push(`pageerror: ${String(e).slice(0, 300)}`))
  page.on('console', (m) => {
    if (m.type() === 'error') report.errors.push(`console.error: ${m.text().slice(0, 300)}`)
  })

  let deckId
  let editorReady = false
  if (tokenArg) {
    const api = async (p, init = {}) => {
      const res = await fetch(`${baseUrl}/api${p}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', 'X-MWB-Token': tokenArg, ...(init.headers || {}) },
      })
      return { status: res.status, json: await res.json().catch(() => null) }
    }
    const created = await api('/decks', { method: 'POST', body: JSON.stringify({ name: 'M31-Scroll-Test-12p', template: 'blank' }) })
    deckId = created.json.id
    const saved = await api(`/decks/${encodeURIComponent(deckId)}`, { method: 'PUT', body: JSON.stringify({ content: DECK_MD }) })
    if (saved.status !== 200) throw new Error('保存测试 deck 失败')
    // 走用户真实路径：首页 → 点击 deck（避免深链中文 id 的编码问题）
    await page.goto(`${baseUrl}/?token=${tokenArg}`, { waitUntil: 'networkidle2' })
    await page.waitForSelector('.deck-item', { timeout: 30000 })
    const clicked = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.deck-item')]
      const item = items.find((el) => (el.textContent || '').includes('M31-Scroll-Test-12p'))
      item?.querySelector('.deck-main')?.click()
      return !!item
    })
    if (!clicked) throw new Error('首页找不到新建的测试 deck')
    await page.waitForSelector('.cm-content', { timeout: 30000 })
    editorReady = true
  } else {
    // mock：通过首页新建后直接改内容
    await page.goto(`${baseUrl}/?mock=1`, { waitUntil: 'networkidle2' })
    await page.waitForSelector('.hero-actions .btn-primary')
    await page.click('.hero-actions .btn-primary')
    await page.waitForSelector('.cm-content')
    await new Promise((r) => setTimeout(r, 1200))
    await page.evaluate((md) => {
      const view = window.__mwbEditorView
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: md } })
    }, DECK_MD)
    await new Promise((r) => setTimeout(r, 2500))
  }

  if (!editorReady) await new Promise((r) => setTimeout(r, 500))
  await page.waitForSelector('.preview-frame', { timeout: 30000 })
  await page.waitForFunction(
    () => {
      const doc = document.querySelector('.preview-frame')?.contentDocument
      return !!doc && doc.querySelectorAll('svg[data-marpit-svg]').length >= 2
    },
    { timeout: 30000 },
  )
  await new Promise((r) => setTimeout(r, 1500))
  step('编辑器与预览就绪', true)

  // ---------- A. 末尾连续打字：scrollTop 不回到 0，iframe 不重载 ----------
  await page.evaluate(() => {
    window.__mwbFrameWinBefore = document.querySelector('.preview-frame')?.contentWindow
  })
  await page.click('.cm-content')
  await page.keyboard.down('Control')
  await page.keyboard.press('End')
  await page.keyboard.up('Control')
  await page.keyboard.type('\n\n')
  await new Promise((r) => setTimeout(r, 900))

  const typingSamples = []
  const text = '滚动稳定性测试abcdefghijklmnopqrstuvwxyz'
  for (const ch of text) {
    await page.keyboard.type(ch)
    await new Promise((r) => setTimeout(r, 90))
    const s = await page.evaluate(() => {
      const f = document.querySelector('.preview-frame')
      const doc = f?.contentDocument
      const sc = doc?.scrollingElement || doc?.documentElement
      return { top: sc?.scrollTop || 0, max: Math.max(0, (sc?.scrollHeight || 0) - (sc?.clientHeight || 0)) }
    })
    typingSamples.push(s)
  }
  report.samples = typingSamples
  await new Promise((r) => setTimeout(r, 800))

  const sameIframe = await page.evaluate(() => {
    const now = document.querySelector('.preview-frame')?.contentWindow
    return !!now && now === window.__mwbFrameWinBefore
  })
  step('打字期间 iframe 未重载（稳定宿主文档）', sameIframe)

  const maxScroll = Math.max(...typingSamples.map((s) => s.max), 1)
  const badSamples = typingSamples.filter((s) => s.max > 100 && s.top < maxScroll * 0.7)
  const zeros = typingSamples.filter((s) => s.top <= 2)
  const finalTop = typingSamples[typingSamples.length - 1]?.top || 0
  step(
    '末尾打字滚动位置稳定（不回到顶部）',
    badSamples.length <= 3 && zeros.length === 0 && finalTop > maxScroll * 0.85,
    `samples=${typingSamples.length} bad=${badSamples.length} zero=${zeros.length} finalTop=${Math.round(finalTop)}/${Math.round(maxScroll)}`,
  )
  await page.screenshot({ path: path.join(shotDir, 'typing-scroll.png') })
  report.screenshots.push(path.join(shotDir, 'typing-scroll.png'))

  const contentChanged = await page.evaluate(() => {
    const md = window.__mwbEditorView?.state?.doc?.toString?.() || ''
    return md.includes('滚动稳定性测试abcdefghijklmnopqrstuvwxyz')
  })
  step('内容确实更新', contentChanged)

  // ---------- B. 光标跳到其他页 → 预览跟随 ----------
  const jump = async (targetPage) => {
    return page.evaluate((p) => {
      const view = window.__mwbEditorView
      const doc = view.state.doc
      let line = 1
      let pageNo = 1
      let inFence = false
      let fmEnd = 0
      if (doc.line(1).text.trim() === '---') {
        for (let i = 2; i <= doc.lines; i++) {
          if (doc.line(i).text.trim() === '---') {
            fmEnd = i
            break
          }
        }
      }
      for (let i = fmEnd + 1; i <= doc.lines; i++) {
        const t = doc.line(i).text.trim()
        if (/^(```|~~~)/.test(t)) inFence = !inFence
        if (inFence) continue
        if (i > fmEnd && /^-{3,}$/.test(t)) pageNo++
        if (pageNo === p) {
          line = i + 2
          break
        }
      }
      const pos = doc.line(Math.min(line, doc.lines)).from
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
      return true
    }, targetPage)
  }
  await jump(5)
  await new Promise((r) => setTimeout(r, 1200))
  const page5 = await page.evaluate(() => {
    const f = document.querySelector('.preview-frame')
    const doc = f?.contentDocument
    const sc = doc?.scrollingElement || doc?.documentElement
    const slides = [...doc.querySelectorAll('svg[data-marpit-svg]')]
    const top = sc.scrollTop
    let index = 0
    slides.forEach((el, i) => {
      if (el.getBoundingClientRect().top + sc.scrollTop <= top + 2) index = i
    })
    return { index: index + 1, top: Math.round(top) }
  })
  step('光标跳到第 5 页 → 预览跟随', page5.index === 5, JSON.stringify(page5))
  await jump(1)
  await new Promise((r) => setTimeout(r, 1000))
  const page1 = await page.evaluate(() => {
    const f = document.querySelector('.preview-frame')
    const doc = f?.contentDocument
    const sc = doc?.scrollingElement || doc?.documentElement
    return Math.round(sc.scrollTop)
  })
  step('光标跳到第 1 页 → 预览回顶部', page1 <= 40, `scrollTop=${page1}`)

  // ---------- C. 全屏播放 ----------
  const btn = await page.$$('button[aria-label="全屏播放"]')
  step('全屏播放按钮存在', btn.length > 0)
  if (btn.length) {
    await btn[0].click()
    await page.waitForSelector('.mwb-player', { timeout: 10000 }).catch(() => null)
    const player = await page.$('.mwb-player')
    step('播放层出现', !!player)
    if (player) {
      const startPage = await page.$eval('.mwb-player', (el) => el.getAttribute('data-page'))
      step('播放起始页 = 当前编辑页', Number(startPage) === 1, `data-page=${startPage}`)
      await new Promise((r) => setTimeout(r, 800))
      const playerSlide = await page.evaluate(() => {
        const f = document.querySelector('.mwb-player-frame')
        const doc = f?.contentDocument
        const slides = [...(doc?.querySelectorAll('svg[data-marpit-svg]') || [])]
        return { total: slides.length, visible: slides.filter((el) => el.style.display !== 'none').length }
      })
      step('播放层单页显示', playerSlide.total === 12 && playerSlide.visible === 1, JSON.stringify(playerSlide))

      const press = async (key) => {
        await page.keyboard.press(key)
        await new Promise((r) => setTimeout(r, 150))
        return page.$eval('.mwb-player', (el) => Number(el.getAttribute('data-page')))
      }
      const p1 = await press('ArrowRight')
      const p2 = await press('ArrowRight')
      const p3 = await press('ArrowDown')
      const p4 = await press('ArrowLeft')
      step('方向键翻页（→→↓←）', p1 === 2 && p2 === 3 && p3 === 4 && p4 === 3, `${p1},${p2},${p3},${p4}`)
      await page.keyboard.press('End')
      await new Promise((r) => setTimeout(r, 200))
      const lastPage = await page.$eval('.mwb-player', (el) => Number(el.getAttribute('data-page')))
      await page.keyboard.press('Home')
      await new Promise((r) => setTimeout(r, 200))
      const homePage = await page.$eval('.mwb-player', (el) => Number(el.getAttribute('data-page')))
      step('Home/End 首尾页', lastPage === 12 && homePage === 1, `end=${lastPage} home=${homePage}`)
      await page.screenshot({ path: path.join(shotDir, 'fullscreen.png') })
      report.screenshots.push(path.join(shotDir, 'fullscreen.png'))

      // 全屏播放中 Esc：浏览器可能先退出 fullscreen，再触发我们的 close
      await page.keyboard.press('Escape')
      await new Promise((r) => setTimeout(r, 700))
      let gone = !(await page.$('.mwb-player'))
      if (!gone) {
        await page.keyboard.press('Escape')
        await new Promise((r) => setTimeout(r, 500))
        gone = !(await page.$('.mwb-player'))
      }
      step('Esc 退出播放', gone)
      const bodyOverflow = await page.evaluate(() => document.body.style.overflow)
      step('退出后 body 滚动恢复', bodyOverflow === '', `overflow="${bodyOverflow}"`)
    }
  }

  step('零页面错误', report.errors.length === 0, report.errors.slice(0, 3).join(' | ') || '0')
  await browser.close()
  if (server) server.child.kill()
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
