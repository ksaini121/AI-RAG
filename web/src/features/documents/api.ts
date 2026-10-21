import { request } from '../../api/client'
import { NetworkError, parseDetail } from '../../api/errors'
import type { Document } from '../../api/types'
import {
  accessTokenNeedsRefresh,
  API_BASE,
  getAccessToken,
  hasStoredSession,
  refreshSession,
} from '../../auth/tokens'

export const listDocuments = (): Promise<Document[]> => request<Document[]>('/documents')

export const deleteDocument = (id: string): Promise<void> =>
  request<void>(`/documents/${id}`, { method: 'DELETE' })

interface XhrResult {
  status: number
  body: unknown
}

function sendUpload(
  file: File,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<XhrResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_BASE}/documents`)
    const token = getAccessToken()
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      let body: unknown = null
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        // non-JSON body (e.g. empty or proxy error page)
      }
      resolve({ status: xhr.status, body })
    }
    xhr.onerror = () => reject(new NetworkError())
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    if (signal?.aborted) return xhr.abort()

    const form = new FormData()
    form.append('file', file)
    xhr.send(form)
  })
}

/**
 * Upload with progress. fetch cannot report upload progress, so this uses XHR while keeping the
 * same auth behaviour as `authFetch`: refresh before expiry, and once more after a 401.
 */
export async function uploadDocument(
  file: File,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<Document> {
  if (hasStoredSession() && accessTokenNeedsRefresh()) {
    if ((await refreshSession()) === 'network') throw new NetworkError()
  }
  let res = await sendUpload(file, onProgress, signal)
  if (res.status === 401 && hasStoredSession() && (await refreshSession()) === 'ok') {
    onProgress(0)
    res = await sendUpload(file, onProgress, signal)
  }
  if (res.status < 200 || res.status >= 300) throw parseDetail(res.status, res.body)
  return res.body as Document
}
