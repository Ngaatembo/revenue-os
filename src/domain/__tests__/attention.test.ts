import assert from 'node:assert/strict'
import test from 'node:test'
import { ALL_RULES, evaluateAttention, summarizeAttention, explainRanking } from '../attention/engine.ts'
import type { AttentionContext, AttentionRule, LeadForAttention } from '../attention/types.ts'
import { resolveAllSettings, type BrainFact } from '../businessBrain.ts'
import { DEFAULT_WORKFLOW, type OpportunityWorkflow } from '../issueWorkflow.ts'
import { money } from '../money.ts'
import type { InvoiceEvidence, RevenueOpportunity } from '../types.ts'

const NOW = '2026-10-19T10:00:00.000Z'
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString()

function opp(id: string, dueDaysAgo: number, amount = 100_000, workflow?: Partial<OpportunityWorkflow>, currency = 'USD'): RevenueOpportunity {
  const invoice: InvoiceEvidence = {
    id, customerId: 'c-' + id, customerName: 'Customer ' + id, invoiceNumber: 'INV-' + id, currency: currency as never, total: money(amount, currency), paid: money(0, currency),
    issuedAt: daysAgo(dueDaysAgo + 30), dueAt: daysAgo(dueDaysAgo), source: { sourceId: 's', recordId: id, importedAt: daysAgo(1) },
  }
  return { id: 'overdue_invoice:' + id, kind: 'overdue_invoice', status: 'open', evidence: [invoice], outstanding: money(amount, currency),
    estimate: { low: money(0, currency), high: money(0, currency), assumptionId: 'recovery-rate', formula: 'outstanding_times_recovery_rate' }, detectedAt: daysAgo(1),
    workflow: workflow ? { ...DEFAULT_WORKFLOW, ...workflow } : undefined }
}
function lead(id: string, patch: Partial<LeadForAttention> = {}): LeadForAttention {
  return { id, name: 'Lead ' + id, business: 'Biz ' + id, status: 'follow_up', nextFollowUp: '2026-10-19', value: '', currency: '', createdAt: daysAgo(2), ...patch }
}
function ctx(patch: Partial<AttentionContext> = {}, facts: BrainFact[] = []): AttentionContext {
  return { asOf: NOW, opportunities: [], progressByInvoiceId: new Map(), reminderSentAt: new Map(), noReplyCounts: new Map(), leads: [], leadActivities: [],
    settings: resolveAllSettings(facts), ...patch }
}
const setting = (key: string, value: string): BrainFact => ({ id: 'f-' + key, key, kind: 'user_entered', value, sourceLabel: 'Owner', sourceRef: null, note: null, status: 'active', supersededBy: null,
  statusReason: null, statusChangedAt: null, recordedBy: 'u', recordedAt: NOW })

test('a recent, untouched-for-days-only invoice raises nothing', () => {
  assert.equal(evaluateAttention(ctx({ opportunities: [opp('a', 3)] })).items.length, 0)
})

test('every item explains what, evidence, why and next step', () => {
  const { items } = evaluateAttention(ctx({ opportunities: [opp('a', 45)] }))
  assert.equal(items.length, 1)
  const f = items[0].headline
  for (const text of [f.what, f.why, f.nextStep]) assert.ok(text.length > 10)
  assert.ok(f.evidence.length >= 1)
})

test('several rules on one invoice produce ONE alert, not one per rule', () => {
  const o = opp('a', 70, 100_000, { state: 'disputed' })
  const { items } = evaluateAttention(ctx({ opportunities: [o], noReplyCounts: new Map([[o.id, 3]]) }))
  assert.equal(items.length, 1)
  assert.ok(items[0].findings.length >= 3)
  assert.equal(new Set(items[0].findings.map((f) => f.ruleId)).size, items[0].findings.length)
})

test('money belongs to the item once: no double counting across findings', () => {
  const o = opp('a', 70, 100_000, { state: 'disputed' })
  const { items } = evaluateAttention(ctx({ opportunities: [o] }))
  assert.ok(items[0].findings.length > 1)
  assert.equal(items[0].knownMoney?.amount, 100_000)
  assert.equal(summarizeAttention(items).knownExposure[0].amount, 100_000)
})

test('broken promise outranks a plain late invoice of the same size', () => {
  const broken = opp('b', 40, 100_000, { state: 'promised', promisedAmount: money(50_000, 'USD'), promisedDate: '2026-10-10', nextFollowUp: '2026-10-11' })
  const plain = opp('p', 40, 100_000)
  const { items } = evaluateAttention(ctx({ opportunities: [plain, broken] }))
  assert.equal(items[0].subject.id, broken.id)
  assert.equal(items[0].headline.ruleId, 'invoice.broken_promise')
})

test('a promise is not money: the promised amount never enters known exposure', () => {
  const o = opp('b', 40, 100_000, { state: 'promised', promisedAmount: money(100_000, 'USD'), promisedDate: '2026-10-10', nextFollowUp: '2026-10-11' })
  const s = summarizeAttention(evaluateAttention(ctx({ opportunities: [o] })).items)
  assert.equal(s.knownExposure[0].amount, 100_000, 'still fully unpaid')
})

test('snoozed items stay in the list and in the money; they are only flagged', () => {
  const o = opp('s', 45, 100_000, { snoozedUntil: '2026-10-25T00:00:00.000Z' })
  const { items } = evaluateAttention(ctx({ opportunities: [o] }))
  assert.equal(items[0].snoozed, true)
  const s = summarizeAttention(items)
  assert.equal(s.snoozed, 1)
  assert.equal(s.needingAttention, 0)
  assert.equal(s.knownExposure[0].amount, 100_000)
})

test('lead pipeline value is kept apart from known exposure and never summed with it', () => {
  const s = summarizeAttention(evaluateAttention(ctx({
    opportunities: [opp('a', 45, 100_000)],
    leads: [lead('l1', { nextFollowUp: '2026-09-01', value: '5000.00', currency: 'USD' })],
  })).items)
  assert.equal(s.knownExposure[0].amount, 100_000)
  assert.equal(s.pipeline[0].amount, 500_000)
})

test('pipeline value counts at half weight against owed money of the same size', () => {
  const { items } = evaluateAttention(ctx({
    opportunities: [opp('a', 45, 100_000)],
    leads: [lead('l1', { nextFollowUp: '2026-09-01', value: '1000.00', currency: 'USD' })],
  }))
  const invoice = items.find((i) => i.subject.type === 'invoice')!
  const leadItem = items.find((i) => i.subject.type === 'lead')!
  assert.equal(invoice.ranking[0].value, 1)
  assert.equal(leadItem.ranking[0].value, 0.5)
})

test('currencies are never compared: each is scaled to its own largest item', () => {
  const { items } = evaluateAttention(ctx({ opportunities: [opp('u', 45, 100_000, undefined, 'USD'), opp('e', 45, 100, undefined, 'EUR')] }))
  assert.deepEqual(items.map((i) => i.ranking[0].value), [1, 1])
})

test('stalled-lead threshold comes from the Business Brain', () => {
  const l = lead('l1', { nextFollowUp: '2026-10-05' }) // 14 days ago
  assert.equal(evaluateAttention(ctx({ leads: [l] })).items[0].headline.ruleId, 'lead.stalled')
  const lenient = evaluateAttention(ctx({ leads: [l] }, [setting('lead_stall_days', '30')])).items[0]
  assert.equal(lenient.headline.ruleId, 'lead.follow_up_due', 'with 30 days it is merely due, not stalled')
})

test('a lead is stalled OR due, never both (no duplicate alert)', () => {
  const { items } = evaluateAttention(ctx({ leads: [lead('l1', { nextFollowUp: '2026-09-01' })] }))
  assert.equal(items.length, 1)
  assert.equal(items[0].findings.length, 1)
})

test('unanswered enquiry uses the response target and clears once any activity is recorded', () => {
  const l = lead('n1', { status: 'new', nextFollowUp: '2026-10-25', createdAt: daysAgo(3) })
  assert.equal(evaluateAttention(ctx({ leads: [l] })).items[0].headline.ruleId, 'lead.unanswered_enquiry')
  assert.equal(evaluateAttention(ctx({ leads: [l], leadActivities: [{ leadId: 'n1', createdAt: daysAgo(1) }] })).items.length, 0)
  assert.equal(evaluateAttention(ctx({ leads: [l] }, [setting('enquiry_response_hours', '240')])).items.length, 0, 'a 10-day target is not yet missed')
  assert.equal(evaluateAttention(ctx({ leads: [{ ...l, createdAt: daysAgo(0) }] })).items.length, 0, 'a brand-new enquiry is fine')
})

test('closed and converted leads never raise alerts', () => {
  const leads = (['converted', 'closed'] as const).map((status, i) => lead('x' + i, { status, nextFollowUp: '2026-01-01' }))
  assert.equal(evaluateAttention(ctx({ leads })).items.length, 0)
})

test('reminder with no effect after a week, and repeated no-reply, are flagged', () => {
  const o = opp('r', 12)
  const { items } = evaluateAttention(ctx({ opportunities: [o], reminderSentAt: new Map([['r', daysAgo(8)]]), noReplyCounts: new Map([[o.id, 3]]) }))
  const ids = items[0].findings.map((f) => f.ruleId)
  assert.ok(ids.includes('invoice.reminder_no_effect'))
  assert.ok(ids.includes('invoice.repeated_no_reply'))
  assert.equal(evaluateAttention(ctx({ opportunities: [o], reminderSentAt: new Map([['r', daysAgo(2)]]) })).items.find((i) => i.findings.some((f) => f.ruleId === 'invoice.reminder_no_effect')), undefined)
})

test('an overdue invoice nobody has touched is flagged as inferred, and acting on it clears that finding', () => {
  const o = opp('u', 15)
  const first = evaluateAttention(ctx({ opportunities: [o] })).items[0]
  assert.equal(first.headline.ruleId, 'invoice.untouched')
  assert.equal(first.headline.strength, 'inferred')
  assert.equal(evaluateAttention(ctx({ opportunities: [o], progressByInvoiceId: new Map([['r' , 'proposed' as const]]) })).items.length, 1)
  assert.equal(evaluateAttention(ctx({ opportunities: [o], progressByInvoiceId: new Map([['u', 'proposed' as const]]) })).items.length, 0)
})

test('ranking is explained with weights summing to 100%', () => {
  const { items } = evaluateAttention(ctx({ opportunities: [opp('a', 45)] }))
  assert.equal(Math.round(items[0].ranking.reduce((s, p) => s + p.weight, 0) * 100), 100)
  assert.match(explainRanking(items[0]), /Priority \d+(\.\d)? of 100/)
  assert.ok(items[0].priority > 0 && items[0].priority <= 100)
})

test('a rule that crashes is reported and does not hide the other rules', () => {
  const boom: AttentionRule = { id: 'test.boom', description: 'x', run: () => { throw new Error('bad') } }
  const { items, failedRules } = evaluateAttention(ctx({ opportunities: [opp('a', 45)] }), [boom, ...ALL_RULES])
  assert.deepEqual(failedRules, ['test.boom'])
  assert.equal(items.length, 1)
})

test('output is deterministic: same inputs, same order', () => {
  const c = ctx({ opportunities: [opp('a', 45, 5_000), opp('b', 45, 5_000), opp('c', 61, 5_000)] })
  const a = evaluateAttention(c).items.map((i) => i.id)
  const b = evaluateAttention({ ...c, opportunities: [...c.opportunities].reverse() }).items.map((i) => i.id)
  assert.deepEqual(a, b)
})
