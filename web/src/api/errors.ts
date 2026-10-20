export class ApiError extends Error {
  code: string
  status: number
  detail?: string

  constructor(code: string, message: string, status = 0, detail?: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

export function readableError(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}
