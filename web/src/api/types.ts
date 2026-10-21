// Hand-written until `npm run generate:types` is wired to a running API.
export interface User {
  id: string
  name: string
  email: string
}

export interface TokenPair {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
}

export interface LoginResponse extends TokenPair {
  user: User
}

export type DocumentStatus = 'pending' | 'parsing' | 'chunking' | 'embedding' | 'ready' | 'failed'

export interface Document {
  id: string
  filename: string
  content_type: string
  size_bytes: number
  status: DocumentStatus
  error: string | null
  chunk_count: number
  created_at: string
  updated_at: string
}
