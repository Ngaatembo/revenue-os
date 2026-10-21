import { useEffect, useState } from 'react'
import type { SupabaseSession } from '../lib/supabaseRest.ts'
import { loadConversationThreads } from './api.ts'
import { describeConnection, type ConnectionRow } from './catalog.ts'
import { deriveConversationInsights, type ConversationInsight, type ConversationThread } from './conversationInsights.ts'

export interface ConversationData { threads: ConversationThread[] | null; insights: ConversationInsight[]; error: string }

/** Loads persisted conversation threads for the connected mailbox and derives labelled insights. Reloads when a sync lands. */
export function useConversations(session: SupabaseSession, organizationId: string, gmail: ConnectionRow | undefined): ConversationData {
  const [state, setState] = useState<{ threads: ConversationThread[] | null; error: string }>({ threads: null, error: '' })
  const account = gmail?.provider_account_email ?? null
  const connected = describeConnection(gmail).state !== 'not_connected'
  const marker = `${gmail?.records_synced ?? 0}:${gmail?.last_successful_sync_at ?? ''}`
  useEffect(() => {
    if (!connected) return
    let cancelled = false
    loadConversationThreads(session, organizationId, account)
      .then((threads) => { if (!cancelled) setState({ threads, error: '' }) })
      .catch((cause) => { if (!cancelled) setState((previous) => ({ ...previous, error: cause instanceof Error ? cause.message : 'Could not load conversations.' })) })
    return () => { cancelled = true }
  }, [session, organizationId, account, connected, marker])
  const threads = connected ? state.threads : null
  return { threads, insights: threads ? deriveConversationInsights(threads) : [], error: connected ? state.error : '' }
}
