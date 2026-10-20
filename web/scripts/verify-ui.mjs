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

// 1x1 PNG（图片插入/粘贴测试用）
const testPngPath = path.join(os.tmpdir(), 'mwb-verify-test.png')
fs.writeFileSync(
  testPngPath,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)

/** 读取 CodeMirror 完整文档（CM 只渲染可视行，不能用 textContent 判断全文） */
function readEditor(page) {
  return page.evaluate(() => {
    const view = window.__mwbEditorView
    return view?.state?.doc?.toString?.() || ''
  })
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
  await new Promise((r) => setTimeout(r, 400))

  // ================================================================
  // M2：格式工具栏 / 左大纲栏 / 右属性面板 / 图片·表格插入 / 粘贴
  // ================================================================
  const toolbarBtns = await page.$$eval('.editor-toolbar button', (els) => els.map((e) => e.textContent?.trim() || ''))
  step('格式工具栏渲染', toolbarBtns.length >= 10, `${toolbarBtns.length} 个按钮`)

  await page.waitForSelector('.side-left .sn-tabs', { timeout: 15000 }).catch(() => null)
  const navOk = await page.$('.side-left .sn-tabs')
  step('大纲/幻灯片左栏挂载', !!navOk, navOk ? 'SlideNavigator 已渲染' : '未找到 .sn-tabs')

  const inspectorOk = await page.$('.side-right .inspector')
  step('属性面板挂载', !!inspectorOk)
  await page.screenshot({ path: path.join(shotDir, 'edit-m2.png') })
  report.screenshots.push(path.join(shotDir, 'edit-m2.png'))

  // 工具栏加粗（光标处插入占位文本）
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.editor-toolbar button')].find((b) => b.textContent?.trim() === 'B')
    btn?.click()
  })
  await new Promise((r) => setTimeout(r, 500))
  let md = await readEditor(page)
  step('工具栏加粗', md.includes('**'), md.match(/\*\*[^*]*\*\*/)?.[0] || '')

  // 属性面板：尺寸 4:3 → front-matter + 预览 viewBox
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.inspector .seg-btn')].find((b) => b.textContent?.trim() === '4:3')
    btn?.click()
  })
  await new Promise((r) => setTimeout(r, 1400))
  md = await readEditor(page)
  step('属性面板改尺寸写回 front-matter', /size:\s*4:3/.test(md), md.match(/size:[^\n]*/)?.[0] || '')
  const viewBox = await page.evaluate(() => {
    const f = document.querySelector('.preview-frame')
    return f?.contentDocument?.querySelector('svg')?.getAttribute('viewBox') || ''
  })
  step('尺寸变更预览生效', viewBox.includes('960 720'), viewBox)

  // 属性面板：页眉（global）
  await page.evaluate(() => {
    const input = document.querySelector('.inspector input[placeholder*="2024"]')
    if (input) {
      input.value = '2024 年度汇报'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }
  })
  await new Promise((r) => setTimeout(r, 1400))
  md = await readEditor(page)
  step('属性面板改页眉', /header:\s*("?)2024 年度汇报/.test(md), md.match(/header:[^\n]*/)?.[0] || '')

  // 属性面板：全局 class（第一组 chips 的 lead）
  await page.evaluate(() => {
    const groups = [...document.querySelectorAll('.inspector-group')]
    const g = groups.find((x) => x.querySelector('h3')?.textContent?.includes('全局 class'))
    const chip = g && [...g.querySelectorAll('.chip')].find((c) => c.textContent?.trim() === 'lead')
    chip?.click()
  })
  await new Promise((r) => setTimeout(r, 1000))
  md = await readEditor(page)
  step('属性面板全局 class', /^class:\s*.*lead/m.test(md), md.match(/^class:[^\n]*/m)?.[0] || '')

  // 属性面板：本页 class（第二组 chips 的 invert）
  await page.evaluate(() => {
    const groups = [...document.querySelectorAll('.inspector-group')]
    const g = groups.find((x) => x.querySelector('h3')?.textContent?.includes('本页 class'))
    const chip = g && [...g.querySelectorAll('.chip')].find((c) => c.textContent?.trim() === 'invert')
    chip?.click()
  })
  await new Promise((r) => setTimeout(r, 1000))
  md = await readEditor(page)
  step('属性面板本页 class 指令', /<!--\s*_class:\s*invert\s*-->/.test(md), md.match(/<!--\s*_class[^>]*-->/)?.[0] || '')

  // 图片插入器：上传 → 背景图 left → 插入
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.editor-toolbar button')].find((b) => b.textContent?.includes('图片'))
    btn?.click()
  })
  await page.waitForSelector('.insert-panel', { timeout: 20000 }).catch(() => null)
  const dialogOpen = await page.$('.insert-panel')
  step('图片插入器打开', !!dialogOpen)
  if (dialogOpen) {
    const fileInput = await page.$('.insert-panel input[type="file"]')
    if (fileInput) await fileInput.uploadFile(testPngPath)
    await page.waitForSelector('.insert-panel .thumb, .insert-panel .thumb-meta', { timeout: 25000 }).catch(() => null)
    const uploaded = await page.$('.insert-panel .thumb-meta')
    step('图片上传成功', !!uploaded, uploaded ? (await page.$eval('.insert-panel .thumb-meta', (el) => el.textContent?.trim().slice(0, 60))) : '')
    await page.evaluate(() => {
      const panel = document.querySelector('.insert-panel')
      const bgBtn = panel && [...panel.querySelectorAll('button')].find((b) => b.textContent?.trim() === '背景图')
      bgBtn?.click()
    })
    await new Promise((r) => setTimeout(r, 300))
    await page.evaluate(() => {
      const panel = document.querySelector('.insert-panel')
      const leftBtn = panel && [...panel.querySelectorAll('button')].find((b) => b.textContent?.trim() === '左侧')
      leftBtn?.click()
    })
    await new Promise((r) => setTimeout(r, 300))
    await page.evaluate(() => {
      const panel = document.querySelector('.insert-panel')
      const insertBtn = panel && [...panel.querySelectorAll('.btn-primary')][0]
      insertBtn?.click()
    })
    await new Promise((r) => setTimeout(r, 1400))
    md = await readEditor(page)
    step('背景图插入 Markdown', /!\[bg left[^\]]*\]\(assets\//.test(md), md.match(/!\[bg[^\]]*\]\([^)]*\)/)?.[0] || '')
    const bgInPreview = await page.evaluate(() => {
      const f = document.querySelector('.preview-frame')
      const doc = f?.contentDocument
      if (!doc) return 0
      let count = 0
      // marp 背景图渲染为 section 内 <figure style="background-image:url(...)">（advanced background）
      doc.querySelectorAll('figure, [style*="blob:"], [style*="background-image"]').forEach((el) => {
        const style = el.getAttribute('style') || ''
        if (style.includes('blob:') || style.includes('background-image')) count++
      })
      return count
    })
    step('背景图在预览中解析', bgInPreview > 0, `matched elements=${bgInPreview}`)
  }

  // 表格插入器：3×3 → 插入
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.editor-toolbar button')].find((b) => b.textContent?.includes('表格'))
    btn?.click()
  })
  await page.waitForSelector('.table-panel', { timeout: 20000 }).catch(() => null)
  const tableOpen = await page.$('.table-panel')
  step('表格插入器打开', !!tableOpen)
  if (tableOpen) {
    await page.evaluate(() => {
      const panel = document.querySelector('.table-panel')
      const inputs = panel?.querySelectorAll('.num-field input') || []
      if (inputs[0]) {
        inputs[0].value = '3'
        inputs[0].dispatchEvent(new Event('change', { bubbles: true }))
      }
      if (inputs[1]) {
        inputs[1].value = '3'
        inputs[1].dispatchEvent(new Event('change', { bubbles: true }))
      }
    })
    await new Promise((r) => setTimeout(r, 300))
    await page.evaluate(() => {
      const panel = document.querySelector('.table-panel')
      const insertBtn = panel && [...panel.querySelectorAll('.btn-primary')][0]
      insertBtn?.click()
    })
    await new Promise((r) => setTimeout(r, 1000))
    md = await readEditor(page)
    const tableRows = (md.match(/^\|.*\|$/gm) || []).length
    step('表格插入 Markdown（GFM）', tableRows >= 4, `表格行数=${tableRows}`)
  }

  // 粘贴图片快捷路径（上传 + 插入 ![w:60%]）
  await page.evaluate(async () => {
    const dataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const blob = await (await fetch(dataUrl)).blob()
    const file = new File([blob], 'paste-test.png', { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)
    const pane = document.querySelector('.editor-pane')
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
    pane?.dispatchEvent(event)
  })
  await new Promise((r) => setTimeout(r, 3000))
  md = await readEditor(page)
  step(
    '粘贴图片快捷插入',
    /!\[w:(?:60%|\d+px)\]\(assets\//.test(md),
    md.match(/!\[w:[^\]]*\]\([^)]*\)/)?.[0] || '',
  )

  // 侧栏折叠
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.topbar-right button')].find((b) => b.textContent?.includes('大纲'))
    btn?.click()
  })
  await new Promise((r) => setTimeout(r, 400))
  const leftClosed = await page.evaluate(() => ({
    cls: document.querySelector('.editor-body')?.className || '',
    ls: localStorage.getItem('mwb.edit.leftOpen'),
  }))
  step('左栏可折叠且记忆状态', leftClosed.cls.includes('left-closed') && leftClosed.ls === '0', JSON.stringify(leftClosed))

  await page.screenshot({ path: path.join(shotDir, 'edit-m2-after.png') })
  report.screenshots.push(path.join(shotDir, 'edit-m2-after.png'))

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
