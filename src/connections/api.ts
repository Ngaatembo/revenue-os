import { apiRequest, getFreshSession, type SupabaseSession } from '../lib/supabaseRest.ts'
import type { ConnectionRow } from './catalog.ts'
import type { ConversationThread } from './conversationInsights.ts'

export const loadConnectionStatus = (session: SupabaseSession, organizationId: string) =>
  apiRequest<ConnectionRow[]>(session, 'rpc/list_connection_status', { method: 'POST', body: JSON.stringify({ p_organization_id: organizationId }) })

export const loadConversationThreads = (session: SupabaseSession, organizationId: string) => {
  const params = new URLSearchParams({
    select: 'provider,thread_id,message_count,last_message_at,last_direction,last_inbound_at,last_outbound_at,counterpart_address,counterpart_name,subject,last_snippet,all_automated',
    organization_id: `eq.${organizationId}`, order: 'last_message_at.desc', limit: '500',
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
