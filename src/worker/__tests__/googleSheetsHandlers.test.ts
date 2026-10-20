import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encryptRefreshToken } from '../googleSheetsCrypto.ts'
import { handleGoogleSheets } from '../googleSheetsHandlers.ts'

const KEY = '0123456789abcdef'.repeat(4)
const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon-test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-test',
  APP_ORIGIN: 'https://app.example',
  GOOGLE_CLIENT_ID: 'google-client-id',
  GOOGLE_CLIENT_SECRET: 'google-client-secret',
  GOOGLE_TOKEN_ENCRYPTION_KEY: KEY,
} as Parameters<typeof handleGoogleSheets>[1]

const header = ['customer_id', 'customer_name', 'invoice_number', 'currency', 'total_amount', 'paid_amount', 'issued_at', 'due_at']
const goodRow = ['c-1', 'Synthetic Customer', 'INV-1', 'USD', '120.50', '20', '2026-10-01', '2026-10-31']

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

function mockFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url)
    return handler(url, init)
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

async function connectedToken() {
  return encryptRefreshToken('synthetic-refresh-token', KEY)
}

function syncRequest() {
  return new Request('https://app.example/api/integrations/google/sync', {
    method: 'POST',
    headers: { Authorization: 'Bearer valid-test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ organization_id: 'org-1', spreadsheet_id: 'spreadsheet12345', range: 'Invoices!A:H' }),
  })
}

function baseMock(encryptedToken: string, sheetValues: unknown[][], onCall?: (url: URL, init?: RequestInit) => Response | null) {
  const calls: Array<{ url: URL; init?: RequestInit }> = []
  const restore = mockFetch(async (url, init) => {
    calls.push({ url, init })
    const overridden = onCall?.(url, init)
    if (overridden) return overridden
    if (url.pathname === '/auth/v1/user') return json({ id: 'auth-user-1', email: 'owner@example.test' })
    if (url.pathname === '/rest/v1/users') return json([{ id: 'internal-user-1' }])
    if (url.pathname === '/rest/v1/memberships') return json([{ organization_id: 'org-1', user_id: 'internal-user-1', role: 'owner' }])
    if (url.pathname === '/rest/v1/source_sync_runs' && init?.method === 'POST') return json([])
    if (url.pathname === '/rest/v1/provider_connections' && (!init?.method || init.method === 'GET')) {
      return json([{ status: 'connected', encrypted_refresh_token: encryptedToken }])
    }
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') return json({ access_token: 'synthetic-access-token' })
    if (url.hostname === 'sheets.googleapis.com' && url.pathname.includes('/values/')) return json({ values: sheetValues })
    if (url.pathname === '/rest/v1/rpc/persist_invoice_import') return json({ accepted_rows: 1, rejected_rows: 0, duplicate: false, import_id: 'import-1' })
    if (url.pathname === '/rest/v1/rpc/complete_source_sync_snapshot') return json({ reconciled: true, accepted_rows: 1, rejected_rows: 0, missing_for_review: 0 })
    if (url.pathname === '/rest/v1/provider_connections' && init?.method === 'PATCH') return json([])
    throw new Error('Unexpected fetch: ' + url.toString() + ' method=' + (init?.method ?? 'GET'))
  })
  return { calls, restore }
}

test('Google Sheets sync persists validated rows and advances last-success only after complete reconciliation', async () => {
  const encrypted = await connectedToken()
  const { calls, restore } = baseMock(encrypted, [header, goodRow])
  try {
    const response = await handleGoogleSheets(syncRequest(), env)
    assert.equal(response.status, 200)
    const payload = await response.json() as { status: string; accepted_rows: number; rejected_rows: number; reconciliation: { reconciled: boolean } }
    assert.equal(payload.status, 'synced')
    assert.equal(payload.accepted_rows, 1)
    assert.equal(payload.rejected_rows, 0)
    assert.equal(payload.reconciliation.reconciled, true)

    const persisted = calls.find((call) => call.url.pathname === '/rest/v1/rpc/persist_invoice_import')
    assert.ok(persisted, 'invoice import RPC should be called')
    const persistedBody = JSON.parse(String(persisted.init?.body)) as { source_id: string; rows: Array<{ id: string; invoiceNumber: string }> }
    assert.equal(persistedBody.source_id, 'google_sheets:spreadsheet12345')
    assert.equal(persistedBody.rows[0].id, 'google_sheets:spreadsheet12345:INV-1')
    assert.equal(persistedBody.rows[0].invoiceNumber, 'INV-1')

    const finalized = calls.find((call) => call.url.pathname === '/rest/v1/rpc/complete_source_sync_snapshot')
    assert.ok(finalized, 'snapshot completion RPC should be called')
    const finalBody = JSON.parse(String(finalized.init?.body)) as { p_accepted_rows: number; p_rejected_rows: number; p_invoice_ids: string[] }
    assert.equal(finalBody.p_accepted_rows, 1)
    assert.equal(finalBody.p_rejected_rows, 0)
    assert.deepEqual(finalBody.p_invoice_ids, ['google_sheets:spreadsheet12345:INV-1'])

    const connectionPatch = calls.find((call) => call.url.pathname === '/rest/v1/provider_connections' && call.init?.method === 'PATCH')
    assert.ok(connectionPatch, 'connection status should be updated')
    const connectionBody = JSON.parse(String(connectionPatch.init?.body)) as { last_successful_sync_at?: string; last_error_code?: string | null }
    assert.equal(typeof connectionBody.last_successful_sync_at, 'string')
    assert.equal(connectionBody.last_error_code, null)
  } finally {
    restore()
  }
})

test('partially rejected sheet rows never advance last-successful-sync or reconcile missing rows', async () => {
  const encrypted = await connectedToken()
  const invalidRow = ['c-2', 'Bad Customer', 'INV-2', 'USD', '10', '11', '2026-10-01', '2026-10-31']
  const calls: Array<{ url: URL; init?: RequestInit }> = []
  const { restore } = baseMock(encrypted, [header, goodRow, invalidRow], (url, init) => {
    calls.push({ url, init })
    if (url.pathname === '/rest/v1/rpc/persist_invoice_import') return json({ accepted_rows: 1, rejected_rows: 1, duplicate: false, import_id: 'import-2' })
    if (url.pathname === '/rest/v1/rpc/complete_source_sync_snapshot') return json({ reconciled: false, reason: 'rejected_rows', accepted_rows: 1, rejected_rows: 1, missing_for_review: 0 })
    return null
  })
  try {
    const response = await handleGoogleSheets(syncRequest(), env)
    assert.equal(response.status, 200)
    const payload = await response.json() as { status: string; rejected_rows: number; reconciliation: { reconciled: boolean } }
    assert.equal(payload.status, 'synced_with_errors')
    assert.equal(payload.rejected_rows, 1)
    assert.equal(payload.reconciliation.reconciled, false)
    const connectionPatch = calls.find((call) => call.url.pathname === '/rest/v1/provider_connections' && call.init?.method === 'PATCH')
    assert.ok(connectionPatch, 'connection error should be recorded')
    const connectionBody = JSON.parse(String(connectionPatch.init?.body)) as { last_successful_sync_at?: string; last_error_code?: string }
    assert.equal(connectionBody.last_successful_sync_at, undefined)
    assert.equal(connectionBody.last_error_code, 'snapshot_rejected_rows')
  } finally {
    restore()
  }
})

test('failure to create a source snapshot run is surfaced and never recorded as a successful sync', async () => {
  const encrypted = await connectedToken()
  const calls: Array<{ url: URL; init?: RequestInit }> = []
  const { restore } = baseMock(encrypted, [header, goodRow], (url, init) => {
    calls.push({ url, init })
    if (url.pathname === '/rest/v1/source_sync_runs' && init?.method === 'POST') return json({ message: 'relation does not exist' }, 404)
    return null
  })
  try {
    const response = await handleGoogleSheets(syncRequest(), env)
    assert.equal(response.status, 502)
    const payload = await response.json() as { error: string }
    assert.equal(payload.error, 'database_request_failed')
    const connectionPatch = calls.find((call) => call.url.pathname === '/rest/v1/provider_connections' && call.init?.method === 'PATCH')
    assert.ok(connectionPatch, 'connection error should be recorded')
    const connectionBody = JSON.parse(String(connectionPatch.init?.body)) as { last_successful_sync_at?: string; last_error_code?: string }
    assert.equal(connectionBody.last_successful_sync_at, undefined)
    assert.equal(connectionBody.last_error_code, 'database_request_failed')
  } finally {
    restore()
  }
})
