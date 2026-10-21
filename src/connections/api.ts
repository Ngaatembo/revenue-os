import { apiRequest, getFreshSession, type SupabaseSession } from '../lib/supabaseRest.ts'
import type { ConnectionRow } from './catalog.ts'
import type { ConversationThread } from './conversationInsights.ts'
import type { MutedSender, TrackingRow } from './tracking.ts'

export const loadConnectionStatus = (session: SupabaseSession, organizationId: string) =>
  apiRequest<ConnectionRow[]>(session, 'rpc/list_connection_status', { method: 'POST', body: JSON.stringify({ p_organization_id: organizationId }) })

export const loadConversationThreads = (session: SupabaseSession, organizationId: string, account: string | null) => {
  const params = new URLSearchParams({
    select: 'provider,thread_id,source_account,message_count,last_message_at,last_direction,last_inbound_at,last_outbound_at,counterpart_address,counterpart_name,subject,last_snippet,all_automated',
    organization_id: `eq.${organizationId}`, provider: 'eq.gmail', ...(account ? { source_account: `eq.${account.toLowerCase()}` } : {}), order: 'last_message_at.desc', limit: '500',
  })
  return apiRequest<ConversationThread[]>(session, `conversation_threads?${params}`)
}

export const loadCommunicationTotals = async (session: SupabaseSession, organizationId: string) => {
  const params = new URLSearchParams({ select: 'occurred_at', organization_id: `eq.${organizationId}`, order: 'occurred_at.asc', limit: '1' })
  const oldest = await apiRequest<Array<{ occurred_at: string }>>(session, `communications?${params}`)
  return { oldest: oldest[0]?.occurred_at ?? null }
}

async function workerPost(session: SupabaseSession, path: string, body: Record<string, unknown>) {
  const fresh = await getFreshSession(session)
  const response = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${fresh.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new Error(typeof payload.message === 'string' ? payload.message : response.status === 403 ? 'Your role in this workspace cannot do that. Ask an owner or admin.' : response.status === 503 ? 'Connections are not configured on this server yet.' : 'The request failed. Try again shortly.')
  return payload
}
export const syncNow = (session: SupabaseSession, organizationId: string, provider: string) => workerPost(session, '/api/connections/sync', { organization_id: organizationId, provider })
export const disconnectProvider = (session: SupabaseSession, organizationId: string, provider: string) => workerPost(session, '/api/connections/disconnect', { organization_id: organizationId, provider })

export async function startAuthorization(session: SupabaseSession, organizationId: string, provider: 'gmail' | 'google_sheets'): Promise<string> {
  const fresh = await getFreshSession(session)
  const response = await fetch(`/api/integrations/google/start?organization_id=${encodeURIComponent(organizationId)}&provider=${provider}`, { headers: { Authorization: `Bearer ${fresh.access_token}` } })
  const payload = await response.json().catch(() => ({})) as { authorization_url?: string; message?: string; error?: string }
  if (!response.ok || !payload.authorization_url) {
    throw new Error(payload.message || (response.status === 503 ? 'Google connections are not configured on this server yet, so nothing was connected.' : response.status === 403 ? 'Your role in this workspace cannot connect sources. Ask an owner or admin.' : 'Could not start Google authorization.'))
  }
  return payload.authorization_url
}

export type ReadinessReport = {
  checks: Record<string, boolean>
  google_redirect_uri_to_register: string
  sync_interval_minutes: number
  message_budget_per_run: number
  background_sync: { status: 'no_connection_to_observe' | 'waiting_for_first_sync' | 'running' | 'not_observed_recently'; newest_successful_sync_minutes_ago: number | null; connections_observed: number }
}
export async function loadReadiness(session: SupabaseSession, organizationId: string): Promise<ReadinessReport> {
  const fresh = await getFreshSession(session)
  const response = await fetch(`/api/connections/readiness?organization_id=${encodeURIComponent(organizationId)}`, { headers: { Authorization: `Bearer ${fresh.access_token}` } })
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new Error(response.status === 403 ? 'Only owners and admins can run the setup check.' : response.status === 503 ? 'The server is missing required settings, so the check cannot run: Google connections are not configured.' : 'The setup check failed.')
  return payload as unknown as ReadinessReport
}

export const loadConversationTracking = (session: SupabaseSession, organizationId: string) => {
  const params = new URLSearchParams({ select: 'provider,thread_id,status,handled_at,remind_at,note,updated_at', organization_id: `eq.${organizationId}`, limit: '2000' })
  return apiRequest<TrackingRow[]>(session, `conversation_tracking?${params}`)
}
export const loadMutedSenders = (session: SupabaseSession, organizationId: string) => {
  const params = new URLSearchParams({ select: 'address', organization_id: `eq.${organizationId}`, order: 'address.asc', limit: '1000' })
  return apiRequest<MutedSender[]>(session, `muted_senders?${params}`)
}
export type TrackingAction = 'handled' | 'snooze' | 'reopen' | 'note'
export const setConversationTracking = (session: SupabaseSession, organizationId: string, threadId: string, action: TrackingAction, options: { remindAt?: string; note?: string } = {}) =>
  apiRequest<unknown>(session, 'rpc/set_conversation_tracking', { method: 'POST', body: JSON.stringify({ p_org_id: organizationId, p_provider: 'gmail', p_thread_id: threadId, p_action: action, p_remind_at: options.remindAt ?? null, p_note: options.note ?? null }) })
export const muteSender = (session: SupabaseSession, organizationId: string, address: string) =>
  apiRequest<unknown>(session, 'rpc/mute_sender', { method: 'POST', body: JSON.stringify({ p_org_id: organizationId, p_address: address }) })
export const unmuteSender = (session: SupabaseSession, organizationId: string, address: string) =>
  apiRequest<unknown>(session, 'rpc/unmute_sender', { method: 'POST', body: JSON.stringify({ p_org_id: organizationId, p_address: address }) })
