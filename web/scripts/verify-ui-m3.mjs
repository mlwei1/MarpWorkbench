/**
 * M3 UI 集成验证（mock 或真实服务）：mermaid 插入/渲染、网络图片代理、图片原位编辑、RemoteImagesBanner。
 *
 * 用法：
 *   node web/scripts/verify-ui-m3.mjs                     # 自动起 vite preview（mock）
 *   node web/scripts/verify-ui-m3.mjs --url http://127.0.0.1:8898 --token xxx   # 真实服务
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
const remoteUrlArg = argValue('--remote-url') || 'https://example.com/remote-test.png'
const PORT = 5199
const baseUrl = urlArg || `http://127.0.0.1:${PORT}`
const homeUrl = tokenArg ? `${baseUrl}/?token=${tokenArg}` : `${baseUrl}/?mock=1`
const shotDir = path.join(os.tmpdir(), 'mwb-verify-m3')
fs.mkdirSync(shotDir, { recursive: true })

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

const report = { steps: [], errors: [], screenshots: [] }
function step(name, ok, detail) {
  report.steps.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const testPngPath = path.join(os.tmpdir(), 'mwb-m3-test.png')
fs.writeFileSync(
  testPngPath,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)

function readEditor(page) {
  return page.evaluate(() => window.__mwbEditorView?.state?.doc?.toString?.() || '')
}
function setEditorCursorLine(page, line) {
  return page.evaluate((lineNo) => {
    const view = window.__mwbEditorView
    if (!view) return false
    const doc = view.state.doc
    const n = Math.min(Math.max(1, lineNo), doc.lines)
    view.dispatch({ selection: { anchor: doc.line(n).from } })
    view.focus()
    return true
  }, line)
}

async function main() {
  const puppeteer = loadPuppeteer()
  if (!chrome) throw new Error('未找到 Chrome/Edge')
  let server
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
  page.setDefaultTimeout(30000)
  page.on('pageerror', (e) => report.errors.push(`pageerror: ${String(e).slice(0, 300)}`))
  page.on('console', (m) => {
    if (m.type() === 'error') report.errors.push(`console.error: ${m.text().slice(0, 300)}`)
  })
  const external = []
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    const u = req.url()
    if (/^https?:\/\//.test(u) && !u.startsWith(baseUrl) && !u.startsWith('http://127.0.0.1')) {
      external.push(u)
      req.abort()
    } else {
      req.continue()
    }
  })

  // 进入编辑器
  await page.goto(homeUrl, { waitUntil: 'networkidle2' })
  await page.waitForSelector('.home-main .hero h1', { timeout: 20000 })
  const newBtn = await page.$('.hero-actions .btn-primary')
  await newBtn.click()
  await page.waitForSelector('.cm-content', { timeout: 20000 })
  await page.waitForSelector('.preview-frame', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 1500))
  step('进入编辑器', true, page.url())

  // ---------- 1) mermaid 插入 ----------
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.editor-toolbar button')].find((b) => b.textContent?.includes('图表'))
    btn?.click()
  })
  await new Promise((r) => setTimeout(r, 600))
  let md = await readEditor(page)
  step('工具栏插入 mermaid 模板', /```mermaid/.test(md) && /graph LR/.test(md), md.match(/```mermaid[\s\S]{0,60}/)?.[0]?.replace(/\n/g, '⏎') || '')
  // mermaid 首次渲染需要懒加载 5MB bundle（~3-5s）：等待 SVG 或错误框出现
  await page
    .waitForFunction(
      () => {
        const doc = document.querySelector('.preview-frame')?.contentDocument
        if (!doc) return false
        return doc.querySelectorAll('.mwb-mermaid svg, .mwb-mermaid-error').length > 0
      },
      { timeout: 25000 },
    )
    .catch(() => null)
  const mermaidState = await page.evaluate(() => {
    const f = document.querySelector('.preview-frame')
    const doc = f?.contentDocument
    return {
      mermaidSvg: doc?.querySelectorAll('.mwb-mermaid svg').length || 0,
      mermaidBlock: doc?.querySelectorAll('code.language-mermaid, code.language-mmd').length || 0,
      errorBox: doc?.querySelectorAll('.mwb-mermaid-error').length || 0,
      hasBundle: !!window.MermaidBundle,
    }
  })
  if (mermaidState.hasBundle || mermaidState.mermaidSvg > 0) {
    step('mermaid 预览渲染为 SVG', mermaidState.mermaidSvg >= 1, JSON.stringify(mermaidState))
  } else {
    step('mermaid 模块未就绪（安全降级：保留代码块）', mermaidState.mermaidBlock >= 1 && mermaidState.errorBox === 0, JSON.stringify(mermaidState))
  }
  await page.screenshot({ path: path.join(shotDir, 'mermaid.png') })
  report.screenshots.push(path.join(shotDir, 'mermaid.png'))

  // ---------- 2) 网络图片：代理 + banner ----------
  await page.evaluate((remoteUrl) => {
    const view = window.__mwbEditorView
    if (!view) return
    const doc = view.state.doc
    view.dispatch({
      changes: { from: doc.length, insert: `\n\n![远程图](${remoteUrl})\n` },
      selection: { anchor: doc.length + 40 },
    })
  }, remoteUrlArg)
  await new Promise((r) => setTimeout(r, 1200))
  // 等 iframe 里出现代理 URL（异步渲染 + 重渲染）
  await page
    .waitForFunction(
      () => {
        const doc = document.querySelector('.preview-frame')?.contentDocument
        if (!doc) return false
        return [...doc.querySelectorAll('img')].some((i) => (i.getAttribute('src') || '').includes('/api/proxy/image?'))
      },
      { timeout: 15000 },
    )
    .catch(() => null)
  const remoteState = await page.evaluate(() => {
    const f = document.querySelector('.preview-frame')
    const doc = f?.contentDocument
    const imgs = [...(doc?.querySelectorAll('img') || [])].map((i) => i.getAttribute('src') || '')
    const banner = document.querySelector('.remote-banner-host')
    return {
      imgSrcs: imgs,
      bannerExists: !!banner,
      bannerText: (banner?.textContent || '').slice(0, 120),
    }
  })
  step('网络图片被替换为同源代理 URL', remoteState.imgSrcs.some((s) => s.includes('/api/proxy/image?')), remoteState.imgSrcs.filter((s) => s.includes('proxy')).slice(0, 2).join(','))
  step('RemoteImagesBanner 挂载', remoteState.bannerExists && remoteState.bannerText.includes('网络图片'), remoteState.bannerText)

  // 真实服务：验证代理实际返回图片（naturalWidth>0）
  if (tokenArg) {
    const loaded = await page
      .waitForFunction(
        () => {
          const doc = document.querySelector('.preview-frame')?.contentDocument
          const img = [...(doc?.querySelectorAll('img') || [])].find((i) => (i.getAttribute('src') || '').includes('/api/proxy/image?'))
          return !!img && img.naturalWidth > 0
        },
        { timeout: 20000 },
      )
      .then(() => true)
      .catch(() => false)
    step('代理图片加载成功（naturalWidth>0）', loaded, loaded ? '是否显示 OK' : '未加载（可能服务端未开 MWB_PROXY_ALLOW_PRIVATE 或不可达）')
    if (loaded) {
      // 点 banner「下载到本地」→ md URL 替换为 assets/remote-*
      const clicked = await page.evaluate(() => {
        const banner = document.querySelector('.remote-banner-host')
        const btn = banner && [...banner.querySelectorAll('button')].find((b) => (b.textContent || '').includes('下载到本地'))
        if (!btn) return false
        btn.click()
        return true
      })
      if (clicked) {
        const localized = await page
          .waitForFunction(
            () => {
              const md = window.__mwbEditorView?.state?.doc?.toString?.() || ''
              return /assets\/remote-[^\s)]+/.test(md)
            },
            { timeout: 40000 },
          )
          .then(() => true)
          .catch(() => false)
        md = await readEditor(page)
        step('网络图片一键本地化写回 Markdown', localized, md.match(/assets\/remote-[^\s)]+/)?.[0] || '')
      } else {
        step('网络图片一键本地化写回 Markdown', false, '未找到「下载到本地」按钮')
      }
    }
  }

  // ---------- 3) 图片原位编辑 ----------
  // 先在光标处插入一张本地图片（打开图片插入器 → 上传 → 插入）
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
    await page.waitForSelector('.insert-panel .thumb-meta, .insert-panel .thumb', { timeout: 25000 }).catch(() => null)
    await new Promise((r) => setTimeout(r, 500))
    await page.evaluate(() => {
      const panel = document.querySelector('.insert-panel')
      const insertBtn = panel && [...panel.querySelectorAll('.btn-primary')][0]
      insertBtn?.click()
    })
    await new Promise((r) => setTimeout(r, 1500))
    md = await readEditor(page)
    step('插入普通图片', /!\[[^\]]*\]\(assets\//.test(md), md.match(/!\[[^\]]*\]\(assets\/[^)]*\)/g)?.slice(-1)[0] || '')

    // 光标放到图片行 → 点图片按钮 → 应进入编辑模式
    const imageLine = md.split('\n').findIndex((l) => /!\[[^\]]*\]\(assets\//.test(l)) + 1
    await setEditorCursorLine(page, imageLine)
    await new Promise((r) => setTimeout(r, 300))
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.editor-toolbar button')].find((b) => b.textContent?.includes('图片'))
      btn?.click()
    })
    await page.waitForSelector('.insert-panel', { timeout: 15000 }).catch(() => null)
    await new Promise((r) => setTimeout(r, 800))
    const editMode = await page.evaluate(() => {
      const panel = document.querySelector('.insert-panel')
      const title = panel?.querySelector('h2')?.textContent?.trim() || ''
      const buttons = [...(panel?.querySelectorAll('button') || [])].map((b) => b.textContent?.trim() || '')
      return { title, hasSave: buttons.some((t) => t.includes('保存')) }
    })
    step('光标在图片行时进入编辑模式', editMode.title.includes('编辑') || editMode.hasSave, JSON.stringify(editMode))
    await page.screenshot({ path: path.join(shotDir, 'image-edit.png') })
    report.screenshots.push(path.join(shotDir, 'image-edit.png'))

    if (editMode.title.includes('编辑') || editMode.hasSave) {
      const countBefore = (md.match(/!\[[^\]]*\]\(assets\//g) || []).length
      // 改宽度（如果存在宽度选择）
      await page.evaluate(() => {
        const panel = document.querySelector('.insert-panel')
        const select = [...(panel?.querySelectorAll('select') || [])].find((s) => [...s.options].some((o) => /%/.test(o.textContent || '')))
        if (select) {
          const opt = [...select.options].find((o) => o.value === '50')
          if (opt) {
            select.value = '50'
            select.dispatchEvent(new Event('change', { bubbles: true }))
          }
        }
      })
      await new Promise((r) => setTimeout(r, 400))
      await page.evaluate(() => {
        const panel = document.querySelector('.insert-panel')
        const saveBtn = [...(panel?.querySelectorAll('.btn-primary') || [])][0]
        saveBtn?.click()
      })
      await new Promise((r) => setTimeout(r, 1800))
      const mdAfter = await readEditor(page)
      const countAfter = (mdAfter.match(/!\[[^\]]*\]\(assets\//g) || []).length
      step('编辑保存后原位替换（不新增图片行）', countAfter === countBefore, `before=${countBefore} after=${countAfter}`)
      step('图片行被更新（宽度/属性变化）', mdAfter !== md, mdAfter.split('\n').find((l) => /!\[[^\]]*\]\(assets\//.test(l))?.trim() || '')
    }
  }

  step('零外网请求（代理除外）', external.length === 0, external.slice(0, 3).join(', ') || '0 个')
  await page.screenshot({ path: path.join(shotDir, 'final.png') })
  report.screenshots.push(path.join(shotDir, 'final.png'))

  await browser.close()
  if (server) server.child.kill()
  fs.writeFileSync(path.join(shotDir, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`\n截图/报告：${shotDir}`)
  if (report.errors.length) console.log('页面错误：', report.errors.slice(0, 8).join(' | '))
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
