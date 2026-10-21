import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SupabaseSession } from '../lib/supabaseRest.ts'
import { loadConversationThreads, loadConversationTracking, loadMutedSenders, muteSender, setConversationTracking, unmuteSender } from './api.ts'
import { describeConnection, type ConnectionRow } from './catalog.ts'
import { deriveConversationInsights, type ConversationInsight, type ConversationThread } from './conversationInsights.ts'
import { applyTracking, reminderTime, type MutedSender, type ReminderChoice, type SetAside, type TrackingRow } from './tracking.ts'

export interface ConversationActions {
  markHandled: (threadId: string) => Promise<void>
  remind: (threadId: string, choice: ReminderChoice) => Promise<void>
  saveNote: (threadId: string, note: string) => Promise<void>
  reopen: (threadId: string) => Promise<void>
  mute: (address: string) => Promise<void>
  unmute: (address: string) => Promise<void>
}
export interface ConversationData {
  /** Every stored thread (null until the first load), before any owner tracking is applied. */
  threads: ConversationThread[] | null
  /** Insights for threads that still need the owner. */
  insights: ConversationInsight[]
  error: string
  /** Conversations the owner handled or snoozed, and senders they muted. */
  setAside: SetAside[]
  mutedSenders: string[]
  notes: Map<string, string>
  /** False until the tracking tables exist (the app works without them; the buttons stay hidden). */
  trackingAvailable: boolean
  busyThread: string | null
  actionError: string
  actions: ConversationActions
}

const noopActions: ConversationActions = { markHandled: async () => {}, remind: async () => {}, saveNote: async () => {}, reopen: async () => {}, mute: async () => {}, unmute: async () => {} }

/** Loads persisted conversation threads and the owner's follow-up tracking, and derives labelled insights. Reloads when a sync lands. */
export function useConversations(session: SupabaseSession, organizationId: string, gmail: ConnectionRow | undefined): ConversationData {
  const [state, setState] = useState<{ threads: ConversationThread[] | null; tracking: TrackingRow[]; muted: MutedSender[]; trackingAvailable: boolean; error: string }>({ threads: null, tracking: [], muted: [], trackingAvailable: false, error: '' })
  const [tick, setTick] = useState(0)
  const [busyThread, setBusyThread] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const account = gmail?.provider_account_email ?? null
  const connected = describeConnection(gmail).state !== 'not_connected'
  const marker = `${gmail?.records_synced ?? 0}:${gmail?.last_successful_sync_at ?? ''}`
  useEffect(() => {
    if (!connected) return
    let cancelled = false
    const trackingLoads = Promise.all([loadConversationTracking(session, organizationId), loadMutedSenders(session, organizationId)])
      .then(([tracking, muted]) => ({ tracking, muted, available: true }))
      .catch(() => ({ tracking: [] as TrackingRow[], muted: [] as MutedSender[], available: false })) // tables not created yet: the app still works
    Promise.all([loadConversationThreads(session, organizationId, account), trackingLoads])
      .then(([threads, tracked]) => { if (!cancelled) setState({ threads, tracking: tracked.tracking, muted: tracked.muted, trackingAvailable: tracked.available, error: '' }) })
      .catch((cause) => { if (!cancelled) setState((previous) => ({ ...previous, error: cause instanceof Error ? cause.message : 'Could not load conversations.' })) })
    return () => { cancelled = true }
  }, [session, organizationId, account, connected, marker, tick])

  const run = useCallback(async (key: string, work: () => Promise<unknown>) => {
    setBusyThread(key); setActionError('')
    try { await work(); setTick((n) => n + 1) }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : 'That did not save. Try again.') }
    finally { setBusyThread(null) }
  }, [])
  const actions = useMemo<ConversationActions>(() => ({
    markHandled: (id) => run(id, () => setConversationTracking(session, organizationId, id, 'handled')),
    remind: (id, choice) => run(id, () => setConversationTracking(session, organizationId, id, 'snooze', { remindAt: reminderTime(choice) })),
    saveNote: (id, note) => run(id, () => setConversationTracking(session, organizationId, id, 'note', { note })),
    reopen: (id) => run(id, () => setConversationTracking(session, organizationId, id, 'reopen')),
    mute: (address) => run(address, () => muteSender(session, organizationId, address)),
    unmute: (address) => run(address, () => unmuteSender(session, organizationId, address)),
  }), [run, session, organizationId])

  const threads = connected ? state.threads : null
  const applied = useMemo(() => (threads ? applyTracking(threads, state.tracking, state.muted) : null), [threads, state.tracking, state.muted])
  const insights = useMemo(() => (applied ? deriveConversationInsights(applied.visible) : []), [applied])
  return {
    threads, insights, error: connected ? state.error : '',
    setAside: applied?.setAside ?? [], mutedSenders: state.muted.map((m) => m.address), notes: applied?.notes ?? new Map(),
    trackingAvailable: state.trackingAvailable, busyThread, actionError, actions: connected ? actions : noopActions,
  }
}
