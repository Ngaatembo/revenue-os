/**
 * Follow-up tracking rules: which conversations the owner has set aside, and when they come back.
 * Pure functions so the resurfacing rules are testable. A set-aside conversation always returns when the customer writes again,
 * because a new message is exactly the thing the owner must not miss.
 */
import type { ConversationThread } from './conversationInsights.ts'

export type TrackingStatus = 'open' | 'handled' | 'snoozed'
export interface TrackingRow {
  provider: string
  thread_id: string
  status: TrackingStatus
  handled_at: string | null
  remind_at: string | null
  note: string | null
  updated_at: string
}
export interface MutedSender { address: string }

export type SetAsideReason = 'handled' | 'snoozed'
export interface SetAside { thread: ConversationThread; tracking: TrackingRow; reason: SetAsideReason }

export interface TrackingResult {
  /** Threads that still need the owner's attention. */
  visible: ConversationThread[]
  /** Threads the owner handled or snoozed and that have not yet come back. */
  setAside: SetAside[]
  /** Threads hidden because the sender was muted. */
  mutedThreads: ConversationThread[]
  /** Owner notes by thread id, for threads in any state. */
  notes: Map<string, string>
}

const time = (value: string | null) => (value ? new Date(value).getTime() : NaN)

/** Why a thread is set aside right now, or null when it should be shown. */
export function setAsideReason(thread: ConversationThread, tracking: TrackingRow | undefined, now: number): SetAsideReason | null {
  if (!tracking) return null
  const lastInbound = time(thread.last_inbound_at)
  if (tracking.status === 'handled') {
    const handledAt = time(tracking.handled_at)
    // The customer wrote after it was marked handled: it is a new conversation turn, so it comes back.
    if (Number.isFinite(lastInbound) && Number.isFinite(handledAt) && lastInbound > handledAt) return null
    return 'handled'
  }
  if (tracking.status === 'snoozed') {
    const remindAt = time(tracking.remind_at)
    const snoozedAt = time(tracking.updated_at)
    if (Number.isFinite(remindAt) && now >= remindAt) return null
    if (Number.isFinite(lastInbound) && Number.isFinite(snoozedAt) && lastInbound > snoozedAt) return null
    return 'snoozed'
  }
  return null
}

export function applyTracking(threads: ConversationThread[], rows: TrackingRow[], muted: MutedSender[], now = Date.now()): TrackingResult {
  const byThread = new Map(rows.map((row) => [`${row.provider}\n${row.thread_id}`, row]))
  const mutedSet = new Set(muted.map((m) => m.address.toLowerCase()))
  const visible: ConversationThread[] = []
  const setAside: SetAside[] = []
  const mutedThreads: ConversationThread[] = []
  const notes = new Map<string, string>()
  for (const thread of threads) {
    const tracking = byThread.get(`${thread.provider}\n${thread.thread_id}`)
    if (tracking?.note) notes.set(thread.thread_id, tracking.note)
    if (thread.counterpart_address && mutedSet.has(thread.counterpart_address.toLowerCase())) { mutedThreads.push(thread); continue }
    const reason = setAsideReason(thread, tracking, now)
    if (reason && tracking) setAside.push({ thread, tracking, reason })
    else visible.push(thread)
  }
  return { visible, setAside, mutedThreads, notes }
}

/** True when the owner has ever written to this address, so muting it deserves a second look. */
export function ownerHasWrittenTo(address: string | null, threads: ConversationThread[]): boolean {
  if (!address) return false
  const target = address.toLowerCase()
  return threads.some((t) => t.counterpart_address?.toLowerCase() === target && t.last_outbound_at !== null)
}

export type ReminderChoice = 'tomorrow' | 'three_days' | 'next_week'
export const REMINDER_CHOICES: Array<{ id: ReminderChoice; label: string }> = [
  { id: 'tomorrow', label: 'Tomorrow' }, { id: 'three_days', label: 'In 3 days' }, { id: 'next_week', label: 'Next week' },
]
/** Reminders fire at 08:00 UTC on the chosen day, so the owner sees it at the start of their working day. */
export function reminderTime(choice: ReminderChoice, now = Date.now()): string {
  const days = choice === 'tomorrow' ? 1 : choice === 'three_days' ? 3 : 7
  const d = new Date(now + days * 86_400_000)
  d.setUTCHours(8, 0, 0, 0)
  if (d.getTime() <= now) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString()
}
