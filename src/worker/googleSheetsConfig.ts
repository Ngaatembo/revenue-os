/**
 * Google Sheets OAuth endpoint contract and configuration guard.
 *
 * The actual OAuth handlers are intentionally not enabled until the deployment has
 * server-only persistence and state storage configured. Returning an honest 503 is safer
 * than accepting OAuth callbacks without replay protection or durable encrypted tokens.
 */
export interface GoogleSheetsOAuthEnv {
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  GOOGLE_TOKEN_ENCRYPTION_KEY?: string
  GOOGLE_OAUTH_STATE?: { get(key: string): Promise<string | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>; delete(key: string): Promise<void> }
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

export function googleSheetsOAuthReady(env: GoogleSheetsOAuthEnv): boolean {
  return Boolean(
    env.GOOGLE_CLIENT_ID?.trim() &&
    env.GOOGLE_CLIENT_SECRET?.trim() &&
    env.GOOGLE_TOKEN_ENCRYPTION_KEY?.trim() &&
    env.GOOGLE_OAUTH_STATE &&
    env.SUPABASE_URL?.trim() &&
    env.SUPABASE_ANON_KEY?.trim() &&
    env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
  )
}

export function oauthNotConfiguredResponse(): Response {
  return new Response(JSON.stringify({
    error: 'google_sheets_not_configured',
    message: 'Google Sheets connection is not configured yet. No connection has been created.',
  }), {
    status: 503,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}
