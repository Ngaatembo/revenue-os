import { dateOnly } from '../issueWorkflow.ts'
import { formatMoney, money } from '../money.ts'
import { daysBetween, depositMoney, percentOfMinor, quotationMoney } from '../records.ts'
import type { AttentionContext, AttentionFinding, AttentionRule, RecordsContext } from './types.ts'

const records = (context: AttentionContext): RecordsContext | undefined => context.records
const POSTPONED_AT = 3

const quoteSubject = (q: { id: string; reference: string; customerName: string }) => ({ type: 'quotation' as const, id: q.id, label: `${q.customerName} · quotation ${q.reference}` })

export const quoteFollowUpRule: AttentionRule = {
  id: 'quote.follow_up_due',
  description: 'A sent quotation has a follow-up date that has arrived or passed.',
  run: (context) => {
    const today = dateOnly(context.asOf)
    return (records(context)?.quotations ?? []).flatMap((q): AttentionFinding[] => {
      if (q.status !== 'sent' || !q.followUpDate || q.followUpDate > today) return []
      const late = daysBetween(q.followUpDate, today)
      return [{
        ruleId: 'quote.follow_up_due', subject: quoteSubject(q), severity: late > 3 ? 4 : 3, strength: 'confirmed', urgency: Math.min(0.9, 0.5 + late / 20), likelihood: 0.5, effort: 0.2,
        speculativeMoney: quotationMoney(q),
        what: late === 0 ? 'Quotation follow-up is due today.' : `Quotation follow-up is ${late} day${late === 1 ? '' : 's'} late.`,
        evidence: [`Quotation ${q.reference} for ${formatMoney(quotationMoney(q))} was sent ${q.sentOn}; follow-up was planned for ${q.followUpDate}.`, 'The quotation value is a possible sale, not money owed.'],
        why: 'A quotation that nobody chases is usually lost to whoever answers first.', nextStep: 'Contact the customer, then record what they said and set the next follow-up.',
      }]
    })
  },
}

export const quoteUnansweredRule: AttentionRule = {
  id: 'quote.unanswered',
  description: 'No contact has been recorded on an open quotation for as long as your "quote follow-up" setting.',
  run: (context) => {
    const today = dateOnly(context.asOf)
    const setting = context.settings.quote_follow_up_days
    return (records(context)?.quotations ?? []).flatMap((q): AttentionFinding[] => {
      if (q.status !== 'sent') return []
      const since = q.lastContactOn ?? q.sentOn
      const silent = daysBetween(since, today)
      if (silent < setting.value) return []
      return [{
        ruleId: 'quote.unanswered', subject: quoteSubject(q), severity: 3, strength: 'inferred', urgency: Math.min(0.85, 0.4 + silent / 60), likelihood: 0.4, effort: 0.2,
        speculativeMoney: quotationMoney(q),
        what: `No recorded contact on this quotation for ${silent} days.`,
        evidence: [q.lastContactOn ? `Last contact recorded ${q.lastContactOn}.` : `Sent ${q.sentOn}; no follow-up or reply has been recorded.`, setting.explanation, 'If you spoke to the customer outside Revenue OS, record it so this clears.'],
        why: 'Quotations that go quiet rarely close on their own.', nextStep: 'Ask the customer for a decision and record the answer.',
      }]
    })
  },
}

export const quoteExpiringRule: AttentionRule = {
  id: 'quote.expiring',
  description: 'An open quotation is about to expire or has expired without an answer.',
  run: (context) => {
    const today = dateOnly(context.asOf)
    return (records(context)?.quotations ?? []).flatMap((q): AttentionFinding[] => {
      if (q.status !== 'sent' || !q.validUntil) return []
      const left = daysBetween(today, q.validUntil)
      if (left > 7) return []
      return [{
        ruleId: 'quote.expiring', subject: quoteSubject(q), severity: left < 0 ? 3 : 4, strength: 'confirmed', urgency: left < 0 ? 0.6 : Math.min(0.95, 0.95 - left * 0.05), likelihood: 0.5, effort: 0.2,
        speculativeMoney: quotationMoney(q),
        what: left < 0 ? `Quotation expired ${-left} day${left === -1 ? '' : 's'} ago with no answer.` : left === 0 ? 'Quotation expires today.' : `Quotation expires in ${left} day${left === 1 ? '' : 's'}.`,
        evidence: [`Valid until ${q.validUntil}; still unanswered.`],
        why: left < 0 ? 'The price may no longer be valid; decide whether to renew or close it.' : 'Customers decide faster when there is a deadline.', nextStep: left < 0 ? 'Renew the quotation or mark it withdrawn.' : 'Remind the customer of the deadline.',
      }]
    })
  },
}

export const quotePostponedRule: AttentionRule = {
  id: 'quote.postponed',
  description: 'A follow-up date has been pushed back several times.',
  run: (context) => {
    const counts = records(context)?.rescheduleCounts
    return (records(context)?.quotations ?? []).flatMap((q): AttentionFinding[] => {
      const n = counts?.get(`quotation:${q.id}`) ?? 0
      if (q.status !== 'sent' || n < POSTPONED_AT) return []
      return [{
        ruleId: 'quote.postponed', subject: quoteSubject(q), severity: 3, strength: 'confirmed', urgency: 0.5, likelihood: 0.35, effort: 0.3,
        speculativeMoney: quotationMoney(q),
        what: `The follow-up has been pushed back ${n} times.`, evidence: [`${n} reschedules are on record for quotation ${q.reference}.`],
        why: 'Repeated delay often means the sale is stuck or nobody owns it.', nextStep: 'Decide: make contact now, hand it to someone, or close it.',
      }]
    })
  },
}

export const quoteNoDepositRule: AttentionRule = {
  id: 'quote.accepted_no_deposit',
  description: 'An accepted quotation has no deposit recorded although you normally ask for one.',
  run: (context) => {
    const percent = context.settings.deposit_percent
    if (percent.value <= 0) return []
    const r = records(context)
    return (r?.quotations ?? []).flatMap((q): AttentionFinding[] => {
      if (q.status !== 'accepted' || r!.deposits.some((d) => d.quotationId === q.id && d.status !== 'cancelled')) return []
      const expected = money(percentOfMinor(q.amountMinor, percent.value), q.currency)
      return [{
        ruleId: 'quote.accepted_no_deposit', subject: quoteSubject(q), severity: 3, strength: 'inferred', urgency: 0.6, likelihood: 0.6, effort: 0.2,
        speculativeMoney: expected,
        what: `Accepted, but no deposit has been requested (usual deposit ${formatMoney(expected)}).`,
        evidence: [`Quotation ${q.reference} for ${formatMoney(quotationMoney(q))} was accepted.`, percent.explanation],
        why: 'Starting work without the usual deposit leaves you carrying the risk.', nextStep: 'Ask for the deposit and record the promised date.',
      }]
    })
  },
}

export const depositDueRule: AttentionRule = {
  id: 'deposit.due',
  description: 'A promised deposit is due or late and no payment has been verified.',
  run: (context) => {
    const today = dateOnly(context.asOf)
    const counts = records(context)?.rescheduleCounts
    return (records(context)?.deposits ?? []).flatMap((d): AttentionFinding[] => {
      if (d.status !== 'promised' || d.promisedDate > today) return []
      const late = daysBetween(d.promisedDate, today)
      const moved = counts?.get(`deposit:${d.id}`) ?? 0
      return [{
        ruleId: 'deposit.due', subject: { type: 'deposit', id: d.id, label: `${d.customerName} · deposit` }, severity: late > 3 ? 5 : 4, strength: 'confirmed', urgency: Math.min(0.95, 0.65 + late / 20), likelihood: 0.6, effort: 0.2,
        speculativeMoney: depositMoney(d),
        what: late === 0 ? 'A promised deposit is due today and not yet verified.' : `A promised deposit is ${late} day${late === 1 ? '' : 's'} late.`,
        evidence: [`${formatMoney(depositMoney(d))} was promised for ${d.promisedDate}.`, moved ? `The date has been moved ${moved} time${moved === 1 ? '' : 's'}.` : 'The date has not been moved.', 'A promise is not payment: it counts as received only when a payment record matches it.'],
        why: 'Work started without the deposit is unsecured.', nextStep: 'Ask for the deposit, then import the payment or mark it received to be verified.',
      }]
    })
  },
}

export const depositUnverifiedRule: AttentionRule = {
  id: 'deposit.unverified',
  description: 'You said a deposit was received but no payment record backs it.',
  run: (context) => {
    const today = dateOnly(context.asOf)
    return (records(context)?.deposits ?? []).flatMap((d): AttentionFinding[] => {
      if (d.status !== 'received_unverified') return []
      const waited = d.ownerConfirmedOn ? daysBetween(d.ownerConfirmedOn, today) : 0
      if (waited < 3) return []
      return [{
        ruleId: 'deposit.unverified', subject: { type: 'deposit', id: d.id, label: `${d.customerName} · deposit` }, severity: 2, strength: 'inferred', urgency: 0.35, likelihood: 0.5, effort: 0.3,
        what: `You marked this deposit received ${waited} days ago; no payment record confirms it.`,
        evidence: [`Owner-confirmed ${d.ownerConfirmedMinor !== null ? formatMoney(money(d.ownerConfirmedMinor, d.currency)) : 'an amount'} on ${d.ownerConfirmedOn ?? 'an unknown date'}.`, 'Only an imported payment record makes a deposit verified.'],
        why: 'Unverified deposits are easy to miscount.', nextStep: 'Import the bank or payment file that includes it.',
      }]
    })
  },
}

export const paymentReviewRule: AttentionRule = {
  id: 'payment.needs_review',
  description: 'A payment could not be matched to exactly one invoice and is waiting for you.',
  run: (context) => {
    const today = dateOnly(context.asOf)
    return (records(context)?.paymentReviews ?? []).flatMap((p): AttentionFinding[] => {
      if (p.status !== 'pending') return []
      const age = Math.max(0, daysBetween(p.createdAt, today))
      const amount = formatMoney(money(p.amountMinor, p.currency))
      return [{
        ruleId: 'payment.needs_review', subject: { type: 'payment_review', id: p.id, label: `Payment ${p.externalRecordId} · ${amount}` }, severity: 3, strength: 'confirmed', urgency: Math.min(0.8, 0.35 + age / 30), likelihood: 0.8, effort: 0.2,
        what: p.reason === 'invoice_ambiguous' ? `A ${amount} payment matches ${p.candidateInvoiceIds.length} invoices with the same number.` : `A ${amount} payment names invoice "${p.invoiceNumber}" which is not in your records.`,
        evidence: [`Received ${p.receivedAt.slice(0, 10)}; waiting ${age} day${age === 1 ? '' : 's'}.`, 'The payment is saved but not applied to anything until you decide.'],
        why: 'Until it is matched, an invoice may look unpaid (and get chased) although the customer has paid.', nextStep: p.reason === 'invoice_ambiguous' ? 'Choose which invoice this payment belongs to.' : 'Import the missing invoice, link a deposit, or dismiss it with a reason.',
      }]
    })
  },
}

export const taskOverdueRule: AttentionRule = {
  id: 'task.overdue',
  description: 'A task you or your team set is past its due date.',
  run: (context) => {
    const today = dateOnly(context.asOf)
    const counts = records(context)?.rescheduleCounts
    return (records(context)?.tasks ?? []).flatMap((t): AttentionFinding[] => {
      if (t.status !== 'open' || t.dueDate >= today) return []
      const late = daysBetween(t.dueDate, today)
      const moved = counts?.get(`task:${t.id}`) ?? 0
      return [{
        ruleId: 'task.overdue', subject: { type: 'task', id: t.id, label: t.title }, severity: 3, strength: 'confirmed', urgency: Math.min(0.9, 0.5 + late / 20), likelihood: 0.5, effort: 0.3,
        what: `Task is ${late} day${late === 1 ? '' : 's'} overdue.`,
        evidence: [`Due ${t.dueDate}.`, t.ownerId ? 'It has an owner.' : 'Nobody owns it.', ...(moved >= POSTPONED_AT ? [`Its date has been pushed back ${moved} times.`] : [])],
        why: 'Overdue tasks are the commitments most likely to be forgotten.', nextStep: 'Do it, reschedule it with a reason, or cancel it.',
      }]
    })
  },
}

export const taskDueSoonRule: AttentionRule = {
  id: 'task.due_soon',
  description: 'A task is due today or within two days.',
  run: (context) => {
    const today = dateOnly(context.asOf)
    return (records(context)?.tasks ?? []).flatMap((t): AttentionFinding[] => {
      const left = daysBetween(today, t.dueDate)
      if (t.status !== 'open' || left < 0 || left > 2) return []
      return [{
        ruleId: 'task.due_soon', subject: { type: 'task', id: t.id, label: t.title }, severity: 2, strength: 'confirmed', urgency: left === 0 ? 0.6 : 0.4, likelihood: 0.5, effort: 0.3,
        what: left === 0 ? 'Task is due today.' : `Task is due in ${left} day${left === 1 ? '' : 's'}.`, evidence: [`Due ${t.dueDate}.`],
        why: 'A deadline that is close is easiest to keep when you see it early.', nextStep: 'Finish it or move the date with a reason.',
      }]
    })
  },
}

export const taskUnownedRule: AttentionRule = {
  id: 'task.unowned',
  description: 'An open task has nobody responsible for it.',
  run: (context) => (records(context)?.tasks ?? []).flatMap((t): AttentionFinding[] => {
    if (t.status !== 'open' || t.ownerId) return []
    return [{
      ruleId: 'task.unowned', subject: { type: 'task', id: t.id, label: t.title }, severity: 2, strength: 'confirmed', urgency: 0.3, likelihood: 0.6, effort: 0.1,
      what: 'Nobody is responsible for this task.', evidence: [`Due ${t.dueDate}; no owner assigned.`],
      why: 'Work with no owner is the work that does not get done.', nextStep: 'Assign someone.',
    }]
  }),
}

export const actionUnownedRule: AttentionRule = {
  id: 'action.unowned',
  description: 'A recovery action is waiting on a person but nobody owns it.',
  run: (context) => (records(context)?.openActions ?? []).flatMap((a): AttentionFinding[] => {
    if (a.ownerId) return []
    return [{
      ruleId: 'action.unowned', subject: { type: 'action', id: a.id, label: a.label }, severity: 2, strength: 'confirmed', urgency: 0.35, likelihood: 0.6, effort: 0.1,
      what: a.status === 'proposed' ? 'A drafted reminder has nobody responsible for reviewing it.' : 'An approved reminder has nobody responsible for sending it.',
      evidence: [`Status: ${a.status === 'proposed' ? 'draft' : 'approved, not sent'}.`],
      why: 'Nothing is sent automatically, so an action with no owner just waits.', nextStep: 'Assign an owner on the Actions page.',
    }]
  }),
}

export const RECORD_RULES: AttentionRule[] = [quoteFollowUpRule, quoteUnansweredRule, quoteExpiringRule, quotePostponedRule, quoteNoDepositRule, depositDueRule, depositUnverifiedRule, paymentReviewRule, taskOverdueRule, taskDueSoonRule, taskUnownedRule, actionUnownedRule]
