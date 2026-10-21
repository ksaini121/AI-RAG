import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, NetworkError } from '../../api/client'
import type { Document } from '../../api/types'
import { uploadDocument } from './api'
import { DocumentRow } from './DocumentRow'
import { Dropzone } from './Dropzone'
import { precheck } from './precheck'
import { documentsKey, useDeleteDocument, useDocuments } from './useDocuments'

interface UploadItem {
  id: number
  name: string
  progress: number
  error: string | null
  done: boolean
}

let nextId = 0

function messageOf(err: unknown): string {
  if (err instanceof ApiError || err instanceof NetworkError) return err.message
  return 'Upload failed'
}

export function DocumentsPage() {
  const qc = useQueryClient()
  const { data, isPending, error, refetch } = useDocuments()
  const del = useDeleteDocument()
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const controller = useRef(new AbortController())

  // Abort in-flight uploads on unmount. A fresh controller per mount keeps StrictMode's
  // mount/unmount/mount from leaving us with an already-aborted signal.
  useEffect(() => {
    controller.current = new AbortController()
    const c = controller.current
    return () => c.abort()
  }, [])

  const patch = useCallback((id: number, change: Partial<UploadItem>) => {
    setUploads((list) => list.map((u) => (u.id === id ? { ...u, ...change } : u)))
  }, [])

  const startUpload = useCallback(
    async (file: File) => {
      const id = nextId++
      const rejected = precheck(file)
      if (rejected) {
        setUploads((l) => [...l, { id, name: file.name, progress: 0, error: rejected, done: true }])
        return
      }
      setUploads((l) => [...l, { id, name: file.name, progress: 0, error: null, done: false }])
      try {
        const doc = await uploadDocument(
          file,
          (progress) => patch(id, { progress }),
          controller.current.signal,
        )
        qc.setQueryData<Document[]>(documentsKey, (docs) => [doc, ...(docs ?? [])])
        void qc.invalidateQueries({ queryKey: documentsKey })
        // Drop the finished entry; the document now shows in the table.
        setUploads((l) => l.filter((u) => u.id !== id))
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        patch(id, { error: messageOf(err), done: true })
      }
    },
    [patch, qc],
  )

  const onFiles = (files: File[]) => files.forEach((f) => void startUpload(f))

  const onDelete = (doc: Document) => {
    if (!window.confirm(`Delete "${doc.filename}"? This cannot be undone.`)) return
    setDeleteError(null)
    del.mutate(doc.id, {
      onError: (err) => setDeleteError(`Could not delete "${doc.filename}": ${messageOf(err)}`),
    })
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">Documents</h1>
      <Dropzone onFiles={onFiles} />

      {uploads.length > 0 && (
        <ul className="space-y-2">
          {uploads.map((u) => (
            <li key={u.id} className="rounded border bg-white p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="break-all">{u.name}</span>
                {u.error ? (
                  <button
                    className="text-slate-500 hover:text-slate-900"
                    onClick={() => setUploads((l) => l.filter((x) => x.id !== u.id))}
                  >
                    Dismiss
                  </button>
                ) : (
                  <span className="text-slate-500">{u.progress}%</span>
                )}
              </div>
              {u.error ? (
                <p className="mt-1 text-red-700">{u.error}</p>
              ) : (
                <div className="mt-2 h-1.5 rounded bg-slate-200">
                  <div
                    className="h-full rounded bg-slate-900"
                    style={{ width: `${u.progress}%` }}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {deleteError && (
        <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">
          {deleteError}
        </p>
      )}

      {isPending ? (
        <p className="text-slate-500">Loading documents…</p>
      ) : error ? (
        <div role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">
          {error instanceof NetworkError || error instanceof ApiError
            ? error.message
            : 'Could not load documents'}{' '}
          <button className="underline" onClick={() => void refetch()}>
            Retry
          </button>
        </div>
      ) : data.length === 0 ? (
        <p className="text-slate-500">No documents yet. Upload one to get started.</p>
      ) : (
        <div className="overflow-x-auto rounded border bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Size</th>
                <th className="px-3 py-2 font-medium">Chunks</th>
                <th className="px-3 py-2 font-medium">Uploaded</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {data.map((doc) => (
                <DocumentRow
                  key={doc.id}
                  doc={doc}
                  onDelete={onDelete}
                  deleting={del.isPending && del.variables === doc.id}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
