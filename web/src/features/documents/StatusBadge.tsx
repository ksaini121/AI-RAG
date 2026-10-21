import type { DocumentStatus } from '../../api/types'
import { STATUS_STEPS } from './constants'

export function StatusBadge({ status, error }: { status: DocumentStatus; error: string | null }) {
  if (status === 'failed') {
    return (
      <div>
        <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
          failed
        </span>
        {error && <p className="mt-1 max-w-xs text-xs text-red-700">{error}</p>}
      </div>
    )
  }
  const current = STATUS_STEPS.indexOf(status)
  const ready = status === 'ready'
  return (
    <div>
      <span
        className={`rounded px-2 py-0.5 text-xs font-medium ${
          ready ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'
        }`}
      >
        {status}
      </span>
      <div className="mt-1 flex gap-0.5" aria-hidden="true">
        {STATUS_STEPS.map((step, i) => (
          <span
            key={step}
            className={`h-1 w-5 rounded ${
              i <= current ? (ready ? 'bg-green-500' : 'bg-amber-500') : 'bg-slate-200'
            }`}
          />
        ))}
      </div>
    </div>
  )
}
