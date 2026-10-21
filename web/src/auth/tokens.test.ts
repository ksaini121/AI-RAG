import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSession, getRefreshToken, refreshSession, setSession } from './tokens'

const pair = (n: number) => ({
  access_token: `a${n}`,
  refresh_token: `r${n}`,
  token_type: 'bearer',
  expires_in: 900,
})

beforeEach(() => {
  clearSession()
  vi.restoreAllMocks()
})

describe('refreshSession', () => {
  it('collapses concurrent calls into one request', async () => {
    setSession(pair(1))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(pair(2)), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const results = await Promise.all([refreshSession(), refreshSession(), refreshSession()])

    expect(results).toEqual(['ok', 'ok', 'ok'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getRefreshToken()).toBe('r2')
  })

  it('clears the session when the refresh token is rejected', async () => {
    setSession(pair(1))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 })),
    )

    expect(await refreshSession()).toBe('rejected')
    expect(getRefreshToken()).toBeNull()
  })

  it('keeps the session on a network error', async () => {
    setSession(pair(1))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('offline'))),
    )

    expect(await refreshSession()).toBe('network')
    expect(getRefreshToken()).toBe('r1')
  })
})
