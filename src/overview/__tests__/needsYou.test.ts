import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildNeedsYou, type NeedsYouInput } from '../needsYou.ts'

const empty: NeedsYouInput = { overdue: [], brokenPromises: 0, conversationsAwaiting: [], draftsToReview: 0, followUpsDue: 0 }
const row = (n: number) => ({ id: `i${n}`, customer: `Customer ${n}`, invoice: `INV-${n}`, amount: `$${n}00`, lateLabel: `${n * 10} days late` })

describe('buildNeedsYou', () => {
  it('is empty when nothing needs the owner (the All clear state)', () => {
    assert.deepEqual(buildNeedsYou(empty), [])
  })
  it('puts money first, then promises, conversations, decisions and follow-ups', () => {
    const items = buildNeedsYou({ overdue: [row(1)], brokenPromises: 2, conversationsAwaiting: [{ id: 't1', who: 'Kudzai', subject: 'Quote', observed: '3 days since they wrote' }], draftsToReview: 1, followUpsDue: 1 })
    assert.deepEqual(items.map((i) => i.kind), ['money', 'promise', 'conversation', 'decision', 'followup'])
  })
  it('never shows more than five items and at most three overdue invoices', () => {
    const items = buildNeedsYou({ ...empty, overdue: [row(1), row(2), row(3), row(4), row(5)], brokenPromises: 1, draftsToReview: 4, followUpsDue: 2 })
    assert.equal(items.length, 5)
    assert.equal(items.filter((i) => i.kind === 'money').length, 3)
  })
  it('labels conversations as inferred and recorded facts as observed', () => {
    const items = buildNeedsYou({ ...empty, overdue: [row(1)], conversationsAwaiting: [{ id: 't', who: 'A', subject: 'S', observed: 'o' }] })
    assert.equal(items.find((i) => i.kind === 'money')?.basis, 'Observed')
    assert.equal(items.find((i) => i.kind === 'conversation')?.basis, 'Inferred')
  })
  it('pluralises correctly', () => {
    assert.match(buildNeedsYou({ ...empty, draftsToReview: 1 })[0].title, /1 reminder draft waiting/)
    assert.match(buildNeedsYou({ ...empty, draftsToReview: 2 })[0].title, /2 reminder drafts waiting/)
  })
})
