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
