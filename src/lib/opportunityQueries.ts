/**
 * Pure builders for the opportunity requests. They contain no network or environment access so
 * the workspace-scoping rules can be unit tested: every read is filtered by organization_id, and
 * every RPC carries the organization id so the database can check workspace membership and role.
 * Authorization itself is enforced by Supabase RLS and the RPC's own checks, never by the browser.
 */

/** Open and dismissed issues. Dismissed ones stay loaded so an unpaid invoice is never silently hidden. */
export function trackedOpportunitiesParams(organizationId: string): URLSearchParams {
  if (!organizationId.trim()) throw new Error('A workspace id is required.')
  return new URLSearchParams({
    select: 'id,kind,status,currency,outstanding_minor,estimate_low_minor,estimate_high_minor,assumption_id,detected_at,detection_reason,workflow_state,snoozed_until,next_follow_up,promised_amount_minor,promised_date,dismissed_reason',
    organization_id: `eq.${organizationId}`,
    kind: 'eq.overdue_invoice',
    status: 'in.(open,dismissed)',
    order: 'detected_at.desc',
    limit: '5000',
  })
}

export function opportunityEvidenceParams(organizationId: string): URLSearchParams {
  if (!organizationId.trim()) throw new Error('A workspace id is required.')
  return new URLSearchParams({
    select: 'opportunity_id,invoice_id',
    organization_id: `eq.${organizationId}`,
    limit: '50000',
  })
}

export function syncRpcBody(organizationId: string): string {
  if (!organizationId.trim()) throw new Error('A workspace id is required.')
  return JSON.stringify({ p_org_id: organizationId })
}

export function interactionsParams(organizationId: string): URLSearchParams {
  if (!organizationId.trim()) throw new Error('A workspace id is required.')
  return new URLSearchParams({
    select: 'id,opportunity_id,invoice_id,action_id,interaction_type,summary,promised_amount_minor,promised_date,next_follow_up,created_at',
    organization_id: `eq.${organizationId}`,
    order: 'created_at.desc',
    limit: '2000',
  })
}

export function paymentEvidenceParams(organizationId: string): URLSearchParams {
  if (!organizationId.trim()) throw new Error('A workspace id is required.')
  return new URLSearchParams({
    select: 'id,invoice_id,amount_minor,currency,received_at',
    organization_id: `eq.${organizationId}`,
    order: 'received_at.desc',
    limit: '5000',
  })
}

export type InvoiceResponseType = 'customer_replied' | 'promised_to_pay' | 'disputed' | 'asked_for_extension' | 'no_response' | 'paid_claimed' | 'note'

export const RESPONSE_TYPES: readonly { type: InvoiceResponseType; label: string }[] = [
  { type: 'no_response', label: 'No reply yet' },
  { type: 'customer_replied', label: 'Customer replied' },
  { type: 'promised_to_pay', label: 'Customer promised to pay' },
  { type: 'asked_for_extension', label: 'Customer asked for more time' },
  { type: 'disputed', label: 'Customer disputes the invoice' },
  { type: 'paid_claimed', label: 'Customer says they paid' },
  { type: 'note', label: 'Add a note only' },
]

export type RecordResponseInput = {
  organizationId: string
  interactionId: string
  opportunityId: string
  type: InvoiceResponseType
  summary: string
  /** Decimal amount typed by the owner, e.g. "250.00". Converted to integer minor units here. */
  promisedAmount?: string
  promisedDate?: string
  nextFollowUp?: string
}

/** Parses "250", "250.5" or "250.50" into integer minor units. Returns null for anything else (no rounding, no guessing). */
export function parseMinorUnits(text: string): number | null {
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(text.trim())
  if (!match) return null
  const minor = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || '0')
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null
}

export function recordResponseBody(input: RecordResponseInput): string {
  if (!input.organizationId.trim()) throw new Error('A workspace id is required.')
  if (!input.interactionId.trim() || !input.opportunityId.trim()) throw new Error('An interaction id and issue id are required.')
  let promisedMinor: number | null = null
  if (input.type === 'promised_to_pay') {
    promisedMinor = parseMinorUnits(input.promisedAmount ?? '')
    if (promisedMinor === null) throw new Error('Enter the promised amount as a number with up to two decimals, such as 250.00.')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.promisedDate ?? '')) throw new Error('Choose the date the customer promised to pay by.')
  }
  return JSON.stringify({
    p_org_id: input.organizationId,
    p_interaction_id: input.interactionId,
    p_opportunity_id: input.opportunityId,
    p_interaction_type: input.type,
    p_summary: input.summary.trim(),
    p_promised_amount_minor: promisedMinor,
    p_promised_date: input.type === 'promised_to_pay' ? input.promisedDate : null,
    p_next_follow_up: input.nextFollowUp || null,
  })
}

export type IssueTransition = 'acknowledge' | 'snooze' | 'unsnooze' | 'dismiss' | 'reopen'

export function issueStateBody(input: { organizationId: string; opportunityId: string; transition: IssueTransition; reason?: string; snoozeUntil?: string }): string {
  if (!input.organizationId.trim()) throw new Error('A workspace id is required.')
  if (!input.opportunityId.trim()) throw new Error('An issue id is required.')
  return JSON.stringify({
    p_org_id: input.organizationId,
    p_opportunity_id: input.opportunityId,
    p_transition: input.transition,
    p_reason: input.reason?.trim() || null,
    p_snooze_until: input.snoozeUntil ?? null,
  })
}

export type SyncFailure = 'not_available' | 'no_permission' | 'no_assumption' | 'failed'

/** Maps a failed sync into what the screen should do next, without exposing raw errors as the plan. */
export function classifySyncFailure(message: string): SyncFailure {
  const text = message.toLowerCase()
  if (text.includes('could not find the function') || (text.includes('sync_overdue_opportunities') && text.includes('schema cache'))) return 'not_available'
  if (text.includes('permission denied')) return 'no_permission'
  if (text.includes('recovery-rate assumption')) return 'no_assumption'
  return 'failed'
}
