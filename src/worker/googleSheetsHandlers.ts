import type { GoogleSheetsOAuthEnv } from './googleSheetsConfig.ts'
import { createOAuthState, encryptRefreshToken, hashOAuthState } from './googleSheetsCrypto.ts'

interface Env extends GoogleSheetsOAuthEnv {
  APP_ORIGIN?: string
}

type Json = Record<string, unknown>
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly', 'openid', 'email'].join(' ')

function response(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  } })
}
function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })
}
function base(env: Env) { return env.SUPABASE_URL?.replace(/\/$/, '') }
function serviceHeaders(env: Env) {
  return { apikey: env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/json' }
}
async function db(env: Env, path: string, init: RequestInit = {}) {
  const response = await fetch(`${base(env)}/rest/v1/${path}`, { ...init, headers: { ...serviceHeaders(env), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(8000) })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error('database_request_failed')
  return data
}
function bearer(request: Request) {
  const value = request.headers.get('authorization') ?? ''
  return /^Bearer\s+\S+$/i.test(value) ? value.replace(/^Bearer\s+/i, '') : null
}
async function authenticate(request: Request, env: Env): Promise<{ authId: string; email: string | null } | null> {
  const token = bearer(request)
  if (!token || !base(env) || !env.SUPABASE_ANON_KEY) return null
  const r = await fetch(`${base(env)}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
  if (!r.ok) return null
  const user = await r.json() as Json
  return typeof user.id === 'string' ? { authId: user.id, email: typeof user.email === 'string' ? user.email : null } : null
}
async function membership(env: Env, authId: string, organizationId: string) {
  const users = await db(env, `users?select=id&auth_subject=eq.${encodeURIComponent(authId)}&limit=1`) as Array<{ id: string }>
  if (!users[0]?.id) return null
  const rows = await db(env, `memberships?select=organization_id,user_id,role&organization_id=eq.${encodeURIComponent(organizationId)}&user_id=eq.${encodeURIComponent(users[0].id)}&limit=1`) as Array<{ organization_id: string; user_id: string; role: string }>
  return rows[0] ?? null
}
function safeAppOrigin(request: Request, env: Env) {
  const configured = env.APP_ORIGIN
  const incoming = new URL(request.url).origin
  return configured && configured === incoming ? configured : null
}
function appRedirect(origin: string, result: string) {
  const target = new URL('/', origin)
  target.searchParams.set('google_sheets', result)
  return target.toString()
}
async function tokenRequest(env: Env, values: Record<string, string>) {
  const body = new URLSearchParams({ ...values, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET! })
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10000) })
  const data = await r.json().catch(() => null) as Json | null
  if (!r.ok || !data) throw new Error('google_token_exchange_failed')
  return data
}

/**
 * Server-side Google Sheets OAuth routes. Requires the two provider tables/migration,
 * server-only Supabase service key, encryption key, and exact APP_ORIGIN configuration.
 */
export async function handleGoogleSheets(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const origin = safeAppOrigin(request, env)
  if (!origin) return response({ error: 'app_origin_not_allowed' }, 403)

  if (url.pathname === '/api/integrations/google/start') {
    if (request.method !== 'GET') return response({ error: 'method_not_allowed' }, 405)
    const user = await authenticate(request, env)
    if (!user) return response({ error: 'unauthorized' }, 401)
    const organizationId = url.searchParams.get('organization_id')?.trim()
    if (!organizationId || organizationId.length > 160) return response({ error: 'organization_required' }, 400)
    const member = await membership(env, user.authId, organizationId)
    if (!member) return response({ error: 'workspace_access_denied' }, 403)
    const state = createOAuthState()
    const stateHash = await hashOAuthState(state)
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()
    await db(env, 'provider_oauth_states', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
      state_hash: stateHash, provider: 'google_sheets', organization_id: organizationId,
      user_id: member.user_id, expires_at: expiresAt,
    }) })
    const callback = new URL('/api/integrations/google/callback', url.origin).toString()
    const google = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    google.searchParams.set('client_id', env.GOOGLE_CLIENT_ID!)
    google.searchParams.set('redirect_uri', callback)
    google.searchParams.set('response_type', 'code')
    google.searchParams.set('scope', SCOPES)
    google.searchParams.set('access_type', 'offline')
    google.searchParams.set('prompt', 'consent')
    google.searchParams.set('include_granted_scopes', 'true')
    google.searchParams.set('state', state)
    return redirect(google.toString())
  }

  if (url.pathname === '/api/integrations/google/callback') {
    if (request.method !== 'GET') return response({ error: 'method_not_allowed' }, 405)
    const state = url.searchParams.get('state') ?? ''
    const code = url.searchParams.get('code')
    const providerError = url.searchParams.get('error')
    if (!state || state.length > 64 || providerError || !code || code.length > 4096) {
      return redirect(appRedirect(origin, 'failed'))
    }
    try {
      const stateHash = await hashOAuthState(state)
      const consumed = await db(env, 'rpc/consume_provider_oauth_state', {
        method: 'POST', body: JSON.stringify({ p_state_hash: stateHash }),
      }) as Array<{ provider: string; organization_id: string; user_id: string }>
      const saved = consumed[0]
      if (!saved || saved.provider !== 'google_sheets') return redirect(appRedirect(origin, 'failed'))
      const tokens = await tokenRequest(env, {
        code, grant_type: 'authorization_code',
        redirect_uri: new URL('/api/integrations/google/callback', url.origin).toString(),
      })
      if (typeof tokens.refresh_token !== 'string' || typeof tokens.access_token !== 'string') {
        return redirect(appRedirect(origin, 'failed'))
      }
      const encrypted = await encryptRefreshToken(tokens.refresh_token, env.GOOGLE_TOKEN_ENCRYPTION_KEY!)
      const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(5000),
      })
      const userInfo = userInfoResponse.ok ? await userInfoResponse.json() as Json : {}
      const accountEmail = typeof userInfo.email === 'string' ? userInfo.email.slice(0, 320) : null
      const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(' ').filter((scope) => scope === 'https://www.googleapis.com/auth/spreadsheets.readonly' || scope === 'openid' || scope === 'email') : []
      if (!scopes.includes('https://www.googleapis.com/auth/spreadsheets.readonly')) {
        return redirect(appRedirect(origin, 'failed'))
      }
      await db(env, 'provider_connections?on_conflict=organization_id,provider', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          organization_id: saved.organization_id, provider: 'google_sheets', status: 'connected',
          provider_account_email: accountEmail, encrypted_refresh_token: encrypted,
          granted_scopes: scopes, last_error_code: null, updated_at: new Date().toISOString(),
        }),
      })
      return redirect(appRedirect(origin, 'connected'))
    } catch {
      return redirect(appRedirect(origin, 'failed'))
    }
  }

  if (url.pathname === '/api/integrations/google/status') {
    if (request.method !== 'GET') return response({ error: 'method_not_allowed' }, 405)
    const user = await authenticate(request, env)
    if (!user) return response({ error: 'unauthorized' }, 401)
    const organizationId = url.searchParams.get('organization_id')?.trim()
    if (!organizationId) return response({ error: 'organization_required' }, 400)
    if (!await membership(env, user.authId, organizationId)) return response({ error: 'workspace_access_denied' }, 403)
    const rows = await db(env, `provider_connections?select=status,provider_account_email,granted_scopes,last_successful_sync_at,last_error_code,updated_at&organization_id=eq.${encodeURIComponent(organizationId)}&provider=eq.google_sheets&limit=1`) as Array<Record<string, unknown>>
    return response({ connection: rows[0] ?? { status: 'disconnected' } })
  }

  if (url.pathname === '/api/integrations/google/disconnect') {
    if (request.method !== 'POST') return response({ error: 'method_not_allowed' }, 405)
    const user = await authenticate(request, env)
    if (!user) return response({ error: 'unauthorized' }, 401)
    const body = await request.json().catch(() => null) as Json | null
    const organizationId = typeof body?.organization_id === 'string' ? body.organization_id.trim() : ''
    if (!organizationId) return response({ error: 'organization_required' }, 400)
    const member = await membership(env, user.authId, organizationId)
    if (!member || !['owner', 'admin'].includes(member.role)) return response({ error: 'workspace_admin_required' }, 403)
    await db(env, `provider_connections?organization_id=eq.${encodeURIComponent(organizationId)}&provider=eq.google_sheets`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'disconnected', encrypted_refresh_token: null, granted_scopes: [], updated_at: new Date().toISOString() }),
    })
    return response({ status: 'disconnected' })
  }

  return response({ error: 'not_found' }, 404)
}
