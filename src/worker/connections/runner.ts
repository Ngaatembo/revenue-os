import { db } from '../googleSheetsHandlers.ts'
import { accessTokenFor, AuthorizationRevokedError, RateLimitedError, type FetchFn, type GoogleEnv } from './google.ts'
import { parseCursor, syncGmail, type CommunicationRow, type GmailCursor } from './gmail.ts'
import { parseSheetsCursor, safeProblemCode, syncSheet } from './sheets.ts'

export interface RunnerEnv extends GoogleEnv {
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  SYNC_MESSAGE_BUDGET?: string
  SYNC_INTERVAL_MINUTES?: string
}
/** What happened to the opportunity refresh that follows a Sheets import. Reported separately from the import itself. */
export type InsightRefresh = 'refreshed' | 'skipped_no_recovery_rate' | 'failed' | 'not_needed'
export const SYNCABLE = ['gmail', 'google_sheets'] as const
export type SyncOutcome =
  | { status: 'synced'; fetched: number; stored: number; complete: boolean; changed?: boolean; insights?: InsightRefresh }
  | { status: 'rate_limited'; retry_after_seconds: number }
  | { status: 'needs_reauthorization' }
  | { status: 'needs_setup'; reason: 'source_not_selected' }
  | { status: 'failed'; error_code: string }
  | { status: 'skipped'; reason: 'not_due_or_already_running' }

/** How often a healthy connection is re-checked. Providers are asked for changes only, so this is cheap. */
export function syncIntervalMs(env: RunnerEnv): number {
  const minutes = Number(env.SYNC_INTERVAL_MINUTES)
  return Math.max(1, Math.min(60, Number.isFinite(minutes) && minutes > 0 ? minutes : 5)) * 60_000
}
const enc = encodeURIComponent
/** Problems the owner has to fix (the sheet's content), not transient provider trouble: shown immediately, no failure backoff. */
const OWNER_FIXABLE = (code: string) => code.startsWith('missing_columns:') || code.startsWith('ambiguous_sheet_headers:')
  || ['duplicate_sheet_headers', 'no_valid_invoice_rows', 'sheet_needs_header_and_rows', 'sheet_too_many_rows', 'sheet_too_large', 'google_sheet_invalid_range', 'google_sheet_not_found', 'google_sheet_access_denied', 'provider_access_denied', 'provider_not_found'].includes(code)

function patch(env: RunnerEnv, org: string, provider: string, fields: Record<string, unknown>) {
  return db(env, `provider_connections?organization_id=eq.${enc(org)}&provider=eq.${enc(provider)}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
  })
}

interface Claimed {
  sync_cursor: string | null; encrypted_refresh_token: string; provider_account_email: string | null
  consecutive_failures: number; initial_sync_completed_at: string | null; records_synced: number
}
interface ProviderRun { complete: boolean; fetched: number; stored: number; records?: number; cursor?: string; warning?: string; changed?: boolean; insights?: InsightRefresh; needsAttention?: boolean }

async function runGmail(env: RunnerEnv, org: string, c: Claimed, accessToken: string, fetchFn: FetchFn): Promise<ProviderRun> {
  const ownerEmail = c.provider_account_email
  if (!ownerEmail) throw new Error('account_email_missing')
  const budget = Math.max(10, Math.min(500, Number(env.SYNC_MESSAGE_BUDGET) || 100))
  let inserted = 0 // rows that were actually new (re-reads after reauthorization are ignored by the unique key)
  const result = await syncGmail({
    fetchFn, accessToken, ownerEmail, cursor: parseCursor(c.sync_cursor), messageBudget: budget,
    onStage: async (stage) => { await patch(env, org, 'gmail', { sync_stage: stage }) },
    save: async (rows: CommunicationRow[]) => {
      for (let i = 0; i < rows.length; i += 100) {
        const added = await db(env, 'communications?on_conflict=organization_id,provider,external_id&select=id', {
          method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
          body: JSON.stringify(rows.slice(i, i + 100).map((row) => ({ ...row, organization_id: org }))),
        }) as unknown[]
        inserted += Array.isArray(added) ? added.length : 0
      }
    },
    checkpoint: async (cursor: GmailCursor) => {
      await patch(env, org, 'gmail', { sync_cursor: JSON.stringify(cursor), records_synced: Number(c.records_synced) + inserted })
    },
  })
  return { complete: result.complete, fetched: result.fetched, stored: result.stored, changed: inserted > 0 }
}

async function runSheets(env: RunnerEnv, org: string, c: Claimed, accessToken: string, fetchFn: FetchFn): Promise<ProviderRun> {
  const selections = await db(env, `provider_source_selections?select=source_config&organization_id=eq.${enc(org)}&provider=eq.google_sheets&limit=1`) as Array<{ source_config: { spreadsheet_id?: string; range?: string } }>
  const config = selections[0]?.source_config
  if (!config?.spreadsheet_id || !config.range) throw new Error('source_not_selected')
  const spreadsheetId = config.spreadsheet_id, range = config.range
  const sourceId = `google_sheets:${spreadsheetId}`
  const result = await syncSheet({
    fetchFn, accessToken, spreadsheetId, range, cursor: parseSheetsCursor(c.sync_cursor),
    onStage: async (stage) => { await patch(env, org, 'google_sheets', { sync_stage: stage }) },
    importSnapshot: async ({ rows, rejectedRows, contentHash }) => {
      const runId = crypto.randomUUID()
      await db(env, 'source_sync_runs', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
        organization_id: org, id: runId, source_key: sourceId, provider: 'google_sheets', spreadsheet_id: spreadsheetId, source_range: range, status: 'started', accepted_rows: 0, rejected_rows: 0 }) })
      try {
        const saved = await db(env, 'rpc/persist_invoice_import_system', { method: 'POST', body: JSON.stringify({
          p_org_id: org, p_source_id: sourceId, p_source_name: `Google Sheets ${spreadsheetId}`.slice(0, 240), p_content_hash: contentHash, p_rows: rows, p_rejected_rows: rejectedRows }) }) as { duplicate?: boolean }
        await db(env, 'rpc/complete_source_sync_snapshot', { method: 'POST', body: JSON.stringify({
          p_organization_id: org, p_run_id: runId, p_source_key: sourceId, p_source_range: range, p_spreadsheet_id: spreadsheetId,
          p_content_digest: contentHash, p_invoice_ids: rows.map((row) => row.id), p_accepted_rows: rows.length, p_rejected_rows: rejectedRows }) })
        return { duplicate: Boolean(saved?.duplicate) }
      } catch (cause) {
        await db(env, `source_sync_runs?organization_id=eq.${enc(org)}&id=eq.${enc(runId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'failed', completed_at: new Date().toISOString(), error_code: 'automatic_import_failed' }) }).catch(() => undefined)
        throw cause instanceof Error && cause.message === 'database_request_failed' ? new Error('invoice_import_persist_failed') : cause
      }
    },
  })
  if (result.kind === 'rejected_known') {
    await patch(env, org, 'google_sheets', { sync_cursor: JSON.stringify(result.cursor) })
    throw new Error(result.code)
  }
  // The import itself succeeded (or nothing changed). Now refresh opportunities when new data arrived, or when an
  // earlier refresh failed and is still owed. The result is reported and recorded, never ignored.
  const previous = parseSheetsCursor(c.sync_cursor)
  const owed = Boolean(previous.pendingEvaluation)
  let insights: InsightRefresh = 'not_needed'
  let cursor = result.cursor
  let needsAttention = false
  if (result.kind === 'imported' || owed) {
    await patch(env, org, 'google_sheets', { sync_stage: 'insights' })
    insights = await refreshInsights(env, org)
    if (insights === 'failed') {
      const failures = (previous.evaluationFailures ?? 0) + 1
      cursor = { ...cursor, pendingEvaluation: true, evaluationFailures: failures }
      needsAttention = failures >= 3
    } else {
      cursor = { ...cursor, pendingEvaluation: undefined, evaluationFailures: undefined }
    }
  }
  // One code is stored; the most actionable problem wins.
  const warning = insights === 'failed' ? 'insight_refresh_failed' : result.rejectedRows > 0 ? 'snapshot_rejected_rows' : insights === 'skipped_no_recovery_rate' ? 'insights_need_recovery_rate' : undefined
  return { complete: true, fetched: result.rows, stored: result.kind === 'imported' ? result.rows : 0, records: result.kind === 'imported' ? result.rows : undefined,
    cursor: JSON.stringify(cursor), warning, changed: result.kind === 'imported' && !result.duplicate, insights, needsAttention }
}

/** Runs the workspace evaluation that turns imported invoices into opportunities. Never throws; failure is a reportable result. */
async function refreshInsights(env: RunnerEnv, org: string): Promise<InsightRefresh> {
  try {
    const result = await db(env, 'rpc/refresh_org_after_sync', { method: 'POST', body: JSON.stringify({ p_org_id: org }) })
    if (result === 'ok') return 'refreshed'
    if (result === 'skipped') return 'skipped_no_recovery_rate'
    return 'failed' // 'failed' (the evaluation logged its own error) or anything unexpected
  } catch {
    return 'failed'
  }
}

/** Provider-neutral entry point: claim, sync one chunk, checkpoint, record honest state. */
export async function runConnectionSync(env: RunnerEnv, organizationId: string, provider: string,
  opts: { force?: boolean; fetchFn?: FetchFn } = {}): Promise<SyncOutcome> {
  if (!(SYNCABLE as readonly string[]).includes(provider)) return { status: 'failed', error_code: 'provider_not_syncable' }
  const claimed = await db(env, 'rpc/claim_connection_sync', { method: 'POST',
    body: JSON.stringify({ p_organization_id: organizationId, p_provider: provider, p_force: Boolean(opts.force) }) }) as Claimed[]
  const connection = claimed[0]
  if (!connection) return { status: 'skipped', reason: 'not_due_or_already_running' }
  const fetchFn = opts.fetchFn ?? fetch
  const interval = syncIntervalMs(env)
  try {
    const accessToken = await accessTokenFor(env, connection.encrypted_refresh_token, fetchFn)
    const run = provider === 'gmail' ? await runGmail(env, organizationId, connection, accessToken, fetchFn) : await runSheets(env, organizationId, connection, accessToken, fetchFn)
    const now = new Date()
    if (run.complete) {
      await patch(env, organizationId, provider, {
        status: run.needsAttention ? 'needs_attention' : 'connected', sync_stage: 'complete', last_successful_sync_at: now.toISOString(), last_error_code: run.warning ?? null,
        consecutive_failures: 0, sync_started_at: null, next_sync_at: new Date(now.getTime() + interval).toISOString(),
        initial_sync_completed_at: connection.initial_sync_completed_at ?? now.toISOString(),
        ...(run.cursor !== undefined ? { sync_cursor: run.cursor } : {}), ...(run.records !== undefined ? { records_synced: run.records } : {}),
      })
    } else {
      // More to fetch (budget exhausted or history reset). Stay in the fetching state; the schedule continues immediately.
      await patch(env, organizationId, provider, { status: 'connected', sync_stage: 'fetching', sync_started_at: null,
        last_error_code: null, consecutive_failures: 0, next_sync_at: now.toISOString() })
    }
    return { status: 'synced', fetched: run.fetched, stored: run.stored, complete: run.complete, changed: run.changed, insights: run.insights }
  } catch (cause) {
    if (cause instanceof RateLimitedError) {
      await patch(env, organizationId, provider, { status: 'connected', sync_stage: 'waiting_rate_limit', sync_started_at: null,
        last_error_code: 'provider_rate_limited', next_sync_at: new Date(Date.now() + cause.retryAfterSeconds * 1000).toISOString() }).catch(() => undefined)
      return { status: 'rate_limited', retry_after_seconds: cause.retryAfterSeconds }
    }
    if (cause instanceof AuthorizationRevokedError) {
      // Drop the unusable credential and ask the owner to reconnect. Already-synced records stay.
      await patch(env, organizationId, provider, { status: 'error', sync_stage: 'failed', sync_started_at: null, encrypted_refresh_token: null,
        last_error_code: 'authorization_revoked', next_sync_at: null }).catch(() => undefined)
      return { status: 'needs_reauthorization' }
    }
    const code = (cause instanceof Error ? safeProblemCode(cause.message) : null) ?? 'sync_failed'
    if (code === 'source_not_selected') {
      await patch(env, organizationId, provider, { status: 'connected', sync_stage: null, sync_started_at: null, last_error_code: code,
        next_sync_at: new Date(Date.now() + interval).toISOString() }).catch(() => undefined)
      return { status: 'needs_setup', reason: 'source_not_selected' }
    }
    if (OWNER_FIXABLE(code)) {
      // The owner has to fix the sheet or its sharing. Show it right away; checking again is cheap because unchanged files are skipped.
      await patch(env, organizationId, provider, { status: 'needs_attention', sync_stage: 'failed', sync_started_at: null, last_error_code: code,
        next_sync_at: new Date(Date.now() + interval).toISOString() }).catch(() => undefined)
      return { status: 'failed', error_code: code }
    }
    const failures = connection.consecutive_failures + 1
    const backoffMs = Math.min(6 * 3600_000, 5 * 60_000 * 2 ** Math.min(failures - 1, 6))
    await patch(env, organizationId, provider, {
      status: failures >= 3 ? 'needs_attention' : 'connected', sync_stage: 'failed', sync_started_at: null,
      last_error_code: code, consecutive_failures: failures, next_sync_at: new Date(Date.now() + backoffMs).toISOString(),
    }).catch(() => undefined)
    return { status: 'failed', error_code: code }
  }
}

/** Cron entry: sync every connection that is due. Each claim is atomic, so overlapping runs never double-sync. */
export async function runDueSyncs(env: RunnerEnv, fetchFn?: FetchFn, limit = 20): Promise<{ attempted: number; results: SyncOutcome[] }> {
  const nowIso = new Date().toISOString()
  const due = await db(env, `provider_connections?select=organization_id,provider&provider=in.(gmail,google_sheets)&status=in.(connected,needs_attention,syncing)&encrypted_refresh_token=not.is.null&or=(next_sync_at.is.null,next_sync_at.lte.${enc(nowIso)})&order=next_sync_at.asc.nullsfirst&limit=${limit}`) as Array<{ organization_id: string; provider: string }>
  const results: SyncOutcome[] = []
  for (const c of due) results.push(await runConnectionSync(env, c.organization_id, c.provider, { fetchFn }))
  return { attempted: due.length, results }
}
