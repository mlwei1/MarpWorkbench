/**
 * 图片粘贴 / 拖拽接入（M2，owner: export-eng，契约 §2.7）
 *
 * 用法（EditView 集成）：
 * ```ts
 * const detach = attachImagePasteDrop(editorEl, {
 *   onFiles: async (files) => {
 *     const asset = await uploadAsset(deckId, files[0])
 *     editor.insertText(`![w:60%](${asset.path})`, { block: true })
 *   },
 * })
 * onBeforeUnmount(detach)
 * ```
 *
 * 行为：
 * - 只拦截**图片**文件；文本/文件粘贴、非图片拖拽一律放行（不影响 CodeMirror 默认行为）；
 * - paste 用 capture 阶段监听，先于 CodeMirror 处理；
 * - dragover/drop 在容器上监听，拖入图片时 preventDefault；非图片拖拽不拦截（交给编辑器）。
 */

const IMAGE_MIME_RE = /^image\/(png|jpe?g|gif|webp|svg\+xml)$/i
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg)$/i

export function isImageFile(file: File | null | undefined): boolean {
  if (!file) return false
  if (IMAGE_MIME_RE.test(file.type || '')) return true
  return !file.type && IMAGE_EXT_RE.test(file.name || '')
}

/** 从 FileList / DataTransfer.files 里挑出图片文件 */
export function imageFilesFrom(list: FileList | File[] | null | undefined): File[] {
  if (!list) return []
  const files = Array.from(list as ArrayLike<File>)
  return files.filter(isImageFile)
}

/** 从剪贴板事件提取图片文件（截图粘贴 / 复制文件） */
export function imagesFromClipboard(event: ClipboardEvent): File[] {
  const data = event.clipboardData
  if (!data) return []
  const fromItems: File[] = []
  if (data.items) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== 'file') continue
      if (item.type && !IMAGE_MIME_RE.test(item.type)) continue
      const file = item.getAsFile()
      if (file && isImageFile(file)) fromItems.push(file)
    }
  }
  if (fromItems.length) return fromItems
  return imageFilesFrom(data.files)
}

/** 从拖拽事件提取图片文件 */
export function imagesFromDataTransfer(data: DataTransfer | null | undefined): File[] {
  if (!data) return []
  return imageFilesFrom(data.files)
}

export interface AttachImagePasteDropOptions {
  /** 收到图片文件（可能是多张） */
  onFiles: (files: File[]) => void | Promise<void>
  /** 自定义过滤（默认 isImageFile） */
  accepts?: (file: File) => boolean
  /** 拖拽状态变化（用于高亮拖拽区，可选） */
  onDragState?: (active: boolean) => void
}

/**
 * 在元素上接入图片粘贴/拖拽。返回解绑函数。
 * 注意：解绑时移除全部监听器；组件卸载请务必调用。
 */
export function attachImagePasteDrop(
  el: HTMLElement,
  options: AttachImagePasteDropOptions
): () => void {
  if (!el) return () => {}
  const accepts = options.accepts || isImageFile
  let dragDepth = 0

  const pick = (files: File[]): File[] => files.filter((f) => accepts(f))

  const onPaste = (event: ClipboardEvent): void => {
    const files = pick(imagesFromClipboard(event))
    if (!files.length) return // 非图片：完全放行
    event.preventDefault()
    event.stopPropagation()
    void options.onFiles(files)
  }

  const setDrag = (active: boolean): void => {
    options.onDragState?.(active)
  }

  const hasImageDrag = (event: DragEvent): boolean => {
    const dt = event.dataTransfer
    if (!dt) return false
    // 拖拽过程中 files 可能为空，只能看 items 的 type
    if (dt.items && dt.items.length) {
      return Array.from(dt.items).some(
        (item) => item.kind === 'file' && (!item.type || IMAGE_MIME_RE.test(item.type))
      )
    }
    return Array.from(dt.types || []).includes('Files')
  }

  const onDragEnter = (event: DragEvent): void => {
    if (!hasImageDrag(event)) return
    dragDepth++
    if (dragDepth === 1) setDrag(true)
  }

  const onDragOver = (event: DragEvent): void => {
    if (!hasImageDrag(event)) return // 非图片：不拦截（编辑器可处理文本拖拽）
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    setDrag(true)
  }

  const onDragLeave = (event: DragEvent): void => {
    if (!hasImageDrag(event)) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) setDrag(false)
  }

  const onDrop = (event: DragEvent): void => {
    const files = pick(imagesFromDataTransfer(event.dataTransfer))
    dragDepth = 0
    setDrag(false)
    if (!files.length) return // 非图片：放行（交给编辑器/浏览器）
    event.preventDefault()
    event.stopPropagation()
    void options.onFiles(files)
  }

  el.addEventListener('paste', onPaste, true)
  el.addEventListener('dragenter', onDragEnter, true)
  el.addEventListener('dragover', onDragOver, true)
  el.addEventListener('dragleave', onDragLeave, true)
  el.addEventListener('drop', onDrop, true)

  return () => {
    el.removeEventListener('paste', onPaste, true)
    el.removeEventListener('dragenter', onDragEnter, true)
    el.removeEventListener('dragover', onDragOver, true)
    el.removeEventListener('dragleave', onDragLeave, true)
    el.removeEventListener('drop', onDrop, true)
    dragDepth = 0
    setDrag(false)
  }
}

/** 快捷路径默认宽度（契约 §2.8：粘贴/拖拽直接插入普通图片，约 60% 宽） */
export const PASTE_IMAGE_WIDTH_PERCENT = 60

/**
 * 生成快捷粘贴插入的 Markdown（相对路径，标准 Marp 语法）。
 * 注意：marp-core 4.4 **不支持** `![w:60%]` 百分比（实测不产生样式），
 * 因此按 16:9 deck 宽度换算为 px（60% of 1280 = 768px），产物仍是标准 Marp 语法。
 */
export function pasteImageSnippet(assetPath: string, widthPercent = PASTE_IMAGE_WIDTH_PERCENT): string {
  const p = String(assetPath || '').trim()
  if (!p) return ''
  const width = Math.max(1, Math.min(100, Math.round(widthPercent)))
  const px = Math.max(1, Math.round((width / 100) * 1280))
  return `![w:${px}px](${p})`
}
