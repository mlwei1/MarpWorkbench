// 检查 marp-core 渲染 mermaid fence 的真实 HTML 结构（决定提取正则/清理逻辑）
// 用法：node spike/mermaid/inspect-marp-html.mjs
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const requireFromWeb = createRequire(pathToFileURL(path.join(repoRoot, 'web/package.json')))
const marpEntry = requireFromWeb.resolve('@marp-team/marp-core')
const { Marp } = await import(pathToFileURL(marpEntry).href)
const pkg = requireFromWeb('@marp-team/marp-core/package.json')

const marp = new Marp({ html: true, script: false, math: { lib: 'mathjax' }, emoji: { shortcode: true, unicode: false } })
const md = `---
theme: default
---

# Mermaid 测试

\`\`\`mermaid
graph LR
  A[开始] --> B{是否 > 3?}
  B -->|是| C[结束]
\`\`\`

---

\`\`\`mmd
sequenceDiagram
  participant 用户
  participant 系统
  用户->>系统: 登录
  系统-->>用户: OK
\`\`\`
`
const res = marp.render(md)
console.log('marp-core', pkg.version)
console.log('--- html ---')
console.log(res.html)
console.log('--- css length ---', res.css.length)
