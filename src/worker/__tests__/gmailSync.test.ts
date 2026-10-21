import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAddress, parseGmailMessage, parseCursor, syncGmail, type CommunicationRow, type GmailCursor, type GmailSyncIO } from '../connections/gmail.ts'
import { RateLimitedError } from '../connections/google.ts'

const OWNER = 'owner@shop.test'
type Msg = { id: string; threadId: string; labelIds: string[]; snippet: string; internalDate: string; payload: { headers: Array<{ name: string; value: string }> } }
const msg = (n: number, over: Partial<Msg> & { from?: string; to?: string; subject?: string; extra?: Array<{ name: string; value: string }> } = {}): Msg => ({
  id: `m${n}`, threadId: over.threadId ?? `t${n}`, labelIds: over.labelIds ?? ['INBOX'], snippet: over.snippet ?? `hello ${n}`,
  internalDate: over.internalDate ?? String(Date.UTC(2026, 9, 1) + n * 60_000),
  payload: { headers: [{ name: 'From', value: over.from ?? `Cust ${n} <cust${n}@example.test>` }, { name: 'To', value: over.to ?? OWNER }, { name: 'Subject', value: over.subject ?? `Enquiry ${n}` }, ...(over.extra ?? [])] },
})

/** A small in-memory Gmail: list (paged), get, history. */
function fakeGmail(messages: Msg[], opts: { history?: Array<{ ids: string[] }>; historyId?: string; failGetOnce?: number; rateLimitAfter?: number; historyExpired?: boolean } = {}) {
  const calls: string[] = []
  let gets = 0
  const fetchFn = async (input: string | URL): Promise<Response> => {
    const url = new URL(String(input)); const path = url.pathname.replace('/gmail/v1/users/me/', ''); calls.push(path)
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
    if (path === 'profile') return ok({ emailAddress: OWNER, historyId: opts.historyId ?? '1000' })
    if (path === 'messages') {
      const size = Number(url.searchParams.get('maxResults') ?? 100); const start = Number(url.searchParams.get('pageToken') ?? 0)
      const page = messages.slice(start, start + size)
      return ok({ messages: page.map((m) => ({ id: m.id })), ...(start + size < messages.length ? { nextPageToken: String(start + size) } : {}) })
    }
    if (path.startsWith('messages/')) {
      gets += 1
      if (opts.rateLimitAfter !== undefined && gets > opts.rateLimitAfter) return new Response(JSON.stringify({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }), { status: 403, headers: { 'retry-after': '45' } })
      const m = messages.find((x) => x.id === decodeURIComponent(path.slice(9)))
      return m ? ok(m) : new Response('{}', { status: 404 })
    }
    if (path === 'history') {
      if (opts.historyExpired) return new Response('{}', { status: 404 })
      return ok({ history: (opts.history ?? []).map((h) => ({ messagesAdded: h.ids.map((id) => ({ message: { id } })) })), historyId: '2000' })
    }
    return new Response('{}', { status: 404 })
  }
  return { fetchFn, calls, gets: () => gets }
}

function harness(fetchFn: GmailSyncIO['fetchFn'], cursor: GmailCursor, budget = 100) {
  const saved = new Map<string, CommunicationRow>(); const checkpoints: Array<{ cursor: GmailCursor; stored: number }> = []; const stages: string[] = []
  const io: GmailSyncIO = {
    fetchFn, accessToken: 't', ownerEmail: OWNER, cursor, messageBudget: budget,
    onStage: async (s) => { stages.push(s) },
    save: async (rows) => { for (const r of rows) if (!saved.has(r.external_id)) saved.set(r.external_id, r) },
    checkpoint: async (c, n) => { checkpoints.push({ cursor: c, stored: n }) },
  }
  return { io, saved, checkpoints, stages }
}

test('address parsing handles names, quotes and bare addresses', () => {
  assert.deepEqual(parseAddress('"Tendai M." <T@Example.test>'), { address: 't@example.test', name: 'Tendai M.' })
  assert.deepEqual(parseAddress('plain@example.test'), { address: 'plain@example.test', name: null })
  assert.deepEqual(parseAddress('Not an address'), { address: null, name: null })
})

test('inbound, outbound, automated and unusable messages are classified from provider facts', () => {
  const inbound = parseGmailMessage(msg(1), OWNER)!
  assert.equal(inbound.direction, 'inbound'); assert.equal(inbound.counterpart_address, 'cust1@example.test'); assert.equal(inbound.is_automated, false)
  const outbound = parseGmailMessage(msg(2, { labelIds: ['SENT'], from: OWNER, to: 'Buyer <buyer@example.test>' }), OWNER)!
  assert.equal(outbound.direction, 'outbound'); assert.equal(outbound.counterpart_address, 'buyer@example.test')
  assert.equal(parseGmailMessage(msg(3, { extra: [{ name: 'List-Unsubscribe', value: '<mailto:x>' }] }), OWNER)!.is_automated, true)
  assert.equal(parseGmailMessage(msg(4, { from: 'noreply@bank.test' }), OWNER)!.is_automated, true)
  assert.equal(parseGmailMessage(msg(5, { labelIds: ['DRAFT'] }), OWNER), null)
  assert.equal(parseGmailMessage(msg(6, { from: OWNER }), OWNER), null, 'notes to self are not customer conversations')
  assert.equal(parseGmailMessage({ id: 'x' }, OWNER), null)
})

test('stored fields are bounded and carry a source reference', () => {
  const row = parseGmailMessage(msg(1, { subject: 'S'.repeat(900), snippet: 'x'.repeat(900) }), OWNER)!
  assert.equal(row.subject!.length, 300); assert.equal(row.snippet!.length, 200)
  assert.equal(row.external_id, 'm1'); assert.equal(row.thread_id, 't1'); assert.equal(row.source_account, OWNER)
})

test('initial backfill pages through the mailbox, checkpoints each page and finishes', async () => {
  const messages = Array.from({ length: 250 }, (_, i) => msg(i + 1))
  const g = fakeGmail(messages); const h = harness(g.fetchFn, {}, 1000)
  const r = await syncGmail(h.io)
  assert.equal(r.complete, true); assert.equal(r.mode, 'backfill'); assert.equal(h.saved.size, 250)
  assert.equal(r.cursor.historyId, '1000', 'the incremental position is pinned before the backfill starts')
  assert.equal(r.cursor.backfill!.done, true)
  assert.ok(h.checkpoints.length >= 4, 'profile pin + one checkpoint per page')
  assert.ok(h.stages.includes('fetching') && h.stages.includes('processing'))
})

test('a budget-limited run stops, keeps its checkpoint and resumes without duplicates', async () => {
  const messages = Array.from({ length: 250 }, (_, i) => msg(i + 1))
  const g = fakeGmail(messages); const first = harness(g.fetchFn, {}, 100)
  const r1 = await syncGmail(first.io)
  assert.equal(r1.complete, false); assert.equal(first.saved.size, 100)
  const second = harness(g.fetchFn, r1.cursor, 100)
  for (const [k, v] of first.saved) second.saved.set(k, v)
  const r2 = await syncGmail(second.io)
  assert.equal(r2.complete, false); assert.equal(second.saved.size, 200)
  const third = harness(g.fetchFn, r2.cursor, 100); for (const [k, v] of second.saved) third.saved.set(k, v)
  const r3 = await syncGmail(third.io)
  assert.equal(r3.complete, true); assert.equal(third.saved.size, 250)
  // re-running the final state adds nothing
  const again = harness(g.fetchFn, { ...r3.cursor, backfill: { pageToken: null, done: false } }, 1000); for (const [k, v] of third.saved) again.saved.set(k, v)
  await syncGmail(again.io); assert.equal(again.saved.size, 250)
})

test('incremental sync fetches only newly added messages and advances the history position', async () => {
  const messages = [msg(1), msg(2), msg(3)]
  const g = fakeGmail(messages, { history: [{ ids: ['m2'] }, { ids: ['m2', 'm3'] }] })
  const h = harness(g.fetchFn, { historyId: '1000', backfill: { pageToken: null, done: true } })
  const r = await syncGmail(h.io)
  assert.equal(r.mode, 'incremental'); assert.deepEqual([...h.saved.keys()].sort(), ['m2', 'm3'])
  assert.equal(r.cursor.historyId, '2000'); assert.equal(r.complete, true)
  assert.equal(g.gets(), 2, 'duplicate history entries are fetched once')
})

test('an expired history position triggers a safe re-backfill instead of an error', async () => {
  const g = fakeGmail([msg(1)], { historyExpired: true })
  const h = harness(g.fetchFn, { historyId: '1', backfill: { pageToken: null, done: true } })
  const r = await syncGmail(h.io)
  assert.equal(r.complete, false); assert.equal(r.cursor.historyId, undefined); assert.equal(r.cursor.backfill!.done, false)
})

test('rate limiting surfaces a typed error and keeps rows already saved', async () => {
  const messages = Array.from({ length: 30 }, (_, i) => msg(i + 1))
  const g = fakeGmail(messages, { rateLimitAfter: 10 }); const h = harness(g.fetchFn, {}, 100)
  await assert.rejects(syncGmail(h.io), (e: unknown) => e instanceof RateLimitedError && e.retryAfterSeconds === 45)
  assert.ok(h.checkpoints.length >= 1, 'the pinned position was checkpointed before the failure')
})

test('cursor parsing tolerates garbage', () => {
  assert.deepEqual(parseCursor(null), {}); assert.deepEqual(parseCursor('{not json'), {}); assert.deepEqual(parseCursor('123'), {})
})
