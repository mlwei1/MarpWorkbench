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

/** themes 成员的 `<ThemeGallery>`；文件未就绪时 null */
export const ThemeGalleryAsync = pick(themeGalleryModules, '../themes/ThemeGallery.vue')
/** export-eng 的 `<ExportPanel>`；文件未就绪时 null */
export const ExportPanelAsync = pick(exportPanelModules, '../export/ExportPanel.vue')
