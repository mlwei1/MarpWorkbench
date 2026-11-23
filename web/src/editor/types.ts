/** 编辑器/工具栏共享类型（契约 §2.7） */

export type FormatCommand =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'ul'
  | 'ol'
  | 'quote'
  | 'codeblock'
  | 'inlinecode'
  | 'hr'
  | 'math'

export interface EditorApi {
  focus(): void
  getCursorLine(): number
  setCursor(line: number, ch?: number): void
  scrollToLine(line: number): void
  insertText(text: string, opts?: { block?: boolean; atCursor?: boolean }): void
  /** M5：用一次 dispatch 替换 [from,to) 文本（保留撤销历史）；cursorLine 为替换后的目标行（1-based） */
  replaceRange(from: number, to: number, text: string, cursorLine?: number): void
  format(cmd: FormatCommand): void
  undo(): void
  redo(): void
}
