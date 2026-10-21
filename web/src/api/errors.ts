export class ApiError extends Error {
  status: number
  /** Field name -> message, populated from FastAPI 422 validation responses. */
  fields: Record<string, string>

  constructor(status: number, message: string, fields: Record<string, string> = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.fields = fields
  }
}

interface ValidationItem {
  loc?: unknown[]
  msg?: string
}

/** FastAPI `detail` is a string for HTTPException and an array for validation errors. */
export function parseDetail(status: number, body: unknown): ApiError {
  const detail = (body as { detail?: unknown } | null)?.detail
  if (typeof detail === 'string') return new ApiError(status, detail)
  if (Array.isArray(detail)) {
    const fields: Record<string, string> = {}
    const messages: string[] = []
    for (const item of detail as ValidationItem[]) {
      // Pydantic prefixes validator failures with "Value error, "; show the bare message.
      const msg = (item.msg ?? 'Invalid value').replace(/^Value error, /, '')
      const field = item.loc && item.loc.length > 1 ? String(item.loc[item.loc.length - 1]) : null
      if (field && !(field in fields)) fields[field] = msg
      messages.push(msg)
    }
    return new ApiError(status, messages.join('; '), fields)
  }
  return new ApiError(status, `Request failed (${status})`)
}

export class NetworkError extends Error {
  constructor() {
    super('Cannot reach the API')
    this.name = 'NetworkError'
  }
}
