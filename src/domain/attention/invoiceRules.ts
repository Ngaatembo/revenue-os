import { dateOnly, isSnoozed } from '../issueWorkflow.ts'
import { formatMoney } from '../money.ts'
import { daysOverdue } from '../prioritization.ts'
import type { RevenueOpportunity } from '../types.ts'
import type { AttentionContext, AttentionFinding, AttentionRule, Subject } from './types.ts'

const DAY = 86_400_000

function subjectOf(opportunity: RevenueOpportunity): Subject {
  const invoice = opportunity.evidence[0]
  return { type: 'invoice', id: opportunity.id, label: `${invoice.customerName} · invoice ${invoice.invoiceNumber}` }
}

function base(opportunity: RevenueOpportunity, asOf: string) {
  const invoice = opportunity.evidence[0]
  const days = daysOverdue(invoice.dueAt, asOf)
  return {
    subject: subjectOf(opportunity),
    knownMoney: opportunity.outstanding,
    days,
    facts: [`Invoice ${invoice.invoiceNumber} for ${formatMoney(invoice.total)} was due ${invoice.dueAt.slice(0, 10)}.`, `${formatMoney(opportunity.outstanding)} is unpaid in your records (${days} day${days === 1 ? '' : 's'} past due).`],
  }
}

const forEachOpen = (context: AttentionContext, build: (opportunity: RevenueOpportunity, b: ReturnType<typeof base>) => AttentionFinding | null) =>
  context.opportunities.flatMap((opportunity) => {
    if (opportunity.status !== 'open') return []
    const finding = build(opportunity, base(opportunity, context.asOf))
    return finding ? [finding] : []
  })

export const brokenPromiseRule: AttentionRule = {
  id: 'invoice.broken_promise',
  description: 'The customer promised to pay by a date that has passed and the invoice is still unpaid.',
  run: (context) => forEachOpen(context, (opportunity, b) => {
    const workflow = opportunity.workflow
    if (!workflow?.promisedAmount || !workflow.promisedDate || workflow.promisedDate >= dateOnly(context.asOf)) return null
    return {
      ruleId: 'invoice.broken_promise', subject: b.subject, severity: 5, strength: 'confirmed', urgency: 0.95, likelihood: 0.7, effort: 0.3, knownMoney: b.knownMoney,
      what: `The customer promised ${formatMoney(workflow.promisedAmount)} by ${workflow.promisedDate} and has not paid.`,
      evidence: [...b.facts, `You recorded the promise; no matching payment evidence has been imported.`],
      why: 'A missed promise is the strongest sign the invoice is slipping, and the customer has already agreed the debt.',
      nextStep: 'Contact the customer about the missed date, then record what they say.',
    }
  }),
}

export const disputedRule: AttentionRule = {
  id: 'invoice.disputed',
  description: 'The customer disputes the invoice.',
  run: (context) => forEachOpen(context, (opportunity, b) => opportunity.workflow?.state === 'disputed' ? {
    ruleId: 'invoice.disputed', subject: b.subject, severity: 4, strength: 'confirmed', urgency: 0.7, likelihood: 0.5, effort: 0.7, knownMoney: b.knownMoney,
    what: 'The customer disputes this invoice.', evidence: [...b.facts, 'You recorded a dispute against it.'],
    why: 'More reminders will not help until the disagreement is settled, and it may mean the invoice is wrong.',
    nextStep: 'Resolve the dispute with the customer, then record the outcome or dismiss the issue with a reason.',
  } : null),
}

export const paymentClaimedRule: AttentionRule = {
  id: 'invoice.payment_claimed_unverified',
  description: 'The customer says they paid but no payment evidence matches.',
  run: (context) => forEachOpen(context, (opportunity, b) => opportunity.workflow?.state === 'payment_claimed' ? {
    ruleId: 'invoice.payment_claimed_unverified', subject: b.subject, severity: 4, strength: 'confirmed', urgency: 0.6, likelihood: 0.8, effort: 0.2, knownMoney: b.knownMoney,
    what: 'The customer says they have paid, but no payment is recorded.', evidence: [...b.facts, 'A claim of payment is recorded; it is not evidence of payment.'],
    why: 'Either the money arrived and has not been matched, or the claim is wrong. Both need checking before chasing again.',
    nextStep: 'Check your bank records, then import the payment as evidence.',
  } : null),
}

export const followUpDueRule: AttentionRule = {
  id: 'invoice.follow_up_due',
  description: 'A follow-up you planned has arrived and nothing has been recorded since.',
  run: (context) => forEachOpen(context, (opportunity, b) => {
    const workflow = opportunity.workflow
    const today = dateOnly(context.asOf)
    if (!workflow?.nextFollowUp || workflow.state === 'new' || workflow.nextFollowUp > today) return null
    return {
      ruleId: 'invoice.follow_up_due', subject: b.subject, severity: 3, strength: 'confirmed', urgency: 0.6, likelihood: 0.6, effort: 0.2, knownMoney: b.knownMoney,
      what: `A follow-up planned for ${workflow.nextFollowUp} has not been recorded.`, evidence: b.facts,
      why: 'Follow-ups that slip are how invoices get forgotten.', nextStep: 'Follow up with the customer and record what happens.',
    }
  }),
}

export const severelyOverdueRule: AttentionRule = {
  id: 'invoice.severely_overdue',
  description: 'Invoice is more than 30 days past due.',
  run: (context) => forEachOpen(context, (_opportunity, b) => b.days > 30 ? {
    ruleId: 'invoice.severely_overdue', subject: b.subject, severity: b.days > 60 ? 4 : 3, strength: 'confirmed', urgency: b.days > 60 ? 0.9 : 0.7, likelihood: b.days > 60 ? 0.4 : 0.6, effort: 0.4, knownMoney: b.knownMoney,
    what: `The invoice is ${b.days} days past due.`, evidence: b.facts,
    why: 'The longer an invoice is overdue, the less likely it is to be paid.', nextStep: 'Contact the customer and agree a payment date.',
  } : null),
}

export const untouchedOverdueRule: AttentionRule = {
  id: 'invoice.untouched',
  description: 'Overdue for over a week with no reminder, response or note recorded.',
  run: (context) => forEachOpen(context, (opportunity, b) => {
    const progress = context.progressByInvoiceId.get(opportunity.evidence[0].id) ?? 'none'
    const state = opportunity.workflow?.state ?? 'new'
    if (b.days <= 7 || progress !== 'none' || state !== 'new') return null
    return {
      ruleId: 'invoice.untouched', subject: b.subject, severity: 2, strength: 'inferred', urgency: 0.4, likelihood: 0.7, effort: 0.2, knownMoney: b.knownMoney,
      what: 'Nothing has been done about this overdue invoice yet.', evidence: [...b.facts, 'No reminder, response or acknowledgement is recorded.'],
      why: 'Many late invoices are paid after a simple reminder, but only if someone sends it.', nextStep: 'Draft a reminder for your review.',
    }
  }),
}

export const reminderNoEffectRule: AttentionRule = {
  id: 'invoice.reminder_no_effect',
  description: 'A reminder was sent more than a week ago and no payment has been observed.',
  run: (context) => forEachOpen(context, (opportunity, b) => {
    const sent = context.reminderSentAt.get(opportunity.evidence[0].id)
    if (!sent) return null
    const waited = Math.floor((Date.parse(context.asOf) - Date.parse(sent)) / DAY)
    if (!Number.isFinite(waited) || waited < 7) return null
    return {
      ruleId: 'invoice.reminder_no_effect', subject: b.subject, severity: 3, strength: 'confirmed', urgency: 0.55, likelihood: 0.5, effort: 0.3, knownMoney: b.knownMoney,
      what: `A reminder was marked sent ${waited} days ago and the invoice is still unpaid.`, evidence: [...b.facts, `You marked a reminder as sent on ${sent.slice(0, 10)}.`],
      why: 'The first reminder did not move it. A second, firmer step is usually needed.', nextStep: 'Call the customer or send a firmer follow-up, then record the result.',
    }
  }),
}

export const repeatedNoReplyRule: AttentionRule = {
  id: 'invoice.repeated_no_reply',
  description: 'Chased three or more times without a reply.',
  run: (context) => forEachOpen(context, (opportunity, b) => {
    const count = context.noReplyCounts.get(opportunity.id) ?? 0
    if (count < 3) return null
    return {
      ruleId: 'invoice.repeated_no_reply', subject: b.subject, severity: 4, strength: 'confirmed', urgency: 0.65, likelihood: 0.35, effort: 0.6, knownMoney: b.knownMoney,
      what: `You have recorded no reply ${count} times.`, evidence: [...b.facts, `${count} "no reply" entries are recorded.`],
      why: 'Repeating the same message is not working.', nextStep: 'Change the approach: phone, a different contact, or a formal notice.',
    }
  }),
}

export const INVOICE_RULES: AttentionRule[] = [
  brokenPromiseRule, disputedRule, paymentClaimedRule, followUpDueRule, severelyOverdueRule, untouchedOverdueRule, reminderNoEffectRule, repeatedNoReplyRule,
]

export function invoiceSnoozedUntil(opportunity: RevenueOpportunity, asOf: string): string | null {
  return opportunity.workflow && isSnoozed(opportunity.workflow, asOf) ? opportunity.workflow.snoozedUntil : null
}
