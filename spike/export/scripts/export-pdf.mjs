/**
 * 无头 Chrome/Edge --print-to-pdf 实测脚本（Rust 实现的行为基准）。
 *
 * 复现命令：
 *   node scripts/export-pdf.mjs --browser=chrome --in=out/print.html --out=out/export-chrome.pdf
 *   node scripts/export-pdf.mjs --browser=edge   --in=out/print.html --out=out/export-edge.pdf
 *
 * 关键实现（与 docs/research/desktop-packaging.md §1.4 一致）：
 * - 每次导出独立 --user-data-dir 临时目录
 * - 显式 --no-pdf-header-footer + --virtual-time-budget
 * - 轮询 PDF「存在且大小稳定 ≥300ms」；Edge 打印完不退出 → taskkill /T /F
 * - 超时 60s
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const outDir = path.join(ROOT, 'out')

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const browserName = arg('browser', 'chrome')
const inputFile = path.resolve(arg('in', path.join(outDir, 'print.html')))
const outputFile = path.resolve(arg('out', path.join(outDir, `export-${browserName}.pdf`)))
const timeoutMs = Number(arg('timeout', '60000'))

function findBrowser(name) {
  const candidates = {
    chrome: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe')
    ],
    edge: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ]
  }[name]
  for (const c of candidates || []) if (fs.existsSync(c)) return c
  // App Paths 注册表兜底
  const exe = name === 'edge' ? 'msedge.exe' : 'chrome.exe'
  for (const hive of ['HKLM', 'HKCU']) {
    try {
      const key = `SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`
      const out = execFileSync('reg', ['query', `${hive}\\${key}`, '/ve'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      const m = out.match(/REG_SZ\s+"?([^"\r\n]+)"?/)
      if (m && fs.existsSync(m[1].trim())) return m[1].trim()
    } catch {}
  }
  return null
}

function killTree(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {}
}

const browserPath = findBrowser(browserName)
if (!browserPath) {
  console.error(JSON.stringify({ ok: false, error: `未找到 ${browserName}` }))
  process.exit(2)
}
if (!fs.existsSync(inputFile)) {
  console.error(JSON.stringify({ ok: false, error: `输入 HTML 不存在: ${inputFile}` }))
  process.exit(2)
}

fs.mkdirSync(path.dirname(outputFile), { recursive: true })
const profileDir = path.join(outDir, `profile-${browserName}-${Date.now().toString(36)}`)
fs.rmSync(outputFile, { force: true })

const fileUrl = pathToFileURL(inputFile).href
const args = [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--no-pdf-header-footer',
  '--virtual-time-budget=8000',
  `--user-data-dir=${profileDir}`,
  '--disable-extensions',
  '--disable-sync',
  '--disable-background-networking',
  '--mute-audio',
  `--print-to-pdf=${outputFile}`,
  fileUrl
]

const t0 = Date.now()
const child = spawn(browserPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''
child.stderr.on('data', (d) => {
  if (stderr.length < 4000) stderr += d.toString()
})
let exited = false
let exitCode = null
child.on('exit', (code) => {
  exited = true
  exitCode = code
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let lastSize = -1
let stableSince = null
let result = null
while (Date.now() - t0 < timeoutMs) {
  await sleep(100)
  let size = 0
  try {
    size = fs.statSync(outputFile).size
  } catch {}
  if (size > 0) {
    if (size !== lastSize) {
      lastSize = size
      stableSince = Date.now()
    } else if (stableSince && Date.now() - stableSince >= 300) {
      result = { ok: true, bytes: size }
      break
    }
  } else if (exited) {
    // 进程退出但没有 PDF：再等 300ms 允许落盘延迟
    await sleep(300)
    if (fs.existsSync(outputFile)) {
      result = { ok: true, bytes: fs.statSync(outputFile).size }
    } else {
      result = { ok: false, error: 'browser 已退出但未生成 PDF', exitCode, stderr: stderr.slice(0, 1200) }
    }
    break
  }
}
const ms = Date.now() - t0

let killed = false
if (!exited) {
  killTree(child.pid)
  killed = true
}
await new Promise((r) => {
  if (exited) r()
  else {
    child.on('exit', r)
    setTimeout(r, 3000)
  }
})
try {
  fs.rmSync(profileDir, { recursive: true, force: true })
} catch {}

if (!result) {
  result = { ok: false, error: `超时 ${timeoutMs}ms 未生成 PDF`, timeout: true, stderr: stderr.slice(0, 1200) }
}
console.log(
  JSON.stringify(
    {
      ...result,
      browser: browserName,
      browserPath,
      headlessFlag: '--headless=new',
      inputFile,
      outputFile,
      ms,
      killed,
      exitCode,
      stderr: stderr.slice(0, 1200),
      pdfBytes: fs.existsSync(outputFile) ? fs.statSync(outputFile).size : 0
    },
    null,
    2
  )
)
if (!result.ok) process.exit(1)
