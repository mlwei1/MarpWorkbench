/**
 * 服务端导出路由端到端验收（真实 exe，不 mock）：
 *   启动 exe（MWB_DATA_DIR 临时目录 + MWB_NO_OPEN=1，读 stdout 的 MWB_LISTEN_URL/MWB_TOKEN）
 *   → POST /api/export/pdf（真实 marp-core 3 页样例渲染结果）
 *   → 校验 PDF 页数 / 960×540pt / 中文可提取 / 无页眉页脚（调用 verify-pdf.mjs）
 *   → POST /api/export/capture（CDP 2x 截图）→ 下载 PNG → pptxgenjs 组装 → 解包校验
 *   → POST /api/export/html → 下载校验单文件
 *   → /api/shutdown
 *
 * 用法：node scripts/e2e-server.mjs [--exe=server/target/release/MarpWorkbench.exe] [--format=png|jpeg]
 * 产物：out/e2e-*.pdf / out/e2e-cdp-slide-N.png / out/e2e-cdp.pptx / out/e2e.html / out/e2e-report.json
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const REPO = path.resolve(ROOT, '..', '..')
const outDir = path.join(ROOT, 'out')
fs.mkdirSync(outDir, { recursive: true })

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const exe = path.resolve(arg('exe', path.join(REPO, 'server', 'target', 'release', 'MarpWorkbench.exe')))
const format = arg('format', 'png')
const report = { ok: false, exe, format, checks: [] }
const check = (name, ok, detail = '') => {
  report.checks.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
  return ok
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!fs.existsSync(exe)) {
  console.error(`未找到 exe: ${exe}（先 cargo build --release）`)
  process.exit(2)
}
const render = JSON.parse(fs.readFileSync(path.join(outDir, 'render.json'), 'utf8'))

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwb-e2e-'))
const env = { ...process.env, MWB_DATA_DIR: dataDir, MWB_NO_OPEN: '1' }
const child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let stdout = ''
let stderr = ''
child.stdout.on('data', (d) => (stdout += d.toString()))
child.stderr.on('data', (d) => (stderr += d.toString()))

async function waitListen(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const mUrl = stdout.match(/MWB_LISTEN_URL=(\S+)/)
    const mTok = stdout.match(/MWB_TOKEN=(\S+)/)
    if (mUrl && mTok) return { base: mUrl[1].replace(/\/$/, ''), token: mTok[1] }
    await sleep(100)
  }
  throw new Error(`等待服务启动超时 stdout=${stdout.slice(-600)} stderr=${stderr.slice(-600)}`)
}

async function api(base, token, p, init = {}) {
  const res = await fetch(base + '/api' + p, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-MWB-Token': token, ...(init.headers || {}) }
  })
  let json = null
  const text = await res.text()
  try {
    json = JSON.parse(text)
  } catch {
    /* 二进制 */
  }
  return { status: res.status, json, text, headers: res.headers }
}

async function download(base, token, url, outFile) {
  const res = await fetch(base + url, { headers: { 'X-MWB-Token': token } })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(outFile, buf)
  return { bytes: buf.length, disposition: res.headers.get('content-disposition') || '' }
}

const t0 = Date.now()
try {
  const { base, token } = await waitListen()
  check('exe 启动 + 读取 MWB_LISTEN_URL/MWB_TOKEN', true, base)

  // ---------- PDF ----------
  const tPdf = Date.now()
  const pdf = await api(base, token, '/export/pdf', {
    method: 'POST',
    body: JSON.stringify({
      html: render.html,
      css: render.css,
      title: '导出管线实测',
      width: render.width,
      height: render.height
    })
  })
  const pdfMs = Date.now() - tPdf
  check('POST /api/export/pdf 200', pdf.status === 200, JSON.stringify(pdf.json).slice(0, 300))
  if (pdf.status === 200) {
    const dl = await download(base, token, pdf.json.fileUrl, path.join(outDir, 'e2e.pdf'))
    check('PDF 下载成功（带 token）', dl.bytes > 20000, `${dl.bytes} B, ms=${pdfMs}`)
    check('PDF pages 字段=3', pdf.json.pages === 3, `pages=${pdf.json.pages}`)
    check('Content-Disposition 含 filename*', /filename\*=UTF-8/i.test(dl.disposition), dl.disposition)
    const verify = spawnSync(process.execPath, [path.join(__dirname, 'verify-pdf.mjs'), path.join(outDir, 'e2e.pdf'), '--pages', '3'], {
      encoding: 'utf8'
    })
    const vjson = JSON.parse(verify.stdout || '{}')
    check('PDF 3 页 / 960×540pt / 中文 / 无页眉页脚', vjson.ok === true, JSON.stringify({
      pages: vjson.pdfPages,
      sizes: vjson.pageSizes?.[0],
      cjk: vjson.cjkChars,
      headerFooter: vjson.hasHeaderFooter
    }))
    report.pdf = { ...pdf.json, verified: vjson.ok, ms: pdfMs, bytes: dl.bytes }
  }

  // ---------- capture + PPTX ----------
  const tCap = Date.now()
  const cap = await api(base, token, '/export/capture', {
    method: 'POST',
    body: JSON.stringify({
      html: render.html,
      css: render.css,
      width: render.width,
      height: render.height,
      scale: 2,
      slideCount: render.slides,
      format
    })
  })
  const capMs = Date.now() - tCap
  check('POST /api/export/capture 200', cap.status === 200, JSON.stringify(cap.json).slice(0, 400))
  if (cap.status === 200) {
    check('capture 走 CDP 原生通道（非降级）', cap.json.fallback === false, `mode=${cap.json.mode} reason=${cap.json.reason || ''}`)
    check('capture 返回 3 张 2x 图', cap.json.images?.length === 3 && cap.json.images.every((i) => i.w === 2560 && i.h === 1440), JSON.stringify(cap.json.images?.map((i) => `${i.w}x${i.h}`)))
    const files = []
    for (const img of cap.json.images || []) {
      const f = path.join(outDir, `e2e-cdp-slide-${img.index + 1}.${format === 'jpeg' ? 'jpg' : 'png'}`)
      const dl = await download(base, token, img.url, f)
      files.push({ file: f, bytes: dl.bytes })
    }
    check('截图下载成功', files.length === 3, JSON.stringify(files.map((f) => f.bytes)))
    report.capture = { ...cap.json, ms: capMs, files }

    // pptxgenjs 组装（模拟前端 ExportPanel 的流程）
    const { default: PptxGenJS } = await import('pptxgenjs')
    const pptx = new PptxGenJS()
    pptx.author = 'MarpWorkbench'
    pptx.defineLayout({ name: 'MWB', width: 1280 / 96, height: 720 / 96 })
    pptx.layout = 'MWB'
    const comments = render.comments || []
    cap.json.images.forEach((img, i) => {
      const dataUrl = `data:image/${format === 'jpeg' ? 'jpeg' : 'png'};base64,${fs.readFileSync(files[i].file).toString('base64')}`
      const slide = pptx.addSlide()
      slide.background = { data: dataUrl }
      if (comments[i]) slide.addNotes(comments[i])
    })
    const pptxPath = path.join(outDir, 'e2e-cdp.pptx')
    await pptx.writeFile({ fileName: pptxPath })
    check('pptxgenjs 组装 PPTX', fs.statSync(pptxPath).size > 100000, `${fs.statSync(pptxPath).size} B`)
    const inspect = spawnSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'inspect-pptx.ps1'), '-Pptx', pptxPath, '-WorkDir', path.join(outDir, 'e2e-unpacked')], { encoding: 'utf8' })
    const ijson = JSON.parse(inspect.stdout || '{}')
    check(
      'PPTX 解包校验：3 页 / sldSz 12192000×6858000 / 备注 / 背景图',
      ijson.slideCount === 3 && ijson.sldSz?.cx === '12192000' && ijson.notes?.length === 3 && ijson.media?.every((m) => m.w === 2560 && m.h === 1440),
      JSON.stringify({ sldSz: ijson.sldSz, notes: ijson.notes?.length, media: ijson.media?.map((m) => `${m.w}x${m.h}`) })
    )
    report.pptx = { file: pptxPath, bytes: fs.statSync(pptxPath).size, inspect: ijson }
  }

  // ---------- HTML ----------
  const html = await api(base, token, '/export/html', {
    method: 'POST',
    body: JSON.stringify({ html: render.html, css: render.css, title: '导出管线实测' })
  })
  check('POST /api/export/html 200', html.status === 200, JSON.stringify(html.json).slice(0, 200))
  if (html.status === 200) {
    const f = path.join(outDir, 'e2e.html')
    const dl = await download(base, token, html.json.fileUrl, f)
    const text = fs.readFileSync(f, 'utf8')
    // 无外网子资源（bundle 内部 JS 字符串里可能含 https 文本，但不应出现在 src/href/@import 属性中）
    const externalSubresource = /(?:src|href)\s*=\s*["']https?:\/\//i.test(text) || /@import\s+(?:url\()?["']?https?:\/\//i.test(text)
    check(
      'HTML 单文件：内联主题 CSS + helper + viewer + 无外网子资源',
      dl.bytes > 15000 && text.includes('@page') && text.includes('mwb-bar') && text.includes('marp-core') && !externalSubresource,
      `${dl.bytes} B, externalSubresource=${externalSubresource}`
    )
    report.html = { ...html.json, bytes: dl.bytes }
  }

  // ---------- 清理/安全 ----------
  const bad = await api(base, token, '/export/file/..%2F..%2Fsettings.json')
  check('导出文件路径穿越被拒绝', bad.status === 400 || bad.status === 404, `status=${bad.status}`)
  const staleTmp = await api(base, token, '/export/tmp/deadbeefdeadbeef/slide-99.png')
  check('过期/不存在截图返回 404', staleTmp.status === 404, `status=${staleTmp.status}`)
  const badName = await api(base, token, '/export/tmp/deadbeefdeadbeef/evil.exe')
  check('非法截图文件名返回 400', badName.status === 400, `status=${badName.status}`)

  await api(base, token, '/shutdown', { method: 'POST' }).catch(() => null)
  const exited = await new Promise((r) => {
    child.once('exit', () => r(true))
    setTimeout(() => r(false), 8000)
  })
  check('退出应用（/api/shutdown）', exited)

  report.ok = report.checks.every((c) => c.ok)
} catch (err) {
  check('E2E 执行', false, String(err?.stack || err))
} finally {
  try {
    child.kill()
  } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true })
  report.totalMs = Date.now() - t0
  fs.writeFileSync(path.join(outDir, 'e2e-report.json'), JSON.stringify(report, null, 2))
  const failed = report.checks.filter((c) => !c.ok)
  console.log(`\n[e2e] ${report.checks.length - failed.length}/${report.checks.length} 通过，耗时 ${report.totalMs}ms`)
  if (!report.ok) process.exit(1)
}
