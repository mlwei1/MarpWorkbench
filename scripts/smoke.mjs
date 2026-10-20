#!/usr/bin/env node
/**
 * M1 集成冒烟脚本（Lead 用）
 *
 * 用法：
 *   node scripts/smoke.mjs                     # 用默认构建产物
 *   node scripts/smoke.mjs --exe <path>        # 指定 exe
 *   node scripts/smoke.mjs --keep              # 保留临时数据目录便于排查
 *
 * 覆盖：启动(无浏览器) → /api/health → 新建 deck → 保存(ifRev) → 读回 → 主题列表 →
 *       字体/资源 → 导出 PDF（校验页数/大小/尺寸字段）→ 退出。
 * 不覆盖：PPTX 组装（需要浏览器端 pptxgenjs，M1 用 Playwright E2E 单独验）。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const getArg = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const exe = resolve(getArg('--exe', 'server/target/release/MarpWorkbench.exe'))
const keep = args.includes('--keep')

if (!existsSync(exe)) {
  console.error(`[smoke] 未找到 exe: ${exe}（先运行 pnpm run build:server）`)
  process.exit(1)
}

const dataDir = mkdtempSync(join(tmpdir(), 'mwb-smoke-'))
const env = { ...process.env, MWB_DATA_DIR: dataDir, MWB_NO_OPEN: '1' }
const t0 = Date.now()
const child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let stdout = ''
let stderr = ''
child.stdout.on('data', (d) => (stdout += d.toString()))
child.stderr.on('data', (d) => (stderr += d.toString()))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
  return ok
}

async function waitForListen(timeoutMs = 30000) {
  const start = Date.now()
  let url = null
  let token = null
  while (Date.now() - start < timeoutMs) {
    const mUrl = stdout.match(/MWB_LISTEN_URL=(\S+)/)
    const mTok = stdout.match(/MWB_TOKEN=(\S+)/)
    if (mUrl) url = mUrl[1]
    if (mTok) token = mTok[1]
    if (url && token) return { url, token }
    await sleep(100)
  }
  throw new Error(`等待服务启动超时。stdout=${stdout.slice(-800)} stderr=${stderr.slice(-800)}`)
}

async function api(base, token, path, opts = {}) {
  const res = await fetch(`${base}/api${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-MWB-Token': token, ...(opts.headers || {}) },
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON（文件下载） */
  }
  return { status: res.status, json, text, headers: res.headers }
}

try {
  const { url, token } = await waitForListen()
  check('服务启动 + 监听 URL/TOKEN 输出', true, `${url} (${Date.now() - t0}ms)`)

  const health = await api(url, token, '/health')
  check('/api/health 200', health.status === 200 && health.json?.ok === true, JSON.stringify(health.json))

  const created = await api(url, token, '/decks', {
    method: 'POST',
    body: JSON.stringify({ name: '冒烟测试-deck', template: 'title' }),
  })
  const deckId = created.json?.id
  check('新建 deck', created.status === 200 && !!deckId, deckId)

  const md = [
    '---',
    'marp: true',
    'theme: business-blue',
    'paginate: true',
    'size: 16:9',
    '---',
    '',
    '# 冒烟测试',
    '',
    '## 中文标题与代码',
    '',
    '```js',
    'console.log("hello 世界")',
    '```',
    '',
    '---',
    '',
    '# 第二页',
    '',
    '| A | B |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '---',
    '',
    '# 第三页',
  ].join('\n')

  const saved = await api(url, token, `/decks/${encodeURIComponent(deckId)}`, {
    method: 'PUT',
    body: JSON.stringify({ content: md }),
  })
  check('保存 deck（PUT）', saved.status === 200 && saved.json?.rev, JSON.stringify(saved.json))

  const read = await api(url, token, `/decks/${encodeURIComponent(deckId)}`)
  check('读回 deck 内容一致', read.status === 200 && read.json?.content === md)

  const stale = await api(url, token, `/decks/${encodeURIComponent(deckId)}`, {
    method: 'PUT',
    body: JSON.stringify({ content: md, ifRev: 'deadbeefdeadbeef' }),
  })
  check('ifRev 冲突返回 409', stale.status === 409, `status=${stale.status}`)

  const themes = await api(url, token, '/themes')
  const themeCount = themes.json?.themes?.length ?? 0
  check('主题列表非空', themes.status === 200 && themeCount > 0, `${themeCount} 个主题`)

  const settings = await api(url, token, '/settings')
  check('settings 可读', settings.status === 200 && typeof settings.json?.workspaceRoot === 'string')

  // 用与 marp-core 输出同构的 HTML（div.marpit > svg[data-marpit-svg]）验证 PDF/capture 通道。
  // 真实 HTML 由前端 marp-core 渲染后 POST；这里模拟结构以便打印分页 CSS 生效。
  const slide = (n, body) =>
    `<svg data-marpit-svg viewBox="0 0 1280 720" xmlns="http://www.w3.org/2000/svg">` +
    `<foreignObject width="1280" height="720">` +
    `<section xmlns="http://www.w3.org/1999/xhtml" style="width:1280px;height:720px;box-sizing:border-box;padding:60px;font-family:'Microsoft YaHei';background:#ffffff;color:#1a2233">` +
    `<h1>${n}</h1>${body}</section></foreignObject></svg>`
  const html =
    '<div class="marpit">' +
    slide('冒烟测试', '<p>中文 hello</p>') +
    slide('第二页', '<table border="1"><tr><td>A</td><td>B</td></tr></table>') +
    slide('第三页', '<pre><code>console.log("hi")</code></pre>') +
    '</div>'
  const css = 'section{background:#fff;color:#1a2233}'
  const pdf = await api(url, token, '/export/pdf', {
    method: 'POST',
    body: JSON.stringify({ html, css, title: '冒烟测试', width: 1280, height: 720 }),
    timeout: 120000,
  })
  const fileUrl = pdf.json?.fileUrl
  let pdfBytes = 0
  let pdfHead = ''
  if (fileUrl) {
    const res = await fetch(url + fileUrl, { headers: { 'X-MWB-Token': token } })
    const buf = Buffer.from(await res.arrayBuffer())
    pdfBytes = buf.length
    pdfHead = buf.subarray(0, 8).toString('latin1')
  }
  check(
    '导出 PDF 成功',
    pdf.status === 200 && pdfBytes > 20000 && pdfHead.startsWith('%PDF'),
    `pages=${pdf.json?.pages} bytes=${pdfBytes} file=${fileUrl}`,
  )
  check('PDF 页数=3', pdf.json?.pages === 3, `pages=${pdf.json?.pages}`)

  // capture（PPTX 图片源）：3 页 → 3 张图，且能取回位图字节
  const cap = await api(url, token, '/export/capture', {
    method: 'POST',
    body: JSON.stringify({ html, css, width: 1280, height: 720, scale: 2, slideCount: 3 }),
    timeout: 180000,
  })
  const images = cap.json?.images ?? []
  let imgMagic = ''
  let imgBytes = 0
  if (images.length) {
    const res = await fetch(url + images[0].url, { headers: { 'X-MWB-Token': token } })
    const buf = Buffer.from(await res.arrayBuffer())
    imgBytes = buf.length
    imgMagic = buf.subarray(0, 4).toString('hex')
  }
  check(
    'capture 逐页截图（PPTX 用）',
    cap.status === 200 && images.length === 3 && imgBytes > 5000,
    `images=${images.length} first=${imgBytes}B magic=${imgMagic} format=${cap.json?.format ?? 'png'}`,
  )

  // 退出
  await api(url, token, '/shutdown', { method: 'POST' }).catch(() => null)
  const exited = await new Promise((r) => {
    child.once('exit', () => r(true))
    setTimeout(() => r(false), 8000)
  })
  check('退出应用（/api/shutdown）', exited)
} catch (e) {
  check('冒烟脚本执行', false, String(e?.stack || e))
} finally {
  try {
    child.kill()
  } catch {
    /* ignore */
  }
  if (!keep) rmSync(dataDir, { recursive: true, force: true })
  else console.log(`[smoke] 保留数据目录: ${dataDir}`)

  const failed = results.filter((r) => !r.ok)
  console.log(`\n[smoke] ${results.length - failed.length}/${results.length} 通过，耗时 ${Date.now() - t0}ms`)
  if (failed.length) process.exit(1)
}
