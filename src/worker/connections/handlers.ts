import { authenticate, db, membership, response } from '../googleSheetsHandlers.ts'
import { revokeGoogleToken } from './google.ts'
import { runConnectionSync, type RunnerEnv } from './runner.ts'

type Json = Record<string, unknown>
interface Env extends RunnerEnv { SUPABASE_ANON_KEY?: string; APP_ORIGIN?: string }
const PROVIDERS = ['gmail', 'google_sheets']

/** Provider-neutral connection routes: sync now, disconnect. Status is read by members straight from list_connection_status(). */
export async function handleConnections(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  if (env.APP_ORIGIN && env.APP_ORIGIN !== url.origin) return response({ error: 'app_origin_not_allowed' }, 403)
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
    if (provider !== 'gmail') return response({ error: 'provider_not_syncable', message: 'Google Sheets is synced from its own card.' }, 400)
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
