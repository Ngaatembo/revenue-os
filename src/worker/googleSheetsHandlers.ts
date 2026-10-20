import type { GoogleSheetsOAuthEnv } from './googleSheetsConfig.ts'
import { createOAuthState, decryptRefreshToken, encryptRefreshToken, hashOAuthState } from './googleSheetsCrypto.ts'
import { parseSheetInvoiceValues } from './googleSheetsSync.ts'

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
/** Turn safe internal sync codes into next steps a non-technical business owner can act on. */
export function googleSheetsSyncErrorMessage(code: string): string {
  if (code.startsWith('missing_columns:')) {
    const fields = code.slice('missing_columns:'.length).split(',').filter(Boolean).join(', ')
    return fields ? 'Your sheet is missing these invoice fields: ' + fields + '. Add them to the header row, or use the Revenue OS invoice template.' : 'Your sheet is missing required invoice columns. Use the Revenue OS invoice template.'
  }
  if (code.startsWith('ambiguous_sheet_headers:')) return 'Two columns look like the same invoice field. Keep one column for each field and try again.'
  if (code === 'duplicate_sheet_headers') return 'The header row contains duplicate column names. Rename the duplicate columns and try again.'
  if (code === 'sheet_needs_header_and_rows') return 'This range needs a header row followed by at least one invoice row.'
  if (code === 'no_valid_invoice_rows') return 'The headers were recognised, but no invoice rows were valid. Check customer names, invoice numbers, currency, amounts and dates.'
  if (code === 'invalid_spreadsheet_id' || code === 'google_sheet_not_found') return 'We could not find that spreadsheet. Check that the URL or ID is correct.'
  if (code === 'google_sheet_access_denied') return 'Google could not read this sheet. Make sure the connected Google account has at least Viewer access to it.'
  if (code === 'google_token_refresh_failed') return 'Google access has expired or been revoked. Disconnect Google Sheets, reconnect it, and try again.'
  if (code === 'invalid_range') return 'Enter a valid sheet range, such as Invoices!A:H, including the header row.'
  if (code === 'invoice_import_persist_failed') return 'The sheet was read, but Revenue OS could not save the invoices. No successful sync was recorded; try again shortly.'
  if (code === 'duplicate_sheet_headers') return 'The header row contains duplicate column names. Rename the duplicate columns and try again.'
  return 'Google Sheets could not be synced. Check the sheet range, required invoice fields, and access, then try again.'
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
    return response({ authorization_url: google.toString() })
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

  if (url.pathname === '/api/integrations/google/sync') {
    if (request.method !== 'POST') return response({ error: 'method_not_allowed' }, 405)
    const user = await authenticate(request, env)
    if (!user) return response({ error: 'unauthorized' }, 401)
    const body = await request.json().catch(() => null) as Json | null
    const organizationId = typeof body?.organization_id === 'string' ? body.organization_id.trim() : ''
    const spreadsheetId = typeof body?.spreadsheet_id === 'string' ? body.spreadsheet_id.trim() : ''
    const range = typeof body?.range === 'string' ? body.range.trim() : 'A:H'
    if (!organizationId || organizationId.length > 160) return response({ error: 'organization_required' }, 400)
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(spreadsheetId)) return response({ error: 'invalid_spreadsheet_id' }, 400)
    if (!range || range.length > 200 || /[\r\n]/.test(range)) return response({ error: 'invalid_range' }, 400)
    const member = await membership(env, user.authId, organizationId)
    if (!member || !['owner', 'admin', 'operator'].includes(member.role)) return response({ error: 'workspace_permission_denied' }, 403)
    let activeRunId: string | null = null
    const sourceId = `google_sheets:${spreadsheetId}`
    try {
      const runId = crypto.randomUUID()
      activeRunId = runId
      await db(env, 'source_sync_runs', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ organization_id: organizationId, id: runId, source_key: sourceId,
          provider: 'google_sheets', spreadsheet_id: spreadsheetId, source_range: range,
          status: 'started', accepted_rows: 0, rejected_rows: 0 }),
      })
      const connections = await db(env, `provider_connections?select=status,encrypted_refresh_token&organization_id=eq.${encodeURIComponent(organizationId)}&provider=eq.google_sheets&limit=1`) as Array<{ status: string; encrypted_refresh_token: string | null }>
      const connection = connections[0]
      if (!connection || connection.status !== 'connected' || !connection.encrypted_refresh_token) {
        throw new Error('google_sheets_not_connected')
      }
      const refreshToken = await decryptRefreshToken(connection.encrypted_refresh_token, env.GOOGLE_TOKEN_ENCRYPTION_KEY!)
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, refresh_token: refreshToken, grant_type: 'refresh_token' }),
        signal: AbortSignal.timeout(10000),
      })
      const tokenPayload = await tokenResponse.json().catch(() => null) as Json | null
      const accessToken = tokenPayload && typeof tokenPayload.access_token === 'string' ? tokenPayload.access_token : null
      if (!tokenResponse.ok || !accessToken) throw new Error('google_token_refresh_failed')
      const sheetUrl = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`)
      sheetUrl.searchParams.set('majorDimension', 'ROWS')
      sheetUrl.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE')
      const sheetResponse = await fetch(sheetUrl, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15000) })
      const sheetPayload = await sheetResponse.json().catch(() => null) as Json | null
      if (!sheetResponse.ok || !sheetPayload || !Array.isArray(sheetPayload.values)) {
        const reason = sheetResponse.status === 403 ? 'google_sheet_access_denied' : sheetResponse.status === 404 ? 'google_sheet_not_found' : 'google_sheet_read_failed'
        throw new Error(reason)
      }
      const importedAt = new Date().toISOString()
      const parsed = parseSheetInvoiceValues(sheetPayload.values as unknown[][], sourceId, importedAt)
      const canonical = JSON.stringify({ spreadsheetId, range, rows: parsed.rows.map((row) => ({ id: row.id, invoiceNumber: row.invoiceNumber, customerId: row.customerId, customerName: row.customerName, currency: row.currency, totalMinor: row.totalMinor, paidMinor: row.paidMinor, issuedAt: row.issuedAt, dueAt: row.dueAt })) })
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
      const contentHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
      const savedResponse = await fetch(`${base(env)}/rest/v1/rpc/persist_invoice_import`, {
        method: 'POST',
        headers: { apikey: env.SUPABASE_ANON_KEY!, Authorization: `Bearer ${bearer(request)}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          org_id: organizationId, source_id: sourceId, source_name: `Google Sheets ${spreadsheetId}`,
          content_hash: contentHash, rows: parsed.rows, rejected_rows: parsed.rejectedRows,
        }),
        signal: AbortSignal.timeout(15000),
      })
      const saved = await savedResponse.json().catch(() => null) as Json | null
      if (!savedResponse.ok || !saved) throw new Error('invoice_import_persist_failed')
      const finalized = await db(env, 'rpc/complete_source_sync_snapshot', {
        method: 'POST',
        body: JSON.stringify({
          p_organization_id: organizationId, p_run_id: runId, p_source_key: sourceId,
          p_source_range: range, p_spreadsheet_id: spreadsheetId, p_content_digest: contentHash,
          p_invoice_ids: parsed.rows.map((row) => row.id),
          p_accepted_rows: parsed.rows.length, p_rejected_rows: parsed.rejectedRows,
        }),
      }) as Json
      activeRunId = null
      if (parsed.rejectedRows === 0) {
        await db(env, `provider_connections?organization_id=eq.${encodeURIComponent(organizationId)}&provider=eq.google_sheets`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ last_successful_sync_at: importedAt, last_error_code: null, updated_at: importedAt }),
        })
      } else {
        await db(env, `provider_connections?organization_id=eq.${encodeURIComponent(organizationId)}&provider=eq.google_sheets`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ last_error_code: 'snapshot_rejected_rows', updated_at: importedAt }),
        })
      }
      return response({
        status: parsed.rejectedRows === 0 ? 'synced' : 'synced_with_errors',
        accepted_rows: Number(saved.accepted_rows ?? 0), rejected_rows: parsed.rejectedRows,
        duplicate: Boolean(saved.duplicate), reconciliation: finalized,
        import_id: typeof saved.import_id === 'string' ? saved.import_id : '',
      })
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : 'google_sheet_sync_failed'
      const safeCode = /^[a-z0-9_:-]{1,80}$/.test(code) ? code : 'google_sheet_sync_failed'
      if (activeRunId) {
        await db(env, `source_sync_runs?organization_id=eq.${encodeURIComponent(organizationId)}&id=eq.${encodeURIComponent(activeRunId)}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'failed', completed_at: new Date().toISOString(), error_code: safeCode }),
        }).catch(() => undefined)
      }
      await db(env, `provider_connections?organization_id=eq.${encodeURIComponent(organizationId)}&provider=eq.google_sheets`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ last_error_code: safeCode, updated_at: new Date().toISOString() }),
      }).catch(() => undefined)
      const status = safeCode === 'google_sheet_access_denied' ? 403 : safeCode === 'google_sheet_not_found' ? 404 : safeCode.startsWith('missing_columns:') || safeCode.startsWith('ambiguous_sheet_headers:') || ['duplicate_sheet_headers', 'no_valid_invoice_rows', 'sheet_needs_header_and_rows', 'invalid_range'].includes(safeCode) ? 422 : 502
      return response({ error: safeCode, message: googleSheetsSyncErrorMessage(safeCode) }, status)
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
