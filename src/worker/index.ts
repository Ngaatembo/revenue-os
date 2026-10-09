interface AssetBinding { fetch(request: Request): Promise<Response> }
interface D1Statement {
  first<T = Record<string, unknown>>(): Promise<T | null>
}
interface D1Database {
  prepare(query: string): D1Statement
}
interface Env { ASSETS: AssetBinding; DB: D1Database }

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/health') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405)
      try {
        const result = await env.DB.prepare('SELECT 1 AS connected').first<{ connected: number }>()
        if (result?.connected !== 1) throw new Error('D1 health query returned an unexpected result')
        return json({ status: 'ok', database: 'connected' })
      } catch {
        return json({ status: 'degraded', database: 'unavailable' }, 503)
      }
    }

    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'Not found' }, 404)
    }

    return env.ASSETS.fetch(request)
  },
}
