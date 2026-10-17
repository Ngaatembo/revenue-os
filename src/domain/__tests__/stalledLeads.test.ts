import assert from 'node:assert/strict'
import test from 'node:test'
import { detectStalledLeads, type LeadForDetection } from '../stalledLeads.ts'

const TODAY = '2026-10-17'
function lead(id: string, nextFollowUp: string, status: LeadForDetection['status'] = 'new', value = '', currency = 'USD'): LeadForDetection {
  return { id, name: 'N ' + id, business: 'Biz ' + id, status, nextFollowUp, value, currency }
}

test('a lead is stalled once its follow-up is at least 7 days late (exact boundary)', () => {
  const { stalled } = detectStalledLeads([lead('a', '2026-10-10'), lead('b', '2026-10-11'), lead('c', '2026-10-17'), lead('d', '2026-10-30')], TODAY)
  assert.deepEqual(stalled.map((s) => s.lead.id), ['a'])
  assert.equal(stalled[0].daysStalled, 7)
})

test('converted and closed leads are never stalled; open statuses are', () => {
  const { stalled } = detectStalledLeads([
    lead('n', '2026-09-01', 'new'), lead('f', '2026-09-01', 'follow_up'), lead('c', '2026-09-01', 'contacted'),
    lead('won', '2026-09-01', 'converted'), lead('lost', '2026-09-01', 'closed'),
  ], TODAY)
  assert.deepEqual(stalled.map((s) => s.lead.id).sort(), ['c', 'f', 'n'])
})

test('most stalled first, ties broken by id; reason cites the saved fields', () => {
  const { stalled } = detectStalledLeads([lead('b', '2026-09-20'), lead('a', '2026-09-20'), lead('z', '2026-08-01')], TODAY)
  assert.deepEqual(stalled.map((s) => s.lead.id), ['z', 'a', 'b'])
  assert.match(stalled[0].reason, /Biz z was planned for 2026-08-01, 77 days ago/)
})

test('potential value is a pipeline figure in minor units, absent when not recorded or invalid', () => {
  const { stalled } = detectStalledLeads([lead('a', '2026-09-01', 'new', '250.50'), lead('b', '2026-09-01', 'new', ''), lead('c', '2026-09-01', 'new', '12.345'), lead('d', '2026-09-01', 'new', '0')], TODAY)
  const byId = new Map(stalled.map((s) => [s.lead.id, s]))
  assert.equal(byId.get('a')?.potentialValue?.amount, 25050)
  assert.equal(byId.get('b')?.potentialValue, null)
  assert.equal(byId.get('c')?.potentialValue, null)
  assert.equal(byId.get('d')?.potentialValue, null)
})

test('unreadable dates are reported as skipped, never guessed; impossible calendar dates are rejected', () => {
  const result = detectStalledLeads([lead('x', 'soon'), lead('y', '2026-02-30'), lead('ok', '2026-09-01')], TODAY)
  assert.deepEqual(result.skippedIds, ['x', 'y'])
  assert.deepEqual(result.stalled.map((s) => s.lead.id), ['ok'])
})

test('invalid parameters fail loudly; no leads means nothing stalled', () => {
  assert.throws(() => detectStalledLeads([], 'yesterday'), /valid YYYY-MM-DD/)
  assert.throws(() => detectStalledLeads([], TODAY, 0), /positive integer/)
  assert.deepEqual(detectStalledLeads([], TODAY), { stalled: [], skippedIds: [] })
})

test('the threshold is configurable', () => {
  assert.equal(detectStalledLeads([lead('a', '2026-10-15')], TODAY, 2).stalled.length, 1)
  assert.equal(detectStalledLeads([lead('a', '2026-10-15')], TODAY, 3).stalled.length, 0)
})
