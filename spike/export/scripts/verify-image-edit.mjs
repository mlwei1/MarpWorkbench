/**
 * M3-A/B 验收脚本（owner: export-eng）
 *
 * PART 1 Node 单测（esbuild 编译 compose.ts / remoteImages.ts → 断言）：
 *   - 图片语法解析：普通图/背景图/宽度/透明度/滤镜/代码围栏跳过/±1 行容差
 *   - 原位替换：精确 range、保留前后文与行号、失效 range 自动重定位
 *   - 网络图片工具：find/replace/proxy URL/html 代理替换/失败不抛错
 *
 * PART 2 真实浏览器冒烟（Vite dev + mock；不依赖 EditView 集成，直接挂载组件）：
 *   - ImageInsertDialog 编辑模式：标题/预填（bg left:40% opacity:.5）/改右侧 60%/保存 emit edit
 *   - 用 replaceImageAt 验证 markdown 原位替换（不是新增行）
 *   - 普通图片 w:640px 编辑 → w:960px
 *   - RemoteImagesBanner：检测 2 张、mock 下载失败提示、忽略 → localStorage 记忆、URL 变化后重现
 *   - proxyImageUrl 自带 &token=；proxyRemoteImagesInHtml 只换图片不换 <a href>
 *
 * 用法：node spike/export/scripts/verify-image-edit.mjs
 * 产物：spike/export/out/verify-image-edit-report.json + m3-edit-dialog.png / m3-banner.png
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const REPO = path.resolve(ROOT, '..', '..')
const outDir = path.join(ROOT, 'out')
fs.mkdirSync(outDir, { recursive: true })
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = Number(process.env.MWB_M3_DEV_PORT || 5192)
const BASE = `http://localhost:${PORT}`

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, part: currentPart, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + String(detail).slice(0, 240) : ''}`)
  return ok
}
let currentPart = 'unit'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// PART 1：Node 单测
// ---------------------------------------------------------------------------
const esbuild = path.join(REPO, 'web', 'node_modules', '.bin', 'esbuild.cmd')
function bundle(entry, outName) {
  const outFile = path.join(outDir, outName)
  const res = spawnSync(
    esbuild,
    [entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${outFile}`, '--log-level=warning'],
    { encoding: 'utf8', shell: true }
  )
  if (res.status !== 0) throw new Error(`esbuild 失败 ${entry}: ${res.stderr || res.stdout}`)
  return import(pathToFileURL(outFile).href)
}

const compose = await bundle(path.join(REPO, 'web', 'src', 'insert', 'compose.ts'), 'm3-compose-bundle.mjs')
const remote = await bundle(path.join(REPO, 'web', 'src', 'insert', 'remoteImages.ts'), 'm3-remote-bundle.mjs')

const bgMd = [
  '---',
  'marp: true',
  'theme: jazz',
  '---',
  '# 封面',
  '',
  '这是正文',
  '',
  '![bg left:40% opacity:.5](assets/bg.png)',
  '',
  '## 内容',
  '',
  '---',
  '',
  '# 第二页',
  '![插图 w:640px](assets/a.png)',
  ''
].join('\n')

// parse：背景图
const bgParsed = compose.parseImageAtLine(bgMd, 9)
check(
  'parse：背景图（bg left:40% opacity:.5）',
  bgParsed &&
    bgParsed.kind === 'background' &&
    bgParsed.path === 'assets/bg.png' &&
    bgParsed.bgLayout === 'left' &&
    bgParsed.bgRatio === 40 &&
    bgParsed.opacity === 0.5 &&
    bgParsed.line === 9 &&
    bgMd.slice(bgParsed.start, bgParsed.end) === '![bg left:40% opacity:.5](assets/bg.png)',
  JSON.stringify(bgParsed && { line: bgParsed.line, kind: bgParsed.kind, mods: bgParsed.modifiers })
)

// parse：普通图片（alt + w:640px）
const imgParsed = compose.parseImageAtLine(bgMd, 16)
check(
  'parse：普通图片（alt + w:640px → widthPx）',
  imgParsed &&
    imgParsed.kind === 'image' &&
    imgParsed.alt === '插图' &&
    imgParsed.widthPx === 640 &&
    imgParsed.modifiers.includes('w:640px'),
  JSON.stringify(imgParsed && { alt: imgParsed.alt, widthPx: imgParsed.widthPx })
)

// parse：滤镜 + fit + 不认识的修饰符透传
const advMd = '![bg right:30% contain blur:4px grayscale brightness:.8](https://example.com/bg.png)\n'
const advParsed = compose.parseImageAtLine(advMd, 1)
check(
  'parse：bg right:30% contain blur grayscale + 未知修饰符透传',
  advParsed &&
    advParsed.bgLayout === 'right' &&
    advParsed.bgRatio === 30 &&
    advParsed.fit === 'contain' &&
    advParsed.blur === 4 &&
    advParsed.grayscale === true &&
    advParsed.extraModifiers.includes('brightness:.8') &&
    advParsed.path === 'https://example.com/bg.png',
  JSON.stringify(advParsed && { fit: advParsed.fit, blur: advParsed.blur, extras: advParsed.extraModifiers })
)

// parse：宽度百分比语法（w:50%）
const pctParsed = compose.parseImageAtLine('![w:50%](assets/x.png)\n', 1)
check('parse：w:50% → widthPercent=50', pctParsed && pctParsed.widthPercent === 50, JSON.stringify(pctParsed && { widthPercent: pctParsed.widthPercent }))

// parse：代码围栏内不识别
const fenceMd = ['# 页', '```md', '![bg left:40%](assets/bg.png)', '```', '![w:640px](assets/a.png)', ''].join('\n')
check('parse：代码围栏内的图片不识别', compose.parseImageAtLine(fenceMd, 3) === null)
const fenceTokens = compose.findImageTokens(fenceMd)
check('findImageTokens：只找到围栏外 1 张', fenceTokens.length === 1 && fenceTokens[0].path === 'assets/a.png', `count=${fenceTokens.length}`)

// parse：±1 行容差
check(
  'parse：光标在图片行 ±1 行可命中',
  compose.parseImageAtLine(bgMd, 8)?.line === 9 &&
    compose.parseImageAtLine(bgMd, 10)?.line === 9 &&
    compose.parseImageAtLine(bgMd, 11) === null,
  JSON.stringify({
    prev: compose.parseImageAtLine(bgMd, 8)?.line ?? null,
    next: compose.parseImageAtLine(bgMd, 10)?.line ?? null,
    far: compose.parseImageAtLine(bgMd, 11)?.line ?? null
  })
)

// replace：原位替换（保留前后文与行号）
const replaced = compose.replaceImageAt(bgMd, bgParsed, '![bg right:60% opacity:.5](assets/bg.png)')
const replacedLines = replaced.split('\n')
check(
  'replace：原位替换（行数不变、前后文保留）',
  replacedLines.length === bgMd.split('\n').length &&
    replacedLines[8] === '![bg right:60% opacity:.5](assets/bg.png)' &&
    replaced.includes('这是正文') &&
    replacedLines[15].includes('![插图 w:640px](assets/a.png)') &&
    !replaced.includes('bg left:40%'),
  JSON.stringify({ before: replacedLines.length, line9: replacedLines[8] })
)

// replace：range 失效（前置内容变化）自动重定位
const shifted = '# 新增开头\n\n' + bgMd
const shiftedReplace = compose.replaceImageAt(shifted, bgParsed, '![bg](assets/bg.png)')
check(
  'replace：range 失效后按行/路径重定位',
  shiftedReplace.includes('shifted') === false &&
    shiftedReplace.startsWith('# 新增开头\n\n') &&
    shiftedReplace.split('\n').filter((l) => l.includes('![bg](assets/bg.png)')).length === 1 &&
    !shiftedReplace.includes('bg left:40%'),
  JSON.stringify(shiftedReplace.split('\n').slice(8, 12))
)

// replace：交叉替换普通图 → 背景图
const cross = compose.replaceImageAt(bgMd, imgParsed, '![bg](assets/a.png)')
check(
  'replace：普通图替换为背景图',
  cross.split('\n')[15].trim() === '![bg](assets/a.png)' && cross.split('\n').length === bgMd.split('\n').length
)

// ---------------- remoteImages 单测 ----------------
const remoteMd = [
  '# 网络图片',
  '',
  '![图](https://example.com/a.png)',
  '![bg left:40%](https://cdn.example.com/b%20c.png)',
  '![](assets/local.png)',
  '',
  '```md',
  '![](https://ignored.example.com/fenced.png)',
  '```',
  ''
].join('\n')
const found = remote.findRemoteImages(remoteMd)
check(
  'remote：findRemoteImages 找到 2 张（跳过本地与围栏）',
  found.length === 2 &&
    found.some((r) => r.url === 'https://example.com/a.png') &&
    found.some((r) => r.url === 'https://cdn.example.com/b%20c.png'),
  JSON.stringify(found.map((r) => r.url))
)

const mappedMd = remote.replaceRemoteImages(remoteMd, {
  'https://example.com/a.png': 'assets/remote-11111111.png',
  'https://cdn.example.com/b%20c.png': 'assets/remote-22222222.png'
})
check(
  'remote：replaceRemoteImages 替换普通图与背景图',
  mappedMd.includes('![图](assets/remote-11111111.png)') &&
    mappedMd.includes('![bg left:40%](assets/remote-22222222.png)') &&
    !mappedMd.includes('https://example.com/a.png') &&
    mappedMd.includes('![](assets/local.png)'),
  JSON.stringify(mappedMd.split('\n').slice(1, 5))
)

const proxy = remote.proxyImageUrl('https://example.com/a.png?x=1&y=2')
check(
  'remote：proxyImageUrl 自带 URL 编码 + token 参数',
  proxy.startsWith('/api/proxy/image?url=') &&
    proxy.includes(encodeURIComponent('https://example.com/a.png?x=1&y=2')) &&
    /[?&]token=/.test(proxy),
  proxy
)

const htmlRemote =
  '<img src="https://example.com/a.png"><div style="background-image:url(&quot;https://cdn.example.com/bg.png&quot;)"></div><a href="https://example.com/page">link</a>'
const proxiedHtml = remote.proxyRemoteImagesInHtml(htmlRemote)
check(
  'remote：proxyRemoteImagesInHtml 换图片（含 &quot; url）不换 <a href>',
  proxiedHtml.includes('/api/proxy/image?url=') &&
    !proxiedHtml.includes('src="https://example.com/a.png"') &&
    !proxiedHtml.includes('https://cdn.example.com/bg.png') &&
    proxiedHtml.includes('href="https://example.com/page"'),
  proxiedHtml.slice(0, 200)
)

check(
  'remote：hasRemoteImageRefs 区分网络图/纯本地',
  remote.hasRemoteImageRefs(remoteMd) === true &&
    remote.hasRemoteImageRefs('# 只有本地\n\n![](assets/a.png)\n') === false
)

const noRemote = await remote.localizeRemoteImages('deck-x', '# 无网络图片')
check(
  'remote：localize 无网络图片时直接返回（不请求后端）',
  noRemote.localized === 0 && noRemote.markdown === '# 无网络图片' && noRemote.failed.length === 0
)

let localizeError = ''
try {
  await remote.localizeRemoteImages('deck-x', '![](https://example.com/a.png)')
} catch (err) {
  localizeError = String(err?.message || err)
}
check(
  'remote：localize 后端不可达时给出可读错误（Node 环境）',
  /无法连接本地服务|localize|fetch/i.test(localizeError),
  localizeError
)

const inlineFail = await remote.inlineRemoteImageDataUrls('<img src="https://example.com/a.png">')
check(
  'remote：inlineRemoteImageDataUrls 失败不抛错（failed 列表返回可读原因）',
  inlineFail.inlined === 0 &&
    inlineFail.failed.length === 1 &&
    /无法连接本地服务|Failed to parse URL|fetch/i.test(inlineFail.failed[0].reason),
  JSON.stringify(inlineFail.failed[0] || null)
)

// ---------------------------------------------------------------------------
// PART 2：真实浏览器冒烟
// ---------------------------------------------------------------------------
if (process.env.MWB_SKIP_BROWSER === '1') {
  const failedUnit = checks.filter((c) => !c.ok)
  console.log(`\n[verify-image-edit] 仅单测：${checks.length - failedUnit.length}/${checks.length}`)
  process.exit(failedUnit.length ? 1 : 0)
}
currentPart = 'browser'
const report = { unit: checks.filter((c) => c.part === 'unit'), browser: [] }
let server = null
let browser = null
const serverLog = []

function killTree(pid) {
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* ignore */
  }
}

async function waitServer(timeoutMs = 90000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(BASE + '/')
      if (res.ok) return true
    } catch {
      /* retry */
    }
    await sleep(300)
  }
  return false
}

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const puppeteer = (await import('puppeteer-core')).default
  const env = { ...process.env, MWB_DEV_PORT: String(PORT) }
  server = spawn('pnpm', ['--dir', 'web', 'dev'], { cwd: REPO, env, shell: true })
  server.stdout.on('data', (d) => serverLog.push(d.toString()))
  server.stderr.on('data', (d) => serverLog.push(d.toString()))
  const ready = await waitServer()
  check('Vite dev server 就绪', ready, BASE)
  if (!ready) throw new Error('dev server 未就绪：' + serverLog.join('').slice(-500))

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--disable-gpu', '--no-first-run', '--window-size=1500,950'],
    defaultViewport: { width: 1500, height: 950 }
  })
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)))
  await page.goto(`${BASE}/?mock=1`, { waitUntil: 'networkidle2', timeout: 120000 })
  await page.waitForSelector('.deck-main', { timeout: 60000 })

  // 在页面内挂载组件（不依赖 EditView 集成）
  await page.evaluate(() => {
    const vueEntry = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((name) => /\/node_modules\/\.vite\/deps\/vue\.js/.test(name))
    window.__mwbHarness = {
      vueUrl: vueEntry || '/node_modules/.vite/deps/vue.js',
      containerId: 'mwb-m3-harness'
    }
  })

  const mount = async (payload) =>
    page.evaluate(async (data) => {
      const harness = window.__mwbHarness
      const vue = await import(/* @vite-ignore */ harness.vueUrl)
      const composeMod = await import(/* @vite-ignore */ '/src/insert/compose.ts')
      const dialogMod = await import(/* @vite-ignore */ '/src/insert/ImageInsertDialog.vue')
      const parsed = composeMod.parseImageAtLine(data.md, data.line)
      const old = document.getElementById(harness.containerId)
      if (old) old.remove()
      const container = document.createElement('div')
      container.id = harness.containerId
      document.body.appendChild(container)
      window.__insertResult = null
      window.__dialogClosed = false
      const app = vue.createApp({
        render() {
          return vue.h(dialogMod.default, {
            deckId: 'mock-deck',
            markdown: data.md,
            currentPage: 1,
            initialImage: parsed,
            onInsert: (result) => {
              window.__insertResult = result
            },
            onClose: () => {
              window.__dialogClosed = true
              app.unmount()
              container.remove()
            }
          })
        }
      })
      app.mount(container)
      window.__harnessMd = data.md
      window.__harnessParsed = parsed
      return parsed
    }, payload)

  const mountBanner = async (payload) =>
    page.evaluate(async (data) => {
      const harness = window.__mwbHarness
      const vue = await import(/* @vite-ignore */ harness.vueUrl)
      const bannerMod = await import(/* @vite-ignore */ '/src/insert/RemoteImagesBanner.vue')
      const old = document.getElementById('mwb-m3-banner-harness')
      if (old) old.remove()
      const container = document.createElement('div')
      container.id = 'mwb-m3-banner-harness'
      document.body.appendChild(container)
      window.__localizedPayload = null
      const app = vue.createApp({
        render() {
          return vue.h(bannerMod.default, {
            deckId: data.deckId,
            markdown: data.md,
            onLocalized: (payload) => {
              window.__localizedPayload = payload
            }
          })
        }
      })
      app.mount(container)
      window.__bannerApp = app
      window.__bannerContainer = container
    }, payload)

  const unmountBanner = async () =>
    page.evaluate(() => {
      try {
        window.__bannerApp?.unmount()
      } catch {}
      window.__bannerContainer?.remove()
    })

  const mdBg = [
    '---',
    'marp: true',
    'theme: default',
    '---',
    '# 封面',
    '',
    '这是正文',
    '',
    '![bg left:40% opacity:.5](assets/bg.png)',
    '',
    '## 内容',
    ''
  ].join('\n')
  const bgLine = 9

  const parsedBg = await mount({ md: mdBg, line: bgLine })
  check(
    '浏览器：编辑模式解析出背景图',
    parsedBg && parsedBg.kind === 'background' && parsedBg.line === bgLine,
    JSON.stringify(parsedBg && { line: parsedBg.line, kind: parsedBg.kind })
  )
  await page.waitForSelector('.insert-panel', { timeout: 30000 })
  await sleep(700)
  await page.screenshot({ path: path.join(outDir, 'm3-edit-dialog.png') })

  const headerTitle = await page.$eval('.insert-panel .modal-head h2', (el) => el.textContent || '')
  check('浏览器：标题为「编辑图片」', headerTitle.trim() === '编辑图片', headerTitle)

  const prefill = await page.evaluate(() => {
    const panel = document.querySelector('.insert-panel')
    const activeSeg = (label) =>
      [...panel.querySelectorAll('.seg-btn')]
        .filter((b) => b.classList.contains('active'))
        .map((b) => (b.textContent || '').trim())
    const fieldValue = (labelText, kind = 'range') => {
      const labels = [...panel.querySelectorAll('label.field')]
      const label = labels.find((l) => (l.textContent || '').includes(labelText))
      const input = label?.querySelector(`input[type="${kind}"]`)
      return input ? input.value : null
    }
    return {
      snippet: (panel.querySelector('.snippet')?.textContent || '').trim(),
      activeSeg: activeSeg(),
      ratio: fieldValue('占比'),
      transparency: fieldValue('透明度'),
      blur: fieldValue('模糊'),
      primaryLabel: (panel.querySelector('.btn-primary')?.textContent || '').trim()
    }
  })
  check(
    '浏览器：编辑模式预填（背景/左侧/40%/透明度50%/按钮「保存修改」）',
    prefill.activeSeg.includes('背景图') &&
      prefill.activeSeg.includes('左侧') &&
      prefill.ratio === '40' &&
      prefill.transparency === '50' &&
      prefill.blur === '0' &&
      prefill.primaryLabel === '保存修改' &&
      prefill.snippet === '![bg left:40% opacity:.5](assets/bg.png)',
    JSON.stringify(prefill)
  )

  // 改：右侧 + 占比 60%
  await page.evaluate(() => {
    const panel = document.querySelector('.insert-panel')
    const rightBtn = [...panel.querySelectorAll('.seg-btn')].find((b) => (b.textContent || '').trim() === '右侧')
    rightBtn?.click()
    const labels = [...panel.querySelectorAll('label.field')]
    const ratioLabel = labels.find((l) => (l.textContent || '').includes('占比'))
    const input = ratioLabel?.querySelector('input[type="range"]')
    if (input) {
      input.value = '60'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
  await sleep(400)
  const editedSnippet = await page.$eval('.insert-panel .snippet', (el) => (el.textContent || '').trim())
  check(
    '浏览器：改右侧 60% → snippet 更新',
    editedSnippet === '![bg right:60% opacity:.5](assets/bg.png)',
    editedSnippet
  )

  await page.click('.insert-panel .btn-primary')
  await sleep(500)
  const bgResult = await page.evaluate(() => ({
    result: window.__insertResult,
    closed: window.__dialogClosed,
    md: window.__harnessMd,
    parsed: window.__harnessParsed
  }))
  check(
    '浏览器：保存 emit edit{line,start,end} 并关闭对话框',
    bgResult.result &&
      bgResult.result.snippet === '![bg right:60% opacity:.5](assets/bg.png)' &&
      bgResult.result.edit &&
      bgResult.result.edit.line === bgLine &&
      typeof bgResult.result.edit.start === 'number' &&
      bgResult.result.edit.end > bgResult.result.edit.start &&
      bgResult.closed === true,
    JSON.stringify(bgResult.result && { snippet: bgResult.result.snippet, edit: bgResult.result.edit, closed: bgResult.closed })
  )

  const replacedMd = await page.evaluate(async (data) => {
    const composeMod = await import(/* @vite-ignore */ '/src/insert/compose.ts')
    return composeMod.replaceImageAt(data.md, data.parsed, data.snippet)
  }, { md: bgResult.md, parsed: bgResult.parsed, snippet: bgResult.result.snippet })
  const replacedLines = replacedMd.split('\n')
  check(
    '浏览器：replaceImageAt 原位替换（行数不变、无新增行、旧语法消失）',
    replacedLines.length === bgResult.md.split('\n').length &&
      replacedLines[bgLine - 1] === '![bg right:60% opacity:.5](assets/bg.png)' &&
      !replacedMd.includes('bg left:40%') &&
      replacedMd.includes('这是正文'),
    JSON.stringify({ lines: replacedLines.length, line: replacedLines[bgLine - 1] })
  )

  // 普通图片编辑：w:640px → w:960px（75%）
  const mdImg = ['# 页', '', '![插图 w:640px](assets/a.png)', '', '正文', ''].join('\n')
  const parsedImg = await mount({ md: mdImg, line: 3 })
  await page.waitForSelector('.insert-panel', { timeout: 30000 })
  await sleep(700)
  const imgPrefill = await page.evaluate(() => {
    const panel = document.querySelector('.insert-panel')
    return {
      title: (panel.querySelector('.modal-head h2')?.textContent || '').trim(),
      widthValue: panel.querySelector('.select')?.value ?? null,
      activeSeg: [...panel.querySelectorAll('.seg-btn')].filter((b) => b.classList.contains('active')).map((b) => (b.textContent || '').trim()),
      snippet: (panel.querySelector('.snippet')?.textContent || '').trim()
    }
  })
  check(
    '浏览器：普通图编辑预填（普通图片/50% 宽度/alt 保留）',
    imgPrefill.title === '编辑图片' &&
      imgPrefill.activeSeg.includes('普通图片') &&
      imgPrefill.widthValue === '50' &&
      imgPrefill.snippet === '![插图 w:640px](assets/a.png)',
    JSON.stringify(imgPrefill)
  )
  await page.evaluate(() => {
    const select = document.querySelector('.insert-panel .select')
    if (select) {
      select.value = '75'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }
  })
  await sleep(300)
  const imgSnippet = await page.$eval('.insert-panel .snippet', (el) => (el.textContent || '').trim())
  check('浏览器：普通图宽度 75% → w:960px', imgSnippet === '![插图 w:960px](assets/a.png)', imgSnippet)
  await page.click('.insert-panel .btn-primary')
  await sleep(400)
  const imgResult = await page.evaluate(() => window.__insertResult)
  const imgReplaced = await page.evaluate(async (data) => {
    const composeMod = await import(/* @vite-ignore */ '/src/insert/compose.ts')
    return composeMod.replaceImageAt(data.md, data.parsed, data.snippet)
  }, { md: mdImg, parsed: parsedImg, snippet: imgResult.snippet })
  check(
    '浏览器：普通图保存后原位替换且行数不变',
    imgResult?.edit?.line === 3 &&
      imgReplaced.split('\n').length === mdImg.split('\n').length &&
      imgReplaced.split('\n')[2].trim() === '![插图 w:960px](assets/a.png)',
    JSON.stringify({ edit: imgResult?.edit, line3: imgReplaced.split('\n')[2] })
  )

  // 不命中：parseImageAtLine 对纯文本行返回 null
  const noHit = await page.evaluate(async () => {
    const composeMod = await import(/* @vite-ignore */ '/src/insert/compose.ts')
    return composeMod.parseImageAtLine('# 只有文字\n\n没有图片\n', 3)
  })
  check('浏览器：非图片行 parse 返回 null（新建流程）', noHit === null)

  // ---------------- RemoteImagesBanner ----------------
  const remoteMd = [
    '# 网络图片',
    '',
    '![](https://example.com/a.png)',
    '![bg left:40%](https://cdn.example.com/b.png)',
    ''
  ].join('\n')
  await mountBanner({ deckId: 'mock-deck-banner', md: remoteMd })
  await sleep(500)
  await page.screenshot({ path: path.join(outDir, 'm3-banner.png') })
  const bannerText = await page.$eval('#mwb-m3-banner-harness', (el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
  check(
    '浏览器：Banner 检测到 2 张网络图片',
    /检测到 2 张网络图片/.test(bannerText) && /下载到本地/.test(bannerText),
    bannerText.slice(0, 120)
  )

  // 点击下载（mock 模式无后端 → 可读错误，不崩溃）
  await page.evaluate(() => {
    const container = document.getElementById('mwb-m3-banner-harness')
    const btn = [...container.querySelectorAll('button')].find((b) => (b.textContent || '').includes('下载到本地'))
    btn?.click()
  })
  await sleep(800)
  const bannerAfterDownload = await page.$eval('#mwb-m3-banner-harness', (el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
  check(
    '浏览器：下载失败给出可读提示（mock 无后端）',
    /下载失败|Mock 模式/.test(bannerAfterDownload),
    bannerAfterDownload.slice(0, 140)
  )

  // 忽略 → localStorage 记忆 + 隐藏
  await page.evaluate(() => {
    const container = document.getElementById('mwb-m3-banner-harness')
    const btn = [...container.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '忽略')
    btn?.click()
  })
  await sleep(400)
  const ignoredState = await page.evaluate(() => {
    const visible = !!(document.getElementById('mwb-m3-banner-harness')?.querySelector('.mwb-remote-banner'))
    const value = localStorage.getItem('mwb.remoteImages.ignored.mock-deck-banner')
    return { visible, value }
  })
  check('浏览器：忽略后隐藏 + localStorage 记忆', ignoredState.visible === false && !!ignoredState.value, JSON.stringify(ignoredState))

  // URL 变化后重新出现
  await page.evaluate(() => {
    const container = document.getElementById('mwb-m3-banner-harness')
    const btn = null
    void btn
  }).catch(() => {})
  await mountBanner({ deckId: 'mock-deck-banner', md: '# 网络图片\n\n![](https://example.com/c.png)\n' })
  await sleep(500)
  const reappeared = await page.evaluate(() => {
    const container = document.getElementById('mwb-m3-banner-harness')
    return {
      visible: !!container?.querySelector('.mwb-remote-banner'),
      text: (container?.textContent || '').replace(/\s+/g, ' ').trim()
    }
  })
  check('浏览器：URL 集合变化后 Banner 重新出现', reappeared.visible && /检测到 1 张网络图片/.test(reappeared.text), reappeared.text.slice(0, 100))
  await unmountBanner()

  // proxy 工具（浏览器内 token 上下文）
  const proxyChecks = await page.evaluate(async () => {
    const remoteMod = await import(/* @vite-ignore */ '/src/insert/remoteImages.ts')
    const url = 'https://example.com/a.png?x=1&y=2'
    const proxy = remoteMod.proxyImageUrl(url)
    const html = remoteMod.proxyRemoteImagesInHtml(
      '<img src="https://example.com/a.png"><a href="https://example.com/page">x</a><div style="background-image:url(https://cdn.example.com/b.png)"></div>'
    )
    return {
      proxy,
      hasEncoded: proxy.includes(encodeURIComponent(url)),
      hasToken: /[?&]token=/.test(proxy),
      html,
      linkKept: html.includes('href="https://example.com/page"'),
      imgProxied: !html.includes('src="https://example.com/a.png"') && html.includes('/api/proxy/image?url='),
      bgProxied: !html.includes('url(https://cdn.example.com/b.png)')
    }
  })
  check(
    '浏览器：proxyImageUrl 编码 + token；html 代理只换图片',
    proxyChecks.hasEncoded &&
      proxyChecks.hasToken &&
      proxyChecks.linkKept &&
      proxyChecks.imgProxied &&
      proxyChecks.bgProxied,
    JSON.stringify({ proxy: proxyChecks.proxy.slice(0, 100), linkKept: proxyChecks.linkKept })
  )

  check('浏览器：无页面 JS 错误', pageErrors.length === 0, pageErrors.join(' ; '))
} catch (err) {
  check('M3 浏览器冒烟执行', false, String(err?.stack || err))
} finally {
  try {
    await browser?.close()
  } catch {
    /* ignore */
  }
  if (server) {
    try {
      spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* ignore */
    }
  }
  report.unit = checks.filter((c) => c.part === 'unit')
  report.browser = checks.filter((c) => c.part === 'browser')
  const failed = checks.filter((c) => !c.ok)
  fs.writeFileSync(
    path.join(outDir, 'verify-image-edit-report.json'),
    JSON.stringify({ ok: failed.length === 0, unit: report.unit.length, browser: report.browser.length, checks }, null, 2)
  )
  console.log(`\n[verify-image-edit] unit ${report.unit.filter((c) => c.ok).length}/${report.unit.length}，browser ${report.browser.filter((c) => c.ok).length}/${report.browser.length}`)
  if (failed.length) process.exit(1)
}
