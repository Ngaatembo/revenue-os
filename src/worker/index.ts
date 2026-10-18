import { googleSheetsOAuthReady, oauthNotConfiguredResponse, type GoogleSheetsOAuthEnv } from './googleSheetsConfig'

interface AssetBinding { fetch(request: Request): Promise<Response> }
interface Env extends GoogleSheetsOAuthEnv {
  ASSETS: AssetBinding
  /** Public project URL, e.g. https://<ref>.supabase.co (non-secret, set in wrangler.jsonc `vars`). */
  SUPABASE_URL?: string
  /** Publishable/anon key only (never the service-role key). Set as a Cloudflare variable or secret. */
  SUPABASE_ANON_KEY?: string
}

function json(body: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

/** Read-only reachability probe of Supabase Auth. It performs no database reads or writes. */
async function checkSupabase(env: Env): Promise<Response> {
  const base = env.SUPABASE_URL?.replace(/\/$/, '')
  if (!base || !env.SUPABASE_ANON_KEY) return json({ status: 'degraded', supabase: 'not_configured' }, 503)
  try {
    const response = await fetch(`${base}/auth/v1/health`, {
      headers: { apikey: env.SUPABASE_ANON_KEY },
      signal: AbortSignal.timeout(5000),
    })
    return response.ok
      ? json({ status: 'ok', supabase: 'reachable' })
      : json({ status: 'degraded', supabase: 'unavailable' }, 503)
  } catch {
    return json({ status: 'degraded', supabase: 'unavailable' }, 503)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname.startsWith('/api/integrations/google/')) {
      if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405)
      // Fail closed until the OAuth client, encryption key, one-time state KV, and
      // server-only database credential are configured. Never fake a connected status.
      if (!googleSheetsOAuthReady(env)) return oauthNotConfiguredResponse()
      // The secure OAuth handlers are enabled only in a subsequent change after the
      // deployment's secrets/bindings and integration tests are in place.
      return json({ error: 'google_sheets_handler_not_enabled' }, 503)
    }

    if (url.pathname === '/api/health') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405)
      return checkSupabase(env)
    }

    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'Not found' }, 404)
    }

    return env.ASSETS.fetch(request)
  },
}
