/** Pure request builders for the Business Brain (no network access, unit tested). Every request carries the workspace id. */

const need = (organizationId: string) => { if (!organizationId.trim()) throw new Error('A workspace id is required.') }

export function brainFactsParams(organizationId: string): URLSearchParams {
  need(organizationId)
  return new URLSearchParams({
    select: 'id,fact_key,kind,value_text,source_label,source_ref,note,status,superseded_by,status_reason,status_changed_at,recorded_by,recorded_at',
    organization_id: `eq.${organizationId}`,
    order: 'recorded_at.desc',
    limit: '2000',
  })
}

export function assumptionHistoryParams(organizationId: string): URLSearchParams {
  need(organizationId)
  return new URLSearchParams({
    select: 'id,details,created_at,actor_user_id',
    organization_id: `eq.${organizationId}`,
    event_type: 'eq.assumption_changed',
    order: 'created_at.desc',
    limit: '50',
  })
}

export function recordFactBody(input: { organizationId: string; factId: string; key: string; value: string; kind: string; sourceLabel: string; sourceRef?: string; note?: string }): string {
  need(input.organizationId)
  return JSON.stringify({
    p_org_id: input.organizationId, p_fact_id: input.factId, p_key: input.key, p_value: input.value, p_kind: input.kind,
    p_source_label: input.sourceLabel, p_source_ref: input.sourceRef || null, p_note: input.note || null,
  })
}

export function retractFactBody(input: { organizationId: string; factId: string; reason: string }): string {
  need(input.organizationId)
  return JSON.stringify({ p_org_id: input.organizationId, p_fact_id: input.factId, p_reason: input.reason })
}

export function resolveConflictBody(input: { organizationId: string; key: string; keepFactId: string; reason: string }): string {
  need(input.organizationId)
  return JSON.stringify({ p_org_id: input.organizationId, p_key: input.key, p_keep_fact_id: input.keepFactId, p_reason: input.reason })
}
