/**
 * Central plan and entitlement definitions.
 *
 * Billing is NOT connected. There is no stored subscription, so every workspace
 * currently resolves to the `pilot` plan. Prices below are unvalidated hypotheses
 * from product research and exist only so the product can be tested with pilots;
 * nothing here charges anyone.
 */
export type PlanId = 'pilot' | 'starter' | 'growth'

export type Entitlements = {
  maxInvoicesPerImport: number
  maxActiveLeads: number
  paymentVerification: boolean
  leadRecovery: boolean
}

export type Plan = {
  id: PlanId
  name: string
  entitlements: Entitlements
  /** Monthly price hypotheses in USD; null while the plan is not offered. Unvalidated. */
  priceHypothesisUsd: { emergingMarkets: [number, number]; developedMarkets: [number, number] } | null
}

export const BILLING_STATUS = 'not_connected' as const
export const DEFAULT_PLAN_ID: PlanId = 'pilot'

export const PLANS: Readonly<Record<PlanId, Plan>> = {
  pilot: {
    id: 'pilot',
    name: 'Supervised pilot',
    entitlements: { maxInvoicesPerImport: 2000, maxActiveLeads: 200, paymentVerification: true, leadRecovery: true },
    priceHypothesisUsd: null,
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    entitlements: { maxInvoicesPerImport: 500, maxActiveLeads: 50, paymentVerification: true, leadRecovery: true },
    priceHypothesisUsd: { emergingMarkets: [9, 19], developedMarkets: [29, 49] },
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    entitlements: { maxInvoicesPerImport: 5000, maxActiveLeads: 1000, paymentVerification: true, leadRecovery: true },
    priceHypothesisUsd: null,
  },
}

export function getPlan(id: string | null | undefined): Plan {
  return (id && id in PLANS ? PLANS[id as PlanId] : PLANS[DEFAULT_PLAN_ID])
}

export type LimitCheck = { allowed: true } | { allowed: false; message: string }

export function checkInvoiceImportSize(plan: Plan, rowCount: number): LimitCheck {
  const max = plan.entitlements.maxInvoicesPerImport
  return rowCount <= max
    ? { allowed: true }
    : { allowed: false, message: `The ${plan.name} plan allows up to ${max} invoices per import; this file has ${rowCount}. Split the file and import it in parts.` }
}

export function checkLeadCapacity(plan: Plan, activeLeadCount: number): LimitCheck {
  const max = plan.entitlements.maxActiveLeads
  return activeLeadCount < max
    ? { allowed: true }
    : { allowed: false, message: `The ${plan.name} plan allows up to ${max} active leads. Close or convert some leads to add more.` }
}
