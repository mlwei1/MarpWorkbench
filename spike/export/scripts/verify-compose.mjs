/**
 * M2 插入器验收脚本：编译 web/src/insert/compose.ts → 用真实 marp-core 渲染验证：
 * 1) 图片/表格 snippet 能被 marp-core 正确解析（宽度 px、背景 split/filter、GFM 对齐）
 * 2) 分页/页首插入/光标页计算逻辑正确（front-matter、代码围栏里的 --- 不误判）
 *
 * 用法：node spike/export/scripts/verify-compose.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Marp } from '@marp-team/marp-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const REPO = path.resolve(ROOT, '..', '..')
const outDir = path.join(ROOT, 'out')
fs.mkdirSync(outDir, { recursive: true })

const composeEntry = path.join(REPO, 'web', 'src', 'insert', 'compose.ts')
const bundlePath = path.join(outDir, 'compose-bundle.mjs')
const esbuild = path.join(REPO, 'web', 'node_modules', '.bin', 'esbuild.cmd')
const build = spawnSync(
  esbuild,
  [composeEntry, '--bundle', '--format=esm', '--platform=node', `--outfile=${bundlePath}`, '--log-level=warning'],
  { encoding: 'utf8', shell: true }
)
if (build.status !== 0) {
  console.error('esbuild 失败：', build.stderr || build.stdout)
  process.exit(1)
}
const compose = await import(pathToFileURL(bundlePath).href)

const marp = new Marp({
  html: true,
  script: false,
  math: { lib: 'mathjax' },
  emoji: { shortcode: true, unicode: false }
})

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
  return ok
}
const render = (md) => marp.render(md).html

// ---------------- 1) 图片 snippet ----------------
const imageCases = [
  {
    name: '普通图片 50% → px 宽度',
    snippet: compose.buildImageSnippet({ path: 'assets/photo.png', mode: 'image', widthPercent: 50, slideWidth: 1280 }),
    expect: '![w:640px](assets/photo.png)',
    assertHtml: (html) => html.includes('style="width:640px;"') && html.includes('src="assets/photo.png"')
  },
  {
    name: '普通图片 原图（无宽度修饰）',
    snippet: compose.buildImageSnippet({ path: 'assets/photo.png', mode: 'image' }),
    expect: '![](assets/photo.png)',
    assertHtml: (html) => html.includes('<img src="assets/photo.png"') && !/style="width/.test(html)
  },
  {
    name: '背景图 左侧 40% + opacity:.5',
    snippet: compose.buildImageSnippet({
      path: 'assets/bg.png',
      mode: 'background',
      bgLayout: 'left',
      bgRatio: 40,
      transparency: 50
    }),
    expect: '![bg left:40% opacity:.5](assets/bg.png)',
    assertHtml: (html) =>
      html.includes('data-marpit-advanced-background-split="left"') &&
      html.includes('--marpit-advanced-background-split:40%') &&
      html.includes('filter:opacity(.5)')
  },
  {
    name: '背景图 整页 contain + blur + grayscale',
    snippet: compose.buildImageSnippet({
      path: 'assets/bg.png',
      mode: 'background',
      bgLayout: 'full',
      fit: 'contain',
      opacity: 0.5,
      blur: 5,
      grayscale: true
    }),
    expect: '![bg contain blur:5px grayscale](assets/bg.png)',
    assertHtml: (html) =>
      html.includes('background-size:contain') &&
      html.includes('filter:blur(5px) grayscale(1)') &&
      html.includes('data-marpit-advanced-background="background"')
  },
  {
    name: '右侧 30% 背景',
    snippet: compose.buildImageSnippet({ path: 'assets/bg.png', mode: 'background', bgLayout: 'right', bgRatio: 30 }),
    expect: '![bg right:30%](assets/bg.png)',
    assertHtml: (html) => html.includes('data-marpit-advanced-background-split="right"') && html.includes('--marpit-advanced-background-split:30%')
  },
  {
    name: '中文文件名 URL 编码',
    snippet: compose.buildImageSnippet({ path: 'assets/我的 图片.png', mode: 'image', widthPercent: 50 }),
    // encodeURI 后无空格/括号 → 直接放在 (...) 里即可
    expect: '![w:640px](assets/%E6%88%91%E7%9A%84%20%E5%9B%BE%E7%89%87.png)',
    assertHtml: (html) => html.includes('assets/%E6%88%91%E7%9A%84%20%E5%9B%BE%E7%89%87.png')
  }
]

for (const c of imageCases) {
  const html = render(c.snippet)
  check(c.name, c.snippet === c.expect && c.assertHtml(html), `snippet=${c.snippet}`)
}

// ---------------- 2) 表格 snippet ----------------
const tableSnippet = compose.buildTableSnippet({
  rows: 3,
  cols: 3,
  header: true,
  align: 'center',
  firstColBold: true
})
const tableHtml = render(`# 表格\n${tableSnippet}`)
check(
  '表格 3×3 表头 + 居中 + 首列加粗',
  tableHtml.includes('<table>') &&
    tableHtml.includes('<th style="text-align:center"') &&
    tableHtml.includes('<strong>内容 1</strong>') &&
    /^\n\n\| 表头1 \| 表头2 \| 表头3 \|/.test(tableSnippet),
  JSON.stringify(tableSnippet.slice(0, 160))
)
check(
  '表格无表头模式（数据行从第一行开始）',
  compose.buildTableSnippet({ rows: 2, cols: 2, header: false }).includes('| :--- | :--- |') &&
    !compose.buildTableSnippet({ rows: 2, cols: 2, header: false }).includes('表头')
)

// ---------------- 3) 分页 / 插入 ----------------
const sample = [
  '---',
  'marp: true',
  'theme: business-blue',
  'paginate: true',
  '---',
  '',
  '# 第一页标题',
  '',
  '正文',
  '',
  '---',
  '',
  '# 第二页标题',
  '',
  '```md',
  '---',
  '代码围栏里的 --- 不算分页',
  '```',
  '',
  '---',
  '',
  '# 第三页标题',
  ''
].join('\n')

const pages = compose.splitPages(sample)
check('分页数量=3（代码围栏里的 --- 忽略）', pages.length === 3, `pages=${pages.length}`)
check(
  '页起始行号正确（front-matter 后为第 6 行）',
  pages[0].startLine === 6 && pages[1].startLine === 12 && pages[2].startLine === 21,
  JSON.stringify(pages.map((p) => ({ i: p.index, start: p.startLine })))
)
check(
  'pageAtLine 映射正确',
  compose.pageAtLine(sample, 8) === 1 && compose.pageAtLine(sample, 14) === 2 && compose.pageAtLine(sample, 23) === 3
)

const startInserted = compose.insertAtPageStart(sample, 2, '![bg left:40%](assets/bg.png)')
const startPages = compose.splitPages(startInserted)
const page2 = startInserted.slice(startPages[1].startOffset, startPages[1].endOffset)
const startRendered = (render(startInserted).match(/data-marpit-svg/g) || []).length
check(
  'insertAtPageStart：背景图落在第 2 页页首（页数不变）',
  page2.trimStart().startsWith('![bg left:40%](assets/bg.png)') && startPages.length === 3 && startRendered === 3,
  `pages=${startPages.length} rendered=${startRendered} head=${JSON.stringify(page2.trimStart().slice(0, 40))}`
)

const endInserted = compose.insertAtPageEnd(sample, 1, '![w:640px](assets/a.png)')
const endPages = compose.splitPages(endInserted)
const page1 = endInserted.slice(endPages[0].startOffset, endPages[0].endOffset)
const endRendered = render(endInserted)
const endSlideCount = (endRendered.match(/data-marpit-svg/g) || []).length
check(
  'insertAtPageEnd：普通图片落在第 1 页末尾（页数不变、分隔线不被吃成 setext）',
  page1.includes('![w:640px](assets/a.png)') &&
    endPages.length === 3 &&
    endSlideCount === 3 &&
    !endInserted.slice(endPages[1].startOffset).includes('assets/a.png'),
  `pages=${endPages.length} rendered=${endSlideCount}`
)

const composed = compose.composePreviewMarkdown(sample, '![bg](assets/bg.png)', 'background', 2)
check(
  'composePreviewMarkdown：预览候选 md 仍为 3 页',
  compose.splitPages(composed.markdown).length === 3 && composed.page === 2,
  `pages=${compose.splitPages(composed.markdown).length} page=${composed.page}`
)

// 页首已有 _class 指令时，背景图应插在指令之后
const withDirective = ['---', 'marp: true', '---', '', '<!-- _class: lead -->', '', '# 封面', '', '---', '', '# 第二页'].join('\n')
const directiveInserted = compose.insertAtPageStart(withDirective, 1, '![bg](assets/bg.png)')
check(
  'insertAtPageStart：不打断页首 _class 指令',
  /<!-- _class: lead -->\s*\n\s*!\[bg\]\(assets\/bg\.png\)/.test(directiveInserted),
  JSON.stringify(directiveInserted.slice(0, 120))
)

const failed = checks.filter((c) => !c.ok)
console.log(`\n[verify-compose] ${checks.length - failed.length}/${checks.length} 通过`)
fs.writeFileSync(path.join(outDir, 'verify-compose-report.json'), JSON.stringify({ checks, ok: failed.length === 0 }, null, 2))
if (failed.length) process.exit(1)
