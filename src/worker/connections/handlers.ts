import { authenticate, db, membership, response } from '../googleSheetsHandlers.ts'
import { revokeGoogleToken } from './google.ts'
import { runConnectionSync, syncIntervalMs, type RunnerEnv } from './runner.ts'

type Json = Record<string, unknown>
interface Env extends RunnerEnv { SUPABASE_ANON_KEY?: string; APP_ORIGIN?: string }
const PROVIDERS = ['gmail', 'google_sheets']

/** Provider-neutral connection routes: sync now, disconnect. Status is read by members straight from list_connection_status(). */
export async function handleConnections(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  if (env.APP_ORIGIN && env.APP_ORIGIN !== url.origin) return response({ error: 'app_origin_not_allowed' }, 403)
  if (url.pathname === '/api/connections/readiness') return readiness(request, env, url)
  if (request.method !== 'POST') return response({ error: 'method_not_allowed' }, 405)
  const user = await authenticate(request, env)
  if (!user) return response({ error: 'unauthorized' }, 401)
  const body = await request.json().catch(() => null) as Json | null
  const organizationId = typeof body?.organization_id === 'string' ? body.organization_id.trim() : ''
  const provider = typeof body?.provider === 'string' ? body.provider : ''
  if (!organizationId || organizationId.length > 160) return response({ error: 'organization_required' }, 400)
  if (!PROVIDERS.includes(provider)) return response({ error: 'unknown_provider' }, 400)
  const member = await membership(env, user.authId, organizationId)

  if (url.pathname === '/api/connections/sync') {
    if (!member || !['owner', 'admin', 'operator'].includes(member.role)) return response({ error: 'workspace_permission_denied' }, 403)
    const outcome = await runConnectionSync(env, organizationId, provider, { force: true })
    return response({ outcome })
  }

  if (url.pathname === '/api/connections/disconnect') {
    if (!member || !['owner', 'admin'].includes(member.role)) return response({ error: 'workspace_admin_required' }, 403)
    const rows = await db(env, `provider_connections?select=encrypted_refresh_token&organization_id=eq.${encodeURIComponent(organizationId)}&provider=eq.${provider}&limit=1`) as Array<{ encrypted_refresh_token: string | null }>
    const revoked = rows[0]?.encrypted_refresh_token ? await revokeGoogleToken(rows[0].encrypted_refresh_token, env.GOOGLE_TOKEN_ENCRYPTION_KEY!) : false
    await db(env, `provider_connections?organization_id=eq.${encodeURIComponent(organizationId)}&provider=eq.${provider}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'disconnected', encrypted_refresh_token: null, granted_scopes: [], sync_stage: null, sync_started_at: null, next_sync_at: null, updated_at: new Date().toISOString() }),
    })
    return response({ status: 'disconnected', provider_revoked: revoked })
  }
  return response({ error: 'not_found' }, 404)
}

/**
 * Owner/admin-only configuration check for the deployed Worker. Reports whether each setting is present and
 * well-formed (never its value) and whether background syncing is actually running.
 */
async function readiness(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') return response({ error: 'method_not_allowed' }, 405)
  const user = await authenticate(request, env)
  if (!user) return response({ error: 'unauthorized' }, 401)
  const organizationId = url.searchParams.get('organization_id')?.trim() ?? ''
  if (!organizationId || organizationId.length > 160) return response({ error: 'organization_required' }, 400)
  const member = await membership(env, user.authId, organizationId)
  if (!member || !['owner', 'admin'].includes(member.role)) return response({ error: 'workspace_admin_required' }, 403)
  const present = (value: string | undefined) => Boolean(value?.trim())
  const rows = await db(env, `provider_connections?select=provider,status,last_successful_sync_at,next_sync_at&organization_id=eq.${encodeURIComponent(organizationId)}&status=in.(connected,syncing,needs_attention)`) as Array<{ provider: string; status: string; last_successful_sync_at: string | null; next_sync_at: string | null }>
  const interval = syncIntervalMs(env)
  const newest = rows.map((r) => (r.last_successful_sync_at ? Date.parse(r.last_successful_sync_at) : 0)).reduce((a, b) => Math.max(a, b), 0)
  const ageMinutes = newest ? Math.round((Date.now() - newest) / 60000) : null
  // Healthy connections are re-checked every interval, so a much older "last success" means nothing is running them.
  const cron = rows.length === 0 ? 'no_connection_to_observe' : ageMinutes === null ? 'waiting_for_first_sync' : ageMinutes <= (interval / 60000) * 2 + 3 ? 'running' : 'not_observed_recently'
  return response({
    checks: {
      google_client_id: present(env.GOOGLE_CLIENT_ID),
      google_client_secret: present(env.GOOGLE_CLIENT_SECRET),
      token_encryption_key_valid: /^[a-f0-9]{64}$/i.test(env.GOOGLE_TOKEN_ENCRYPTION_KEY?.trim() ?? ''),
      app_origin_matches_this_request: env.APP_ORIGIN === url.origin,
      supabase_url: present(env.SUPABASE_URL),
      supabase_anon_key: present(env.SUPABASE_ANON_KEY),
      supabase_service_role_key: present(env.SUPABASE_SERVICE_ROLE_KEY),
    },
    google_redirect_uri_to_register: `${url.origin}/api/integrations/google/callback`,
    sync_interval_minutes: interval / 60000,
    message_budget_per_run: Math.max(10, Math.min(500, Number(env.SYNC_MESSAGE_BUDGET) || 100)),
    optional: { whatsapp_webhook_configured: present((env as { WHATSAPP_APP_SECRET?: string }).WHATSAPP_APP_SECRET) && present((env as { WHATSAPP_VERIFY_TOKEN?: string }).WHATSAPP_VERIFY_TOKEN) },
    background_sync: { status: cron, newest_successful_sync_minutes_ago: ageMinutes, connections_observed: rows.length },
  })
}
