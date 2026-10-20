// 纯函数单元测试（Node，不依赖浏览器）：sha1 / HTML 实体 / 代码块提取 / SVG 清理 / 模板 id / 替换骨架
// 用 esbuild 把 web/src/mermaid/*.ts 打成 ESM 后 import（测的是真实源码，不是复制品）
// 用法：node spike/mermaid/run-unit-test.mjs
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..', '..')
const webDir = path.join(REPO, 'web')
const outDir = path.join(HERE, 'out', 'unit')
fs.mkdirSync(outDir, { recursive: true })
const requireFromWeb = createRequire(pathToFileURL(path.join(webDir, 'package.json')))
const esbuild = requireFromWeb('esbuild')

async function bundle(file, name) {
  const outFile = path.join(outDir, name)
  const r = await esbuild.build({ entryPoints: [path.join(webDir, 'src', 'mermaid', file)], bundle: true, format: 'esm', platform: 'neutral', target: ['es2022'], write: false, logLevel: 'warning' })
  fs.writeFileSync(outFile, Buffer.from(r.outputFiles[0].contents))
  return import(pathToFileURL(outFile).href + `?t=${Date.now()}`)
}

const results = []
function test(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (err) {
    results.push({ name, ok: false, error: String(err && err.message ? err.message : err) })
  }
}

const hashMod = await bundle('hash.ts', 'hash.mjs')
const replaceMod = await bundle('replace.ts', 'replace.mjs')

// ---------- sha1 ----------
test('sha1 与 Node crypto 一致（空串/abc/中文/长文本）', () => {
  const samples = ['', 'abc', '中文 mermaid graph LR\n  A --> B', 'x'.repeat(10000), '😀 emoji 混排\n第二行']
  for (const s of samples) {
    const expected = crypto.createHash('sha1').update(s, 'utf8').digest('hex')
    assert.equal(hashMod.sha1Hex(s), expected, `sha1 mismatch for ${s.slice(0, 20)}`)
  }
})
test('sha1 输出 40 位小写 hex', () => {
  assert.match(hashMod.sha1Hex('hello'), /^[0-9a-f]{40}$/)
})

// ---------- 实体/代码提取 ----------
test('decodeHtmlEntities：单趟解码，不二次解码 &amp;lt;', () => {
  assert.equal(replaceMod.decodeHtmlEntities('&amp;lt;'), '&lt;')
  assert.equal(replaceMod.decodeHtmlEntities('A --&gt; B'), 'A --> B')
  assert.equal(replaceMod.decodeHtmlEntities('&quot;x&quot; &#39;y&#39; &#x4e2d;&#25991;'), '"x" \'y\' 中文')
  assert.equal(replaceMod.decodeHtmlEntities('no entities'), 'no entities')
})
test('htmlToMermaidCode：去标签 + 反转义 + CRLF 归一', () => {
  assert.equal(replaceMod.htmlToMermaidCode('graph LR\n  A --&gt; B'), 'graph LR\n  A --> B')
  assert.equal(replaceMod.htmlToMermaidCode('<span class="hljs-keyword">graph</span> LR'), 'graph LR')
  assert.equal(replaceMod.htmlToMermaidCode('a\r\nb'), 'a\nb')
})

// ---------- marp HTML 提取 ----------
const MARP_HTML = `<div class="marpit"><svg data-marpit-svg="" viewBox="0 0 1280 720"><foreignObject width="1280" height="720"><section id="1">
<pre is="marp-pre" data-auto-scaling="downscale-only"><code class="language-mermaid">graph LR
  A[开始] --&gt; B{检查}
  B --&gt;|通过| C[结束]
</code></pre>
</section></foreignObject></svg></div>`
const MARP_MMD = `<pre is="marp-pre"><code class="language-mmd">sequenceDiagram
  用户-&gt;&gt;系统: 登录
</code></pre>`

test('hasMermaid：识别 language-mermaid / language-mmd', () => {
  assert.equal(replaceMod.hasMermaid(MARP_HTML), true)
  assert.equal(replaceMod.hasMermaid(MARP_MMD), true)
})
test('hasMermaid：不误伤普通代码块/纯文本', () => {
  assert.equal(replaceMod.hasMermaid('<pre><code class="language-js">const a=1</code></pre>'), false)
  assert.equal(replaceMod.hasMermaid('<p>language-mermaid 是语言标识</p>'), false)
  assert.equal(replaceMod.hasMermaid(''), false)
})
test('findMermaidBlocks：位置/原文/解码代码正确', () => {
  const html = `before\n${MARP_HTML.slice(MARP_HTML.indexOf('<pre'))}\nmid\n${MARP_MMD}\nafter`
  const blocks = replaceMod.findMermaidBlocks(html)
  assert.equal(blocks.length, 2)
  assert.equal(html.slice(blocks[0].start, blocks[0].end), blocks[0].raw)
  assert.match(blocks[0].code, /A\[开始\] --> B\{检查\}/)
  assert.match(blocks[1].code, /用户->>系统: 登录/)
  // 代码块外内容不动
  assert.equal(replaceMod.replaceMermaidBlocks(html, blocks, () => null), html)
})

// ---------- SVG 清理 ----------
const SVG = '<svg id="mermaid-1" width="100%" style="max-width: 523.5px;" viewBox="0 0 523.5 185" xmlns="http://www.w3.org/2000/svg"><g><text>开始</text></g></svg>'
test('cleanupMermaidSvg：保留 viewBox/max-width，去掉固定 px，加自适应 max-height', () => {
  const out = replaceMod.cleanupMermaidSvg(SVG)
  assert.match(out, /viewBox="0 0 523\.5 185"/)
  assert.match(out, /width="100%"/)
  assert.doesNotMatch(out, /\bheight="185"/)
  assert.match(out, /max-width:523\.5px/)
  assert.match(out, new RegExp(`max-height:${replaceMod.MERMAID_SVG_MAX_HEIGHT_PX}px`))
  assert.match(out, /height:auto/)
})
test('cleanupMermaidSvg：无 max-width 的 svg 用 100% 兜底', () => {
  const out = replaceMod.cleanupMermaidSvg('<svg viewBox="0 0 10 10"><g/></svg>')
  assert.match(out, /max-width:100%/)
})
test('id 模板化：缓存复用时可生成不同 id', () => {
  const svg = '<svg id="mwb-mermaid-3-abc"><marker id="mwb-mermaid-3-abc_pointEnd"/><g marker-end="url(#mwb-mermaid-3-abc_pointEnd)"/></svg>'
  const tpl = replaceMod.templateizeMermaidSvg(svg, 'mwb-mermaid-3-abc')
  assert.ok(!tpl.includes('mwb-mermaid-3-abc'))
  const a = replaceMod.materializeMermaidSvg(tpl, 'mwb-mermaid-9-zzz')
  const b = replaceMod.materializeMermaidSvg(tpl, 'mwb-mermaid-10-yyy')
  assert.notEqual(a, b)
  assert.match(a, /id="mwb-mermaid-9-zzz"/)
  assert.match(a, /url\(#mwb-mermaid-9-zzz_pointEnd\)/)
})
test('wrapper/error 块：class、hash、转义正确', () => {
  const wrap = replaceMod.buildMermaidWrapper('a'.repeat(40), '<svg></svg>')
  assert.match(wrap, /^<div class="mwb-mermaid" data-mermaid-hash="a{40}"/)
  assert.match(wrap, /<svg><\/svg><\/div>$/)
  const err = replaceMod.buildMermaidErrorBlock('<pre>x</pre>', 'Parse error <bad> & "quote"')
  assert.match(err, /^<pre>x<\/pre>/)
  assert.match(err, /class="mwb-mermaid-error"/)
  assert.match(err, /Parse error &lt;bad&gt; &amp; &quot;quote&quot;/)
  assert.match(err, /已保留原始代码块/)
})

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.ok)
console.log('===== mermaid 纯函数单测 =====')
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' => ' + r.error}`)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log('RESULT: FAIL')
  process.exitCode = 1
} else {
  console.log('RESULT: PASS')
}
