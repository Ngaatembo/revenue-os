import assert from 'node:assert/strict'
import test from 'node:test'
import { encryptRefreshToken } from '../googleSheetsCrypto.ts'
import { runConnectionSync, type RunnerEnv } from '../connections/runner.ts'
import { parseSheetsCursor } from '../connections/sheets.ts'

const KEY = 'ab'.repeat(32)
const HEADER = ['customer_id', 'customer_name', 'invoice_number', 'currency', 'total_amount', 'paid_amount', 'issued_at', 'due_at']
const ROW = ['c1', 'Customer One', 'INV-1', 'USD', 100, 0, '2026-01-01', '2026-02-01']
const ORG = 'org-1'

/** In-memory stand-in for the Supabase REST endpoints the Sheets runner uses, plus Google's token/Drive/Sheets calls. */
async function world(opts: { refresh: Array<'ok' | 'skipped' | 'failed' | 'http_error'> }) {
  const connection = { status: 'connected', sync_cursor: null as string | null, encrypted_refresh_token: await encryptRefreshToken('rt', KEY), provider_account_email: 'o@x.test',
    consecutive_failures: 0, initial_sync_completed_at: null as string | null, records_synced: 0, last_error_code: null as string | null, last_successful_sync_at: null as string | null }
  const refreshAnswers = [...opts.refresh]
  const log = { persist: 0, refresh: 0, patches: [] as Array<Record<string, unknown>> }
  const sheet = { values: [HEADER, ROW] as unknown[][], modified: 't1' }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  const realFetch = globalThis.fetch
  const handler = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input)); const body = init?.body && url.host === 'db.test' ? JSON.parse(String(init.body)) : null
    if (url.host === 'db.test') {
      const path = url.pathname.replace('/rest/v1/', '')
      if (path === 'rpc/claim_connection_sync') return json([{ ...connection }])
      if (path === 'provider_source_selections') return json([{ source_config: { spreadsheet_id: 'sheet1234567', range: "'Invoices'!A:H" } }])
      if (path === 'source_sync_runs') return json([])
      if (path === 'rpc/persist_invoice_import_system') { log.persist += 1; return json({ duplicate: false }) }
      if (path === 'rpc/complete_source_sync_snapshot') return json({ reconciled: true })
      if (path === 'rpc/refresh_org_after_sync') {
        log.refresh += 1
        const next = refreshAnswers.shift() ?? 'ok'
        return next === 'http_error' ? json({ message: 'boom' }, 500) : json(next)
      }
      if (path === 'provider_connections') { log.patches.push(body); Object.assign(connection, body); return json([]) }
    }
    if (url.host === 'oauth2.googleapis.com') return json({ access_token: 'at' })
    if (url.host === 'www.googleapis.com') return json({ modifiedTime: sheet.modified, trashed: false })
    if (url.host === 'sheets.googleapis.com') {
      const m = decodeURIComponent(url.pathname).match(/!([A-Z]+)(\d+):([A-Z]+)(\d+)$/)
      return json({ values: m ? sheet.values.slice(Number(m[2]) - 1, Number(m[4])) : sheet.values })
    }
    return json({}, 404)
  }
  globalThis.fetch = handler as typeof fetch
  const env: RunnerEnv = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_TOKEN_ENCRYPTION_KEY: KEY }
  return { connection, log, sheet, env, restore: () => { globalThis.fetch = realFetch },
    sync: () => runConnectionSync(env, ORG, 'google_sheets', { force: true }) }
}

test('a successful refresh is reported as refreshed and leaves no error behind', async () => {
  const w = await world({ refresh: ['ok'] })
  try {
    const out = await w.sync()
    assert.deepEqual({ ...out }, { status: 'synced', fetched: 1, stored: 1, complete: true, changed: true, insights: 'refreshed' })
    assert.equal(w.connection.last_error_code, null); assert.equal(w.connection.status, 'connected')
    assert.equal(parseSheetsCursor(w.connection.sync_cursor).pendingEvaluation, undefined)
  } finally { w.restore() }
})

test('REGRESSION: a failed opportunity refresh is no longer swallowed — import success and refresh failure are both reported and recorded', async () => {
  for (const failure of ['failed', 'http_error'] as const) {
    const w = await world({ refresh: [failure] })
    try {
      const out = await w.sync()
      assert.equal(out.status, 'synced', 'the import itself succeeded'); assert.equal(out.status === 'synced' && out.insights, 'failed')
      assert.equal(w.connection.last_error_code, 'insight_refresh_failed', 'an actionable code is recorded for the owner')
      assert.ok(w.connection.last_successful_sync_at, 'the import success is still recorded'); assert.ok(w.connection.initial_sync_completed_at)
      assert.equal(w.connection.status, 'connected'); assert.equal(w.connection.consecutive_failures, 0, 'not a provider failure')
      assert.equal(parseSheetsCursor(w.connection.sync_cursor).pendingEvaluation, true, 'a retry is owed')
      assert.equal(w.log.persist, 1)
    } finally { w.restore() }
  }
})

test('REGRESSION: the failed refresh is retried on the next check even though the sheet has not changed, without re-importing', async () => {
  const w = await world({ refresh: ['failed', 'ok'] })
  try {
    await w.sync()
    assert.equal(w.log.refresh, 1)
    const retry = await w.sync() // sheet unchanged: same modified time and content
    assert.equal(w.log.persist, 1, 'no second import'); assert.equal(w.log.refresh, 2, 'the owed refresh ran again')
    assert.equal(retry.status === 'synced' && retry.insights, 'refreshed')
    assert.equal(w.connection.last_error_code, null, 'the error clears once the refresh succeeds')
    assert.equal(parseSheetsCursor(w.connection.sync_cursor).pendingEvaluation, undefined, 'nothing is owed any more')
    const idle = await w.sync()
    assert.equal(w.log.refresh, 2, 'and it does not keep re-running afterwards'); assert.equal(idle.status === 'synced' && idle.insights, 'not_needed')
  } finally { w.restore() }
})

test('REGRESSION: repeated refresh failures escalate to "needs attention" while the data stays imported', async () => {
  const w = await world({ refresh: ['failed', 'failed', 'failed', 'ok'] })
  try {
    await w.sync(); assert.equal(w.connection.status, 'connected')
    await w.sync(); assert.equal(w.connection.status, 'connected')
    await w.sync(); assert.equal(w.connection.status, 'needs_attention'); assert.equal(w.connection.last_error_code, 'insight_refresh_failed')
    assert.equal(w.log.persist, 1, 'the data was imported exactly once throughout')
    await w.sync(); assert.equal(w.connection.status, 'connected'); assert.equal(w.connection.last_error_code, null)
  } finally { w.restore() }
})

test('no recovery rate yet is reported as skipped, with guidance, and is not retried as if it were a failure', async () => {
  const w = await world({ refresh: ['skipped'] })
  try {
    const out = await w.sync()
    assert.equal(out.status === 'synced' && out.insights, 'skipped_no_recovery_rate'); assert.equal(w.connection.last_error_code, 'insights_need_recovery_rate'); assert.equal(w.connection.status, 'connected')
    assert.equal(parseSheetsCursor(w.connection.sync_cursor).pendingEvaluation, undefined)
    await w.sync(); assert.equal(w.log.refresh, 1, 'not re-run on an unchanged sheet')
  } finally { w.restore() }
})

test('a changed sheet imports again and refreshes again', async () => {
  const w = await world({ refresh: ['ok', 'ok'] })
  try {
    await w.sync(); w.sheet.values = [HEADER, ROW, ['c2', 'Customer Two', 'INV-2', 'USD', 50, 0, '2026-01-01', '2026-02-01']]; w.sheet.modified = 't2'
    const out = await w.sync()
    assert.equal(w.log.persist, 2); assert.equal(w.log.refresh, 2); assert.equal(out.status === 'synced' && out.insights, 'refreshed')
  } finally { w.restore() }
})
