// 真实服务主题 API 冒烟：启动 exe（隔离临时数据目录）→ 导入/读取/保存/删除主题
// 运行：node spike/themes/api-smoke.mjs [--exe path] [--keep]
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const getArg = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const exe = resolve(getArg('--exe', 'server/target/release/MarpWorkbench.exe'))
if (!existsSync(exe)) {
  console.error(`找不到 exe：${exe}`)
  process.exit(1)
}
const dataDir = mkdtempSync(join(tmpdir(), 'mwb-theme-smoke-'))
const child = spawn(exe, [], {
  env: { ...process.env, MWB_DATA_DIR: dataDir, MWB_NO_OPEN: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stdout = ''
let stderr = ''
child.stdout.on('data', (d) => (stdout += d.toString()))
child.stderr.on('data', (d) => (stderr += d.toString()))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`)
}

async function waitForListen(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const mUrl = stdout.match(/MWB_LISTEN_URL=(\S+)/)
    const mTok = stdout.match(/MWB_TOKEN=(\S+)/)
    if (mUrl && mTok) return { base: mUrl[1].replace(/\/$/, ''), token: mTok[1] }
    await sleep(100)
  }
  throw new Error(`服务启动超时。stdout=${stdout.slice(-800)} stderr=${stderr.slice(-800)}`)
}

async function api(base, token, path, opts = {}) {
  const res = await fetch(`${base}/api${path}`, {
    ...opts,
    headers: { 'X-MWB-Token': token, ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${text.slice(0, 300)}`)
  const type = res.headers.get('content-type') || ''
  return type.includes('json') ? JSON.parse(text) : text
}

const THEME_CSS = `/*
 * @theme m2-api-smoke
 * @name M2 API Smoke
 * @tags test,api,smoke
 * @size 16:9 1280px 720px
 * @auto-scaling true
 */
@import 'default';

section { background: #ffffff; color: #111111; font-size: 28px; }
section.lead { background: #eef2ff; }
section h1 { color: #1e3a8a; }
section pre { background: #0f172a; color: #e2e8f0; }
section table th { background: #e0e7ff; }
section blockquote { border-left: 4px solid #6366f1; }
`
const THEME_CSS_SAVED = THEME_CSS.replace('#1e3a8a', '#7c3aed')

try {
  const { base, token } = await waitForListen()
  const mode = await api(base, token, '/health').catch(() => null)
  check('服务启动 + /api/health', !!mode?.ok, base)

  const list0 = await api(base, token, '/themes')
  check(
    'GET /api/themes（内置主题列表）',
    Array.isArray(list0.themes) && list0.themes.length >= 6,
    `count=${list0.themes.length}：[${list0.themes.map((t) => t.name).join(', ')}]`,
  )
  const builtin = list0.themes.filter((t) => t.source === 'builtin').map((t) => t.name)
  check('内置主题元信息解析（displayName/tags/size）', list0.themes.some((t) => t.displayName && t.tags?.length && t.size?.length), `builtin=${builtin.length}`)

  const created = await api(base, token, '/themes', {
    method: 'POST',
    body: JSON.stringify({ css: THEME_CSS, fileName: 'm2-api-smoke.css' }),
  })
  check(
    'POST /api/themes 导入主题',
    created.name === 'm2-api-smoke' && created.source === 'user',
    `name=${created.name} displayName=${created.displayName} tags=${JSON.stringify(created.tags)}`,
  )

  const css1 = await api(base, token, '/themes/m2-api-smoke/css')
  check('GET /api/themes/:name/css', typeof css1 === 'string' && css1.includes('@theme m2-api-smoke'), `bytes=${css1.length}`)

  const saved = await api(base, token, '/themes/m2-api-smoke', {
    method: 'PUT',
    body: JSON.stringify({ css: THEME_CSS_SAVED }),
  })
  check('PUT /api/themes/:name 保存修改', saved.name === 'm2-api-smoke', `displayName=${saved.displayName}`)
  const css2 = await api(base, token, '/themes/m2-api-smoke/css')
  check('保存后读取生效', typeof css2 === 'string' && css2.includes('#7c3aed'), 'contains #7c3aed')

  // 冲突/非法主题：缺少 @theme 应 400
  let badOk = false
  try {
    await api(base, token, '/themes', { method: 'POST', body: JSON.stringify({ css: 'section { color: red; }' }) })
  } catch (e) {
    badOk = /HTTP 400/.test(String(e.message))
  }
  check('非法 CSS（缺 @theme）被拒绝 400', badOk)

  const del = await api(base, token, '/themes/m2-api-smoke', { method: 'DELETE' })
  check('DELETE /api/themes/:name', del.ok === true, 'ok')
  const list2 = await api(base, token, '/themes')
  check('删除后不在列表', !list2.themes.some((t) => t.name === 'm2-api-smoke'), `count=${list2.themes.length}`)
} catch (e) {
  check('真实服务主题 API 冒烟', false, String(e?.message ?? e))
} finally {
  child.kill()
  await sleep(400)
  if (args.includes('--keep')) {
    console.log(`\n数据目录保留：${dataDir}`)
  } else {
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
}
