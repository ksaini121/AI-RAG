import { Link, Navigate, useNavigate } from 'react-router-dom'
import { AuthForm } from '../components/AuthForm'
import { useAuth } from './AuthProvider'

export function RegisterPage() {
  const { status, register } = useAuth()
  const navigate = useNavigate()

  if (status === 'authed') return <Navigate to="/" replace />

  return (
    <AuthForm
      title="Create account"
      submitLabel="Register"
      fields={[
        { name: 'name', label: 'Name', autoComplete: 'name' },
        { name: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
        { name: 'password', label: 'Password', type: 'password', autoComplete: 'new-password' },
      ]}
      onSubmit={async (v) => {
        await register(v.name ?? '', v.email ?? '', v.password ?? '')
        navigate('/', { replace: true })
      }}
      footer={
        <>
          Have an account?{' '}
          <Link className="underline" to="/login">
            Sign in
          </Link>
        </>
      }
    />
  )
}
