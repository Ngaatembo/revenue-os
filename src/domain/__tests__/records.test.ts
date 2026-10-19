import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateAttention, summarizeAttention } from '../attention/engine.ts'
import type { AttentionContext, RecordsContext } from '../attention/types.ts'
import { resolveAllSettings, type BrainFact } from '../businessBrain.ts'
import { daysBetween, percentOfMinor, totalsByCurrency, type Deposit, type PaymentReviewItem, type Quotation, type Task } from '../records.ts'

const NOW = '2026-10-19T10:00:00.000Z'
const day = (n: number) => new Date(Date.parse('2026-10-19T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10)

const quote = (id: string, p: Partial<Quotation> = {}): Quotation => ({ id, reference: 'Q-' + id, customerName: 'Cust ' + id, currency: 'USD', amountMinor: 500_000, status: 'sent', sentOn: day(-3), validUntil: day(30), followUpDate: day(5), lastContactOn: null, ownerId: 'u1', notes: null, ...p })
const deposit = (id: string, p: Partial<Deposit> = {}): Deposit => ({ id, quotationId: null, customerName: 'Dep ' + id, currency: 'USD', amountMinor: 100_000, status: 'promised', promisedDate: day(3), ownerConfirmedMinor: null, ownerConfirmedOn: null, ...p })
const task = (id: string, p: Partial<Task> = {}): Task => ({ id, title: 'Task ' + id, detail: null, dueDate: day(5), status: 'open', ownerId: 'u1', relatedType: null, relatedId: null, ...p })
const review = (id: string, p: Partial<PaymentReviewItem> = {}): PaymentReviewItem => ({ id, externalRecordId: 'P-' + id, invoiceNumber: 'INV-X', currency: 'USD', amountMinor: 25_000, receivedAt: day(-2) + 'T00:00:00Z', reason: 'invoice_not_found', candidateInvoiceIds: [], status: 'pending', createdAt: day(-2) + 'T00:00:00Z', ...p })

function ctx(r: Partial<RecordsContext> = {}, facts: BrainFact[] = []): AttentionContext {
  return { asOf: NOW, opportunities: [], progressByInvoiceId: new Map(), reminderSentAt: new Map(), noReplyCounts: new Map(), leads: [], leadActivities: [], settings: resolveAllSettings(facts),
    records: { quotations: [], deposits: [], tasks: [], paymentReviews: [], openActions: [], rescheduleCounts: new Map(), ...r } }
}
const fact = (key: string, value: string): BrainFact => ({ id: 'f-' + key, key, kind: 'user_entered', value, sourceLabel: 'Owner', sourceRef: null, note: null, status: 'active', supersededBy: null, statusReason: null, statusChangedAt: null, recordedBy: 'u', recordedAt: NOW })
const rules = (c: AttentionContext) => evaluateAttention(c).items.flatMap((i) => i.findings.map((f) => f.ruleId)).sort()

test('helpers: day arithmetic, integer percentages, per-currency totals', () => {
  assert.equal(daysBetween('2026-10-01', '2026-10-19'), 18)
  assert.equal(daysBetween('2026-10-19', '2026-10-01'), -18)
  assert.equal(percentOfMinor(100_001, 30), 30_000)
  assert.equal(percentOfMinor(5, 50), 3)
  assert.throws(() => percentOfMinor(100, 101))
  assert.deepEqual(totalsByCurrency([{ amountMinor: 5, currency: 'USD' }, { amountMinor: 7, currency: 'ZWG' }, { amountMinor: 3, currency: 'USD' }]).map((m) => `${m.currency}${m.amount}`), ['USD8', 'ZWG7'])
})

test('a quotation with a future follow-up and recent contact raises nothing', () => {
  assert.equal(evaluateAttention(ctx({ quotations: [quote('a', { lastContactOn: day(-1) })] })).items.length, 0)
})

test('unanswered quotation: follow-up due, silence past the setting, and expiry are each explained', () => {
  assert.deepEqual(rules(ctx({ quotations: [quote('a', { followUpDate: day(-2), sentOn: day(-20) })] })), ['quote.follow_up_due', 'quote.unanswered'])
  assert.deepEqual(rules(ctx({ quotations: [quote('b', { validUntil: day(2) })] })), ['quote.expiring'])
  assert.deepEqual(rules(ctx({ quotations: [quote('c', { validUntil: day(-4) })] })), ['quote.expiring'])
})

test('the quote follow-up setting from the Business Brain changes when a quotation counts as unanswered', () => {
  const q = quote('a', { sentOn: day(-10), lastContactOn: day(-10) })
  assert.deepEqual(rules(ctx({ quotations: [q] })), ['quote.unanswered'])
  assert.deepEqual(rules(ctx({ quotations: [q] }, [fact('quote_follow_up_days', '14')])), [])
})

test('closed quotations are never chased', () => {
  for (const status of ['accepted', 'declined', 'withdrawn'] as const) assert.equal(evaluateAttention(ctx({ quotations: [quote('a', { status, followUpDate: day(-5), sentOn: day(-40), validUntil: day(-10) })] })).items.length, 0, status)
})

test('quotation value is a pipeline figure, never known unpaid money', () => {
  const { items } = evaluateAttention(ctx({ quotations: [quote('a', { followUpDate: day(-2) })] }))
  assert.equal(items[0].knownMoney, null)
  assert.equal(items[0].speculativeMoney?.amount, 500_000)
  const summary = summarizeAttention(items)
  assert.equal(summary.knownExposure.length, 0)
  assert.equal(summary.pipeline[0].amount, 500_000)
})

test('repeatedly postponed follow-up is flagged only from the third reschedule', () => {
  const q = quote('a')
  assert.deepEqual(rules(ctx({ quotations: [q], rescheduleCounts: new Map([['quotation:a', 2]]) })), [])
  assert.deepEqual(rules(ctx({ quotations: [q], rescheduleCounts: new Map([['quotation:a', 3]]) })), ['quote.postponed'])
})

test('accepted quotation with no deposit is flagged only when a standard deposit is set, with an exact amount', () => {
  const q = quote('a', { status: 'accepted', followUpDate: null })
  assert.deepEqual(rules(ctx({ quotations: [q] })), [])
  const withSetting = evaluateAttention(ctx({ quotations: [q] }, [fact('deposit_percent', '30')]))
  assert.equal(withSetting.items[0].speculativeMoney?.amount, 150_000)
  assert.deepEqual(rules(ctx({ quotations: [q], deposits: [deposit('d', { quotationId: 'a' })] }, [fact('deposit_percent', '30')])), [])
  assert.deepEqual(rules(ctx({ quotations: [q], deposits: [deposit('d', { quotationId: 'a', status: 'cancelled' })] }, [fact('deposit_percent', '30')])), ['quote.accepted_no_deposit'])
})

test('promised deposit: quiet until its date, then due, then late; verified and cancelled are quiet', () => {
  assert.equal(evaluateAttention(ctx({ deposits: [deposit('a', { promisedDate: day(1) })] })).items.length, 0)
  assert.deepEqual(rules(ctx({ deposits: [deposit('a', { promisedDate: day(0) })] })), ['deposit.due'])
  const late = evaluateAttention(ctx({ deposits: [deposit('a', { promisedDate: day(-4) })] }))
  assert.match(late.items[0].headline.what, /4 days late/)
  for (const status of ['received_verified', 'cancelled'] as const) assert.equal(evaluateAttention(ctx({ deposits: [deposit('a', { promisedDate: day(-4), status })] })).items.length, 0)
})

test('owner-confirmed but unverified deposit waits three days, then asks for evidence; it is not a promise-due finding', () => {
  const d = (n: number) => deposit('a', { status: 'received_unverified', promisedDate: day(-9), ownerConfirmedMinor: 100_000, ownerConfirmedOn: day(n) })
  assert.equal(evaluateAttention(ctx({ deposits: [d(-1)] })).items.length, 0)
  assert.deepEqual(rules(ctx({ deposits: [d(-5)] })), ['deposit.unverified'])
})

test('pending payment reviews are surfaced with the reason and without being summed into owed money', () => {
  const { items } = evaluateAttention(ctx({ paymentReviews: [review('1'), review('2', { reason: 'invoice_ambiguous', candidateInvoiceIds: ['x', 'y'] }), review('3', { status: 'resolved' })] }))
  assert.equal(items.length, 2)
  assert.ok(items.some((i) => /matches 2 invoices/.test(i.headline.what)))
  assert.ok(items.some((i) => /not in your records/.test(i.headline.what)))
  assert.equal(summarizeAttention(items).knownExposure.length, 0)
})

test('tasks: overdue, due soon, unowned; closed tasks are ignored', () => {
  assert.deepEqual(rules(ctx({ tasks: [task('a', { dueDate: day(-3) })] })), ['task.overdue'])
  assert.deepEqual(rules(ctx({ tasks: [task('a', { dueDate: day(1) })] })), ['task.due_soon'])
  assert.deepEqual(rules(ctx({ tasks: [task('a', { ownerId: null })] })), ['task.unowned'])
  assert.deepEqual(rules(ctx({ tasks: [task('a', { dueDate: day(-3), ownerId: null })] })), ['task.overdue', 'task.unowned'])
  assert.equal(evaluateAttention(ctx({ tasks: [task('a', { dueDate: day(-3), ownerId: null, status: 'done' })] })).items.length, 0)
})

test('one task with several problems is ONE alert', () => {
  const { items } = evaluateAttention(ctx({ tasks: [task('a', { dueDate: day(-3), ownerId: null })] }))
  assert.equal(items.length, 1)
  assert.equal(items[0].findings.length, 2)
})

test('unowned recovery actions are flagged; owned ones are not', () => {
  const open = [{ id: 'r1', label: 'Reminder for INV-1', status: 'proposed' as const, ownerId: null }, { id: 'r2', label: 'Reminder for INV-2', status: 'approved' as const, ownerId: 'u1' }]
  const { items } = evaluateAttention(ctx({ openActions: open }))
  assert.equal(items.length, 1)
  assert.equal(items[0].subject.id, 'r1')
})

test('records missing from the context (older callers) raise nothing and do not throw', () => {
  const c = ctx(); delete c.records
  const result = evaluateAttention(c)
  assert.equal(result.items.length, 0)
  assert.deepEqual(result.failedRules, [])
})

test('every record finding explains what, evidence, why and the next step', () => {
  const { items } = evaluateAttention(ctx({ quotations: [quote('a', { followUpDate: day(-2) })], deposits: [deposit('d', { promisedDate: day(-1) })], tasks: [task('t', { dueDate: day(-1), ownerId: null })], paymentReviews: [review('p')] }))
  assert.equal(items.length, 4)
  for (const item of items) for (const f of item.findings) { assert.ok(f.what.length > 8 && f.why.length > 8 && f.nextStep.length > 5 && f.evidence.length >= 1, f.ruleId) }
})

test('a high-value late deposit outranks a low-urgency unowned task', () => {
  const { items } = evaluateAttention(ctx({ deposits: [deposit('d', { promisedDate: day(-5), amountMinor: 900_000 })], tasks: [task('t', { ownerId: null })] }))
  assert.equal(items[0].subject.type, 'deposit')
})

import { parseAmountToMinor } from '../records.ts'
test('typed amounts become exact minor units; unclear input is refused, never guessed', () => {
  assert.equal(parseAmountToMinor('1500'), 150_000)
  assert.equal(parseAmountToMinor('1,500.5'), 150_050)
  assert.equal(parseAmountToMinor('0.07'), 7)
  for (const bad of ['', '0', '-5', '12.345', 'abc', '1e3', '12.', '99999999999999999999']) assert.equal(parseAmountToMinor(bad), null, bad)
})

import { createQuotationBody, createTaskBody, quotationsParams, rescheduleEventsParams, resolveReviewBody, updateDepositBody } from '../../lib/recordQueries.ts'
test('record requests always carry the workspace id and refuse an empty one', () => {
  for (const build of [() => quotationsParams(' '), () => createTaskBody({ organizationId: '', id: 'a', title: 'abc', dueDate: '2026-10-20' }), () => rescheduleEventsParams('', 'task_events')]) assert.throws(build, /workspace id/)
  assert.equal(quotationsParams('org-1').get('organization_id'), 'eq.org-1')
  assert.equal(rescheduleEventsParams('org-1', 'deposit_events').get('select'), 'deposit_id')
  assert.equal(rescheduleEventsParams('org-1', 'deposit_events').get('event_type'), 'eq.rescheduled')
})
test('request bodies send exact minor units and null for empty optional fields', () => {
  const q = JSON.parse(createQuotationBody({ organizationId: 'o', id: 'q', reference: 'R', customerName: 'C', currency: 'USD', amountMinor: 150050, sentOn: '2026-10-01', followUpDate: '2026-10-20' }))
  assert.equal(q.p_amount_minor, 150050); assert.equal(q.p_valid_until, null); assert.equal(q.p_owner_id, null)
  const d = JSON.parse(updateDepositBody({ organizationId: 'o', eventId: 'e', depositId: 'd', action: 'confirm_received', note: 'cash', receivedMinor: 5, receivedOn: '2026-10-19' }))
  assert.equal(d.p_received_minor, 5); assert.equal(d.p_promised_date, null)
})
test('resolving a payment needs a target, or a reason when dismissing', () => {
  assert.throws(() => resolveReviewBody({ organizationId: 'o', itemId: 'i', action: 'to_invoice' }), /Choose/)
  assert.throws(() => resolveReviewBody({ organizationId: 'o', itemId: 'i', action: 'dismiss', note: '  ' }), /why/)
  assert.equal(JSON.parse(resolveReviewBody({ organizationId: 'o', itemId: 'i', action: 'to_deposit', targetId: 'd1' })).p_target_id, 'd1')
})
