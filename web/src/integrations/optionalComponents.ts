/**
 * 可选组件挂载点：ThemeGallery（themes 成员写）与 ExportPanel（export-eng 写）。
 * 这两个文件由其他成员负责，可能晚于本文件出现：
 * 用 import.meta.glob 探测——文件存在时才异步挂载，不存在时 build 仍通过（不报错）。
 */
import { defineAsyncComponent, type Component } from 'vue'

type AsyncModule = () => Promise<{ default: Component }>

function pick(modules: Record<string, AsyncModule>, path: string): Component | null {
  const loader = modules[path]
  return loader ? defineAsyncComponent(loader) : null
}

const themeGalleryModules = import.meta.glob('../themes/ThemeGallery.vue') as Record<string, AsyncModule>
const exportPanelModules = import.meta.glob('../export/ExportPanel.vue') as Record<string, AsyncModule>
const slideNavigatorModules = import.meta.glob('../outline/SlideNavigator.vue') as Record<string, AsyncModule>
const imageDialogModules = import.meta.glob('../insert/ImageInsertDialog.vue') as Record<string, AsyncModule>
const tableDialogModules = import.meta.glob('../insert/TableInsertDialog.vue') as Record<string, AsyncModule>
const themeEditorModules = import.meta.glob('../themes/ThemeEditor.vue') as Record<string, AsyncModule>

/** themes 成员的 `<ThemeGallery>`；文件未就绪时 null */
export const ThemeGalleryAsync = pick(themeGalleryModules, '../themes/ThemeGallery.vue')
/** export-eng 的 `<ExportPanel>`；文件未就绪时 null */
export const ExportPanelAsync = pick(exportPanelModules, '../export/ExportPanel.vue')
/** outline-eng 的 `<SlideNavigator>`（M2 左栏大纲/缩略图）；文件未就绪时 null */
export const SlideNavigatorAsync = pick(slideNavigatorModules, '../outline/SlideNavigator.vue')
/** export-eng 的 `<ImageInsertDialog>`（M2 图片/背景图插入器）；文件未就绪时 null */
export const ImageInsertDialogAsync = pick(imageDialogModules, '../insert/ImageInsertDialog.vue')
/** export-eng 的 `<TableInsertDialog>`（M2 表格插入器）；文件未就绪时 null */
export const TableInsertDialogAsync = pick(tableDialogModules, '../insert/TableInsertDialog.vue')
/** themes 的 `<ThemeEditor>`（通常由 ThemeGallery 内部挂载，这里保留备用） */
export const ThemeEditorAsync = pick(themeEditorModules, '../themes/ThemeEditor.vue')

// ---------- 粘贴/拖拽图片（export-eng 的 pasteDrop.ts，M2） ----------
type PasteDropModule = {
  attachImagePasteDrop?: (el: HTMLElement, opts: { onFiles: (files: File[]) => void | Promise<void> }) => () => void
  /** 生成普通图片 snippet（marp-core 4.4 不支持百分比宽度，export-eng 已换算成 px；第二参数为宽度百分比，默认约 60%） */
  pasteImageSnippet?: (path: string, widthPercent?: number) => string
}
type PasteDropLoader = () => Promise<PasteDropModule>
const pasteDropModules = import.meta.glob('../insert/pasteDrop.ts') as Record<string, PasteDropLoader>

/** 懒加载 pasteDrop.ts；文件未就绪时 null（EditView 会安全跳过） */
export const loadPasteDrop: PasteDropLoader | null = pasteDropModules['../insert/pasteDrop.ts'] || null
