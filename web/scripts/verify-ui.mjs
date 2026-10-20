/**
 * 前端骨架自动验证（无头 Chrome）：
 *   - 启动 vite preview（先用 `pnpm --dir web build` 构建）
 *   - 打开 /?mock=1 → 检查首页 deck 列表
 *   - 新建空白 → /edit/:id → 检查 CodeMirror + 预览 iframe 页数
 *   - 输入内容 → 预览更新 + 自动保存状态
 *   - 切换主题下拉 → front-matter theme 改变（编辑器内容）
 *   - 统计非 127.0.0.1 的外网请求（离线验收）
 *   - 截图存到 %TEMP%/mwb-verify/
 *
 * 用法：node web/scripts/verify-ui.mjs [--url http://127.0.0.1:5199]
 * 依赖：puppeteer-core（优先 web，回退 spike/marp 里的安装）；本机 Chrome。
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
const homeUrl = tokenArg ? `${baseUrl}/?token=${tokenArg}` : `${baseUrl}/?mock=1`
const settingsUrl = tokenArg ? `${baseUrl}/settings` : `${baseUrl}/settings?mock=1`
const shotDir = path.join(os.tmpdir(), 'mwb-verify')
fs.mkdirSync(shotDir, { recursive: true })

function loadPuppeteer() {
  for (const pkg of [path.join(workDir, 'package.json'), path.join(repoRoot, 'spike', 'marp', 'package.json')]) {
    try {
      const req = createRequire(pkg)
      return req('puppeteer-core')
    } catch {
      /* try next */
    }
  }
  throw new Error('找不到 puppeteer-core：请在 web 或 spike/marp 安装（pnpm add -D puppeteer-core）')
}

function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  return candidates.find((p) => fs.existsSync(p))
}

function startPreview() {
  const isWin = process.platform === 'win32'
  const child = spawn(
    isWin ? 'pnpm' : 'pnpm',
    ['--dir', path.join(repoRoot, 'web'), 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWin,
    },
  )
  const log = []
  child.stdout.on('data', (d) => log.push(String(d)))
  child.stderr.on('data', (d) => log.push(String(d)))
  return { child, log }
}

async function waitForServer(url, timeoutMs = 30000) {
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
  throw new Error(`服务未在 ${timeoutMs}ms 内就绪：${url}`)
}

const report = { steps: [], externalRequests: [], screenshots: [], errors: [] }
function step(name, ok, detail) {
  report.steps.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  const puppeteer = loadPuppeteer()
  const chrome = findChrome()
  if (!chrome) throw new Error('未找到 Chrome/Edge')
  let server
  if (!urlArg) {
    server = startPreview()
    try {
      await waitForServer(baseUrl)
    } catch (err) {
      console.error('vite preview 启动失败，日志：\n' + server.log.join(''))
      throw err
    }
  }
  step('vite preview 就绪', true, baseUrl)

  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
  page.setDefaultTimeout(30000)
  page.on('pageerror', (err) => report.errors.push(`pageerror: ${String(err).slice(0, 300)}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') report.errors.push(`console.error: ${msg.text().slice(0, 300)}`)
  })

  // 外网请求检测（离线验收）
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    const u = req.url()
    if (/^https?:\/\//.test(u) && !u.startsWith(baseUrl) && !u.startsWith('http://127.0.0.1')) {
      report.externalRequests.push(u)
      req.abort()
    } else {
      req.continue()
    }
  })

  // ---- 首页 ----
  await page.goto(homeUrl, { waitUntil: 'networkidle2' })
  await page.waitForSelector('.home-main .hero h1', { timeout: 20000 })
  const homeTitle = await page.$eval('.hero h1', (el) => el.textContent?.trim())
  const deckCount = await page.$$eval('.deck-item', (els) => els.length)
  const mockBadge = await page.$('.badge-mock')
  step('首页加载', !!homeTitle, `hero="${homeTitle}" decks=${deckCount} mockBadge=${!!mockBadge}`)
  await page.screenshot({ path: path.join(shotDir, 'home.png') })
  report.screenshots.push(path.join(shotDir, 'home.png'))

  // ---- 新建空白 ----
  const newBtn = await page.$$('.hero-actions .btn-primary')
  if (!newBtn.length) throw new Error('找不到「新建空白」按钮')
  await newBtn[0].click()
  await page.waitForFunction(() => location.pathname.startsWith('/edit/'), { timeout: 15000 })
  await page.waitForSelector('.cm-content', { timeout: 20000 })
  await page.waitForSelector('.preview-frame', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 1200))
  const createdUrl = page.url()
  const editorText = await page.$eval('.cm-content', (el) => el.textContent || '')
  step('新建并进入编辑器', editorText.includes('---'), `url=${createdUrl}`)

  // 等待 iframe 渲染完成（marp bundle 加载 + render）
  await page.waitForFunction(
    () => {
      const f = document.querySelector('.preview-frame')
      const doc = f?.contentDocument
      return !!doc && doc.querySelectorAll('svg[data-marpit-svg]').length > 0
    },
    { timeout: 30000 },
  )
  const slideCountNew = await page.evaluate(() => {
    const f = document.querySelector('.preview-frame')
    return f?.contentDocument?.querySelectorAll('svg[data-marpit-svg]').length || 0
  })
  step('预览 iframe 渲染', slideCountNew >= 2, `slides=${slideCountNew}`)

  // ---- 输入内容 → 预览更新 ----
  const cm = await page.$('.cm-content')
  await cm.click()
  await page.keyboard.down('Control')
  await page.keyboard.press('End')
  await page.keyboard.up('Control')
  await page.keyboard.type('\n\n---\n\n## 自动化测试新增页\n\n- hello preview\n')
  await new Promise((r) => setTimeout(r, 1500))
  const slideCountAfter = await page.evaluate(() => {
    const f = document.querySelector('.preview-frame')
    return f?.contentDocument?.querySelectorAll('svg[data-marpit-svg]').length || 0
  })
  const savedStatus = await page.$eval('.status', (el) => el.textContent || '').catch(() => '')
  step('输入后预览更新', slideCountAfter >= 3, `slides=${slideCountAfter} status="${savedStatus}"`)
  step('自动保存状态', savedStatus.includes('已保存'), savedStatus)

  // ---- Ctrl+S 立即保存 ----
  await page.keyboard.down('Control')
  await page.keyboard.press('s')
  await page.keyboard.up('Control')
  await new Promise((r) => setTimeout(r, 1800))
  const ctrlSStatus = await page.$eval('.status', (el) => el.textContent || '').catch(() => '')
  step('Ctrl+S 立即保存', ctrlSStatus.includes('已保存'), ctrlSStatus)

  // ---- 主题下拉切换 ----
  const themeOptions = await page.$$eval('.theme-select option', (els) => els.map((e) => e.value))
  const currentTheme = await page.$eval('.theme-select', (el) => el.value)
  const previewStyle = () =>
    page.evaluate(() => {
      const f = document.querySelector('.preview-frame')
      const s = f?.contentDocument?.querySelector('section')
      if (!s) return ''
      const cs = getComputedStyle(s)
      return `${cs.backgroundColor}|${cs.backgroundImage}`
    })
  const bgBefore = await previewStyle()
  const otherTheme = themeOptions.find((t) => t !== currentTheme)
  if (otherTheme) {
    await page.select('.theme-select', otherTheme)
    await new Promise((r) => setTimeout(r, 1600))
    const fmText = await page.$eval('.cm-content', (el) => el.textContent || '')
    step('主题下拉切换', fmText.includes(`theme: ${otherTheme}`), `current=${currentTheme} → ${otherTheme}`)
    const bgAfter = await previewStyle()
    const fallbackToast = await page.$$eval('.toast', (els) => els.map((e) => e.textContent || '').filter((t) => t.includes('未加载')))
    step(
      '主题实际生效（预览背景变化）',
      bgAfter !== bgBefore && fallbackToast.length === 0,
      `before=${bgBefore.slice(0, 60)} after=${bgAfter.slice(0, 60)}${fallbackToast.length ? ' fallbackToast!' : ''}`,
    )
  } else {
    step('主题下拉切换', false, '主题列表少于 2 项')
  }

  // ---- 主题画廊（themes 成员组件，如已就绪） ----
  const galleryBtn = await page.$$eval('.topbar-right .btn', (els) => els.map((e) => e.textContent?.trim()))
  const galleryIndex = galleryBtn.indexOf('主题画廊')
  if (galleryIndex >= 0) {
    const btns = await page.$$('.topbar-right .btn')
    await btns[galleryIndex].click()
    await new Promise((r) => setTimeout(r, 1200))
    const gallery = await page.$('.gallery-panel')
    const cards = await page.$$eval('.gallery-panel .theme-card, .gallery-panel [class*="theme"]', (els) => els.length).catch(() => 0)
    step('主题画廊挂载', !!gallery, `cards≈${cards}`)
    if (gallery) {
      // 缩略图是 iframe srcdoc：innerHTML 恒为空，必须看 srcdoc 属性 / contentDocument
      const thumbInfo = await page.evaluate(() => {
        const frames = [...document.querySelectorAll('.gallery-panel .tg-frame')]
        return {
          frames: frames.length,
          srcdocLens: frames.map((f) => (f.getAttribute('srcdoc') || '').length),
          innerHtmlLens: frames.map((f) => f.innerHTML.length),
        }
      })
      step(
        '画廊缩略图 iframe 有内容（srcdoc）',
        thumbInfo.srcdocLens.some((l) => l > 100),
        `frames=${thumbInfo.frames} srcdocLens=[${thumbInfo.srcdocLens.slice(0, 5).join(',')}] innerHtmlLens=[${thumbInfo.innerHtmlLens.slice(0, 5).join(',')}]`,
      )
      await page.screenshot({ path: path.join(shotDir, 'gallery.png') })
      report.screenshots.push(path.join(shotDir, 'gallery.png'))
      await page.keyboard.press('Escape')
      await new Promise((r) => setTimeout(r, 300))
      const stillOpen = await page.$('.gallery-panel')
      if (stillOpen) await page.mouse.click(10, 10)
    }
  } else {
    step('主题画廊挂载', true, '组件未就绪（跳过）')
  }

  // ---- Ctrl+P 打开导出面板（拦截浏览器打印） ----
  await page.mouse.click(10, 10)
  await page.keyboard.down('Control')
  await page.keyboard.press('p')
  await page.keyboard.up('Control')
  await new Promise((r) => setTimeout(r, 600))
  const ctrlPModal = await page.$('.modal-panel')
  step('Ctrl+P 打开导出面板', !!ctrlPModal, ctrlPModal ? '已打开' : '未打开')
  if (ctrlPModal) await page.mouse.click(10, 10)

  // ---- 导出按钮（面板可能尚未就绪） ----
  await page.screenshot({ path: path.join(shotDir, 'edit.png') })
  report.screenshots.push(path.join(shotDir, 'edit.png'))
  const exportBtn = await page.$$('.topbar-right .btn-primary')
  if (exportBtn.length) {
    await exportBtn[0].click()
    await new Promise((r) => setTimeout(r, 500))
    const modal = await page.$('.modal-panel')
    const toast = await page.$('.toast')
    step('导出入口', !!modal || !!toast, modal ? 'ExportPanel 已挂载' : '面板未就绪时给出提示')
    if (modal) {
      await page.screenshot({ path: path.join(shotDir, 'export.png') })
      report.screenshots.push(path.join(shotDir, 'export.png'))
    }
  } else {
    step('导出入口', false, '找不到导出按钮')
  }

  // ---- 设置页 ----
  await page.goto(settingsUrl, { waitUntil: 'networkidle2' }).catch(() => {})
  await page.waitForSelector('.settings-card h2', { timeout: 25000 }).catch(() => null)
  const settingsCards = await page.$$eval('.settings-card h2', (els) => els.map((e) => e.textContent))
  step('设置页', settingsCards.length >= 3, settingsCards.join(' / '))
  await page.screenshot({ path: path.join(shotDir, 'settings.png') })
  report.screenshots.push(path.join(shotDir, 'settings.png'))

  // ---- 离线：外网请求 ----
  step('零外网请求', report.externalRequests.length === 0, report.externalRequests.slice(0, 5).join(', ') || '0 个')

  await browser.close()
  if (server) server.child.kill()
  report.errors = report.errors.slice(0, 20)
  fs.writeFileSync(path.join(shotDir, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`\n截图/报告目录：${shotDir}`)
  const failed = report.steps.filter((s) => !s.ok)
  if (failed.length) {
    console.error(`\n❌ ${failed.length} 项失败`)
    process.exitCode = 1
  } else {
    console.log('\n✅ 全部通过')
  }
}

main().catch(async (err) => {
  console.error('验证脚本异常：', err)
  process.exitCode = 1
  // 防止 puppeteer/子进程悬挂：直接退出
  setTimeout(() => process.exit(1), 500)
})
