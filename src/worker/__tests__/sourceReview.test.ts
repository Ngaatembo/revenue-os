import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleGoogleSheets } from '../googleSheetsHandlers.ts'

const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon-test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-test',
  APP_ORIGIN: 'https://app.example',
} as Parameters<typeof handleGoogleSheets>[1]

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

function mockFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    return handler(new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url), init)
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

test('source review requires authentication', async () => {
  const restore = mockFetch(() => { throw new Error('fetch should not be called') })
  try {
    const response = await handleGoogleSheets(new Request('https://app.example/api/integrations/google/source-review?organization_id=org-1'), env)
    assert.equal(response.status, 401)
    assert.equal((await response.json() as { error: string }).error, 'unauthorized')
  } finally { restore() }
})

test('source review is restricted to owner/admin members', async () => {
  const restore = mockFetch((url) => {
    if (url.pathname === '/auth/v1/user') return json({ id: 'auth-user-1', email: 'operator@example.test' })
    if (url.pathname === '/rest/v1/users') return json([{ id: 'internal-user-1' }])
    if (url.pathname === '/rest/v1/memberships') return json([{ organization_id: 'org-1', user_id: 'internal-user-1', role: 'operator' }])
    throw new Error('Unexpected request: ' + url.pathname)
  })
  try {
    const response = await handleGoogleSheets(new Request('https://app.example/api/integrations/google/source-review?organization_id=org-1', {
      headers: { Authorization: 'Bearer valid-test-token' },
    }), env)
    assert.equal(response.status, 403)
    assert.equal((await response.json() as { error: string }).error, 'workspace_admin_required')
  } finally { restore() }
})

test('owner source review queue includes matching invoice details', async () => {
  const restore = mockFetch((url) => {
    if (url.pathname === '/auth/v1/user') return json({ id: 'auth-user-1', email: 'owner@example.test' })
    if (url.pathname === '/rest/v1/users') return json([{ id: 'internal-user-1' }])
    if (url.pathname === '/rest/v1/memberships') return json([{ organization_id: 'org-1', user_id: 'internal-user-1', role: 'owner' }])
    if (url.pathname === '/rest/v1/source_sync_memberships') return json([{
      organization_id: 'org-1', source_key: 'google_sheets:spreadsheet123', source_range: 'Invoices!A:H',
      invoice_id: 'invoice-1', last_seen_at: '2026-10-20T06:00:00Z', review_state: 'missing_from_source_pending_review', review_note: null,
    }])
    if (url.pathname === '/rest/v1/invoices') return json([{
      id: 'invoice-1', invoice_number: 'INV-100', customer_name: 'Synthetic Customer',
      currency: 'USD', total_minor: 10000, paid_minor: 0, due_at: '2026-10-01T00:00:00Z',
    }])
    throw new Error('Unexpected request: ' + url.pathname)
  })
  try {
    const response = await handleGoogleSheets(new Request('https://app.example/api/integrations/google/source-review?organization_id=org-1', {
      headers: { Authorization: 'Bearer valid-test-token' },
    }), env)
    assert.equal(response.status, 200)
    const payload = await response.json() as { items: Array<{ invoice: { invoice_number: string; customer_name: string } | null }> }
    assert.equal(payload.items.length, 1)
    assert.equal(payload.items[0].invoice?.invoice_number, 'INV-100')
    assert.equal(payload.items[0].invoice?.customer_name, 'Synthetic Customer')
  } finally { restore() }
})

test('source review requires an explicit decision and audit note', async () => {
  const restore = mockFetch((url) => {
    if (url.pathname === '/auth/v1/user') return json({ id: 'auth-user-1', email: 'owner@example.test' })
    if (url.pathname === '/rest/v1/users') return json([{ id: 'internal-user-1' }])
    if (url.pathname === '/rest/v1/memberships') return json([{ organization_id: 'org-1', user_id: 'internal-user-1', role: 'owner' }])
    throw new Error('Unexpected request: ' + url.pathname)
  })
  try {
    const response = await handleGoogleSheets(new Request('https://app.example/api/integrations/google/source-review', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization_id: 'org-1', invoice_id: 'invoice-1', source_key: 'google_sheets:spreadsheet123', source_range: 'Invoices!A:H', resolution: 'settled_elsewhere', note: '   ' }),
    }), env)
    assert.equal(response.status, 400)
    assert.equal((await response.json() as { error: string }).error, 'review_details_required')
  } finally { restore() }
})


test('owner can resolve a pending source review with an auditable decision', async () => {
  let patchedUrl = ''
  let patchedBody: Record<string, unknown> | null = null
  const restore = mockFetch((url, init) => {
    if (url.pathname === '/auth/v1/user') return json({ id: 'auth-user-1', email: 'owner@example.test' })
    if (url.pathname === '/rest/v1/users') return json([{ id: 'internal-user-1' }])
    if (url.pathname === '/rest/v1/memberships') return json([{ organization_id: 'org-1', user_id: 'internal-user-1', role: 'owner' }])
    if (url.pathname === '/rest/v1/source_sync_memberships' && init?.method === 'PATCH') {
      patchedUrl = url.toString()
      patchedBody = JSON.parse(String(init.body)) as Record<string, unknown>
      return json([{ invoice_id: 'invoice-1', review_state: 'resolved' }])
    }
    throw new Error('Unexpected request: ' + url.pathname)
  })
  try {
    const response = await handleGoogleSheets(new Request('https://app.example/api/integrations/google/source-review', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization_id: 'org-1', invoice_id: 'invoice-1', source_key: 'google_sheets:spreadsheet123', source_range: 'Invoices!A:H', resolution: 'settled_elsewhere', note: 'Owner checked the bank statement.' }),
    }), env)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: 'resolved', resolution: 'settled_elsewhere' })
    assert.match(patchedUrl, /organization_id=eq\.org-1/)
    assert.match(patchedUrl, /review_state=eq\.missing_from_source_pending_review/)
    assert.deepEqual(patchedBody && {
      review_state: patchedBody.review_state,
      review_note: patchedBody.review_note,
      reviewed_by: patchedBody.reviewed_by,
      reviewed_at: typeof patchedBody.reviewed_at === 'string',
    }, {
      review_state: 'resolved',
      review_note: '[settled_elsewhere] Owner checked the bank statement.',
      reviewed_by: 'internal-user-1',
      reviewed_at: true,
    })
  } finally { restore() }
})

test('source review does not overwrite an item that is no longer pending', async () => {
  const restore = mockFetch((url, init) => {
    if (url.pathname === '/auth/v1/user') return json({ id: 'auth-user-1', email: 'owner@example.test' })
    if (url.pathname === '/rest/v1/users') return json([{ id: 'internal-user-1' }])
    if (url.pathname === '/rest/v1/memberships') return json([{ organization_id: 'org-1', user_id: 'internal-user-1', role: 'owner' }])
    if (url.pathname === '/rest/v1/source_sync_memberships' && init?.method === 'PATCH') return json([])
    throw new Error('Unexpected request: ' + url.pathname)
  })
  try {
    const response = await handleGoogleSheets(new Request('https://app.example/api/integrations/google/source-review', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization_id: 'org-1', invoice_id: 'invoice-1', source_key: 'google_sheets:spreadsheet123', source_range: 'Invoices!A:H', resolution: 'voided', note: 'Owner confirmed cancellation.' }),
    }), env)
    assert.equal(response.status, 409)
    assert.equal((await response.json() as { error: string }).error, 'source_review_item_not_pending')
  } finally { restore() }
})
