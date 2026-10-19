import { money } from '../domain/money'
import type { CurrencyCode, InvoiceEvidence } from '../domain/types'
import { toRevenueOpportunities, type DbEvidenceRow, type DbOpportunityRow } from '../domain/persistedOpportunities'
import type { RevenueOpportunity } from '../domain/types'
import { interactionsParams, issueStateBody, opportunityEvidenceParams, paymentEvidenceParams, recordResponseBody, syncRpcBody, trackedOpportunitiesParams, type InvoiceResponseType, type IssueTransition, type RecordResponseInput } from './opportunityQueries'
import type { PaymentRecord } from '../domain/promises'
import type { BrainFact } from '../domain/businessBrain'
import { actionOwnersParams, assignActionOwnerBody, assignQuotationBody, createDepositBody, createQuotationBody, createTaskBody, depositsParams, orgOnlyBody, paymentReviewParams, quotationEventBody, quotationsParams, rescheduleEventsParams, resolveReviewBody, tasksParams, updateDepositBody, updateTaskBody, type DepositAction, type QuotationEventType, type ReviewAction, type TaskAction } from './recordQueries'
import type { Deposit, PaymentReviewItem, Quotation, Task, WorkspaceMember } from '../domain/records'
import { assumptionHistoryParams, brainFactsParams, evaluationRunsParams, recordFactBody, resolveConflictBody, retractFactBody } from './brainQueries'

export type SupabaseUser = { id: string; email?: string }
export type SupabaseSession = {
  access_token: string
  refresh_token: string
  expires_at: number
  user: SupabaseUser
}
export type RevenueOrganization = { id: string; name: string; userId: string }
export type LeadStatus = 'new' | 'follow_up' | 'contacted' | 'converted' | 'closed'
export type SalesLead = {
  id: string
  name: string
  business: string
  contact: string
  source: string
  value: string
  currency: string
  nextFollowUp: string
  notes: string
  status: LeadStatus
  createdAt: string
}

type DbLead = {
  id: string
  contact_name: string
  business_name: string
  contact_details: string | null
  source: string
  estimated_value_minor: number | null
  currency: string | null
  next_follow_up: string
  notes: string | null
  status: LeadStatus
  created_at: string
}

const SESSION_KEY = 'revenue-os.auth-session'
const supabaseUrl = ((import.meta.env.VITE_SUPABASE_URL as string | undefined) || 'https://zivgfvcmposnbwqsudas.supabase.co').replace(/\/$/, '')
// Publishable/anon keys are designed for browser use; database access is restricted by RLS.
const publishableKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || 'sb_publishable_twQnXi5Mwmy5_dWIcay0OQ_8-xjyP3h'

export function isSupabaseConfigured() {
  return Boolean(supabaseUrl && publishableKey)
}

function requireConfig() {
  if (!supabaseUrl || !publishableKey) {
    throw new Error('Revenue OS is not connected yet. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to the app environment, then rebuild.')
  }
}

function readError(payload: unknown, fallback: string) {
  if (payload && typeof payload === 'object') {
    const data = payload as Record<string, unknown>
    const message = data.msg ?? data.message ?? data.error_description ?? data.error
    if (typeof message === 'string' && message.trim()) return message
  }
  return fallback
}

async function authRequest(path: string, body?: unknown, token?: string) {
  requireConfig()
  const response = await fetch(`${supabaseUrl}/auth/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      apikey: publishableKey!,
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(readError(payload, 'Authentication request failed.'))
  return payload as Record<string, unknown>
}

function normalizeSession(payload: Record<string, unknown>): SupabaseSession {
  const user = payload.user as Record<string, unknown> | undefined
  const expiresIn = Number(payload.expires_in ?? 3600)
  if (typeof payload.access_token !== 'string' || typeof payload.refresh_token !== 'string' || !user || typeof user.id !== 'string') {
    throw new Error('Supabase did not return an active session. If email confirmation is enabled, verify your email and sign in.')
  }
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    user: { id: user.id, email: typeof user.email === 'string' ? user.email : undefined },
  }
}

export function readStoredSession(): SupabaseSession | null {
  // Prefer durable browser storage so the owner remains signed in after closing the tab.
  // Migrate sessions created by older builds, which used sessionStorage.
  let raw: string | null = null
  try { raw = localStorage.getItem(SESSION_KEY) } catch { /* Fall back below if storage is unavailable. */ }
  if (!raw) {
    try { raw = sessionStorage.getItem(SESSION_KEY) } catch { /* Storage may be disabled by the browser. */ }
  }
  if (!raw) return null

  try {
    const value = JSON.parse(raw) as SupabaseSession
    if (!value.access_token || !value.refresh_token || !value.user?.id) {
      clearStoredSession()
      return null
    }
    storeSession(value)
    return value
  } catch {
    clearStoredSession()
    return null
  }
}

function storeSession(session: SupabaseSession) {
  const serialized = JSON.stringify(session)
  try {
    localStorage.setItem(SESSION_KEY, serialized)
    try { sessionStorage.removeItem(SESSION_KEY) } catch { /* Durable copy is already saved. */ }
  } catch {
    // Keep the current tab working if durable storage is blocked; persistence across tabs
    // is unavailable in that browser mode, but sign-in itself should not fail.
    try { sessionStorage.setItem(SESSION_KEY, serialized) } catch { /* Browser storage is disabled. */ }
  }
}

export function clearStoredSession() {
  try { localStorage.removeItem(SESSION_KEY) } catch { /* Ignore unavailable storage. */ }
  try { sessionStorage.removeItem(SESSION_KEY) } catch { /* Ignore unavailable storage. */ }
}

export function signInWithGoogle() {
  requireConfig()
  const redirectTo = window.location.origin
  const authorizeUrl = new URL(`${supabaseUrl}/auth/v1/authorize`)
  authorizeUrl.searchParams.set('provider', 'google')
  authorizeUrl.searchParams.set('redirect_to', redirectTo)
  // Supabase publishable/anon keys are public browser credentials; RLS protects data access.
  authorizeUrl.searchParams.set('apikey', publishableKey)
  window.location.assign(authorizeUrl.toString())
}

/**
 * Completes Supabase's implicit OAuth callback after Google redirects back to the app.
 * The access token is exchanged for the canonical user record before the session is stored.
 */
export async function consumeOAuthCallback(): Promise<SupabaseSession | null> {
  const query = new URLSearchParams(window.location.search)
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const tokenHash = query.get('token_hash')
  const tokenType = query.get('type')
  const accessToken = hash.get('access_token')
  const refreshToken = hash.get('refresh_token')
  const expiresIn = Number(hash.get('expires_in') ?? 3600)
  const callbackError = query.get('error_description') ?? query.get('error') ??
    hash.get('error_description') ?? hash.get('error')

  if (!tokenHash && !accessToken && !callbackError) return null

  // Clear one-time credentials and provider errors before making any network request.
  window.history.replaceState(null, document.title, window.location.pathname)

  if (callbackError) {
    throw new Error(callbackError.replace(/\+/g, ' '))
  }

  if (tokenHash) {
    if (!tokenType || !['magiclink', 'email', 'signup', 'invite'].includes(tokenType)) {
      throw new Error('This email sign-in link is not valid. Request a new link and try again.')
    }
    const payload = await authRequest('verify', { token_hash: tokenHash, type: tokenType })
    const session = normalizeSession(payload)
    storeSession(session)
    return session
  }

  if (!accessToken || !refreshToken) {
    throw new Error('Google sign-in did not return a complete session. Please try again.')
  }

  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${accessToken}`,
    },
  })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok || !payload || typeof payload.id !== 'string') {
    throw new Error(readError(payload, 'Sign-in succeeded, but Revenue OS could not verify the session. Please request a new link and try again.'))
  }

  const session: SupabaseSession = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: Math.floor(Date.now() / 1000) + (Number.isFinite(expiresIn) ? expiresIn : 3600),
    user: { id: payload.id, email: typeof payload.email === 'string' ? payload.email : undefined },
  }
  storeSession(session)
  return session
}

export async function signIn(email: string, password: string) {
  const payload = await authRequest('token?grant_type=password', { email: email.trim(), password })
  const session = normalizeSession(payload)
  storeSession(session)
  return session
}

export async function signUp(email: string, password: string, fullName: string) {
  const payload = await authRequest('signup', {
    email: email.trim(),
    password,
    data: { full_name: fullName.trim() },
  })
  if (typeof payload.access_token === 'string' && typeof payload.refresh_token === 'string') {
    const session = normalizeSession(payload)
    storeSession(session)
    return { session, confirmationRequired: false }
  }
  return { session: null, confirmationRequired: true }
}

export async function getFreshSession(session: SupabaseSession): Promise<SupabaseSession> {
  if (session.expires_at > Math.floor(Date.now() / 1000) + 60) return session
  const payload = await authRequest('token?grant_type=refresh_token', { refresh_token: session.refresh_token })
  const refreshed = normalizeSession(payload)
  Object.assign(session, refreshed)
  storeSession(session)
  return session
}

async function apiRequest<T>(session: SupabaseSession, path: string, init: RequestInit = {}): Promise<T> {
  requireConfig()
  const current = await getFreshSession(session)
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: publishableKey!,
      Authorization: `Bearer ${current.access_token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(readError(payload, `Database request failed (${response.status}).`))
  return payload as T
}

export async function bootstrapOrganization(session: SupabaseSession, name: string): Promise<RevenueOrganization> {
  const result = await apiRequest<Array<{ organization_id: string; organization_name: string; user_id: string }>>(
    session,
    'rpc/bootstrap_revenue_os_organization',
    { method: 'POST', body: JSON.stringify({ org_name: name.trim() }) },
  )
  const row = Array.isArray(result) ? result[0] : undefined
  if (!row?.organization_id || !row.organization_name || !row.user_id) {
    throw new Error('Your account is signed in, but no workspace was returned. Please sign out and try again.')
  }
  return { id: row.organization_id, name: row.organization_name, userId: row.user_id }
}

function mapLead(row: DbLead): SalesLead {
  return {
    id: row.id,
    name: row.contact_name,
    business: row.business_name,
    contact: row.contact_details ?? '',
    source: row.source,
    value: row.estimated_value_minor === null ? '' : (Number(row.estimated_value_minor) / 100).toFixed(2),
    currency: row.currency ?? 'USD',
    nextFollowUp: row.next_follow_up,
    notes: row.notes ?? '',
    status: row.status,
    createdAt: row.created_at,
  }
}

export async function loadSalesLeads(session: SupabaseSession, organizationId: string): Promise<SalesLead[]> {
  const params = new URLSearchParams({
    select: 'id,contact_name,business_name,contact_details,source,estimated_value_minor,currency,next_follow_up,notes,status,created_at',
    organization_id: `eq.${organizationId}`,
    order: 'next_follow_up.asc,created_at.desc',
  })
  const rows = await apiRequest<DbLead[]>(session, `sales_leads?${params.toString()}`)
  return rows.map(mapLead)
}

export async function createSalesLead(session: SupabaseSession, organization: RevenueOrganization, lead: SalesLead): Promise<SalesLead> {
  const amount = lead.value.trim() ? Number(lead.value) : null
  if (amount !== null && (!Number.isFinite(amount) || amount < 0 || amount > 90000000000000)) {
    throw new Error('Enter a valid non-negative amount for the lead value.')
  }
  const row = {
    organization_id: organization.id,
    id: lead.id,
    contact_name: lead.name.trim(),
    business_name: lead.business.trim(),
    contact_details: lead.contact.trim() || null,
    source: lead.source,
    estimated_value_minor: amount === null ? null : Math.round(amount * 100),
    currency: amount === null ? null : lead.currency,
    next_follow_up: lead.nextFollowUp,
    notes: lead.notes.trim() || null,
    status: lead.status,
    created_by: organization.userId,
  }
  const result = await apiRequest<DbLead[]>(session, 'sales_leads', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  })
  if (!result[0]) throw new Error('The lead was not saved.')
  return mapLead(result[0])
}

export async function updateSalesLead(session: SupabaseSession, organizationId: string, leadId: string, patch: Partial<Pick<SalesLead, 'status' | 'nextFollowUp' | 'notes'>>): Promise<void> {
  const dbPatch: Record<string, string> = { updated_at: new Date().toISOString() }
  if (patch.status) dbPatch.status = patch.status
  if (patch.nextFollowUp) dbPatch.next_follow_up = patch.nextFollowUp
  if (patch.notes !== undefined) dbPatch.notes = patch.notes
  const params = new URLSearchParams({ organization_id: `eq.${organizationId}`, id: `eq.${leadId}` })
  await apiRequest<unknown>(session, `sales_leads?${params.toString()}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(dbPatch),
  })
}

export async function deleteSalesLead(session: SupabaseSession, organizationId: string, leadId: string): Promise<void> {
  const params = new URLSearchParams({ organization_id: `eq.${organizationId}`, id: `eq.${leadId}` })
  await apiRequest<unknown>(session, `sales_leads?${params.toString()}`, { method: 'DELETE' })
}

export type LeadActivityType = 'follow_up_sent' | 'no_response' | 'interested' | 'meeting_booked' | 'not_interested' | 'note'
export type LeadActivity = {
  id: string
  leadId: string
  type: LeadActivityType
  summary: string
  nextFollowUp: string | null
  createdAt: string
}

type DbLeadActivity = {
  id: string
  lead_id: string
  activity_type: LeadActivityType
  summary: string
  next_follow_up: string | null
  created_at: string
}

export async function loadLeadActivities(session: SupabaseSession, organizationId: string): Promise<LeadActivity[]> {
  const params = new URLSearchParams({
    select: 'id,lead_id,activity_type,summary,next_follow_up,created_at',
    organization_id: `eq.${organizationId}`,
    order: 'created_at.desc',
    limit: '500',
  })
  const rows = await apiRequest<DbLeadActivity[]>(session, `lead_activities?${params.toString()}`)
  return rows.map((row) => ({
    id: row.id,
    leadId: row.lead_id,
    type: row.activity_type,
    summary: row.summary,
    nextFollowUp: row.next_follow_up,
    createdAt: row.created_at,
  }))
}

export async function recordLeadActivity(
  session: SupabaseSession,
  organizationId: string,
  input: { leadId: string; type: LeadActivityType; summary: string; nextFollowUp: string | null },
): Promise<LeadActivity> {
  const result = await apiRequest<{
    id: string
    lead_id: string
    activity_type: LeadActivityType
    summary: string
    next_follow_up: string | null
    created_at: string
  }>(session, 'rpc/record_lead_activity', {
    method: 'POST',
    body: JSON.stringify({
      p_org_id: organizationId,
      p_lead_id: input.leadId,
      p_activity_id: 'activity-' + crypto.randomUUID(),
      p_activity_type: input.type,
      p_summary: input.summary.trim(),
      p_next_follow_up: input.nextFollowUp,
    }),
  })
  return {
    id: result.id,
    leadId: result.lead_id,
    type: result.activity_type,
    summary: result.summary,
    nextFollowUp: result.next_follow_up,
    createdAt: result.created_at,
  }
}

export async function signOut(session: SupabaseSession) {
  try {
    await authRequest('logout', {}, session.access_token)
  } finally {
    clearStoredSession()
  }
}


type DbInvoice = {
  id: string
  source_id: string
  external_record_id: string
  customer_id: string
  customer_name: string
  invoice_number: string
  currency: string
  total_minor: number | string
  paid_minor: number | string
  issued_at: string
  due_at: string
  imported_at: string
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function persistInvoiceImport(
  session: SupabaseSession,
  organization: RevenueOrganization,
  input: {
    sourceId: string
    sourceName: string
    contentHash: string
    invoices: InvoiceEvidence[]
    rejectedRows: number
  },
): Promise<{ duplicate: boolean; importId: string; acceptedRows: number; rejectedRows: number }> {
  const rows = input.invoices.map((invoice) => ({
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    customerId: invoice.customerId,
    customerName: invoice.customerName,
    currency: invoice.currency,
    totalMinor: invoice.total.amount,
    paidMinor: invoice.paid.amount,
    issuedAt: invoice.issuedAt,
    dueAt: invoice.dueAt,
    importedAt: invoice.source.importedAt,
  }))
  const result = await apiRequest<{ duplicate: boolean; import_id: string; accepted_rows: number; rejected_rows: number }>(
    session,
    'rpc/persist_invoice_import',
    {
      method: 'POST',
      body: JSON.stringify({
        org_id: organization.id,
        source_id: input.sourceId,
        source_name: input.sourceName,
        content_hash: input.contentHash,
        rows,
        rejected_rows: input.rejectedRows,
      }),
    },
  )
  return {
    duplicate: result.duplicate,
    importId: result.import_id,
    acceptedRows: result.accepted_rows,
    rejectedRows: result.rejected_rows,
  }
}

export async function loadInvoices(session: SupabaseSession, organizationId: string): Promise<InvoiceEvidence[]> {
  const params = new URLSearchParams({
    select: 'id,source_id,external_record_id,customer_id,customer_name,invoice_number,currency,total_minor,paid_minor,issued_at,due_at,imported_at',
    organization_id: `eq.${organizationId}`,
    order: 'imported_at.desc',
  })
  const rows: DbInvoice[] = []
  for (let start = 0; start < 50000; start += 1000) {
    const page = await apiRequest<DbInvoice[]>(session, `invoices?${params.toString()}`, {
      headers: { Range: `${start}-${start + 999}`, 'Range-Unit': 'items' },
    })
    rows.push(...page)
    if (page.length < 1000) break
  }
  return rows.map((row) => ({
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    invoiceNumber: row.invoice_number,
    currency: row.currency as CurrencyCode,
    total: money(Number(row.total_minor), row.currency),
    paid: money(Number(row.paid_minor), row.currency),
    issuedAt: row.issued_at,
    dueAt: row.due_at,
    source: {
      sourceId: row.source_id,
      recordId: row.external_record_id,
      importedAt: row.imported_at,
    },
  }))
}

export async function loadRecoveryRate(session: SupabaseSession, organizationId: string): Promise<number | null> {
  const params = new URLSearchParams({
    select: 'value_bps',
    organization_id: `eq.${organizationId}`,
    id: 'eq.recovery-rate',
    limit: '1',
  })
  const rows = await apiRequest<Array<{ value_bps: number }>>(session, `assumptions?${params.toString()}`)
  return rows[0] ? Number(rows[0].value_bps) : null
}

export async function saveRecoveryRate(session: SupabaseSession, organization: RevenueOrganization, valueBps: number): Promise<void> {
  if (!Number.isInteger(valueBps) || valueBps < 0 || valueBps > 10000) {
    throw new Error('Recovery rate must be between 0 and 100 percent.')
  }
  await apiRequest<unknown>(session, 'assumptions?on_conflict=organization_id,id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      organization_id: organization.id,
      id: 'recovery-rate',
      assumption_key: 'recovery_rate',
      value_bps: valueBps,
      updated_by: organization.userId,
      updated_at: new Date().toISOString(),
    }),
  })
}


export type RecoveryActionStatus = 'proposed' | 'approved' | 'executed' | 'failed' | 'cancelled'
export type RecoveryAction = {
  id: string
  opportunityId: string
  status: RecoveryActionStatus
  message: string
  recipientCustomerId: string
  proposedAt: string
  approvedAt: string | null
  approvedBy: string | null
  executedAt: string | null
  executedBy: string | null
  invoiceId: string
}

type DbRecoveryAction = {
  id: string
  opportunity_id: string
  status: RecoveryActionStatus
  message: string
  recipient_customer_id: string
  proposed_at: string
  approved_at: string | null
  approved_by: string | null
  executed_at: string | null
  executed_by: string | null
}
type DbActionTarget = { action_id: string; invoice_id: string }

function mapRecoveryAction(row: DbRecoveryAction, invoiceId: string): RecoveryAction {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    status: row.status,
    message: row.message,
    recipientCustomerId: row.recipient_customer_id,
    proposedAt: row.proposed_at,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    executedAt: row.executed_at,
    executedBy: row.executed_by,
    invoiceId,
  }
}

export async function loadRecoveryActions(session: SupabaseSession, organizationId: string): Promise<RecoveryAction[]> {
  const params = new URLSearchParams({
    select: 'id,opportunity_id,status,message,recipient_customer_id,proposed_at,approved_at,approved_by,executed_at,executed_by',
    organization_id: `eq.${organizationId}`,
    order: 'proposed_at.desc',
    limit: '200',
  })
  const targetsParams = new URLSearchParams({
    select: 'action_id,invoice_id',
    organization_id: `eq.${organizationId}`,
  })
  const [actions, targets] = await Promise.all([
    apiRequest<DbRecoveryAction[]>(session, `actions?${params.toString()}`),
    apiRequest<DbActionTarget[]>(session, `action_invoice_targets?${targetsParams.toString()}`),
  ])
  const invoiceByAction = new Map(targets.map((target) => [target.action_id, target.invoice_id]))
  return actions.map((action) => mapRecoveryAction(action, invoiceByAction.get(action.id) ?? ''))
}

export async function proposeInvoiceReminder(
  session: SupabaseSession,
  organizationId: string,
  invoiceId: string,
  message: string,
): Promise<RecoveryAction> {
  const row = await apiRequest<{
    id: string; opportunity_id: string; status: RecoveryActionStatus; message: string;
    recipient_customer_id: string; proposed_at: string; approved_at: string | null;
    approved_by: string | null; executed_at: string | null; executed_by: string | null;
    invoice_id: string; duplicate?: boolean
  }>(session, 'rpc/propose_invoice_reminder', {
    method: 'POST',
    body: JSON.stringify({ p_org_id: organizationId, p_invoice_id: invoiceId, p_message: message }),
  })
  return mapRecoveryAction({
    id: row.id, opportunity_id: row.opportunity_id, status: row.status, message: row.message,
    recipient_customer_id: row.recipient_customer_id, proposed_at: row.proposed_at,
    approved_at: row.approved_at, approved_by: row.approved_by, executed_at: row.executed_at,
    executed_by: row.executed_by,
  }, row.invoice_id)
}

export async function transitionRecoveryAction(
  session: SupabaseSession,
  organizationId: string,
  actionId: string,
  transition: 'approve' | 'mark_sent' | 'cancel',
): Promise<RecoveryAction> {
  const row = await apiRequest<{
    id: string; opportunity_id: string; status: RecoveryActionStatus; message: string;
    recipient_customer_id: string; proposed_at: string; approved_at: string | null;
    approved_by: string | null; executed_at: string | null; executed_by: string | null
  }>(session, 'rpc/transition_revenue_action', {
    method: 'POST',
    body: JSON.stringify({ p_org_id: organizationId, p_action_id: actionId, p_transition: transition }),
  })
  const current = (await loadRecoveryActions(session, organizationId)).find((action) => action.id === actionId)
  return mapRecoveryAction({
    id: row.id, opportunity_id: row.opportunity_id, status: row.status, message: row.message,
    recipient_customer_id: row.recipient_customer_id, proposed_at: row.proposed_at,
    approved_at: row.approved_at, approved_by: row.approved_by, executed_at: row.executed_at,
    executed_by: row.executed_by,
  }, current?.invoiceId ?? '')
}


export type VerifiedOutcome = {
  id: string
  actionId: string
  opportunityId: string
  amountMinor: number
  currency: string
  measurementStartsAt: string
  measurementEndsAt: string
  recordedAt: string
  causalClaim: string
}
export type PaymentImportRow = { invoiceNumber: string; externalRecordId: string; currency: string; amountMinor: number; receivedAt: string }

export async function persistPaymentImport(
  session: SupabaseSession,
  organization: RevenueOrganization,
  input: { sourceId: string; sourceName: string; contentHash: string; payments: PaymentImportRow[]; rejectedRows: number },
): Promise<{ duplicate: boolean; importId: string; acceptedRows: number; reviewRows: number; rejectedRows: number }> {
  const result = await apiRequest<{ duplicate: boolean; import_id: string; accepted_rows: number; review_rows?: number; rejected_rows: number }>(
    session,
    'rpc/persist_payment_import',
    {
      method: 'POST',
      body: JSON.stringify({
        p_org_id: organization.id,
        p_source_id: input.sourceId,
        p_source_name: input.sourceName,
        p_content_hash: input.contentHash,
        p_rows: input.payments,
        p_rejected_rows: input.rejectedRows,
      }),
    },
  )
  return { duplicate: result.duplicate, importId: result.import_id, acceptedRows: result.accepted_rows, reviewRows: result.review_rows ?? 0, rejectedRows: result.rejected_rows }
}

export async function verifyRecoveryOutcome(
  session: SupabaseSession,
  organizationId: string,
  actionId: string,
  windowDays = 30,
): Promise<{ verified: boolean; reason?: string; outcomeId?: string; amountMinor?: number; currency?: string; paymentCount?: number }> {
  const result = await apiRequest<{
    verified: boolean; reason?: string; outcome_id?: string; amount_minor?: number;
    currency?: string; payment_count?: number
  }>(session, 'rpc/verify_recovery_outcome', {
    method: 'POST',
    body: JSON.stringify({ p_org_id: organizationId, p_action_id: actionId, p_window_days: windowDays }),
  })
  return {
    verified: result.verified,
    reason: result.reason,
    outcomeId: result.outcome_id,
    amountMinor: result.amount_minor,
    currency: result.currency,
    paymentCount: result.payment_count,
  }
}

export async function loadVerifiedOutcomes(session: SupabaseSession, organizationId: string): Promise<VerifiedOutcome[]> {
  const params = new URLSearchParams({
    select: 'id,action_id,opportunity_id,amount_minor,currency,measurement_starts_at,measurement_ends_at,recorded_at,causal_claim',
    organization_id: `eq.${organizationId}`,
    state: 'eq.verified',
    order: 'recorded_at.desc',
    limit: '200',
  })
  const rows = await apiRequest<Array<{
    id: string; action_id: string; opportunity_id: string; amount_minor: number | string; currency: string;
    measurement_starts_at: string; measurement_ends_at: string; recorded_at: string; causal_claim: string
  }>>(session, `outcomes?${params.toString()}`)
  return rows.map((row) => ({
    id: row.id, actionId: row.action_id, opportunityId: row.opportunity_id,
    amountMinor: Number(row.amount_minor), currency: row.currency,
    measurementStartsAt: row.measurement_starts_at, measurementEndsAt: row.measurement_ends_at,
    recordedAt: row.recorded_at, causalClaim: row.causal_claim,
  }))
}


export type OpportunitySyncResult = { created: number; refreshed: number; closed: number; open: number; recoveryRateBps: number }

/** Runs the server-side overdue detection for this workspace (idempotent). Runs as the signed-in user. */
export async function syncOverdueOpportunities(session: SupabaseSession, organizationId: string): Promise<OpportunitySyncResult> {
  const result = await apiRequest<{ created: number; refreshed: number; closed: number; open: number; recovery_rate_bps: number }>(
    session,
    'rpc/sync_overdue_opportunities',
    { method: 'POST', body: syncRpcBody(organizationId) },
  )
  return { created: result.created, refreshed: result.refreshed, closed: result.closed, open: result.open, recoveryRateBps: result.recovery_rate_bps }
}

/** Saved open and dismissed opportunities joined to their saved source invoices. Nothing is computed or invented here. */
export async function loadOpenOpportunities(
  session: SupabaseSession,
  organizationId: string,
  invoices: InvoiceEvidence[],
): Promise<{ opportunities: RevenueOpportunity[]; dismissed: RevenueOpportunity[]; unresolvedIds: string[] }> {
  const [rows, evidence] = await Promise.all([
    apiRequest<DbOpportunityRow[]>(session, `opportunities?${trackedOpportunitiesParams(organizationId).toString()}`),
    apiRequest<DbEvidenceRow[]>(session, `opportunity_evidence?${opportunityEvidenceParams(organizationId).toString()}`),
  ])
  return toRevenueOpportunities(rows, evidence, invoices)
}

export type InvoiceInteraction = {
  id: string
  opportunityId: string
  invoiceId: string
  actionId: string | null
  type: InvoiceResponseType
  summary: string
  promisedAmountMinor: number | null
  promisedDate: string | null
  nextFollowUp: string | null
  createdAt: string
}

type DbInteraction = {
  id: string; opportunity_id: string; invoice_id: string; action_id: string | null; interaction_type: InvoiceResponseType
  summary: string; promised_amount_minor: number | string | null; promised_date: string | null; next_follow_up: string | null; created_at: string
}

export async function loadInvoiceInteractions(session: SupabaseSession, organizationId: string): Promise<InvoiceInteraction[]> {
  const rows = await apiRequest<DbInteraction[]>(session, `invoice_interactions?${interactionsParams(organizationId).toString()}`)
  return rows.map((row) => ({
    id: row.id, opportunityId: row.opportunity_id, invoiceId: row.invoice_id, actionId: row.action_id, type: row.interaction_type,
    summary: row.summary, promisedAmountMinor: row.promised_amount_minor === null ? null : Number(row.promised_amount_minor),
    promisedDate: row.promised_date, nextFollowUp: row.next_follow_up, createdAt: row.created_at,
  }))
}

/** Records what the customer said. Updates the issue state atomically in the database; never changes money. */
export async function recordInvoiceResponse(
  session: SupabaseSession,
  input: Omit<RecordResponseInput, 'interactionId'> & { interactionId?: string },
): Promise<{ id: string; duplicate: boolean; workflowState?: string }> {
  const interactionId = input.interactionId ?? 'interaction-' + crypto.randomUUID()
  const result = await apiRequest<{ id: string; duplicate: boolean; workflow_state?: string }>(session, 'rpc/record_invoice_response', {
    method: 'POST',
    body: recordResponseBody({ ...input, interactionId }),
  })
  return { id: result.id, duplicate: result.duplicate, workflowState: result.workflow_state }
}

export async function setOpportunityState(
  session: SupabaseSession,
  input: { organizationId: string; opportunityId: string; transition: IssueTransition; reason?: string; snoozeUntil?: string },
): Promise<void> {
  await apiRequest<unknown>(session, 'rpc/set_opportunity_state', { method: 'POST', body: issueStateBody(input) })
}

type DbPaymentEvidence = { id: string; invoice_id: string; amount_minor: number | string; currency: string; received_at: string }

/** Saved payment evidence only (imported payment records). Promises and estimates are never in this list. */
export async function loadPaymentEvidence(session: SupabaseSession, organizationId: string): Promise<PaymentRecord[]> {
  const rows = await apiRequest<DbPaymentEvidence[]>(session, `payment_evidence?${paymentEvidenceParams(organizationId).toString()}`)
  return rows.map((row) => ({ invoiceId: row.invoice_id, amount: money(Number(row.amount_minor), row.currency), receivedAt: row.received_at }))
}

type DbBrainFact = {
  id: string; fact_key: string; kind: BrainFact['kind']; value_text: string; source_label: string; source_ref: string | null; note: string | null
  status: BrainFact['status']; superseded_by: string | null; status_reason: string | null; status_changed_at: string | null; recorded_by: string; recorded_at: string
}

export async function loadBrainFacts(session: SupabaseSession, organizationId: string): Promise<BrainFact[]> {
  const rows = await apiRequest<DbBrainFact[]>(session, `brain_facts?${brainFactsParams(organizationId).toString()}`)
  return rows.map((row) => ({
    id: row.id, key: row.fact_key, kind: row.kind, value: row.value_text, sourceLabel: row.source_label, sourceRef: row.source_ref, note: row.note,
    status: row.status, supersededBy: row.superseded_by, statusReason: row.status_reason, statusChangedAt: row.status_changed_at,
    recordedBy: row.recorded_by, recordedAt: row.recorded_at,
  }))
}

export type AssumptionChange = { id: string; oldBps: number | null; newBps: number; at: string }

export async function loadAssumptionHistory(session: SupabaseSession, organizationId: string): Promise<AssumptionChange[]> {
  const rows = await apiRequest<{ id: string; details: { old_bps: number | null; new_bps: number }; created_at: string }[]>(session, `audit_log?${assumptionHistoryParams(organizationId).toString()}`)
  return rows.map((row) => ({ id: row.id, oldBps: row.details.old_bps ?? null, newBps: row.details.new_bps, at: row.created_at }))
}

export async function recordBrainFact(
  session: SupabaseSession,
  input: { organizationId: string; key: string; value: string; kind: BrainFact['kind']; sourceLabel: string; sourceRef?: string; note?: string; factId?: string },
): Promise<{ id: string; duplicate: boolean; conflict: boolean }> {
  const factId = input.factId ?? 'fact-' + crypto.randomUUID()
  const result = await apiRequest<{ id: string; duplicate: boolean; conflict?: boolean }>(session, 'rpc/record_brain_fact', {
    method: 'POST', body: recordFactBody({ ...input, factId }),
  })
  return { id: result.id, duplicate: result.duplicate, conflict: Boolean(result.conflict) }
}

export async function retractBrainFact(session: SupabaseSession, input: { organizationId: string; factId: string; reason: string }): Promise<void> {
  await apiRequest<unknown>(session, 'rpc/retract_brain_fact', { method: 'POST', body: retractFactBody(input) })
}

export async function resolveBrainConflict(session: SupabaseSession, input: { organizationId: string; key: string; keepFactId: string; reason: string }): Promise<void> {
  await apiRequest<unknown>(session, 'rpc/resolve_brain_conflict', { method: 'POST', body: resolveConflictBody(input) })
}

export type EvaluationRun = { id: string; trigger: 'schedule' | 'manual'; status: 'ok' | 'skipped' | 'failed'; startedAt: string; created: number; closed: number; open: number; message: string | null }

/** Most recent automatic checks, newest first. Empty until the scheduled-evaluation migration is applied and has run. */
export async function loadEvaluationRuns(session: SupabaseSession, organizationId: string): Promise<EvaluationRun[]> {
  const params = evaluationRunsParams(organizationId)
  const rows = await apiRequest<{ id: string; trigger_kind: EvaluationRun['trigger']; status: EvaluationRun['status']; started_at: string; created_count: number; closed_count: number; open_count: number; message: string | null }[]>(session, `evaluation_runs?${params.toString()}`)
  return rows.map((row) => ({ id: row.id, trigger: row.trigger_kind, status: row.status, startedAt: row.started_at, created: row.created_count, closed: row.closed_count, open: row.open_count, message: row.message }))
}


// ---- Business records: quotations, deposits, tasks, payment review, owners ----
const rpc = <T,>(session: SupabaseSession, name: string, body: string) => apiRequest<T>(session, `rpc/${name}`, { method: 'POST', body })
export const newRecordId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

export async function loadQuotations(session: SupabaseSession, organizationId: string): Promise<Quotation[]> {
  const rows = await apiRequest<{ id: string; reference: string; customer_name: string; currency: string; amount_minor: number; status: Quotation['status']; sent_on: string; valid_until: string | null; follow_up_date: string | null; last_contact_on: string | null; owner_id: string | null; notes: string | null }[]>(session, `quotations?${quotationsParams(organizationId)}`)
  return rows.map((r) => ({ id: r.id, reference: r.reference, customerName: r.customer_name, currency: r.currency, amountMinor: Number(r.amount_minor), status: r.status, sentOn: r.sent_on, validUntil: r.valid_until, followUpDate: r.follow_up_date, lastContactOn: r.last_contact_on, ownerId: r.owner_id, notes: r.notes }))
}
export async function loadDeposits(session: SupabaseSession, organizationId: string): Promise<Deposit[]> {
  const rows = await apiRequest<{ id: string; quotation_id: string | null; customer_name: string; currency: string; amount_minor: number; status: Deposit['status']; promised_date: string; owner_confirmed_minor: number | null; owner_confirmed_on: string | null }[]>(session, `deposits?${depositsParams(organizationId)}`)
  return rows.map((r) => ({ id: r.id, quotationId: r.quotation_id, customerName: r.customer_name, currency: r.currency, amountMinor: Number(r.amount_minor), status: r.status, promisedDate: r.promised_date, ownerConfirmedMinor: r.owner_confirmed_minor === null ? null : Number(r.owner_confirmed_minor), ownerConfirmedOn: r.owner_confirmed_on }))
}
export async function loadTasks(session: SupabaseSession, organizationId: string): Promise<Task[]> {
  const rows = await apiRequest<{ id: string; title: string; detail: string | null; due_date: string; status: Task['status']; owner_id: string | null; related_type: Task['relatedType']; related_id: string | null }[]>(session, `tasks?${tasksParams(organizationId)}`)
  return rows.map((r) => ({ id: r.id, title: r.title, detail: r.detail, dueDate: r.due_date, status: r.status, ownerId: r.owner_id, relatedType: r.related_type, relatedId: r.related_id }))
}
export async function loadPaymentReviewItems(session: SupabaseSession, organizationId: string): Promise<PaymentReviewItem[]> {
  const rows = await apiRequest<{ id: string; external_record_id: string; invoice_number_raw: string; currency: string; amount_minor: number; received_at: string; reason: PaymentReviewItem['reason']; candidate_invoice_ids: string[]; status: PaymentReviewItem['status']; created_at: string }[]>(session, `payment_review_items?${paymentReviewParams(organizationId)}`)
  return rows.map((r) => ({ id: r.id, externalRecordId: r.external_record_id, invoiceNumber: r.invoice_number_raw, currency: r.currency, amountMinor: Number(r.amount_minor), receivedAt: r.received_at, reason: r.reason, candidateInvoiceIds: r.candidate_invoice_ids ?? [], status: r.status, createdAt: r.created_at }))
}
/** How many times each record's date was pushed back, keyed `quotation:<id>`, `deposit:<id>`, `task:<id>`. */
export async function loadRescheduleCounts(session: SupabaseSession, organizationId: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  const sources = [['quotation_events', 'quotation', 'quotation_id'], ['deposit_events', 'deposit', 'deposit_id'], ['task_events', 'task', 'task_id']] as const
  const results = await Promise.all(sources.map(([table]) => apiRequest<Record<string, string>[]>(session, `${table}?${rescheduleEventsParams(organizationId, table)}`)))
  results.forEach((rows, index) => { const [, kind, column] = sources[index]; for (const row of rows) { const key = `${kind}:${row[column]}`; counts.set(key, (counts.get(key) ?? 0) + 1) } })
  return counts
}
export async function loadActionOwners(session: SupabaseSession, organizationId: string): Promise<Map<string, string | null>> {
  const rows = await apiRequest<{ action_id: string; owner_id: string | null }[]>(session, `action_owners?${actionOwnersParams(organizationId)}`)
  return new Map(rows.map((r) => [r.action_id, r.owner_id]))
}
export async function loadWorkspaceMembers(session: SupabaseSession, organizationId: string): Promise<WorkspaceMember[]> {
  const rows = await rpc<{ user_id: string; email: string; role: string }[]>(session, 'list_workspace_members', orgOnlyBody(organizationId))
  return rows.map((r) => ({ userId: r.user_id, email: r.email, role: r.role }))
}

export const createQuotation = (session: SupabaseSession, input: Parameters<typeof createQuotationBody>[0]) => rpc<{ duplicate?: boolean }>(session, 'create_quotation', createQuotationBody(input))
export const recordQuotationEvent = (session: SupabaseSession, input: { organizationId: string; quotationId: string; type: QuotationEventType; summary: string; nextFollowUp?: string; eventId?: string }) =>
  rpc<{ duplicate?: boolean }>(session, 'record_quotation_event', quotationEventBody({ ...input, eventId: input.eventId ?? newRecordId('qe') }))
export const assignQuotation = (session: SupabaseSession, input: { organizationId: string; quotationId: string; ownerId: string | null }) => rpc<unknown>(session, 'assign_quotation', assignQuotationBody({ ...input, eventId: newRecordId('qe') }))
export const createDeposit = (session: SupabaseSession, input: Parameters<typeof createDepositBody>[0]) => rpc<{ duplicate?: boolean }>(session, 'create_deposit', createDepositBody(input))
export const updateDeposit = (session: SupabaseSession, input: { organizationId: string; depositId: string; action: DepositAction; note: string; promisedDate?: string; receivedMinor?: number; receivedOn?: string; eventId?: string }) =>
  rpc<unknown>(session, 'update_deposit', updateDepositBody({ ...input, eventId: input.eventId ?? newRecordId('de') }))
export const createTask = (session: SupabaseSession, input: Parameters<typeof createTaskBody>[0]) => rpc<{ duplicate?: boolean }>(session, 'create_task', createTaskBody(input))
export const updateTask = (session: SupabaseSession, input: { organizationId: string; taskId: string; action: TaskAction; note?: string; dueDate?: string; ownerId?: string | null; eventId?: string }) =>
  rpc<unknown>(session, 'update_task', updateTaskBody({ ...input, eventId: input.eventId ?? newRecordId('te') }))
export const assignActionOwner = (session: SupabaseSession, input: { organizationId: string; actionId: string; ownerId: string | null }) => rpc<unknown>(session, 'assign_action_owner', assignActionOwnerBody(input))
export const resolvePaymentReview = (session: SupabaseSession, input: { organizationId: string; itemId: string; action: ReviewAction; targetId?: string; note?: string }) => rpc<unknown>(session, 'resolve_payment_review', resolveReviewBody(input))
export const rematchPaymentReview = (session: SupabaseSession, organizationId: string) => rpc<{ matched: number }>(session, 'rematch_payment_review', orgOnlyBody(organizationId))
