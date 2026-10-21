import { assertGoogleOk, type FetchFn } from './google.ts'

export interface CommunicationRow {
  provider: 'gmail'
  external_id: string
  thread_id: string
  direction: 'inbound' | 'outbound'
  counterpart_address: string | null
  counterpart_name: string | null
  subject: string | null
  snippet: string | null
  occurred_at: string
  is_automated: boolean
  source_account: string
}

interface GmailMessage {
  id?: string; threadId?: string; labelIds?: string[]; snippet?: string; internalDate?: string
  payload?: { headers?: Array<{ name?: string; value?: string }> }
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
export const BACKFILL_QUERY = 'newer_than:90d -category:promotions -category:social -category:forums -in:spam -in:trash -in:chats'
const AUTOMATED_SENDER = /(^|[._-])(no-?reply|do-?not-?reply|donotreply|notifications?|mailer-daemon|postmaster|bounce[s]?|newsletter|alerts?)([._-]|@)/i

export function parseAddress(value: string | undefined): { address: string | null; name: string | null } {
  if (!value) return { address: null, name: null }
  // "Moyo, Tendai" <t@x.test> | Tendai <t@x.test> | t@x.test  (commas inside quotes belong to the name)
  const named = value.match(/^\s*(?:"((?:[^"\\]|\\.)*)"|([^<",]*))\s*<([^<>\s@]+@[^<>\s]+)>/)
  if (named) {
    const name = (named[1] ?? named[2] ?? '').replace(/\\(.)/g, '$1').trim()
    return { address: named[3]!.toLowerCase().slice(0, 320), name: name ? name.slice(0, 200) : null }
  }
  const bare = value.match(/^\s*([^\s<>",@]+@[^\s<>",]+)/)
  return bare ? { address: bare[1]!.toLowerCase().slice(0, 320), name: null } : { address: null, name: null }
}

/** Convert a Gmail metadata message into a normalised communication, or null when it is not a customer conversation. */
export function parseGmailMessage(message: GmailMessage, ownerEmail: string): CommunicationRow | null {
  if (!message.id || !message.threadId || !message.internalDate) return null
  const labels = message.labelIds ?? []
  if (labels.includes('DRAFT') || labels.includes('CHAT')) return null
  const headers = new Map<string, string>()
  for (const h of message.payload?.headers ?? []) if (h.name && h.value !== undefined) headers.set(h.name.toLowerCase(), h.value)
  const owner = ownerEmail.toLowerCase()
  const outbound = labels.includes('SENT')
  const counterpart = parseAddress(outbound ? headers.get('to') : headers.get('from'))
  if (counterpart.address === owner) return null
  const millis = Number(message.internalDate)
  if (!Number.isFinite(millis) || millis <= 0) return null
  const precedence = (headers.get('precedence') ?? '').toLowerCase()
  const autoSubmitted = (headers.get('auto-submitted') ?? 'no').toLowerCase()
  const automated = headers.has('list-unsubscribe') || ['bulk', 'list', 'junk'].includes(precedence)
    || autoSubmitted !== 'no' || (counterpart.address ? AUTOMATED_SENDER.test(counterpart.address) : false)
  return {
    provider: 'gmail', external_id: message.id.slice(0, 200), thread_id: message.threadId.slice(0, 200),
    direction: outbound ? 'outbound' : 'inbound',
    counterpart_address: counterpart.address, counterpart_name: counterpart.name,
    subject: (headers.get('subject') ?? '').trim().slice(0, 300) || null,
    snippet: (message.snippet ?? '').trim().slice(0, 200) || null,
    occurred_at: new Date(millis).toISOString(), is_automated: automated, source_account: owner.slice(0, 320),
  }
}

async function gmailGet(fetchFn: FetchFn, token: string, path: string, params: Record<string, string | string[]> = {}) {
  const url = new URL(`${GMAIL}/${path}`)
  for (const [k, v] of Object.entries(params)) for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, item)
  const r = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) })
  const body = await r.json().catch(() => null) as Record<string, unknown> | null
  assertGoogleOk(r, body)
  return body ?? {}
}

export interface GmailCursor { historyId?: string; backfill?: { pageToken: string | null; done: boolean } }
export function parseCursor(raw: string | null): GmailCursor {
  if (!raw) return {}
  try { const v = JSON.parse(raw) as GmailCursor; return v && typeof v === 'object' ? v : {} } catch { return {} }
}

export interface GmailSyncIO {
  fetchFn: FetchFn
  accessToken: string
  ownerEmail: string
  cursor: GmailCursor
  /** Maximum number of message fetches in this run (provider subrequest budget). */
  messageBudget: number
  onStage: (stage: 'fetching' | 'processing') => Promise<void>
  /** Persist rows; must be idempotent. Returns number of rows processed. */
  save: (rows: CommunicationRow[]) => Promise<void>
  /** Persist the checkpoint after every page so a crash or rate limit never loses progress. */
  checkpoint: (cursor: GmailCursor, savedSoFar: number) => Promise<void>
}
export interface GmailSyncResult { cursor: GmailCursor; fetched: number; stored: number; complete: boolean; mode: 'backfill' | 'incremental' }

async function fetchMetadata(io: GmailSyncIO, ids: string[]): Promise<CommunicationRow[]> {
  const rows: CommunicationRow[] = []
  for (let i = 0; i < ids.length; i += 5) {
    const batch = await Promise.all(ids.slice(i, i + 5).map(async (id) => {
      try {
        return await gmailGet(io.fetchFn, io.accessToken, `messages/${encodeURIComponent(id)}`, {
          format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'List-Unsubscribe', 'Precedence', 'Auto-Submitted'],
        }) as GmailMessage
      } catch (e) {
        if (e instanceof Error && e.message === 'provider_not_found') return null // deleted between list and get
        throw e
      }
    }))
    for (const message of batch) { const row = message && parseGmailMessage(message, io.ownerEmail); if (row) rows.push(row) }
  }
  return rows
}

export async function syncGmail(io: GmailSyncIO): Promise<GmailSyncResult> {
  let cursor: GmailCursor = { ...io.cursor }
  let fetched = 0
  let stored = 0
  let remaining = io.messageBudget

  if (!cursor.historyId) {
    const profile = await gmailGet(io.fetchFn, io.accessToken, 'profile')
    if (typeof profile.historyId !== 'string') throw new Error('provider_request_failed')
    // Pin the incremental position before backfilling so nothing that arrives during the backfill is missed.
    cursor = { historyId: profile.historyId, backfill: { pageToken: null, done: false } }
    await io.checkpoint(cursor, 0)
  }

  if (cursor.backfill && !cursor.backfill.done) {
    await io.onStage('fetching')
    let pageToken = cursor.backfill.pageToken
    while (remaining > 0) {
      const list = await gmailGet(io.fetchFn, io.accessToken, 'messages', {
        q: BACKFILL_QUERY, maxResults: String(Math.min(100, remaining)), ...(pageToken ? { pageToken } : {}),
      })
      const ids = ((list.messages as Array<{ id?: string }> | undefined) ?? []).flatMap((m) => m.id ? [m.id] : [])
      remaining -= ids.length
      fetched += ids.length
      await io.onStage('processing')
      const rows = await fetchMetadata(io, ids)
      if (rows.length) await io.save(rows)
      stored += rows.length
      pageToken = typeof list.nextPageToken === 'string' ? list.nextPageToken : null
      cursor = { ...cursor, backfill: { pageToken, done: pageToken === null } }
      await io.checkpoint(cursor, stored)
      if (pageToken === null) break
      await io.onStage('fetching')
    }
    return { cursor, fetched, stored, complete: cursor.backfill!.done, mode: 'backfill' }
  }

  // Incremental: only messages added since the stored history position. The cursor moves only past history
  // records that were fully handled, so a busy mailbox catches up over several runs and never skips or stalls.
  await io.onStage('fetching')
  let pageToken: string | undefined
  const ids = new Set<string>()
  let lastHandledRecord: string | null = null
  let latest = cursor.historyId!
  let cut = false
  try {
    pages: do {
      const page = await gmailGet(io.fetchFn, io.accessToken, 'history', {
        startHistoryId: cursor.historyId!, historyTypes: 'messageAdded', maxResults: '100', ...(pageToken ? { pageToken } : {}),
      })
      for (const h of (page.history as Array<{ id?: string; messagesAdded?: Array<{ message?: { id?: string } }> }> | undefined) ?? []) {
        const entryIds = (h.messagesAdded ?? []).flatMap((added) => added.message?.id ? [added.message.id] : [])
        const fresh = entryIds.filter((id) => !ids.has(id))
        if (ids.size > 0 && ids.size + fresh.length > io.messageBudget) { cut = true; break pages }
        fresh.forEach((id) => ids.add(id))
        if (h.id) lastHandledRecord = h.id
      }
      if (typeof page.historyId === 'string') latest = page.historyId
      pageToken = typeof page.nextPageToken === 'string' ? page.nextPageToken : undefined
    } while (pageToken)
  } catch (e) {
    if (e instanceof Error && e.message === 'provider_not_found') {
      // The stored history position has expired (Gmail keeps it for about a week). Re-backfill; dedupe keeps this safe.
      const reset: GmailCursor = { historyId: undefined, backfill: { pageToken: null, done: false } }
      await io.checkpoint(reset, 0)
      return { cursor: reset, fetched: 0, stored: 0, complete: false, mode: 'incremental' }
    }
    throw e
  }
  fetched = ids.size
  await io.onStage('processing')
  const rows = await fetchMetadata(io, [...ids])
  if (rows.length) await io.save(rows)
  stored = rows.length
  // Everything read was handled: jump to the mailbox's current position. If we stopped early, continue from the last
  // record we finished (or stay put when the very first record could not be taken), and run again right away.
  const advancedTo = cut ? (lastHandledRecord ?? cursor.historyId!) : latest
  cursor = { ...cursor, historyId: advancedTo }
  await io.checkpoint(cursor, stored)
  return { cursor, fetched, stored, complete: !cut, mode: 'incremental' }
}
