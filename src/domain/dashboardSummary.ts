import { addMoney } from './money.ts'
import type { Money } from './types.ts'
import { money } from './money.ts'

export type SummaryAction = { id: string; status: 'proposed' | 'approved' | 'executed' | 'failed' | 'cancelled' }
export type SummaryOutcome = { id: string; actionId: string; amountMinor: number; currency: string; recordedAt: string }

export type DashboardSummary = {
  actionCounts: { proposed: number; approved: number; executed: number; closedWithoutSend: number }
  /** Reminders waiting on the owner: review (proposed) or send (approved). */
  needsOwner: number
  /** Sent reminders with no verified outcome yet. */
  awaitingEvidence: number
  verifiedByCurrency: Money[]
  verifiedOutcomeCount: number
}

/**
 * Verified amounts come only from saved verified outcomes. One outcome is counted per action
 * (the latest), so a refreshed verification can never double count. Currencies are never mixed.
 */
export function buildDashboardSummary(actions: SummaryAction[], outcomes: SummaryOutcome[]): DashboardSummary {
  const counts = { proposed: 0, approved: 0, executed: 0, closedWithoutSend: 0 }
  for (const action of actions) {
    if (action.status === 'proposed') counts.proposed += 1
    else if (action.status === 'approved') counts.approved += 1
    else if (action.status === 'executed') counts.executed += 1
    else counts.closedWithoutSend += 1
  }

  const latestByAction = new Map<string, SummaryOutcome>()
  for (const outcome of outcomes) {
    const current = latestByAction.get(outcome.actionId)
    if (!current || outcome.recordedAt > current.recordedAt) latestByAction.set(outcome.actionId, outcome)
  }

  const totals = new Map<string, Money>()
  for (const outcome of latestByAction.values()) {
    const amount = money(outcome.amountMinor, outcome.currency)
    const existing = totals.get(amount.currency)
    totals.set(amount.currency, existing ? addMoney(existing, amount) : amount)
  }

  const executedIds = new Set(actions.filter((action) => action.status === 'executed').map((action) => action.id))
  let awaiting = 0
  for (const id of executedIds) if (!latestByAction.has(id)) awaiting += 1

  return {
    actionCounts: counts,
    needsOwner: counts.proposed + counts.approved,
    awaitingEvidence: awaiting,
    verifiedByCurrency: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    verifiedOutcomeCount: latestByAction.size,
  }
}
