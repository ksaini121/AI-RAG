import {
  accessTokenNeedsRefresh,
  API_BASE,
  getAccessToken,
  hasStoredSession,
  refreshSession,
} from '../auth/tokens'
import { NetworkError, parseDetail } from './errors'

export { ApiError, NetworkError } from './errors'

interface FetchOptions extends Omit<RequestInit, 'body'> {
  /** Send the bearer token and retry once on 401. Default true. */
  auth?: boolean
  json?: unknown
  body?: BodyInit | null
}

/**
 * fetch with auth: refreshes proactively before expiry, and once on a 401. Returns the raw
 * Response so streaming callers (SSE) can share the same auth handling as `request`.
 */
export async function authFetch(path: string, opts: FetchOptions = {}): Promise<Response> {
  const { auth = true, json, headers, body, ...rest } = opts

  const send = async (): Promise<Response> => {
    const h = new Headers(headers)
    if (json !== undefined) h.set('Content-Type', 'application/json')
    const token = getAccessToken()
    if (auth && token) h.set('Authorization', `Bearer ${token}`)
    try {
      return await fetch(`${API_BASE}${path}`, {
        ...rest,
        headers: h,
        body: json !== undefined ? JSON.stringify(json) : body,
      })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      throw new NetworkError()
    }
  }

  if (auth && hasStoredSession() && accessTokenNeedsRefresh()) {
    if ((await refreshSession()) === 'network') throw new NetworkError()
  }

  const res = await send()
  if (auth && res.status === 401 && hasStoredSession()) {
    if ((await refreshSession()) === 'ok') return send()
  }
  return res
}

export async function request<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  const res = await authFetch(path, opts)
  if (!res.ok) {
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      // non-JSON error body
    }
    throw parseDetail(res.status, body)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}
