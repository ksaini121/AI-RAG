import type { TokenPair } from '../api/types'

export const API_BASE = import.meta.env.VITE_API_BASE ?? '/api/v1'

// The refresh token lives in localStorage so a reload keeps the session. That makes it readable
// by any XSS, which is why markdown rendering is strict (no raw HTML, no remote images).
// The access token stays in memory only.
const REFRESH_KEY = 'refresh_token'
const REFRESH_EARLY_MS = 30_000

let accessToken: string | null = null
let expiresAt = 0

function readRefresh(): string | null {
  try {
    return localStorage.getItem(REFRESH_KEY)
  } catch {
    return null
  }
}

function writeRefresh(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(REFRESH_KEY)
    else localStorage.setItem(REFRESH_KEY, token)
  } catch {
    // storage unavailable: the session just won't survive a reload
  }
}

export function hasStoredSession(): boolean {
  return readRefresh() !== null
}

export function getRefreshToken(): string | null {
  return readRefresh()
}

export function getAccessToken(): string | null {
  return accessToken
}

export function setSession(pair: TokenPair): void {
  accessToken = pair.access_token
  expiresAt = Date.now() + pair.expires_in * 1000
  writeRefresh(pair.refresh_token)
}

export function clearSession(): void {
  accessToken = null
  expiresAt = 0
  writeRefresh(null)
}

export function accessTokenNeedsRefresh(): boolean {
  return accessToken === null || Date.now() >= expiresAt - REFRESH_EARLY_MS
}

// ---- refresh -------------------------------------------------------------------------------
// The backend rotates refresh tokens: each one is single-use. So concurrent refreshes must be
// collapsed (module-level promise, which also survives React StrictMode's double effects) and
// serialised across tabs (Web Locks), re-reading storage inside the lock so every tab presents the
// newest token rather than one a sibling tab already spent.

export type RefreshResult = 'ok' | 'rejected' | 'network'

let inflight: Promise<RefreshResult> | null = null

async function doRefresh(): Promise<RefreshResult> {
  const token = readRefresh()
  if (!token) return 'rejected'
  let res: Response
  try {
    res = await fetch(`${API_BASE}/users/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: token }),
    })
  } catch {
    // The server may or may not have rotated; we cannot tell. Keep the session and let the
    // caller retry later rather than logging the user out on a flaky connection.
    return 'network'
  }
  if (res.status === 401) {
    clearSession()
    notifyExpired()
    return 'rejected'
  }
  if (!res.ok) return 'network'
  setSession((await res.json()) as TokenPair)
  return 'ok'
}

export function refreshSession(): Promise<RefreshResult> {
  if (inflight) return inflight
  const run = () => doRefresh()
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  const p = (async (): Promise<RefreshResult> =>
    // The DOM typings model the lock callback as returning T, but a returned promise is awaited.
    locks
      ? await (locks.request('auth-refresh', run) as Promise<unknown> as Promise<RefreshResult>)
      : run())()
  inflight = p.finally(() => {
    inflight = null
  })
  return inflight
}

// ---- session expiry / cross-tab logout ------------------------------------------------------
const expiredListeners = new Set<() => void>()

export function onSessionExpired(fn: () => void): () => void {
  expiredListeners.add(fn)
  return () => expiredListeners.delete(fn)
}

function notifyExpired(): void {
  expiredListeners.forEach((fn) => fn())
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    // Another tab logged out (key removed): drop our in-memory token and follow.
    if (e.key === REFRESH_KEY && e.newValue === null) {
      accessToken = null
      expiresAt = 0
      notifyExpired()
    }
  })
}
