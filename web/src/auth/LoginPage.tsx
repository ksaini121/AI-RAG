import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { AuthForm } from '../components/AuthForm'
import { useAuth } from './AuthProvider'

export function LoginPage() {
  const { status, login } = useAuth()
  const navigate = useNavigate()
  const from = (useLocation().state as { from?: { pathname: string } } | null)?.from?.pathname

  if (status === 'authed') return <Navigate to={from ?? '/'} replace />

  return (
    <AuthForm
      title="Sign in"
      submitLabel="Sign in"
      fields={[
        { name: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
        { name: 'password', label: 'Password', type: 'password', autoComplete: 'current-password' },
      ]}
      onSubmit={async (v) => {
        await login(v.email ?? '', v.password ?? '')
        navigate(from ?? '/', { replace: true })
      }}
      footer={
        <>
          No account?{' '}
          <Link className="underline" to="/register">
            Register
          </Link>
        </>
      }
    />
  )
}
