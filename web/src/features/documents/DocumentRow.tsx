import type { Document } from '../../api/types'
import { StatusBadge } from './StatusBadge'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function DocumentRow({
  doc,
  onDelete,
  deleting,
}: {
  doc: Document
  onDelete: (doc: Document) => void
  deleting: boolean
}) {
  return (
    <tr className="border-t align-top">
      <td className="px-3 py-2 break-all">{doc.filename}</td>
      <td className="px-3 py-2 whitespace-nowrap text-slate-600">{formatSize(doc.size_bytes)}</td>
      <td className="px-3 py-2 text-slate-600">{doc.status === 'ready' ? doc.chunk_count : '—'}</td>
      <td className="px-3 py-2 whitespace-nowrap text-slate-600">
        {new Date(doc.created_at).toLocaleString()}
      </td>
      <td className="px-3 py-2">
        <StatusBadge status={doc.status} error={doc.error} />
      </td>
      <td className="px-3 py-2 text-right">
        <button
          className="rounded px-2 py-1 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
          disabled={deleting}
          onClick={() => onDelete(doc)}
        >
          Delete
        </button>
      </td>
    </tr>
  )
}
