// 6 套 Marp 主题真实渲染验收：marp-core 渲染 + Chrome 逐页截图 + 汇总报告
// 运行：node spike/themes/render-themes.mjs
// 依赖复用 spike/marp/node_modules（不额外安装）
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const req = createRequire(join(root, 'spike', 'marp', 'package.json'))
const { Marp } = req('@marp-team/marp-core')
let puppeteer = null
try {
  puppeteer = req('puppeteer-core')
} catch {
  console.warn('puppeteer-core 不可用，跳过截图')
}

const outDir = join(here, 'out')
const contactSheetDir = join(here, 'out')
const browserBundle = join(root, 'spike', 'marp', 'out', 'marp-core.browser.min.js')
const browserBundleUrl = existsSync(browserBundle) ? pathToFileURL(browserBundle).href : null
const shotsDir = join(here, 'shots')
mkdirSync(outDir, { recursive: true })
mkdirSync(shotsDir, { recursive: true })

const index = JSON.parse(readFileSync(join(root, 'themes', 'index.json'), 'utf8'))
const samplePath = join(here, 'sample-deck.md')
const baseMd = readFileSync(samplePath, 'utf8')

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)
const chromePath = chromeCandidates.find((p) => existsSync(p))

const report = { env: { node: process.version, chrome: chromePath ?? null }, themes: {}, summary: {} }

const marp = new Marp({ html: true, math: 'mathjax', script: false })
const themeCssMap = new Map()
const addedThemes = []

for (const meta of index) {
  const cssPath = join(root, 'themes', meta.file)
  const css = readFileSync(cssPath, 'utf8')
  themeCssMap.set(meta.name, css)
  const added = marp.themeSet.add(css)
  addedThemes.push({ meta, added, css })
}

// ---- 1) 元信息与离线检查 ----
for (const { meta, added, css } of addedThemes) {
  const externalUrls = css.match(/https?:\/\/[^\s'")]+/g) ?? []
  report.themes[meta.name] = {
    file: `themes/${meta.file}`,
    cssBytes: Buffer.byteLength(css),
    parsed: {
      name: added.name,
      meta: { ...added.meta },
      importRules: added.importRules.map((r) => r.value),
      size: added.meta?.size ?? null,
      autoScaling: added.meta?.['auto-scaling'] ?? null,
    },
    checks: {
      themeNameMatches: added.name === meta.name,
      displayNameParsed: (added.meta?.name ?? '') === meta.displayName,
      tagsParsed: (added.meta?.tags ?? '') === meta.tags.join(','),
      sizeParsed: Array.isArray(added.meta?.size) && added.meta.size[0] === '16:9 1280px 720px',
      importsDefault: added.importRules.some((r) => r.value === 'default'),
      externalUrls: externalUrls.length,
    },
    warnings: [],
  }
  if (!report.themes[meta.name].checks.importsDefault) {
    report.themes[meta.name].warnings.push('未正确 @import default（必须用真实 CSS @import，不能写在注释里）')
  }
  if (externalUrls.length) report.themes[meta.name].warnings.push(`发现外网 URL：${externalUrls.join(', ')}`)
}

// ---- 2) 每套主题渲染同一份 deck ----
for (const { meta } of addedThemes) {
  const md = baseMd.replace(/^theme:.*$/m, `theme: ${meta.name}`)
  const t0 = performance.now()
  const r = marp.render(md)
  const ms = +(performance.now() - t0).toFixed(1)
  const styleBlock = `<style>${r.css}</style>`
  // 静态 HTML（无 JS）用于离线查看；截图时由 puppeteer 注入 marp-core browser helper，
  // 与应用内 iframe preview 一致（auto-scaling / 数学等运行时能力）
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>theme preview · ${meta.name}</title>
<style>html,body{margin:0;padding:0;background:#fff;} .marpit>svg{display:block;}</style>
${styleBlock}
</head>
<body>${r.html}</body>
</html>`
  writeFileSync(join(outDir, `${meta.name}.html`), html)

  const checks = {
    renderMs: ms,
    htmlBytes: Buffer.byteLength(html),
    cssBytes: Buffer.byteLength(r.css),
    slideCount: (r.html.match(/<svg[^>]*data-marpit-svg/g) ?? []).length,
    hasChinese: /中文排版/.test(r.html),
    hasCodeBlock: /hljs|data-marpit-svg/.test(r.html) && /<pre/.test(r.html),
    hasTable: /<table/.test(r.html),
    hasBlockquote: /<blockquote/.test(r.html),
    hasHeaderFooter: /<header>/.test(r.html) && /<footer>/.test(r.html),
    hasPagination: /data-marpit-pagination="/.test(r.html),
    // 主题关键样式是否真的进了最终 CSS
    styleHits: {
      sectionBg: /section\{[^}]*background/i.test(r.css),
      leadBg: /section\.lead[^{]*\{[^}]*background/i.test(r.css),
      preStyle: /pre\b[^{]*\{[^}]*background/i.test(r.css),
      tableStyle: /table (th|td)|table th|table td/i.test(r.css),
      blockquoteStyle: /blockquote\{/i.test(r.css),
      paginationAfter: /section::after\{[^}]*font-size/i.test(r.css),
      headerFooter: /section>header|section > header/i.test(r.css),
    },
  }
  checks.pass =
    checks.slideCount === 5 &&
    checks.hasChinese &&
    checks.hasCodeBlock &&
    checks.hasTable &&
    checks.hasBlockquote &&
    checks.hasHeaderFooter &&
    checks.hasPagination
  report.themes[meta.name].render = checks
  if (!checks.pass) report.themes[meta.name].warnings.push('渲染内容检查未全部通过，见 render.checks')
  const styleMiss = Object.entries(checks.styleHits).filter(([, v]) => !v).map(([k]) => k)
  if (styleMiss.length) report.themes[meta.name].warnings.push(`主题样式未命中：${styleMiss.join(', ')}`)
}

// ---- 3) Chrome 逐页截图 + 总览图 ----
if (puppeteer && chromePath) {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--hide-scrollbars', '--force-device-scale-factor=1', '--allow-file-access-from-files', '--no-first-run'],
  })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1.5 })
    const coverShots = []
    const detailShots = []
    for (const { meta } of addedThemes) {
      const dir = join(shotsDir, meta.name)
      mkdirSync(dir, { recursive: true })
      const htmlPath = join(outDir, `${meta.name}.html`)
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load', timeout: 30000 })
      await page.waitForSelector('.marpit svg', { timeout: 15000 })
      // 默认静态渲染截图（与 marp 官方静态输出一致，便于核对主题本身）；
      // 设 SPIKE_HELPER=1 可注入 marp-core browser helper（验证 auto-scaling 运行时行为）。
      const useHelper = process.env.SPIKE_HELPER === '1'
      if (browserBundle && useHelper) {
        await page.addScriptTag({ path: browserBundle })
        await page.evaluate(() => {
          try {
            const candidates = [
              window.MarpCore,
              window.MarpCoreBundle && window.MarpCoreBundle.MarpCore,
              window.MarpCoreBrowserHelper,
            ].filter(Boolean)
            window.__MWB_GLOBAL_KEYS = Object.keys(window).filter((k) => /marp/i.test(k)).join(',')
            const M = candidates.find((c) => typeof c.browser === 'function')
            if (M && M.browser) {
              M.browser(document.body)
              window.__MWB_HELPER_APPLIED = true
            } else {
              window.__MWB_HELPER_ERROR = 'browser() not found; candidates=' + candidates.length
            }
          } catch (e) {
            window.__MWB_HELPER_ERROR = String((e && e.message) || e)
          }
        })
      }
      await new Promise((res) => setTimeout(res, 500)) // browser helper 应用 + 字体/渐变稳定
      report.themes[meta.name].browserHelper = await page.evaluate(() => ({
        applied: !!window.__MWB_HELPER_APPLIED,
        error: window.__MWB_HELPER_ERROR || null,
        globalKeys: window.__MWB_GLOBAL_KEYS || '',
        firstSectionStyle: document.querySelector('section')?.getAttribute('style') ?? null,
        autoScalingContainers: document.querySelectorAll('[data-marpit-auto-scaling]').length,
      }))
      if (report.themes[meta.name].browserHelper.applied) {
        // helper 模式：再等一轮 marp-pre / 标题 auto-scaling 的重测量
        await new Promise((res) => setTimeout(res, 600))
      }
      const boxes = await page.evaluate(() =>
        [...document.querySelectorAll('.marpit svg')].map((el) => {
          const rect = el.getBoundingClientRect()
          return { x: rect.left + window.scrollX, y: rect.top + window.scrollY, width: rect.width, height: rect.height }
        }),
      )
      const files = []
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i]
        const file = join(dir, `slide-${String(i + 1).padStart(2, '0')}.png`)
        await page.screenshot({ path: file, clip: { x: b.x, y: b.y, width: b.width, height: b.height } })
        files.push(`shots/${meta.name}/slide-${String(i + 1).padStart(2, '0')}.png`)
      }
      report.themes[meta.name].shots = files
      if (files.length) {
        coverShots.push({ name: meta.name, displayName: meta.displayName, img: join(here, files[0]), content: join(here, files[1] ?? files[0]) })
        detailShots.push({ name: meta.name, displayName: meta.displayName, code: join(here, files[2] ?? files[0]), table: join(here, files[3] ?? files[0]) })
      }
    }

    // 总览图（base64 内嵌，避免 file:// 图片限制）
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    const b64 = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`
    const sheetHtml = (cells) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body{margin:0;background:#111;padding:24px;font-family:'Microsoft YaHei',sans-serif;}
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:20px 24px;max-width:1560px;}
      .label{color:#e5e7eb;font-size:15px;margin:0 0 6px;font-weight:600;}
      .label span{color:#9ca3af;font-weight:400;margin-left:8px;font-size:13px;}
      .pair{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
      .pair img{width:100%;display:block;border-radius:6px;outline:1px solid #333;}
    </style></head><body><div class="grid">${cells}</div></body></html>`
    const shootSheet = async (cells, file, viewport) => {
      const p = join(outDir, `${file}.html`)
      writeFileSync(p, sheetHtml(cells))
      await page.setViewport(viewport)
      await page.goto(pathToFileURL(p).href, { waitUntil: 'load', timeout: 30000 })
      await new Promise((res) => setTimeout(res, 300))
      await page.screenshot({ path: join(shotsDir, `${file}.png`), fullPage: true })
      return `spike/themes/shots/${file}.png`
    }

    const coverCells = coverShots
      .map(
        (s) => `<div class="cell"><div class="label">${esc(s.displayName)} <span>${esc(s.name)}</span></div>
<div class="pair"><img src="${b64(s.img)}"><img src="${b64(s.content)}"></div></div>`,
      )
      .join('\n')
    report.summary.overviewShot = await shootSheet(coverCells, 'overview', { width: 1620, height: 1000, deviceScaleFactor: 1 })

    const detailCells = detailShots
      .map(
        (s) => `<div class="cell"><div class="label">${esc(s.displayName)} <span>代码页 / 表格页</span></div>
<div class="pair"><img src="${b64(s.code)}"><img src="${b64(s.table)}"></div></div>`,
      )
      .join('\n')
    report.summary.detailShot = await shootSheet(detailCells, 'overview-detail', { width: 1620, height: 1000, deviceScaleFactor: 1 })
  } catch (e) {
    report.summary.screenshotError = String(e?.stack ?? e)
    console.error('截图失败:', e.message)
  } finally {
    await browser.close()
  }
}

report.summary = {
  ...report.summary,
  themeCount: addedThemes.length,
  passCount: Object.values(report.themes).filter((t) => t.render?.pass && t.checks.externalUrls === 0).length,
  allOffline: Object.values(report.themes).every((t) => t.checks.externalUrls === 0),
  themes: addedThemes.map((t) => t.meta.name),
}
writeFileSync(join(outDir, 'render-report.json'), JSON.stringify(report, null, 2))

console.log('\n=== 主题渲染验收 ===')
for (const meta of index) {
  const t = report.themes[meta.name]
  console.log(
    `${t.render?.pass ? '✅' : '❌'} ${meta.name.padEnd(16)} | meta=${t.checks.themeNameMatches ? 'ok' : 'BAD'} size=${t.checks.sizeParsed ? 'ok' : 'BAD'} default=${t.checks.importsDefault ? 'ok' : 'BAD'} 外链=${t.checks.externalUrls} | render ${t.render?.renderMs}ms | shots ${t.shots?.length ?? 0} | 警告: ${t.warnings.length ? t.warnings.join(' / ') : '无'}`,
  )
}
console.log(`汇总：${report.summary.passCount}/${report.summary.themeCount} 主题通过，离线=${report.summary.allOffline}，截图目录 spike/themes/shots/`)
