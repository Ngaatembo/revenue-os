/** Pure request builders for quotations, deposits, tasks and the payment review queue (no network, unit tested). */

const need = (organizationId: string) => { if (!organizationId.trim()) throw new Error('A workspace id is required.') }
const base = (organizationId: string, select: string, order: string, limit = '1000') => { need(organizationId); return new URLSearchParams({ select, organization_id: `eq.${organizationId}`, order, limit }) }

export const quotationsParams = (org: string) => base(org, 'id,reference,customer_name,currency,amount_minor,status,sent_on,valid_until,follow_up_date,last_contact_on,owner_id,notes', 'sent_on.desc')
export const depositsParams = (org: string) => base(org, 'id,quotation_id,customer_name,currency,amount_minor,status,promised_date,owner_confirmed_minor,owner_confirmed_on', 'promised_date.asc')
export const tasksParams = (org: string) => base(org, 'id,title,detail,due_date,status,owner_id,related_type,related_id', 'due_date.asc')
export const paymentReviewParams = (org: string) => base(org, 'id,external_record_id,invoice_number_raw,currency,amount_minor,received_at,reason,candidate_invoice_ids,status,created_at', 'created_at.desc')
export function rescheduleEventsParams(organization: string, table: 'quotation_events' | 'deposit_events' | 'task_events'): URLSearchParams {
  const idColumn = table === 'quotation_events' ? 'quotation_id' : table === 'deposit_events' ? 'deposit_id' : 'task_id'
  const params = base(organization, idColumn, 'created_at.desc', '5000')
  params.set('event_type', 'eq.rescheduled')
  return params
}
export function actionOwnersParams(org: string) { return base(org, 'action_id,owner_id', 'assigned_at.desc') }

export const createQuotationBody = (i: { organizationId: string; id: string; reference: string; customerName: string; currency: string; amountMinor: number; sentOn: string; validUntil?: string; followUpDate: string; ownerId?: string; notes?: string }) => {
  need(i.organizationId)
  return JSON.stringify({ p_org_id: i.organizationId, p_id: i.id, p_reference: i.reference, p_customer_name: i.customerName, p_currency: i.currency, p_amount_minor: i.amountMinor, p_sent_on: i.sentOn, p_valid_until: i.validUntil || null, p_follow_up_date: i.followUpDate, p_owner_id: i.ownerId || null, p_notes: i.notes || null })
}
export type QuotationEventType = 'follow_up_sent' | 'customer_replied' | 'rescheduled' | 'accepted' | 'declined' | 'withdrawn' | 'reopened' | 'note'
export const quotationEventBody = (i: { organizationId: string; eventId: string; quotationId: string; type: QuotationEventType; summary: string; nextFollowUp?: string }) => {
  need(i.organizationId)
  return JSON.stringify({ p_org_id: i.organizationId, p_event_id: i.eventId, p_quotation_id: i.quotationId, p_type: i.type, p_summary: i.summary, p_next_follow_up: i.nextFollowUp || null })
}
export const assignQuotationBody = (i: { organizationId: string; eventId: string; quotationId: string; ownerId: string | null }) => { need(i.organizationId); return JSON.stringify({ p_org_id: i.organizationId, p_event_id: i.eventId, p_quotation_id: i.quotationId, p_owner_id: i.ownerId }) }

export const createDepositBody = (i: { organizationId: string; id: string; quotationId?: string; customerName?: string; currency?: string; amountMinor: number; promisedDate: string; note?: string }) => {
  need(i.organizationId)
  return JSON.stringify({ p_org_id: i.organizationId, p_id: i.id, p_quotation_id: i.quotationId || null, p_customer_name: i.customerName || null, p_currency: i.currency || null, p_amount_minor: i.amountMinor, p_promised_date: i.promisedDate, p_note: i.note || null })
}
export type DepositAction = 'reschedule' | 'cancel' | 'reopen' | 'confirm_received' | 'note'
export const updateDepositBody = (i: { organizationId: string; eventId: string; depositId: string; action: DepositAction; note: string; promisedDate?: string; receivedMinor?: number; receivedOn?: string }) => {
  need(i.organizationId)
  return JSON.stringify({ p_org_id: i.organizationId, p_event_id: i.eventId, p_deposit_id: i.depositId, p_action: i.action, p_note: i.note, p_promised_date: i.promisedDate || null, p_received_minor: i.receivedMinor ?? null, p_received_on: i.receivedOn || null })
}

export const createTaskBody = (i: { organizationId: string; id: string; title: string; detail?: string; dueDate: string; ownerId?: string; relatedType?: string; relatedId?: string }) => {
  need(i.organizationId)
  return JSON.stringify({ p_org_id: i.organizationId, p_id: i.id, p_title: i.title, p_detail: i.detail || null, p_due_date: i.dueDate, p_owner_id: i.ownerId || null, p_related_type: i.relatedType || null, p_related_id: i.relatedId || null })
}
export type TaskAction = 'assign' | 'reschedule' | 'complete' | 'cancel' | 'reopen' | 'note'
export const updateTaskBody = (i: { organizationId: string; eventId: string; taskId: string; action: TaskAction; note?: string; dueDate?: string; ownerId?: string | null }) => {
  need(i.organizationId)
  return JSON.stringify({ p_org_id: i.organizationId, p_event_id: i.eventId, p_task_id: i.taskId, p_action: i.action, p_note: i.note || null, p_due_date: i.dueDate || null, p_owner_id: i.ownerId ?? null })
}
export const assignActionOwnerBody = (i: { organizationId: string; actionId: string; ownerId: string | null }) => { need(i.organizationId); return JSON.stringify({ p_org_id: i.organizationId, p_action_id: i.actionId, p_owner_id: i.ownerId }) }

export type ReviewAction = 'to_invoice' | 'to_deposit' | 'dismiss'
export const resolveReviewBody = (i: { organizationId: string; itemId: string; action: ReviewAction; targetId?: string; note?: string }) => {
  need(i.organizationId)
  if (i.action !== 'dismiss' && !i.targetId) throw new Error('Choose the invoice or deposit this payment belongs to.')
  if (i.action === 'dismiss' && !(i.note ?? '').trim()) throw new Error('Say why this payment is being dismissed.')
  return JSON.stringify({ p_org_id: i.organizationId, p_item_id: i.itemId, p_action: i.action, p_target_id: i.targetId || null, p_note: i.note || null })
}
export const orgOnlyBody = (organizationId: string) => { need(organizationId); return JSON.stringify({ p_org_id: organizationId }) }
