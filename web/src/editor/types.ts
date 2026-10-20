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
  format(cmd: FormatCommand): void
  undo(): void
  redo(): void
}
