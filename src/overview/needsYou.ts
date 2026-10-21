/** Ranked "needs you today" rows for the top of Overview. Pure so ordering, wording and the one-appearance rule are testable. */
export type NeedsYouTarget = 'Urgent' | 'Follow-ups' | 'Actions' | 'Overview'

export type NeedsYouAction =
  | { type: 'draft'; label: string; opportunityId: string }
  | { type: 'goto'; label: string; target: NeedsYouTarget }

export interface NeedsYouItem {
  id: string
  kind: 'money' | 'promise' | 'conversation' | 'decision' | 'followup'
  /** Customer name or headline. */
  title: string
  /** Right-aligned figure (an amount), present for money rows only. */
  figure?: string
  detail: string
  /** Observed = read from a saved record; Inferred = derived by a rule the detail states. */
  basis: 'Observed' | 'Inferred'
  action: NeedsYouAction
  /** Only overdue-invoice rows can be snoozed from here; the id is the opportunity to snooze. */
  snoozeOpportunityId?: string
  /** Opens the full controls (record a response, dismiss) for this item. */
  detailsTarget: NeedsYouTarget
}

export interface NeedsYouInput {
  overdue: Array<{ id: string; customer: string; invoice: string; amount: string; lateLabel: string; progress: 'none' | 'proposed' | 'approved' | 'executed' | 'failed' | 'cancelled' }>
  brokenPromises: number
  /** Names of customers whose last message is waiting for the owner's reply. */
  conversationsAwaiting: string[]
  draftsToReview: number
  followUpsDue: number
}

export const MAX_ROWS = 5
const MAX_INVOICE_ROWS = 3

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

/** Customers are listed once on the page: conversations collapse into one summary row that points at the list below. */
export function buildNeedsYou(input: NeedsYouInput): NeedsYouItem[] {
  const items: NeedsYouItem[] = []
  for (const row of input.overdue.slice(0, MAX_INVOICE_ROWS)) {
    const drafted = row.progress !== 'none'
    items.push({
      id: `money-${row.id}`, kind: 'money', title: row.customer, figure: row.amount,
      detail: `Invoice ${row.invoice} · ${row.lateLabel}`, basis: 'Observed',
      action: drafted ? { type: 'goto', label: 'Review draft', target: 'Actions' } : { type: 'draft', label: 'Draft reminder', opportunityId: row.id },
      snoozeOpportunityId: row.id, detailsTarget: 'Urgent',
    })
  }
  if (input.brokenPromises > 0) {
    items.push({ id: 'promises', kind: 'promise', title: `${plural(input.brokenPromises, 'broken promise')} to pay`, detail: 'A customer promised a date that has passed with no payment record.', basis: 'Observed', action: { type: 'goto', label: 'Open', target: 'Urgent' }, detailsTarget: 'Urgent' })
  }
  const waiting = input.conversationsAwaiting
  if (waiting.length > 0) {
    const names = waiting.slice(0, 2).join(', ') + (waiting.length > 2 ? ` and ${waiting.length - 2} more` : '')
    items.push({ id: 'conversations', kind: 'conversation', title: `${plural(waiting.length, 'customer')} ${waiting.length === 1 ? 'is' : 'are'} waiting for your reply`, detail: names, basis: 'Inferred', action: { type: 'goto', label: 'See who', target: 'Overview' }, detailsTarget: 'Overview' })
  }
  if (input.draftsToReview > 0) {
    items.push({ id: 'drafts', kind: 'decision', title: `${plural(input.draftsToReview, 'reminder draft')} waiting for your decision`, detail: 'Nothing is sent until you approve it and send it yourself.', basis: 'Observed', action: { type: 'goto', label: 'Review', target: 'Actions' }, detailsTarget: 'Actions' })
  }
  if (input.followUpsDue > 0) {
    items.push({ id: 'followups', kind: 'followup', title: `${plural(input.followUpsDue, 'follow-up')} due`, detail: 'From the follow-up dates you saved.', basis: 'Observed', action: { type: 'goto', label: 'Open', target: 'Follow-ups' }, detailsTarget: 'Follow-ups' })
  }
  return items.slice(0, MAX_ROWS)
}

/** How many overdue invoices exist beyond the rows shown, for the "and N more" footer. */
export const hiddenInvoiceCount = (input: NeedsYouInput) => Math.max(0, input.overdue.length - MAX_INVOICE_ROWS)
