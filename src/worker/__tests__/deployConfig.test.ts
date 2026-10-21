import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import worker from '../index.ts'

const strip = (text: string) => text.replace(/^\s*\/\/.*$/gm, '')
const wrangler = JSON.parse(strip(readFileSync(new URL('../../../wrangler.jsonc', import.meta.url), 'utf8'))) as {
  name: string; main: string; triggers?: { crons?: string[] }; assets?: { run_worker_first?: string[] }; vars?: Record<string, string>
}

test('the Worker is configured to run background syncs on a Cron Trigger every minute', () => {
  assert.deepEqual(wrangler.triggers?.crons, ['* * * * *'])
  assert.equal(typeof worker.scheduled, 'function', 'the default export must provide scheduled()')
  assert.equal(wrangler.main, 'src/worker/index.ts')
})
test('API routes reach the Worker before static assets', () => { assert.ok(wrangler.assets?.run_worker_first?.includes('/api/*')) })
test('no secret value is committed in wrangler.jsonc', () => {
  const raw = readFileSync(new URL('../../../wrangler.jsonc', import.meta.url), 'utf8')
  assert.deepEqual(Object.keys(wrangler.vars ?? {}).sort(), ['SUPABASE_URL', 'SYNC_INTERVAL_MINUTES', 'SYNC_MESSAGE_BUDGET'])
  assert.equal(wrangler.vars?.SYNC_INTERVAL_MINUTES, '5'); assert.equal(wrangler.vars?.SYNC_MESSAGE_BUDGET, '100')
  assert.equal(/SECRET|SERVICE_ROLE|ENCRYPTION_KEY|CLIENT_ID/i.test(raw.replace(/\/\/.*$/gm, '')), false)
})
test('scheduled() does nothing, and does not throw, when the server is not configured', async () => {
  const pending: Promise<unknown>[] = []
  await worker.scheduled({}, { ASSETS: { fetch: async () => new Response('') } }, { waitUntil: (p) => pending.push(p) })
  assert.equal(pending.length, 0)
})
test('connection routes refuse to run when Google/Supabase settings are missing', async () => {
  const response = await worker.fetch(new Request('https://x.test/api/connections/sync', { method: 'POST' }), { ASSETS: { fetch: async () => new Response('') } })
  assert.equal(response.status, 503)
  const body = await response.json() as { error: string }
  assert.ok(!JSON.stringify(body).includes('secret'))
})
