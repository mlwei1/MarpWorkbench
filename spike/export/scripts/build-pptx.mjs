/**
 * 用 CDP 截图 + pptxgenjs 组装图片版 PPTX（复刻前端 ExportPanel 的 PPTX 流程）。
 * 对应 docs/research/marp-tech.md §4.1：每页 background=dataURL + addNotes(comments[i])。
 *
 * 复现：
 *   node scripts/build-pptx.mjs --prefix=cdp --ext=png   # 无损（预览/验收用）
 *   node scripts/build-pptx.mjs --prefix=perfD --ext=jpg # q90 JPEG（M1 默认，快/小）
 * 产物：out/export-<prefix>.pptx
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pptxgen from 'pptxgenjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const outDir = path.join(ROOT, 'out')

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const prefix = arg('prefix', 'cdp')
const ext = arg('ext', 'png')
const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png'
const output = resolveOut(arg('out', `export-${prefix}.pptx`))

function resolveOut(name) {
  return path.isAbsolute(name) ? name : path.join(outDir, name)
}

const render = JSON.parse(fs.readFileSync(path.join(outDir, 'render.json'), 'utf8'))
const comments = render.comments || []

const imageFiles = fs
  .readdirSync(outDir)
  .filter((f) => new RegExp(`^${prefix}-slide-\\d+\\.(png|jpg|jpeg)$`).test(f))
  .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]))
if (!imageFiles.length) {
  console.error(JSON.stringify({ ok: false, error: `未找到 ${prefix}-slide-N.${ext} 截图` }))
  process.exit(2)
}

const t0 = Date.now()
const pptx = new pptxgen()
pptx.author = 'MarpWorkbench'
pptx.company = 'MarpWorkbench'
pptx.title = render.title || 'MarpWorkbench 导出'
pptx.subject = 'Marp deck（图片版）'
// 16:9 13.333… x 7.5 in（= 1280x720 CSS px @96dpi，与 marp-cli 一致）。
// 必须用 1280/96 而不是 13.333：否则 presentation.xml 的 sldSz.cx=12191695 ≠ 12192000（不是精确 16:9）。
pptx.defineLayout({ name: 'MWB', width: 1280 / 96, height: 720 / 96 })
pptx.layout = 'MWB'

let mediaBytes = 0
for (const [i, file] of imageFiles.entries()) {
  const buf = fs.readFileSync(path.join(outDir, file))
  mediaBytes += buf.length
  const slide = pptx.addSlide()
  slide.background = { data: `${mime};base64,${buf.toString('base64')}` }
  if (comments[i]) slide.addNotes(comments[i])
}

const fileName = output
await pptx.writeFile({ fileName })
const ms = Date.now() - t0
const bytes = fs.statSync(fileName).size
console.log(
  JSON.stringify(
    {
      ok: true,
      file: fileName,
      slides: imageFiles.length,
      layout: { widthIn: 1280 / 96, heightIn: 720 / 96 },
      pptxBytes: bytes,
      mediaBytes,
      ms,
      assemblyMs: ms,
      images: imageFiles
    },
    null,
    2
  )
)
