import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'

const link = ({ isActive }: { isActive: boolean }) =>
  `rounded px-3 py-1.5 text-sm ${isActive ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-200'}`

export function Layout() {
  const { user, logout } = useAuth()
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center gap-2 border-b bg-white px-4 py-2">
        <span className="mr-4 font-semibold">RAG Chat</span>
        <nav className="flex gap-1">
          <NavLink to="/chat" className={link}>
            Chat
          </NavLink>
          <NavLink to="/documents" className={link}>
            Documents
          </NavLink>
        </nav>
        <span className="ml-auto text-sm text-slate-500">{user?.email}</span>
        <button
          className="rounded px-3 py-1.5 text-sm hover:bg-slate-200"
          onClick={() => void logout()}
        >
          Sign out
        </button>
      </header>
      <div className="flex-1">
        <Outlet />
      </div>
    </div>
  )
}
