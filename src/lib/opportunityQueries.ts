/**
 * Pure builders for the opportunity requests. They contain no network or environment access so
 * the workspace-scoping rules can be unit tested: every read is filtered by organization_id, and
 * every RPC carries the organization id so the database can check workspace membership and role.
 * Authorization itself is enforced by Supabase RLS and the RPC's own checks, never by the browser.
 */

export function openOpportunitiesParams(organizationId: string): URLSearchParams {
  if (!organizationId.trim()) throw new Error('A workspace id is required.')
  return new URLSearchParams({
    select: 'id,kind,status,currency,outstanding_minor,estimate_low_minor,estimate_high_minor,assumption_id,detected_at,detection_reason',
    organization_id: `eq.${organizationId}`,
    kind: 'eq.overdue_invoice',
    status: 'eq.open',
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

export type SyncFailure = 'not_available' | 'no_permission' | 'no_assumption' | 'failed'

/** Maps a failed sync into what the screen should do next, without exposing raw errors as the plan. */
export function classifySyncFailure(message: string): SyncFailure {
  const text = message.toLowerCase()
  if (text.includes('could not find the function') || (text.includes('sync_overdue_opportunities') && text.includes('schema cache'))) return 'not_available'
  if (text.includes('permission denied')) return 'no_permission'
  if (text.includes('recovery-rate assumption')) return 'no_assumption'
  return 'failed'
}
