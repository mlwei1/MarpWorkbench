// marp-core 浏览器 IIFE 入口（由 scripts/build-marp-browser.mjs 打包）
// 全局约定（docs/API_CONTRACT.md §2.2）：window.MarpCoreBundle.MarpCore = { Marp, browser }
import { Marp } from '@marp-team/marp-core'
import { browser } from '@marp-team/marp-core/browser'

globalThis.MarpCoreBundle = {
  MarpCore: { Marp, browser },
}
