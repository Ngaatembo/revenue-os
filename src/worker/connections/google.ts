import { decryptRefreshToken } from '../googleSheetsCrypto.ts'

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface GoogleEnv {
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  GOOGLE_TOKEN_ENCRYPTION_KEY?: string
}

/** Thrown when the provider asks us to slow down. The checkpoint is kept and the sync resumes later. */
export class RateLimitedError extends Error {
  retryAfterSeconds: number
  constructor(retryAfterSeconds: number) { super('provider_rate_limited'); this.retryAfterSeconds = retryAfterSeconds }
}
/** Thrown when the owner revoked access or the refresh token no longer works. Reauthorization is required. */
export class AuthorizationRevokedError extends Error {
  constructor() { super('authorization_revoked') }
}

export async function accessTokenFor(env: GoogleEnv, encryptedRefreshToken: string, fetchFn: FetchFn = fetch): Promise<string> {
  const refreshToken = await decryptRefreshToken(encryptedRefreshToken, env.GOOGLE_TOKEN_ENCRYPTION_KEY!)
  const r = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(10000),
  })
  const body = await r.json().catch(() => null) as { access_token?: string; error?: string } | null
  if (r.ok && typeof body?.access_token === 'string') return body.access_token
  // Only "invalid_grant" means this owner's refresh token was revoked or expired. A rejected client (wrong or rotated
  // secret) affects every workspace and must never wipe stored credentials.
  if (body?.error === 'invalid_grant') throw new AuthorizationRevokedError()
  if (body?.error === 'invalid_client' || body?.error === 'unauthorized_client' || body?.error === 'invalid_request') throw new Error('provider_client_rejected')
  if (r.status === 429) throw new RateLimitedError(120)
  throw new Error('provider_token_refresh_failed')
}

/** Best-effort provider-side revocation, used on disconnect. Failure never blocks local credential removal. */
export async function revokeGoogleToken(encryptedRefreshToken: string, encryptionKey: string, fetchFn: FetchFn = fetch): Promise<boolean> {
  try {
    const token = await decryptRefreshToken(encryptedRefreshToken, encryptionKey)
    const r = await fetchFn('https://oauth2.googleapis.com/revoke', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(8000),
    })
    return r.ok
  } catch { return false }
}

/** Map a Google API response to a typed failure. Returns normally only for ok responses. */
export function assertGoogleOk(r: Response, body: unknown): void {
  if (r.ok) return
  const reason = (body as { error?: { errors?: Array<{ reason?: string }>; status?: string } } | null)?.error
  const reasons = (reason?.errors ?? []).map((e) => e.reason)
  if (r.status === 429 || (r.status === 403 && reasons.some((x) => x === 'rateLimitExceeded' || x === 'userRateLimitExceeded')) || reason?.status === 'RESOURCE_EXHAUSTED') {
    const retry = Number(r.headers.get('retry-after'))
    throw new RateLimitedError(Number.isFinite(retry) && retry > 0 ? Math.min(retry, 3600) : 120)
  }
  if (r.status === 401) throw new AuthorizationRevokedError()
  if (r.status === 403) throw new Error('provider_access_denied')
  if (r.status === 404) throw new Error('provider_not_found')
  throw new Error('provider_request_failed')
}
