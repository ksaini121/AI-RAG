import {
  ALLOWED_EXTENSIONS,
  MAX_FILENAME_LENGTH,
  MAX_UPLOAD_BYTES,
  MIN_FILENAME_LENGTH,
} from './constants'

/** Convenience pre-check only; returns a message or null. The server is authoritative. */
export function precheck(file: File): string | null {
  const name = file.name.toLowerCase()
  if (!ALLOWED_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    return `Unsupported file type. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `File is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`
  }
  if (file.name.length < MIN_FILENAME_LENGTH || file.name.length > MAX_FILENAME_LENGTH) {
    return `File name must be ${MIN_FILENAME_LENGTH}–${MAX_FILENAME_LENGTH} characters`
  }
  return null
}
