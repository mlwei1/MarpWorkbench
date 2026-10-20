// 浏览器端入口：验证 @marp-team/marp-core 能否直接打包进浏览器（无 Node 内置模块）
import { Marp } from '@marp-team/marp-core'
import { browser } from '@marp-team/marp-core/browser'

globalThis.MarpCore = { Marp, browser }
