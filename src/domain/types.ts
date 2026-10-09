/** Shared business types for the first Revenue OS vertical slice. */

export type CurrencyCode = string & { readonly __brand: 'CurrencyCode' }
export type MinorUnits = number & { readonly __brand: 'MinorUnits' }

export type Money = {
  /** Integer minor units (for example, cents). Never use floating-point currency. */
  amount: MinorUnits
  currency: CurrencyCode
}

export type InvoiceEvidence = {
  id: string
  customerId: string
  customerName: string
  invoiceNumber: string
  currency: CurrencyCode
  total: Money
  paid: Money
  issuedAt: string
  dueAt: string
  source: {
    sourceId: string
    recordId: string
    importedAt: string
  }
}

export type RevenueAssumption = {
  id: string
  key: 'recovery_rate'
  /** Integer basis points: 2500 = 25%. */
  valueBps: number
  updatedAt: string
  updatedBy: string
}

export type RevenueOpportunity = {
  id: string
  kind: 'overdue_invoice'
  status: 'open' | 'accepted' | 'dismissed' | 'closed'
  evidence: InvoiceEvidence[]
  outstanding: Money
  estimate: {
    low: Money
    high: Money
    assumptionId: string
    formula: 'outstanding_times_recovery_rate'
  }
  detectedAt: string
}

export type RevenueAction = {
  id: string
  opportunityId: string
  kind: 'payment_reminder'
  status: 'proposed' | 'approved' | 'executed' | 'failed' | 'cancelled'
  proposedAt: string
  approvedAt?: string
  approvedBy?: string
  executedAt?: string
  executedBy?: string
  executionMode: 'manual'
  payload: {
    recipientCustomerId: string
    invoiceIds: string[]
    message: string
  }
}

export type PaymentEvidence = {
  id: string
  invoiceId: string
  amount: Money
  receivedAt: string
  source: {
    sourceId: string
    recordId: string
    importedAt: string
  }
}

export type RevenueAttribution = {
  id: string
  actionId: string
  opportunityId: string
  paymentEvidence: PaymentEvidence[]
  amount: Money
  state: 'reported' | 'verified'
  method: 'human_report' | 'matched_payment_record'
  measurementWindow: { startsAt: string; endsAt: string }
  causalClaim: 'observed_after_action_not_proven_causal'
}

export type OpportunityInput = {
  invoices: InvoiceEvidence[]
  assumption: RevenueAssumption
  asOf: string
  minDaysOverdue?: number
}
