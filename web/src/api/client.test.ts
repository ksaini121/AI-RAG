import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSession, setSession } from '../auth/tokens'
import { request } from './client'
import { ApiError, parseDetail } from './errors'

beforeEach(() => {
  clearSession()
  vi.restoreAllMocks()
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('request', () => {
  it('refreshes once on 401 and retries with the new token', async () => {
    setSession({ access_token: 'old', refresh_token: 'r1', token_type: 'bearer', expires_in: 900 })
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(url)
        if (url.endsWith('/users/refresh')) {
          return json({
            access_token: 'new',
            refresh_token: 'r2',
            token_type: 'bearer',
            expires_in: 900,
          })
        }
        const auth = new Headers(init.headers).get('Authorization')
        return auth === 'Bearer new' ? json({ ok: true }) : json({ detail: 'expired' }, 401)
      }),
    )

    expect(await request('/users/me')).toEqual({ ok: true })
    expect(calls.filter((c) => c.endsWith('/users/refresh'))).toHaveLength(1)
  })

  it('throws ApiError with the detail string', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ detail: 'nope' }, 404)),
    )
    await expect(request('/x', { auth: false })).rejects.toMatchObject({
      status: 404,
      message: 'nope',
    })
  })
})

describe('parseDetail', () => {
  it('maps validation arrays to per-field messages', () => {
    const err = parseDetail(422, {
      detail: [
        { loc: ['body', 'password'], msg: 'Value error, Password must contain at least one digit' },
      ],
    })
    expect(err).toBeInstanceOf(ApiError)
    expect(err.fields.password).toBe('Password must contain at least one digit')
  })
})
