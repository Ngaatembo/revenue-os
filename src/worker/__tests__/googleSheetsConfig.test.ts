import { test } from 'node:test'
import assert from 'node:assert/strict'
import { googleSheetsOAuthReady, oauthNotConfiguredResponse } from '../googleSheetsConfig.ts'

const completeEnv = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_TOKEN_ENCRYPTION_KEY: '0123456789abcdef'.repeat(4),
  APP_ORIGIN: 'https://revenue-os.example.com',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'public-key',
  SUPABASE_SERVICE_ROLE_KEY: 'server-only-key',
}

test('Google Sheets OAuth requires every server-side secret and a 256-bit encryption key', () => {
  assert.equal(googleSheetsOAuthReady(completeEnv), true)
  assert.equal(googleSheetsOAuthReady({ ...completeEnv, GOOGLE_CLIENT_SECRET: '' }), false)
  assert.equal(googleSheetsOAuthReady({ ...completeEnv, GOOGLE_TOKEN_ENCRYPTION_KEY: 'short' }), false)
  assert.equal(googleSheetsOAuthReady({ ...completeEnv, APP_ORIGIN: '' }), false)
  assert.equal(googleSheetsOAuthReady({ ...completeEnv, SUPABASE_SERVICE_ROLE_KEY: undefined }), false)
})

test('unconfigured OAuth response is explicit, non-cacheable, and does not expose secrets', async () => {
  const response = oauthNotConfiguredResponse()
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json() as Record<string, unknown>
  assert.equal(body.error, 'google_sheets_not_configured')
  assert.equal(JSON.stringify(body).includes('client-secret'), false)
  assert.equal(JSON.stringify(body).includes('server-only-key'), false)
})
