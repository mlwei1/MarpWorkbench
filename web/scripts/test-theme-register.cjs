// 隔离测试：Node 侧用与浏览器相同的 Marp 配置注册 themes/*.css
const { createRequire } = require('node:module')
const fs = require('node:fs')
const path = require('node:path')

const webDir = path.join(__dirname, '..', 'web')
const req = createRequire(path.join(webDir, 'package.json'))
const { Marp } = req('@marp-team/marp-core')

const EXTERNAL_IMPORT_RE = /@import\s+(?:url\(\s*)?(?:['"]?)https?:\/\/[^;]*;?/gi
const EXTERNAL_URL_RE = /url\(\s*(?:['"]?)https?:\/\/[^)]*\)/gi
const sanitizeCss = (css) => css.replace(EXTERNAL_IMPORT_RE, '').replace(EXTERNAL_URL_RE, 'none')

const marp = new Marp({
  html: true,
  script: false,
  minifyCSS: true,
  math: { lib: 'mathjax', katexFontPath: '/katex/fonts/' },
  emoji: { shortcode: true, unicode: false },
})

const themesDir = path.join(__dirname, '..', '..', 'themes')
for (const f of fs.readdirSync(themesDir).filter((x) => x.endsWith('.css'))) {
  const raw = fs.readFileSync(path.join(themesDir, f), 'utf8')
  const clean = sanitizeCss(raw)
  const name = (/\/\*\s*@theme\s+([\w-]+)/.exec(clean) || [])[1]
  try {
    marp.themeSet.add(clean)
    console.log(`✅ ${f} name=${name} has=${marp.themeSet.has(name)}`)
  } catch (e) {
    console.log(`❌ ${f} name=${name} error=${e.message}`)
  }
}

console.log('registered themes:', [...marp.themeSet.themes()].map((t) => t.name).join(', '))

// 渲染 tech-dark 验证 CSS 生效（取 section 规则里的背景色）
const md = '---\nmarp: true\ntheme: tech-dark\n---\n# Hello\n\n## 科技深色测试'
const res = marp.render(md)
const bg = /section\s*\{[^}]*background[^;]*;/.exec(res.css)
console.log('tech-dark 渲染背景规则:', bg ? bg[0].slice(0, 160) : '未找到')
const viewBox = /viewBox="([^"]+)"/.exec(res.html)
console.log('viewBox:', viewBox ? viewBox[1] : 'none')
