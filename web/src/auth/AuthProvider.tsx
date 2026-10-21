import { useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { request } from '../api/client'
import type { LoginResponse, User } from '../api/types'
import {
  clearSession,
  getRefreshToken,
  hasStoredSession,
  onSessionExpired,
  refreshSession,
  setSession,
} from './tokens'

type Status = 'loading' | 'authed' | 'anon' | 'unreachable'

interface AuthValue {
  status: Status
  user: User | null
  login: (email: string, password: string) => Promise<void>
  register: (name: string, email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  retry: () => void
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<Status>(hasStoredSession() ? 'loading' : 'anon')
  const [user, setUser] = useState<User | null>(null)
  const [attempt, setAttempt] = useState(0)

  const toAnon = useCallback(() => {
    setUser(null)
    setStatus('anon')
    queryClient.clear()
  }, [queryClient])

  // Hydrate: a stored refresh token -> new access token -> current user. The refresh is
  // single-flight at module level, so StrictMode's double effect does not spend the token twice.
  useEffect(() => {
    if (!hasStoredSession()) return
    let cancelled = false
    void (async () => {
      const result = await refreshSession()
      if (cancelled) return
      if (result === 'rejected') return toAnon()
      if (result === 'network') return setStatus('unreachable')
      try {
        const me = await request<User>('/users/me')
        if (cancelled) return
        setUser(me)
        setStatus('authed')
      } catch {
        if (!cancelled) setStatus('unreachable')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [attempt, toAnon])

  useEffect(() => onSessionExpired(toAnon), [toAnon])

  const login = useCallback(async (email: string, password: string) => {
    const res = await request<LoginResponse>('/users/login', {
      method: 'POST',
      json: { email, password },
      auth: false,
    })
    setSession(res)
    setUser(res.user)
    setStatus('authed')
  }, [])

  const register = useCallback(
    async (name: string, email: string, password: string) => {
      await request<User>('/users/', {
        method: 'POST',
        json: { name, email, password },
        auth: false,
      })
      await login(email, password)
    },
    [login],
  )

  const logout = useCallback(async () => {
    const refresh = getRefreshToken()
    if (refresh) {
      try {
        await request('/users/logout', {
          method: 'POST',
          json: { refresh_token: refresh },
          auth: false,
        })
      } catch {
        // revocation is best-effort; the local session is cleared regardless
      }
    }
    clearSession() // removing the key also signs out other tabs via the storage event
    toAnon()
  }, [toAnon])

  const value = useMemo<AuthValue>(
    () => ({
      status,
      user,
      login,
      register,
      logout,
      retry: () => {
        setStatus('loading')
        setAttempt((n) => n + 1)
      },
    }),
    [status, user, login, register, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
