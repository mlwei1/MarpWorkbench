// Minimal Electron 44 spike: render a Marp-style deck in a hidden BrowserWindow
// and export "one slide per PDF page" via webContents.printToPDF().
//
// Run: pnpm export
// Output: spike/packaging/out/deck.pdf + out/export-report.json
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.disableHardwareAcceleration()

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'out')

function writeReport(obj) {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'export-report.json'), JSON.stringify(obj, null, 2))
}

async function exportPdf() {
  const t0 = Date.now()
  const win = new BrowserWindow({
    show: false, // 隐藏窗口导出：不弹窗、不抢焦点
    width: 1280,
    height: 720,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false
    }
  })

  const deckPath = path.join(ROOT, 'slides', 'deck.html')
  await win.loadFile(deckPath)

  // 等字体/布局稳定（真实产品用 document.fonts.ready + 自定义事件，这里给 300ms 兜底）
  await new Promise((r) => setTimeout(r, 300))

  const tPrint = Date.now()
  // 关键参数（Electron 44）：
  //  preferCSSPageSize: true -> 尺寸取 HTML 的 @page { size: 1280px 720px }
  //  printBackground: true  -> 保留背景色/渐变（Marp 主题必备）
  //  margins: 0             -> 去掉打印机默认页边距，否则每页 slide 会被缩放/留白
  const pdf = await win.webContents.printToPDF({
    printBackground: true,
    preferCSSPageSize: true,
    pageSize: { width: 13.333333, height: 7.5 }, // inches，preferCSSPageSize 失效时兜底
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    landscape: false,
    scale: 1
  })
  const printMs = Date.now() - tPrint

  const pdfPath = path.join(OUT_DIR, 'deck.pdf')
  fs.writeFileSync(pdfPath, pdf)

  const report = {
    ok: true,
    pdfPath,
    bytes: pdf.length,
    printToPDF_ms: printMs,
    total_ms: Date.now() - t0,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }
  }
  writeReport(report)
  console.log(JSON.stringify(report))
  win.destroy()
}

// 100+ 页 deck 的整页批量导出思路：同一个隐藏窗口里逐 deck 导出即可，
// 不要为每一页新建窗口（启动/销毁窗口是主要开销）。这里仅导出 3 页。
app.whenReady().then(async () => {
  try {
    await exportPdf()
    app.exit(0)
  } catch (err) {
    writeReport({ ok: false, error: String((err && err.stack) || err) })
    console.error('EXPORT_FAILED', err)
    app.exit(1)
  }
})
