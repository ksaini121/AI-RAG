import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from './AuthProvider'

export function RequireAuth() {
  const { status, retry } = useAuth()
  const location = useLocation()

  if (status === 'loading') return <p className="p-8 text-slate-500">Loading…</p>
  if (status === 'unreachable') {
    return (
      <div className="p-8" role="alert">
        <p className="mb-3">Cannot reach the API.</p>
        <button className="rounded bg-slate-900 px-3 py-1.5 text-white" onClick={retry}>
          Retry
        </button>
      </div>
    )
  }
  if (status === 'anon') return <Navigate to="/login" replace state={{ from: location }} />
  return <Outlet />
}
