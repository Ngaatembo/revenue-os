import { db } from '../googleSheetsHandlers.ts'
import { accessTokenFor, AuthorizationRevokedError, RateLimitedError, type FetchFn, type GoogleEnv } from './google.ts'
import { parseCursor, syncGmail, type CommunicationRow, type GmailCursor } from './gmail.ts'

export interface RunnerEnv extends GoogleEnv {
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  SYNC_MESSAGE_BUDGET?: string
}
export type SyncOutcome =
  | { status: 'synced'; fetched: number; stored: number; complete: boolean }
  | { status: 'rate_limited'; retry_after_seconds: number }
  | { status: 'needs_reauthorization' }
  | { status: 'failed'; error_code: string }
  | { status: 'skipped'; reason: 'not_due_or_already_running' }

const SYNC_INTERVAL_MS = 15 * 60_000
const enc = encodeURIComponent
const SAFE_CODE = /^[a-z0-9_:-]{1,80}$/

function patch(env: RunnerEnv, org: string, provider: string, fields: Record<string, unknown>) {
  return db(env, `provider_connections?organization_id=eq.${enc(org)}&provider=eq.${enc(provider)}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
  })
}

/** Provider-neutral entry point: claim, sync one chunk, checkpoint, record honest state. */
export async function runConnectionSync(env: RunnerEnv, organizationId: string, provider: string,
  opts: { force?: boolean; fetchFn?: FetchFn } = {}): Promise<SyncOutcome> {
  if (provider !== 'gmail') return { status: 'failed', error_code: 'provider_not_syncable' }
  const claimed = await db(env, 'rpc/claim_connection_sync', { method: 'POST',
    body: JSON.stringify({ p_organization_id: organizationId, p_provider: provider, p_force: Boolean(opts.force) }) }) as Array<{
      sync_cursor: string | null; encrypted_refresh_token: string; provider_account_email: string | null
      consecutive_failures: number; initial_sync_completed_at: string | null; records_synced: number }>
  const connection = claimed[0]
  if (!connection) return { status: 'skipped', reason: 'not_due_or_already_running' }

  const fetchFn = opts.fetchFn ?? fetch
  const budget = Math.max(10, Math.min(500, Number(env.SYNC_MESSAGE_BUDGET) || 100))
  let savedTotal = Number(connection.records_synced)
  try {
    const accessToken = await accessTokenFor(env, connection.encrypted_refresh_token, fetchFn)
    const ownerEmail = connection.provider_account_email
    if (!ownerEmail) throw new Error('account_email_missing')
    const result = await syncGmail({
      fetchFn, accessToken, ownerEmail, cursor: parseCursor(connection.sync_cursor), messageBudget: budget,
      onStage: async (stage) => { await patch(env, organizationId, provider, { sync_stage: stage }) },
      save: async (rows: CommunicationRow[]) => {
        for (let i = 0; i < rows.length; i += 100) {
          await db(env, 'communications?on_conflict=organization_id,provider,external_id', {
            method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
            body: JSON.stringify(rows.slice(i, i + 100).map((row) => ({ ...row, organization_id: organizationId }))),
          })
        }
      },
      checkpoint: async (cursor: GmailCursor, stored: number) => {
        savedTotal = Number(connection.records_synced) + stored
        await patch(env, organizationId, provider, { sync_cursor: JSON.stringify(cursor), records_synced: savedTotal })
      },
    })
    const now = new Date()
    if (result.complete) {
      await patch(env, organizationId, provider, {
        status: 'connected', sync_stage: 'complete', last_successful_sync_at: now.toISOString(), last_error_code: null,
        consecutive_failures: 0, sync_started_at: null, next_sync_at: new Date(now.getTime() + SYNC_INTERVAL_MS).toISOString(),
        initial_sync_completed_at: connection.initial_sync_completed_at ?? now.toISOString(),
      })
    } else {
      // More to fetch (budget exhausted or history reset). Stay in the fetching state; the schedule continues immediately.
      await patch(env, organizationId, provider, { status: 'connected', sync_stage: 'fetching', sync_started_at: null,
        last_error_code: null, consecutive_failures: 0, next_sync_at: now.toISOString() })
    }
    return { status: 'synced', fetched: result.fetched, stored: result.stored, complete: result.complete }
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
    const code = cause instanceof Error && SAFE_CODE.test(cause.message) ? cause.message : 'sync_failed'
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
  const due = await db(env, `provider_connections?select=organization_id,provider&provider=eq.gmail&status=in.(connected,needs_attention,syncing)&encrypted_refresh_token=not.is.null&or=(next_sync_at.is.null,next_sync_at.lte.${enc(nowIso)})&order=next_sync_at.asc.nullsfirst&limit=${limit}`) as Array<{ organization_id: string; provider: string }>
  const results: SyncOutcome[] = []
  for (const c of due) results.push(await runConnectionSync(env, c.organization_id, c.provider, { fetchFn }))
  return { attempted: due.length, results }
}
