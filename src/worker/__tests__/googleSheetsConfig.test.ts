import { test } from 'node:test'
import assert from 'node:assert/strict'
import { googleSheetsOAuthReady, oauthNotConfiguredResponse } from '../googleSheetsConfig.ts'

const completeEnv = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_TOKEN_ENCRYPTION_KEY: 'test-encryption-key',
  GOOGLE_OAUTH_STATE: { async get() { return null }, async put() {}, async delete() {} },
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'public-key',
  SUPABASE_SERVICE_ROLE_KEY: 'server-only-key',
}

test('Google Sheets OAuth is disabled unless every server-side dependency is configured', () => {
  assert.equal(googleSheetsOAuthReady(completeEnv), true)
  assert.equal(googleSheetsOAuthReady({ ...completeEnv, GOOGLE_CLIENT_SECRET: '' }), false)
  assert.equal(googleSheetsOAuthReady({ ...completeEnv, GOOGLE_TOKEN_ENCRYPTION_KEY: undefined }), false)
  assert.equal(googleSheetsOAuthReady({ ...completeEnv, GOOGLE_OAUTH_STATE: undefined }), false)
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
