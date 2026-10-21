import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MAX_ROWS, buildNeedsYou, hiddenInvoiceCount, type NeedsYouInput } from '../needsYou.ts'

const empty: NeedsYouInput = { overdue: [], brokenPromises: 0, conversationsAwaiting: [], draftsToReview: 0, followUpsDue: 0 }
const row = (n: number, progress: NeedsYouInput['overdue'][number]['progress'] = 'none') => ({ id: `i${n}`, customer: `Customer ${n}`, invoice: `INV-${n}`, amount: `$${n}00`, lateLabel: `${n * 10} days overdue`, progress })

describe('buildNeedsYou', () => {
  it('is empty when nothing needs the owner (the All clear state)', () => {
    assert.deepEqual(buildNeedsYou(empty), [])
  })
  it('puts money first, then promises, conversations, decisions and follow-ups', () => {
    const items = buildNeedsYou({ overdue: [row(1)], brokenPromises: 2, conversationsAwaiting: ['Kudzai'], draftsToReview: 1, followUpsDue: 1 })
    assert.deepEqual(items.map((i) => i.kind), ['money', 'promise', 'conversation', 'decision', 'followup'])
  })
  it('never shows more than the maximum rows and at most three overdue invoices', () => {
    const input = { ...empty, overdue: [row(1), row(2), row(3), row(4), row(5)], brokenPromises: 1, draftsToReview: 4, followUpsDue: 2 }
    const items = buildNeedsYou(input)
    assert.equal(items.length, MAX_ROWS)
    assert.equal(items.filter((i) => i.kind === 'money').length, 3)
    assert.equal(hiddenInvoiceCount(input), 2)
  })
  it('lists each customer once: waiting conversations collapse into a single summary row', () => {
    const items = buildNeedsYou({ ...empty, conversationsAwaiting: ['Chipo Dube', 'Tendai Moyo', 'Rudo'] })
    assert.equal(items.length, 1)
    assert.match(items[0].title, /^3 customers are waiting for your reply$/)
    assert.equal(items[0].detail, 'Chipo Dube, Tendai Moyo and 1 more')
    assert.equal(items[0].basis, 'Inferred')
  })
  it('a money row offers one primary action: draft, or review once a draft exists', () => {
    const fresh = buildNeedsYou({ ...empty, overdue: [row(1)] })[0]
    assert.deepEqual(fresh.action, { type: 'draft', label: 'Draft reminder', opportunityId: 'i1' })
    const drafted = buildNeedsYou({ ...empty, overdue: [row(1, 'proposed')] })[0]
    assert.deepEqual(drafted.action, { type: 'goto', label: 'Review draft', target: 'Actions' })
    assert.equal(drafted.snoozeOpportunityId, 'i1')
  })
  it('only invoice rows can be snoozed and the amount is a separate right-aligned figure', () => {
    const items = buildNeedsYou({ ...empty, overdue: [row(1)], draftsToReview: 1 })
    assert.equal(items[0].figure, '$100')
    assert.equal(items[1].snoozeOpportunityId, undefined)
  })
  it('pluralises correctly', () => {
    assert.match(buildNeedsYou({ ...empty, draftsToReview: 1 })[0].title, /1 reminder draft waiting/)
    assert.match(buildNeedsYou({ ...empty, draftsToReview: 2 })[0].title, /2 reminder drafts waiting/)
    assert.match(buildNeedsYou({ ...empty, conversationsAwaiting: ['A'] })[0].title, /1 customer is waiting/)
  })
})
