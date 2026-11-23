/**
 * mermaidBlock.ts 单元测试（M5）
 * 运行：node --experimental-strip-types web/scripts/test-mermaid-block.ts
 */
import assert from 'node:assert/strict'
import {
  applyMermaidSizeDirective,
  buildMermaidSnippet,
  findMermaidBlockAtLine,
  isMermaidLang,
  normalizeMermaidSize,
  parseMermaidSizeDirective,
  serializeMermaidSize,
  stripMermaidSizeDirective,
} from '../src/insert/mermaidBlock.ts'

let passed = 0
function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`✅ ${name}`)
  } catch (err) {
    console.error(`❌ ${name}`)
    throw err
  }
}

const DOC = [
  '# 标题', // 1
  '', // 2
  '```mermaid', // 3
  'graph LR', // 4
  '  A[开始] --> B[结束]', // 5
  '```', // 6
  '', // 7
  '正文', // 8
  '', // 9
  '```js', // 10
  'console.log(1)', // 11
  '```', // 12
  '', // 13
  '```mmd', // 14
  '%% mwb-size: xl', // 15
  'pie title 分布', // 16
  '  "A" : 1', // 17
  '```', // 18
].join('\n')

test('isMermaidLang 识别 mermaid/mmd', () => {
  assert.equal(isMermaidLang('mermaid'), true)
  assert.equal(isMermaidLang('Mermaid 图表'), true)
  assert.equal(isMermaidLang('mmd'), true)
  assert.equal(isMermaidLang('javascript'), false)
  assert.equal(isMermaidLang(''), false)
})

test('findMermaidBlockAtLine 命中第一个块（光标在块内）', () => {
  const block = findMermaidBlockAtLine(DOC, 4)
  assert.ok(block)
  assert.equal(block!.line, 3)
  assert.equal(block!.code, 'graph LR\n  A[开始] --> B[结束]')
  assert.equal(block!.preset, 'auto')
  assert.equal(DOC.slice(block!.from, block!.to), '```mermaid\ngraph LR\n  A[开始] --> B[结束]\n```')
})

test('findMermaidBlockAtLine 容忍 ±1 行（fence 外一行）', () => {
  assert.ok(findMermaidBlockAtLine(DOC, 2), '开 fence 上一行应命中')
  assert.ok(findMermaidBlockAtLine(DOC, 7), '闭 fence 下一行应命中')
  assert.equal(findMermaidBlockAtLine(DOC, 8), null)
})

test('findMermaidBlockAtLine 跳过未闭合 fences 与其他语言', () => {
  const unclosed = ['```mermaid', 'graph LR', '  A --> B'].join('\n')
  assert.equal(findMermaidBlockAtLine(unclosed, 2), null)
  // 光标在 js 块内不应命中 mermaid
  assert.equal(findMermaidBlockAtLine(DOC, 11), null)
})

test('findMermaidBlockAtLine 命中第二个块并解析尺寸指令', () => {
  const block = findMermaidBlockAtLine(DOC, 16)
  assert.ok(block)
  assert.equal(block!.line, 14)
  assert.equal(block!.preset, 'xl')
  assert.equal(DOC.slice(block!.from, block!.to).startsWith('```mmd\n%% mwb-size: xl'), true)
})

test('parseMermaidSizeDirective 只扫描前 5 行 / 解析别名', () => {
  const front = parseMermaidSizeDirective('%% mwb-size: 超大\ngraph LR\n  A --> B')
  assert.equal(front.size.preset, 'xl')
  assert.equal(front.codeWithoutDirective, 'graph LR\n  A --> B')
  const late = parseMermaidSizeDirective(['a', 'b', 'c', 'd', 'e', '%% mwb-size: s', 'graph LR'].join('\n'))
  assert.equal(late.directiveFound, false)
  assert.equal(late.size.preset, 'auto')
})

test('normalizeMermaidSize / serializeMermaidSize 契约取值', () => {
  assert.deepEqual(normalizeMermaidSize('small'), { preset: 's' })
  assert.deepEqual(normalizeMermaidSize('大'), { preset: 'l' })
  assert.deepEqual(normalizeMermaidSize('70%'), { preset: 'custom', customValue: '70%' })
  assert.deepEqual(normalizeMermaidSize('900px'), { preset: 'custom', customValue: '900px' })
  assert.deepEqual(normalizeMermaidSize('未知值'), { preset: 'auto' })
  assert.equal(serializeMermaidSize({ preset: 'auto' }), null)
  assert.equal(serializeMermaidSize({ preset: 'xl' }), 'xl')
  assert.equal(serializeMermaidSize({ preset: 'custom', customValue: '70%' }), '70%')
  assert.equal(serializeMermaidSize({ preset: 'custom', customValue: '250%' }), '100%')
})

test('applyMermaidSizeDirective 替换旧指令（不重复）', () => {
  const code = '%% mwb-size: xl\ngraph LR\n  A --> B'
  const next = applyMermaidSizeDirective(code, { preset: 'custom', customValue: '70%' })
  assert.equal(next, '%% mwb-size: 70%\ngraph LR\n  A --> B')
  const auto = applyMermaidSizeDirective(next, { preset: 'auto' })
  assert.equal(auto, 'graph LR\n  A --> B')
  assert.equal((auto.match(/%% mwb-size/g) || []).length, 0)
})

test('buildMermaidSnippet 用 fence 包裹并只保留一条指令', () => {
  const snippet = buildMermaidSnippet('%% mwb-size: xl\ngraph LR\n  A --> B', { preset: 'custom', customValue: '70%' })
  assert.equal(snippet, '```mermaid\n%% mwb-size: 70%\ngraph LR\n  A --> B\n```')
  const directiveCount = (snippet.match(/%% mwb-size/g) || []).length
  assert.equal(directiveCount, 1)
  const autoSnippet = buildMermaidSnippet('graph LR\n  A --> B', { preset: 'auto' })
  assert.equal(autoSnippet, '```mermaid\ngraph LR\n  A --> B\n```')
})

test('stripMermaidSizeDirective 去掉指令行', () => {
  assert.equal(stripMermaidSizeDirective('%% mwb-size: s\ngraph LR'), 'graph LR')
  assert.equal(stripMermaidSizeDirective('graph LR'), 'graph LR')
})

console.log(`\n✅ mermaidBlock 单元测试全部通过（${passed} 组）`)
