import type { DocumentStatus } from '../../api/types'

// Mirrors the server's limits (app/schema/document.py, MAX_UPLOAD_BYTES). The server stays
// authoritative; these only give fast feedback before bytes are sent.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
export const MIN_FILENAME_LENGTH = 4
export const MAX_FILENAME_LENGTH = 100

export const ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md', '.csv', '.xlsx'] as const
export const ACCEPT_ATTR = ALLOWED_EXTENSIONS.join(',')

/** Pipeline order; `failed` is a terminal state outside the stepper. */
export const STATUS_STEPS: DocumentStatus[] = [
  'pending',
  'parsing',
  'chunking',
  'embedding',
  'ready',
]

export const isTerminal = (status: DocumentStatus): boolean =>
  status === 'ready' || status === 'failed'

export const POLL_INTERVAL_MS = 2000
export const POLL_MAX_INTERVAL_MS = 15_000
