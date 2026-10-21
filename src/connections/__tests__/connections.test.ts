import assert from 'node:assert/strict'
import test from 'node:test'
import { describeConnection, errorMessage, formatAge, freshnessLine, PROVIDERS, type ConnectionRow } from '../catalog.ts'
import { decideLanding, setupInProgress } from '../landing.ts'
import { deriveConversationInsights, gmailThreadLink, type ConversationThread } from '../conversationInsights.ts'

const row = (over: Partial<ConnectionRow> = {}): ConnectionRow => ({
  provider: 'gmail', status: 'connected', provider_account_email: 'o@x.test', sync_stage: null, sync_started_at: null, last_successful_sync_at: null,
  initial_sync_completed_at: null, next_sync_at: null, last_error_code: null, consecutive_failures: 0, records_synced: 0, ...over,
})

test('a missing, pending or disconnected connection is never shown as connected', () => {
  for (const r of [undefined, null, row({ status: 'disconnected' }), row({ status: 'pending' })]) {
    const v = describeConnection(r); assert.equal(v.state, 'not_connected'); assert.equal(v.action, 'connect'); assert.equal(v.initialSyncDone, false)
  }
})
test('authorized but never synced is "setting up", with an honest indeterminate stage', () => {
  const v = describeConnection(row())
  assert.equal(v.state, 'syncing'); assert.equal(v.indeterminate, true); assert.equal(v.stage, 'Connection established')
  assert.equal(describeConnection(row({ status: 'syncing', sync_stage: 'fetching' })).stage, 'Fetching available information')
  assert.equal(describeConnection(row({ status: 'syncing', sync_stage: 'processing' })).stage, 'Processing and organizing records')
})
test('a finished initial sync is connected; a later background sync keeps it connected', () => {
  const done = row({ initial_sync_completed_at: '2026-10-21T00:00:00Z', last_successful_sync_at: '2026-10-21T00:00:00Z', sync_stage: 'complete' })
  assert.equal(describeConnection(done).state, 'connected'); assert.equal(describeConnection(done).stage, 'Initial synchronization complete')
  assert.equal(describeConnection({ ...done, status: 'syncing', sync_stage: 'fetching' }).label, 'Syncing')
})
test('failures and revoked access ask for the right action', () => {
  const revoked = describeConnection(row({ status: 'error', last_error_code: 'authorization_revoked' }))
  assert.equal(revoked.state, 'failed'); assert.equal(revoked.action, 'reconnect'); assert.match(revoked.message!, /Reconnect/)
  const attention = describeConnection(row({ status: 'needs_attention', last_error_code: 'provider_request_failed', consecutive_failures: 3 }))
  assert.equal(attention.state, 'needs_attention'); assert.equal(attention.action, 'sync_now')
  assert.equal(describeConnection(row({ status: 'connected', sync_stage: 'waiting_rate_limit', last_error_code: 'provider_rate_limited' })).message, errorMessage('provider_rate_limited'))
})
test('no percentage or record count is invented', () => {
  const v = describeConnection(row({ status: 'syncing', sync_stage: 'fetching', records_synced: 42 }))
  assert.equal(JSON.stringify(v).includes('%'), false); assert.equal(v.indeterminate, true)
})
test('WhatsApp is never offered as connectable and states its real dependency', () => {
  const w = PROVIDERS.find((p) => p.id === 'whatsapp_business')!
  assert.equal(w.availability, 'external_approval_required'); assert.match(w.dependency!, /Meta/); assert.match(w.dependency!, /existing chats/)
})
test('formatAge', () => { assert.equal(formatAge(null), 'never'); assert.equal(formatAge(new Date(Date.now() - 3 * 3600_000).toISOString()), '3 h ago') })

test('landing: unfinished setup always goes to Connections; a synchronized source or existing records go to Overview', () => {
  const base = { hasRecords: false, recordsLoading: false }
  assert.equal(decideLanding({ ...base, connections: null }), 'loading')
  assert.equal(decideLanding({ ...base, connections: [] }), 'connections')
  assert.equal(decideLanding({ ...base, connections: [row()] }), 'connections', 'authorized but never synchronized is still setup')
  assert.equal(decideLanding({ ...base, connections: [row({ status: 'error', last_error_code: 'authorization_revoked' })] }), 'connections')
  assert.equal(decideLanding({ ...base, connections: [row({ initial_sync_completed_at: '2026-10-21T00:00:00Z' })] }), 'overview')
  assert.equal(decideLanding({ ...base, connections: [], hasRecords: true }), 'overview')
  assert.equal(decideLanding({ ...base, recordsLoading: true, connections: [] }), 'loading')
})
test('setupInProgress is true until a source has really synchronized', () => {
  assert.equal(setupInProgress(null), true); assert.equal(setupInProgress([]), true); assert.equal(setupInProgress([row()]), true)
  assert.equal(setupInProgress([row({ last_successful_sync_at: '2026-10-21T00:00:00Z' })]), false)
})
test('freshness wording is built only from recorded state', () => {
  const now = Date.parse('2026-10-21T12:00:00Z')
  assert.match(freshnessLine([], now), /No source is connected/)
  assert.match(freshnessLine(null, now), /No source is connected/)
  assert.match(freshnessLine([row({ last_successful_sync_at: '2026-10-21T11:55:00Z', initial_sync_completed_at: '2026-10-21T11:55:00Z' })], now), /Gmail last synchronized 5 min ago/)
  assert.match(freshnessLine([row()], now), /Gmail is still setting up/)
  assert.match(freshnessLine([row({ status: 'error', last_error_code: 'authorization_revoked' })], now), /Gmail needs to be reconnected/)
  assert.doesNotMatch(freshnessLine([row({ provider: 'whatsapp_business', last_successful_sync_at: '2026-10-21T11:55:00Z' })], now), /WhatsApp last synchronized/)
})

const day = 86_400_000
const now = Date.parse('2026-10-21T12:00:00Z')
const thread = (over: Partial<ConversationThread>): ConversationThread => ({
  provider: 'gmail', thread_id: 't', message_count: 1, last_message_at: new Date(now - 3 * day).toISOString(), last_direction: 'inbound', last_inbound_at: new Date(now - 3 * day).toISOString(),
  last_outbound_at: null, counterpart_address: 'c@x.test', counterpart_name: 'Cust', subject: 'Quote', last_snippet: 'hi', all_automated: false, ...over,
})
test('insights: unanswered inbound is awaiting_reply, labelled observed vs inferred', () => {
  const [i] = deriveConversationInsights([thread({})], now)
  assert.equal(i.kind, 'awaiting_reply'); assert.equal(i.daysSince, 3); assert.match(i.observed, /wrote 3 days ago/); assert.match(i.inference, /probably/)
})
test('insights: recent, automated, replied, very old and one-sided outbound threads are not flagged', () => {
  const list = [
    thread({ thread_id: 'recent', last_message_at: new Date(now - 3600_000).toISOString() }),
    thread({ thread_id: 'auto', all_automated: true }),
    thread({ thread_id: 'replied', last_direction: 'outbound', last_outbound_at: new Date(now - day).toISOString(), last_message_at: new Date(now - day).toISOString() }),
    thread({ thread_id: 'old', last_message_at: new Date(now - 90 * day).toISOString() }),
    thread({ thread_id: 'cold-outreach', last_direction: 'outbound', last_inbound_at: null, last_message_at: new Date(now - 10 * day).toISOString() }),
  ]
  assert.deepEqual(deriveConversationInsights(list, now), [])
})
test('insights: our reply followed by silence becomes gone_quiet; waiting customers sort first', () => {
  const quiet = thread({ thread_id: 'q', last_direction: 'outbound', last_message_at: new Date(now - 8 * day).toISOString(), last_outbound_at: new Date(now - 8 * day).toISOString() })
  const answeredRecently = thread({ thread_id: 'a', last_direction: 'outbound', last_message_at: new Date(now - 5 * day).toISOString(), last_outbound_at: new Date(now - 5 * day).toISOString() })
  assert.deepEqual(deriveConversationInsights([answeredRecently], now), [], 'a reply 5 days ago is not yet a stalled conversation')
  const waiting = thread({ thread_id: 'w' })
  const result = deriveConversationInsights([quiet, waiting], now)
  assert.deepEqual(result.map((r) => r.kind), ['awaiting_reply', 'gone_quiet'])
})
test('source links point at the original thread', () => {
  assert.equal(gmailThreadLink('o@x.test', 'abc'), 'https://mail.google.com/mail/?authuser=o%40x.test#all/abc')
})
