// 生成 100 页 deck 用于导出性能实测
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const slidesDir = path.join(__dirname, '..', 'slides')
const base = fs.readFileSync(path.join(slidesDir, 'deck.html'), 'utf8')
const head = base.split('<body>')[0] + '<body>\n'
const slides = []
for (let i = 1; i <= 100; i++) {
  const cls = i % 3 === 1 ? 's1' : i % 3 === 2 ? 's2' : 's3'
  slides.push(`  <section class="slide ${cls}">
    <h2>SLIDE ${i} / 100</h2>
    <p>性能测试页 ${i}：中文文本、背景色、渐变与代码样式。</p>
    <p><code>const n = ${i}</code></p>
    <div class="tag">SLIDE ${i} / 100</div>
  </section>`)
}
fs.writeFileSync(path.join(slidesDir, 'deck-100.html'), head + slides.join('\n') + '\n</body>\n</html>\n')
console.log('written', path.join(slidesDir, 'deck-100.html'), 'slides=100')
