import assert from 'node:assert/strict'
import test from 'node:test'
import worker from '../index.ts'

const assets = { fetch: async () => new Response('asset') }
const env = { ASSETS: assets, SUPABASE_URL: 'https://example.supabase.co/', SUPABASE_ANON_KEY: 'sb_publishable_test' }
const get = (path: string, method = 'GET') => new Request('https://app.test' + path, { method })

test('health: reachable Supabase -> 200 and only a GET to auth health with the public key', async () => {
  const original = globalThis.fetch
  const calls: Array<{ url: string; apikey: string | null }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), apikey: new Headers(init?.headers).get('apikey') })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  try {
    const response = await worker.fetch(get('/api/health'), env)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: 'ok', supabase: 'reachable' })
    assert.deepEqual(calls, [{ url: 'https://example.supabase.co/auth/v1/health', apikey: 'sb_publishable_test' }])
  } finally { globalThis.fetch = original }
})

test('health: Supabase error or network failure -> 503 without leaking details', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = (async () => new Response('x', { status: 500 })) as typeof fetch
    assert.equal((await worker.fetch(get('/api/health'), env)).status, 503)
    globalThis.fetch = (async () => { throw new Error('secret internal detail') }) as typeof fetch
    const response = await worker.fetch(get('/api/health'), env)
    assert.equal(response.status, 503)
    assert.doesNotMatch(await response.text(), /secret internal detail/)
  } finally { globalThis.fetch = original }
})

test('health: missing configuration -> 503 not_configured and no outbound request', async () => {
  const original = globalThis.fetch
  let called = false
  globalThis.fetch = (async () => { called = true; return new Response('{}') }) as typeof fetch
  try {
    const response = await worker.fetch(get('/api/health'), { ASSETS: assets })
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { status: 'degraded', supabase: 'not_configured' })
    assert.equal(called, false)
  } finally { globalThis.fetch = original }
})

test('routing: non-GET health is 405, unknown /api is 404, everything else serves assets', async () => {
  assert.equal((await worker.fetch(get('/api/health', 'POST'), env)).status, 405)
  assert.equal((await worker.fetch(get('/api/nope'), env)).status, 404)
  assert.equal(await (await worker.fetch(get('/dashboard'), env)).text(), 'asset')
})
