import { money } from './money.ts'
import { DEFAULT_WORKFLOW, type OpportunityWorkflow, type WorkflowState } from './issueWorkflow.ts'
import type { InvoiceEvidence, RevenueOpportunity } from './types.ts'

export type DbOpportunityRow = {
  id: string
  kind: string
  status: string
  currency: string
  outstanding_minor: number | string
  estimate_low_minor: number | string
  estimate_high_minor: number | string
  assumption_id: string
  detected_at: string
  detection_reason?: string | null
  workflow_state?: string | null
  snoozed_until?: string | null
  next_follow_up?: string | null
  promised_amount_minor?: number | string | null
  promised_date?: string | null
  dismissed_reason?: string | null
}
export type DbEvidenceRow = { opportunity_id: string; invoice_id: string }

export type PersistedOpportunityResult = {
  opportunities: RevenueOpportunity[]
  /** Dismissed issues. They are out of the attention queue, but their invoices may still be unpaid. */
  dismissed: RevenueOpportunity[]
  /** Saved opportunities that cannot be shown because their source invoice is not available. Never guessed. */
  unresolvedIds: string[]
}

const WORKFLOW_STATES: readonly WorkflowState[] = ['new', 'acknowledged', 'awaiting_response', 'in_conversation', 'promised', 'disputed', 'payment_claimed']

function toWorkflow(row: DbOpportunityRow): OpportunityWorkflow {
  const state = WORKFLOW_STATES.find((candidate) => candidate === row.workflow_state) ?? DEFAULT_WORKFLOW.state
  const promisedMinor = row.promised_amount_minor === null || row.promised_amount_minor === undefined ? null : Number(row.promised_amount_minor)
  return {
    state,
    snoozedUntil: row.snoozed_until ?? null,
    nextFollowUp: row.next_follow_up ?? null,
    promisedAmount: promisedMinor !== null && Number.isSafeInteger(promisedMinor) && promisedMinor > 0 && row.promised_date ? money(promisedMinor, row.currency) : null,
    promisedDate: promisedMinor !== null && row.promised_date ? row.promised_date : null,
    dismissedReason: row.dismissed_reason ?? null,
  }
}

/**
 * Rebuilds open overdue-invoice opportunities from saved rows plus their source invoices.
 * An opportunity is shown only when its evidence resolves to a real saved invoice in the same
 * currency; otherwise it is reported as unresolved instead of being filled in.
 */
export function toRevenueOpportunities(
  rows: DbOpportunityRow[],
  evidence: DbEvidenceRow[],
  invoices: InvoiceEvidence[],
): PersistedOpportunityResult {
  const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]))
  const invoiceIdsByOpportunity = new Map<string, string[]>()
  for (const link of evidence) {
    const list = invoiceIdsByOpportunity.get(link.opportunity_id) ?? []
    list.push(link.invoice_id)
    invoiceIdsByOpportunity.set(link.opportunity_id, list)
  }

  const opportunities: RevenueOpportunity[] = []
  const dismissed: RevenueOpportunity[] = []
  const unresolvedIds: string[] = []
  for (const row of rows) {
    if (row.kind !== 'overdue_invoice' || (row.status !== 'open' && row.status !== 'dismissed')) continue
    const linked = (invoiceIdsByOpportunity.get(row.id) ?? []).map((id) => invoiceById.get(id))
    const sources = linked.filter((invoice): invoice is InvoiceEvidence => invoice !== undefined && invoice.currency === row.currency)
    if (linked.length === 0 || sources.length !== linked.length) { unresolvedIds.push(row.id); continue }
    const outstanding = money(Number(row.outstanding_minor), row.currency)
    const opportunity: RevenueOpportunity = {
      id: row.id,
      kind: 'overdue_invoice',
      status: row.status === 'dismissed' ? 'dismissed' : 'open',
      evidence: sources,
      outstanding,
      estimate: {
        low: money(Number(row.estimate_low_minor), row.currency),
        high: money(Number(row.estimate_high_minor), row.currency),
        assumptionId: row.assumption_id,
        formula: 'outstanding_times_recovery_rate',
      },
      detectedAt: row.detected_at,
      workflow: toWorkflow(row),
    }
    if (row.status === 'dismissed') dismissed.push(opportunity)
    else opportunities.push(opportunity)
  }
  return { opportunities, dismissed, unresolvedIds }
}
