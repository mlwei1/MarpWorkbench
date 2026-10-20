// 从 marp-cli 打包产物中提取关键实现片段（源码是 rollup 打成的单行 bundle）
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const libDir = process.argv[2]
const keywords = process.argv.slice(3)
const files = readdirSync(libDir).filter((f) => f.endsWith('.js'))

for (const file of files) {
  const src = readFileSync(join(libDir, file), 'utf8')
  for (const kw of keywords) {
    let idx = -1
    let count = 0
    while ((idx = src.indexOf(kw, idx + 1)) !== -1 && count < 3) {
      count++
      const start = Math.max(0, idx - 350)
      const snippet = src.slice(start, idx + 650).replace(/\n/g, ' ')
      console.log(`\n===== ${file} :: ${kw} #${count} @${idx} =====\n${snippet}\n`)
    }
  }
}
