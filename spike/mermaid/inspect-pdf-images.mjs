// 检查 PDF 里每页的 image XObject 尺寸，判断是「整图位图化」还是「SVG filter 阴影被光栅化」
// 用法：node spike/mermaid/inspect-pdf-images.mjs [pdf]
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..', '..')
const requireFromPackaging = createRequire(pathToFileURL(path.join(REPO, 'spike', 'packaging', 'browser-print', 'verify.mjs')))
const pdfjs = await import(pathToFileURL(requireFromPackaging.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href)
const OPS = pdfjs.OPS

const pdfPath = process.argv[2] || path.join(HERE, 'out', 'print-deck.pdf')
const buf = fs.readFileSync(pdfPath)
const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true }).promise
console.log(`pdf=${path.relative(REPO, pdfPath)} bytes=${buf.length} pages=${pdf.numPages}`)
for (let i = 1; i <= pdf.numPages; i++) {
  const page = await pdf.getPage(i)
  const ops = await page.getOperatorList()
  const images = []
  for (let k = 0; k < ops.fnArray.length; k++) {
    const fn = ops.fnArray[k]
    if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintJpegXObject) {
      const arg = ops.argsArray[k]
      const objId = fn === OPS.paintImageXObject ? arg[0] : null
      let info = { fn, objId }
      try {
        const img = objId ? page.objs.get(objId) : null
        if (img) info = { ...info, width: img.width, height: img.height, kind: img.kind, dataBytes: img.data ? img.data.length : null }
      } catch (e) {
        info.error = String(e)
      }
      images.push(info)
    }
  }
  console.log(`p${i}: images=${images.length} ${JSON.stringify(images)}`)
}
await pdf.destroy()
