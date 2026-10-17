import { money } from './money.ts'
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
}
export type DbEvidenceRow = { opportunity_id: string; invoice_id: string }

export type PersistedOpportunityResult = {
  opportunities: RevenueOpportunity[]
  /** Saved opportunities that cannot be shown because their source invoice is not available. Never guessed. */
  unresolvedIds: string[]
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
  const unresolvedIds: string[] = []
  for (const row of rows) {
    if (row.kind !== 'overdue_invoice' || row.status !== 'open') continue
    const linked = (invoiceIdsByOpportunity.get(row.id) ?? []).map((id) => invoiceById.get(id))
    const sources = linked.filter((invoice): invoice is InvoiceEvidence => invoice !== undefined && invoice.currency === row.currency)
    if (linked.length === 0 || sources.length !== linked.length) { unresolvedIds.push(row.id); continue }
    const outstanding = money(Number(row.outstanding_minor), row.currency)
    opportunities.push({
      id: row.id,
      kind: 'overdue_invoice',
      status: 'open',
      evidence: sources,
      outstanding,
      estimate: {
        low: money(Number(row.estimate_low_minor), row.currency),
        high: money(Number(row.estimate_high_minor), row.currency),
        assumptionId: row.assumption_id,
        formula: 'outstanding_times_recovery_rate',
      },
      detectedAt: row.detected_at,
    })
  }
  return { opportunities, unresolvedIds }
}
