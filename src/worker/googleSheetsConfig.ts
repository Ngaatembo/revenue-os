/** Server-side configuration guard for Google Sheets OAuth. */
export interface GoogleSheetsOAuthEnv {
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  GOOGLE_TOKEN_ENCRYPTION_KEY?: string
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  APP_ORIGIN?: string
}

export function googleSheetsOAuthReady(env: GoogleSheetsOAuthEnv): boolean {
  return Boolean(
    env.GOOGLE_CLIENT_ID?.trim() &&
    env.GOOGLE_CLIENT_SECRET?.trim() &&
    /^[a-f0-9]{64}$/i.test(env.GOOGLE_TOKEN_ENCRYPTION_KEY?.trim() ?? '') &&
    env.APP_ORIGIN?.trim() &&
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
