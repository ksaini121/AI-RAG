import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Document } from '../../api/types'
import { deleteDocument, listDocuments } from './api'
import { isTerminal, POLL_INTERVAL_MS, POLL_MAX_INTERVAL_MS } from './constants'

export const documentsKey = ['documents'] as const

/** One list request; polls every 2 s while some document is ingesting and none has failed. */
export function useDocuments() {
  return useQuery({
    queryKey: documentsKey,
    queryFn: listDocuments,
    refetchInterval: (query) => {
      const docs = query.state.data
      if (!docs?.some((d) => !isTerminal(d.status))) return false
      // A failed ingestion stops polling altogether, even if other documents are still running.
      if (docs.some((d) => d.status === 'failed')) return false
      // Back off while requests are failing instead of hammering a struggling API.
      const failures = query.state.fetchFailureCount + query.state.errorUpdateCount
      return Math.min(POLL_INTERVAL_MS * 2 ** failures, POLL_MAX_INTERVAL_MS)
    },
  })
}

export function useDeleteDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: deleteDocument,
    onMutate: async (id: string) => {
      await qc.cancelQueries({ queryKey: documentsKey })
      const previous = qc.getQueryData<Document[]>(documentsKey)
      qc.setQueryData<Document[]>(documentsKey, (docs) => docs?.filter((d) => d.id !== id))
      return { previous }
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(documentsKey, ctx.previous)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: documentsKey }),
  })
}
