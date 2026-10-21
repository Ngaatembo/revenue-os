/** Ranked "needs you today" items for the top of Overview. Pure so the ordering and wording are testable. */
export type NeedsYouTarget = 'Urgent' | 'Follow-ups' | 'Actions' | 'Overview'

export interface NeedsYouItem {
  id: string
  kind: 'money' | 'promise' | 'conversation' | 'decision' | 'followup'
  title: string
  detail: string
  /** Observed = read from a saved record; Inferred = derived by a rule the detail states. */
  basis: 'Observed' | 'Inferred'
  target: NeedsYouTarget
}

export interface NeedsYouInput {
  overdue: Array<{ id: string; customer: string; invoice: string; amount: string; lateLabel: string }>
  brokenPromises: number
  conversationsAwaiting: Array<{ id: string; who: string; subject: string; observed: string }>
  draftsToReview: number
  followUpsDue: number
}

const MAX_ITEMS = 5

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

export function buildNeedsYou(input: NeedsYouInput): NeedsYouItem[] {
  const items: NeedsYouItem[] = []
  for (const row of input.overdue.slice(0, 3)) {
    items.push({ id: `money-${row.id}`, kind: 'money', title: `${row.customer} owes you ${row.amount}`, detail: `Invoice ${row.invoice} · ${row.lateLabel}`, basis: 'Observed', target: 'Urgent' })
  }
  if (input.brokenPromises > 0) {
    items.push({ id: 'promises', kind: 'promise', title: `${plural(input.brokenPromises, 'broken promise')} to pay`, detail: 'A customer promised a date that has passed with no payment record.', basis: 'Observed', target: 'Urgent' })
  }
  for (const row of input.conversationsAwaiting.slice(0, 2)) {
    items.push({ id: `conversation-${row.id}`, kind: 'conversation', title: `${row.who} is waiting for your reply`, detail: `${row.subject} · ${row.observed}`, basis: 'Inferred', target: 'Overview' })
  }
  if (input.draftsToReview > 0) {
    items.push({ id: 'drafts', kind: 'decision', title: `${plural(input.draftsToReview, 'reminder draft')} waiting for your decision`, detail: 'Nothing is sent until you approve it and send it yourself.', basis: 'Observed', target: 'Actions' })
  }
  if (input.followUpsDue > 0) {
    items.push({ id: 'followups', kind: 'followup', title: `${plural(input.followUpsDue, 'follow-up')} due`, detail: 'From the follow-up dates you saved.', basis: 'Observed', target: 'Follow-ups' })
  }
  return items.slice(0, MAX_ITEMS)
}
