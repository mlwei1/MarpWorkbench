#!/usr/bin/env node
/**
 * M5.1 验收：CLI `--export`（md → pptx / pptx-editable / pdf / html）
 *
 * 真实 exe；每个格式独立临时数据目录；PPTX 用 python-pptx 校验；PDF/HTML 校验文件头/内容。
 * 用法：node scripts/verify-cli.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve('.')
const exe = join(ROOT, 'server/target/release/MarpWorkbench.exe')
const fixture = join(ROOT, 'scripts/fixtures/cli-demo.md')
const PYTHON = [
  'C:\\Users\\52900\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe',
  'python',
].find((p) => p === 'python' || existsSync(p))
const checkEditable = join(ROOT, 'scripts/dev/check-editable-pptx.py')

const results = []
const log = (...a) => console.log(...a)
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

function runCli(args, { dataDir, timeout = 240000 } = {}) {
  const env = { ...process.env }
  if (dataDir) env.MWB_DATA_DIR = dataDir
  const started = Date.now()
  const r = spawnSync(exe, args, { encoding: 'utf8', timeout, env, windowsHide: true })
  return { ...r, ms: Date.now() - started }
}

function lastJson(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i])
      if (j && typeof j === 'object') return j
    } catch {
      /* ignore */
    }
  }
  return null
}

function pythonPptxInfo(path) {
  const code = `import json,sys
from pptx import Presentation
p=Presentation(sys.argv[1]); s=list(p.slides)
print(json.dumps({"slides":len(s),"w":round(p.slide_width/914400.0,3),"h":round(p.slide_height/914400.0,3),"notes":sum(1 for x in s if x.has_notes_slide and (x.notes_slide.notes_text_frame.text or '').strip())}))`
  const r = spawnSync(PYTHON, ['-c', code, path], { encoding: 'utf8', timeout: 120000 })
  try {
    return JSON.parse(r.stdout.trim().split('\n').pop())
  } catch {
    return { error: (r.stdout || '') + (r.stderr || '') }
  }
}

const work = mkdtempSync(join(tmpdir(), 'mwb-cli-'))
const outDir = join(work, 'out')
mkdirSync(outDir, { recursive: true })

try {
  check('exe 存在', existsSync(exe), exe)
  check('fixture 存在', existsSync(fixture), fixture)

  // --help / --version
  const help = runCli(['--help'], { timeout: 30000 })
  check('--help 输出用法', help.status === 0 && /--export/.test(help.stdout + help.stderr) && /--format/.test(help.stdout + help.stderr), (help.stdout || help.stderr || '').slice(0, 120))
  const ver = runCli(['--version'], { timeout: 30000 })
  check('--version 输出', ver.status === 0 && /MarpWorkbench\s+0\.4\.0/.test(ver.stdout), (ver.stdout || '').trim())

  // 1) 可编辑 PPTX
  {
    const dataDir = mkdtempSync(join(tmpdir(), 'mwb-cli-data-'))
    const out = join(outDir, 'cli-editable.pptx')
    const r = runCli(['--export', fixture, '--format', 'pptx-editable', '--out', out], { dataDir })
    const j = lastJson(r.stdout)
    check('CLI pptx-editable 退出 0', r.status === 0, (r.stderr || '').slice(-200))
    check('CLI pptx-editable JSON ok', j?.ok === true && existsSync(out), JSON.stringify(j || {}).slice(0, 200))
    if (existsSync(out)) {
      const size = statSync(out).size
      check('可编辑 PPTX 文件 >100KB', size > 100 * 1024, `${(size / 1024).toFixed(0)}KB`)
      const py = spawnSync(PYTHON, [checkEditable, out, '--slides', '10', '--width-in', '13.333', '--height-in', '7.5', '--require-tables', '1', '--min-text-chars', '150'], { encoding: 'utf8', timeout: 120000 })
      let po = null
      try {
        po = JSON.parse(py.stdout.trim().split('\n').pop())
      } catch {
        po = null
      }
      check('可编辑 PPTX python-pptx 校验', py.status === 0 && po?.ok === true, po ? JSON.stringify({ slides: po.slide_count, tables: po.tables, bg: po.bg_blip_slides }) : (py.stderr || '').slice(0, 200))
      const info = pythonPptxInfo(out)
      check('可编辑 PPTX 10 页 + notes', info?.slides === 10 && info?.notes >= 1, JSON.stringify(info))
    }
  }

  // 2) 图片版 PPTX
  {
    const dataDir = mkdtempSync(join(tmpdir(), 'mwb-cli-data-'))
    const out = join(outDir, 'cli-image.pptx')
    const r = runCli(['--export', fixture, '--format', 'pptx', '--out', out], { dataDir })
    const j = lastJson(r.stdout)
    check('CLI pptx 退出 0', r.status === 0, (r.stderr || '').slice(-200))
    check('CLI pptx JSON ok + 文件', j?.ok === true && existsSync(out), JSON.stringify(j || {}).slice(0, 200))
    if (existsSync(out)) {
      const info = pythonPptxInfo(out)
      check('图片版 PPTX 可打开且 10 页', info?.slides === 10, JSON.stringify(info))
    }
  }

  // 3) PDF
  {
    const dataDir = mkdtempSync(join(tmpdir(), 'mwb-cli-data-'))
    const out = join(outDir, 'cli.pdf')
    const r = runCli(['--export', fixture, '--format', 'pdf', '--out', out], { dataDir })
    const j = lastJson(r.stdout)
    const buf = existsSync(out) ? readFileSync(out) : Buffer.alloc(0)
    const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length
    check('CLI pdf 退出 0', r.status === 0, (r.stderr || '').slice(-200))
    check('CLI pdf 文件头 %PDF', buf.length > 4 && buf.subarray(0, 4).toString() === '%PDF', `${(buf.length / 1024).toFixed(0)}KB`)
    check('CLI pdf 页数 10', pages === 10, `pages=${pages}`)
    check('CLI pdf JSON ok', j?.ok === true, JSON.stringify(j || {}).slice(0, 200))
  }

  // 4) HTML
  {
    const dataDir = mkdtempSync(join(tmpdir(), 'mwb-cli-data-'))
    const out = join(outDir, 'cli.html')
    const r = runCli(['--export', fixture, '--format', 'html', '--out', out], { dataDir })
    const j = lastJson(r.stdout)
    const html = existsSync(out) ? readFileSync(out, 'utf8') : ''
    check('CLI html 退出 0', r.status === 0, (r.stderr || '').slice(-200))
    check('CLI html 内容含幻灯片', html.includes('<html') && (html.includes('data-marpit-svg') || html.includes('marpit')), `bytes=${html.length}`)
    check('CLI html JSON ok', j?.ok === true, JSON.stringify(j || {}).slice(0, 200))
  }

  // 5) 错误路径
  {
    const dataDir = mkdtempSync(join(tmpdir(), 'mwb-cli-data-'))
    const r = runCli(['--export', join(work, 'not-exists.md'), '--format', 'pptx'], { dataDir, timeout: 60000 })
    check('不存在的输入文件 → 退出 1 + 可读错误', r.status === 1 && /不存在|not found|错误/i.test(r.stdout + r.stderr), (r.stdout + r.stderr).slice(-160))
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n[CLI] ${results.length - failed.length}/${results.length} 通过`)
  console.log(`输出目录: ${outDir}`)
  process.exit(failed.length ? 1 : 0)
} catch (e) {
  check('CLI 验收执行', false, String(e?.stack || e))
  const failed = results.filter((r) => !r.ok)
  console.log(`\n[CLI] ${results.length - failed.length}/${results.length} 通过`)
  process.exit(1)
}
