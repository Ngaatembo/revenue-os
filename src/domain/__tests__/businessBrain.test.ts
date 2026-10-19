import assert from 'node:assert/strict'
import test from 'node:test'
import { activeFacts, deriveRecordFacts, factHistory, findConflicts, findRecordMismatches, medianTermsDays, resolveSetting, validateFactKey, validateFactValue, type BrainFact } from '../businessBrain.ts'
import { money } from '../money.ts'
import type { InvoiceEvidence } from '../types.ts'

const NOW = '2026-10-19T10:00:00.000Z'
let n = 0
function fact(key: string, value: string, patch: Partial<BrainFact> = {}): BrainFact {
  n += 1
  return { id: 'f' + n, key, kind: 'user_entered', value, sourceLabel: 'Owner', sourceRef: null, note: null, status: 'active', supersededBy: null, statusReason: null,
    statusChangedAt: null, recordedBy: 'u1', recordedAt: new Date(Date.parse(NOW) - (100 - n) * 60_000).toISOString(), ...patch }
}
function invoice(id: string, issued: string, due: string, total = 100_000, paid = 0, customer = 'c1', currency = 'USD'): InvoiceEvidence {
  return { id, customerId: customer, customerName: customer, invoiceNumber: id, currency: currency as never, total: money(total, currency), paid: money(paid, currency),
    issuedAt: issued, dueAt: due, source: { sourceId: 's', recordId: id, importedAt: '2026-10-10T00:00:00.000Z' } }
}

test('known settings are validated like the database does', () => {
  assert.deepEqual(validateFactValue('payment_terms_days', ' 30 '), { ok: true, value: '30' })
  assert.equal(validateFactValue('payment_terms_days', 'thirty').ok, false)
  assert.equal(validateFactValue('payment_terms_days', '366').ok, false)
  assert.equal(validateFactValue('payment_terms_days', '-1').ok, false)
  assert.equal(validateFactValue('payment_terms_days', '1.5').ok, false)
  assert.equal(validateFactValue('deposit_percent', '101').ok, false)
  assert.equal(validateFactValue('quote_follow_up_days', '0').ok, false)
  assert.equal(validateFactValue('preferred_payment_method', 'Bank transfer').ok, true)
  assert.equal(validateFactValue('anything', '   ').ok, false)
  assert.equal(validateFactKey('Bad Key') !== null, true)
  assert.equal(validateFactKey('good_key_2'), null)
})

test('an unset setting uses the default and says it is not confirmed', () => {
  const r = resolveSetting('quote_follow_up_days', [])
  assert.equal(r.value, 7)
  assert.equal(r.source, 'default')
  assert.match(r.explanation, /not set/)
})

test('a user-entered value is used and explained with its source', () => {
  const r = resolveSetting('lead_stall_days', [fact('lead_stall_days', '10', { sourceLabel: 'Sales call' })])
  assert.equal(r.value, 10)
  assert.equal(r.source, 'user_entered')
  assert.match(r.explanation, /Sales call/)
})

test('retracted and superseded facts are ignored when resolving', () => {
  const r = resolveSetting('lead_stall_days', [fact('lead_stall_days', '10', { status: 'retracted' }), fact('lead_stall_days', '11', { status: 'superseded' })])
  assert.equal(r.source, 'default')
})

test('conflicting values are never silently picked: default used, flagged', () => {
  const facts = [fact('payment_terms_days', '14'), fact('payment_terms_days', '45', { kind: 'imported' })]
  assert.equal(findConflicts(facts).length, 1)
  const r = resolveSetting('payment_terms_days', facts)
  assert.equal(r.conflicted, true)
  assert.equal(r.value, 30)
  assert.match(r.explanation, /conflicting/)
})

test('the same value from two sources is agreement, not a conflict', () => {
  const facts = [fact('payment_terms_days', '14'), fact('payment_terms_days', '14', { kind: 'imported' })]
  assert.equal(findConflicts(facts).length, 0)
  assert.equal(resolveSetting('payment_terms_days', facts).value, 14)
})

test('an invalid stored value is ignored rather than trusted', () => {
  assert.equal(resolveSetting('payment_terms_days', [fact('payment_terms_days', '9999')]).source, 'default')
})

test('an estimate is used when it is the only recorded value', () => {
  const r = resolveSetting('lead_stall_days', [fact('lead_stall_days', '9', { kind: 'estimate' })])
  assert.equal(r.source, 'estimate')
})

test('median payment terms from invoices', () => {
  const inv = [invoice('a', '2026-01-01', '2026-01-31'), invoice('b', '2026-01-01', '2026-01-15'), invoice('c', '2026-01-01', '2026-01-31')]
  assert.equal(medianTermsDays(inv), 30)
  assert.equal(medianTermsDays([]), null)
})

test('derived facts come only from records, with currencies kept apart', () => {
  const inv = [
    invoice('a', '2026-08-01', '2026-09-01', 100_000, 40_000, 'c1', 'USD'),
    invoice('b', '2026-08-01', '2026-12-01', 50_000, 0, 'c2', 'USD'),
    invoice('c', '2026-08-01', '2026-09-01', 70_000, 0, 'c3', 'EUR'),
  ]
  const entries = deriveRecordFacts({ invoices: inv, payments: [], assumptionBps: 2500, asOf: NOW })
  const by = Object.fromEntries(entries.map((e) => [e.id, e]))
  assert.match(by.unpaid_total.value, /EUR|€/)
  assert.match(by.unpaid_total.value, /\$/)
  assert.match(by.overdue_total.value, /600\.00/)
  assert.doesNotMatch(by.overdue_total.value, /500\.00/, 'the not-yet-due invoice is excluded')
  assert.equal(by.recovery_rate.value, '25%')
  assert.equal(by.recovery_rate.cls, 'assumption')
  assert.equal(by.payments_recorded, undefined, 'no payments, no verified claim')
})

test('payments are the only verified class and promises never enter it', () => {
  const entries = deriveRecordFacts({ invoices: [invoice('a', '2026-08-01', '2026-09-01')], payments: [{ invoiceId: 'a', amount: money(25_000, 'USD'), receivedAt: '2026-10-01T00:00:00Z' }], assumptionBps: null, asOf: NOW })
  const verified = entries.filter((e) => e.cls === 'verified')
  assert.equal(verified.length, 1)
  assert.match(verified[0].value, /250\.00/)
  assert.equal(entries.find((e) => e.id === 'recovery_rate')!.value, 'Not set')
})

test('with no records nothing is invented', () => {
  const entries = deriveRecordFacts({ invoices: [], payments: [], assumptionBps: null, asOf: NOW })
  assert.deepEqual(entries.map((e) => e.id), ['recovery_rate'])
})

test('stated terms that disagree with the records are surfaced, small gaps are not', () => {
  const inv = [invoice('a', '2026-01-01', '2026-01-15'), invoice('b', '2026-02-01', '2026-02-15')]
  assert.equal(findRecordMismatches([fact('payment_terms_days', '45')], inv).length, 1)
  assert.equal(findRecordMismatches([fact('payment_terms_days', '18')], inv).length, 0)
  assert.equal(findRecordMismatches([fact('payment_terms_days', '45', { status: 'retracted' })], inv).length, 0)
})

test('history keeps every version, newest first, and active filter excludes old ones', () => {
  const facts = [fact('lead_stall_days', '10', { status: 'superseded' }), fact('lead_stall_days', '12')]
  assert.equal(factHistory(facts, 'lead_stall_days').length, 2)
  assert.equal(factHistory(facts, 'lead_stall_days')[0].value, '12')
  assert.equal(activeFacts(facts).length, 1)
})
