import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ConversationThread } from '../conversationInsights.ts'
import { applyTracking, ownerHasWrittenTo, reminderTime, setAsideReason, type TrackingRow } from '../tracking.ts'

const now = Date.parse('2026-10-21T10:00:00Z')
const iso = (offsetHours: number) => new Date(now + offsetHours * 3_600_000).toISOString()
const thread = (id: string, address: string, lastInboundHoursAgo: number | null, outbound = false): ConversationThread => ({
  provider: 'gmail', thread_id: id, message_count: 1, last_message_at: iso(-(lastInboundHoursAgo ?? 100)), last_direction: 'inbound',
  last_inbound_at: lastInboundHoursAgo === null ? null : iso(-lastInboundHoursAgo), last_outbound_at: outbound ? iso(-200) : null,
  counterpart_address: address, counterpart_name: null, subject: 'S', last_snippet: null, all_automated: false,
})
const row = (id: string, status: TrackingRow['status'], extra: Partial<TrackingRow> = {}): TrackingRow => ({
  provider: 'gmail', thread_id: id, status, handled_at: null, remind_at: null, note: null, updated_at: iso(-10), ...extra,
})

describe('setAsideReason', () => {
  it('keeps a handled conversation out of the list', () => {
    assert.equal(setAsideReason(thread('t', 'a@x.test', 48), row('t', 'handled', { handled_at: iso(-10) }), now), 'handled')
  })
  it('brings a handled conversation back when the customer writes again afterwards', () => {
    assert.equal(setAsideReason(thread('t', 'a@x.test', 2), row('t', 'handled', { handled_at: iso(-10) }), now), null)
  })
  it('does not bring it back for a message that was already there when it was handled', () => {
    assert.equal(setAsideReason(thread('t', 'a@x.test', 12), row('t', 'handled', { handled_at: iso(-10) }), now), 'handled')
  })
  it('hides a snoozed conversation until the reminder time', () => {
    assert.equal(setAsideReason(thread('t', 'a@x.test', 48), row('t', 'snoozed', { remind_at: iso(20) }), now), 'snoozed')
  })
  it('returns a snoozed conversation once the reminder time has passed', () => {
    assert.equal(setAsideReason(thread('t', 'a@x.test', 48), row('t', 'snoozed', { remind_at: iso(-1) }), now), null)
  })
  it('returns a snoozed conversation early when the customer writes again', () => {
    assert.equal(setAsideReason(thread('t', 'a@x.test', 2), row('t', 'snoozed', { remind_at: iso(20), updated_at: iso(-10) }), now), null)
  })
  it('shows an open (note-only) or untracked conversation', () => {
    assert.equal(setAsideReason(thread('t', 'a@x.test', 48), row('t', 'open', { note: 'hi' }), now), null)
    assert.equal(setAsideReason(thread('t', 'a@x.test', 48), undefined, now), null)
  })
})

describe('applyTracking', () => {
  const threads = [thread('1', 'a@x.test', 48), thread('2', 'b@x.test', 48), thread('3', 'c@x.test', 48), thread('4', 'Muted@X.test', 48)]
  it('splits visible, set-aside and muted threads, and collects notes', () => {
    const result = applyTracking(threads, [row('1', 'handled', { handled_at: iso(-10), note: 'paid deposit' }), row('2', 'open', { note: 'call Friday' })], [{ address: 'muted@x.test' }], now)
    assert.deepEqual(result.visible.map((t) => t.thread_id), ['2', '3'])
    assert.deepEqual(result.setAside.map((s) => [s.thread.thread_id, s.reason]), [['1', 'handled']])
    assert.deepEqual(result.mutedThreads.map((t) => t.thread_id), ['4'])
    assert.equal(result.notes.get('1'), 'paid deposit')
    assert.equal(result.notes.get('2'), 'call Friday')
  })
  it('a mute wins over everything else for that sender, matching case-insensitively', () => {
    const result = applyTracking([thread('4', 'MUTED@x.test', 1)], [], [{ address: 'muted@x.test' }], now)
    assert.equal(result.visible.length, 0)
    assert.equal(result.mutedThreads.length, 1)
  })
})

describe('ownerHasWrittenTo and reminderTime', () => {
  it('flags a sender the owner has written to', () => {
    const ts = [thread('1', 'a@x.test', 5, true), thread('2', 'b@x.test', 5, false)]
    assert.equal(ownerHasWrittenTo('A@x.test', ts), true)
    assert.equal(ownerHasWrittenTo('b@x.test', ts), false)
    assert.equal(ownerHasWrittenTo(null, ts), false)
  })
  it('reminders land at 08:00 UTC on the chosen day and always in the future', () => {
    assert.equal(reminderTime('tomorrow', now), '2026-10-22T08:00:00.000Z')
    assert.equal(reminderTime('three_days', now), '2026-10-24T08:00:00.000Z')
    assert.equal(reminderTime('next_week', now), '2026-10-28T08:00:00.000Z')
    assert.ok(Date.parse(reminderTime('tomorrow', Date.parse('2026-10-21T23:59:00Z'))) > Date.parse('2026-10-21T23:59:00Z'))
  })
})
