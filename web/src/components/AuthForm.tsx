import { useState } from 'react'
import type { FormEvent } from 'react'
import { ApiError } from '../api/errors'

interface Field {
  name: string
  label: string
  type?: string
  autoComplete?: string
}

interface Props {
  title: string
  submitLabel: string
  fields: Field[]
  onSubmit: (values: Record<string, string>) => Promise<void>
  footer: React.ReactNode
}

export function AuthForm({ title, submitLabel, fields, onSubmit, footer }: Props) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | Error | null>(null)

  async function handle(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSubmit(values)
    } catch (err) {
      setError(err as Error)
    } finally {
      setBusy(false)
    }
  }

  const fieldErrors = error instanceof ApiError ? error.fields : {}
  const generalError = error && Object.keys(fieldErrors).length === 0 ? error.message : null

  return (
    <main className="mx-auto mt-16 max-w-sm rounded-lg bg-white p-6 shadow">
      <h1 className="mb-4 text-xl font-semibold">{title}</h1>
      <form onSubmit={handle} className="space-y-3" noValidate>
        {fields.map((f) => (
          <div key={f.name}>
            <label htmlFor={f.name} className="mb-1 block text-sm font-medium">
              {f.label}
            </label>
            <input
              id={f.name}
              name={f.name}
              type={f.type ?? 'text'}
              autoComplete={f.autoComplete}
              value={values[f.name] ?? ''}
              onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
              aria-invalid={f.name in fieldErrors}
              aria-describedby={f.name in fieldErrors ? `${f.name}-error` : undefined}
              className="w-full rounded border border-slate-300 px-3 py-2"
              required
            />
            {fieldErrors[f.name] && (
              <p id={`${f.name}-error`} className="mt-1 text-sm text-red-600">
                {fieldErrors[f.name]}
              </p>
            )}
          </div>
        ))}
        {generalError && (
          <p role="alert" className="text-sm text-red-600">
            {generalError}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-50"
        >
          {busy ? 'Please wait…' : submitLabel}
        </button>
      </form>
      <p className="mt-4 text-sm text-slate-600">{footer}</p>
    </main>
  )
}
