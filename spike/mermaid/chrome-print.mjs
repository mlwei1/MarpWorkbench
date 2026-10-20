// 无头 Chrome --print-to-pdf 小工具（参数与 server/src/export/pdf.rs 一致）
// 用法：import { findChrome, runChromePrint } from './chrome-print.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean)
  const found = candidates.find((p) => fs.existsSync(p))
  if (!found) throw new Error('未找到 Chrome/Edge，可设置 CHROME_PATH')
  return found
}

/**
 * @param {{url:string, pdfPath:string, chromePath?:string, extraArgs?:string[], timeoutMs?:number}} opts
 * @returns {Promise<{code:number|null, pdfReadyMs:number|null, exitMs:number, pdfExists:boolean, stderrTail:string}>}
 */
export function runChromePrint({ url, pdfPath, chromePath = findChrome(), extraArgs = [], timeoutMs = 120000 }) {
  return new Promise((resolve) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mwb-mermaid-print-'))
    if (fs.existsSync(pdfPath)) fs.rmSync(pdfPath)
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-breakpad',
      `--user-data-dir=${profile}`,
      `--print-to-pdf=${pdfPath}`,
      '--no-pdf-header-footer',
      '--virtual-time-budget=8000',
      ...extraArgs,
      url,
    ]
    const t0 = Date.now()
    const child = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d.toString()))
    // 与 server/src/export/pdf.rs 相同：PDF「存在且大小稳定 400ms」即视为打印完成；
    // Chrome 打印完可能不立刻退出，因此主动 kill（避免误等几十秒）。
    let stable = null
    let lastSize = -1
    let lastChange = 0
    const poll = setInterval(() => {
      try {
        if (!fs.existsSync(pdfPath)) return
        const size = fs.statSync(pdfPath).size
        if (size <= 0) return
        if (size !== lastSize) {
          lastSize = size
          lastChange = Date.now()
        } else if (!stable && Date.now() - lastChange >= 400) {
          stable = { size, ms: Date.now() - t0 }
          clearInterval(poll)
          setTimeout(() => {
            try { child.kill() } catch {}
          }, 500)
        }
      } catch {}
    }, 100)
    const timeout = setTimeout(() => {
      clearInterval(poll)
      try { child.kill() } catch {}
    }, timeoutMs)
    child.on('exit', (code) => {
      clearInterval(poll)
      clearTimeout(timeout)
      try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
      resolve({
        code,
        exitMs: Date.now() - t0,
        pdfReadyMs: stable ? stable.ms : null,
        pdfExists: fs.existsSync(pdfPath),
        stderrTail: stderr.slice(-800),
      })
    })
  })
}
