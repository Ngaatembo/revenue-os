import { googleSheetsOAuthReady, oauthNotConfiguredResponse, type GoogleSheetsOAuthEnv } from './googleSheetsConfig.ts'
import { handleGoogleSheets } from './googleSheetsHandlers.ts'
import { handleConnections } from './connections/handlers.ts'
import { runDueSyncs } from './connections/runner.ts'

interface AssetBinding { fetch(request: Request): Promise<Response> }
interface Env extends GoogleSheetsOAuthEnv { ASSETS: AssetBinding; SYNC_MESSAGE_BUDGET?: string }

function json(body: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  })
}

/** Read-only reachability probe of Supabase Auth. */
async function checkSupabase(env: Env): Promise<Response> {
  const base = env.SUPABASE_URL?.replace(/\/$/, '')
  if (!base || !env.SUPABASE_ANON_KEY) return json({ status: 'degraded', supabase: 'not_configured' }, 503)
  try {
    const response = await fetch(`${base}/auth/v1/health`, {
      headers: { apikey: env.SUPABASE_ANON_KEY },
      signal: AbortSignal.timeout(5000),
    })
    return response.ok ? json({ status: 'ok', supabase: 'reachable' }) : json({ status: 'degraded', supabase: 'unavailable' }, 503)
  } catch {
    return json({ status: 'degraded', supabase: 'unavailable' }, 503)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/integrations/google/')) {
      if (!googleSheetsOAuthReady(env)) return oauthNotConfiguredResponse()
      return handleGoogleSheets(request, env)
    }
    if (url.pathname.startsWith('/api/connections/')) {
      if (!googleSheetsOAuthReady(env)) return oauthNotConfiguredResponse()
      return handleConnections(request, env)
    }
    if (url.pathname === '/api/health') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405)
      return checkSupabase(env)
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404)
    return env.ASSETS.fetch(request)
  },
  /** Cron Trigger: keeps connected sources up to date without the owner doing anything. */
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<void> {
    if (!googleSheetsOAuthReady(env)) return
    ctx.waitUntil(runDueSyncs(env).then((r) => console.log(JSON.stringify({ event: 'scheduled_sync', attempted: r.attempted, outcomes: r.results.map((o) => o.status) }))).catch(() => console.log(JSON.stringify({ event: 'scheduled_sync_failed' }))))
  },
}
