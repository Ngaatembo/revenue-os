/**
 * Turns observed conversation facts into labelled insights.
 * Observed: what the mailbox shows (who wrote last, when). Inferred: that a reply is probably still owed.
 * An inference can be wrong (the reply may have been a phone call), so it is always worded as "no reply recorded".
 */
export interface ConversationThread {
  provider: string
  thread_id: string
  message_count: number
  last_message_at: string
  last_direction: 'inbound' | 'outbound'
  last_inbound_at: string | null
  last_outbound_at: string | null
  counterpart_address: string | null
  counterpart_name: string | null
  subject: string | null
  last_snippet: string | null
  all_automated: boolean
}

export type InsightKind = 'awaiting_reply' | 'gone_quiet'
export interface ConversationInsight {
  kind: InsightKind
  thread: ConversationThread
  daysSince: number
  /** Observed facts the insight rests on. */
  observed: string
  /** What Revenue OS infers from them. */
  inference: string
  recommendation: string
}

const DAY = 86_400_000
export const AWAITING_REPLY_AFTER_DAYS = 2
export const GONE_QUIET_AFTER_DAYS = 5
export const MAX_AGE_DAYS = 45

export function whoLabel(t: ConversationThread) { return t.counterpart_name || t.counterpart_address || 'A customer' }

export function deriveConversationInsights(threads: ConversationThread[], now = Date.now()): ConversationInsight[] {
  const out: ConversationInsight[] = []
  for (const t of threads) {
    if (t.all_automated) continue
    const last = new Date(t.last_message_at).getTime()
    if (!Number.isFinite(last)) continue
    const days = Math.floor((now - last) / DAY)
    if (days > MAX_AGE_DAYS || days < 0) continue
    if (t.last_direction === 'inbound' && days >= AWAITING_REPLY_AFTER_DAYS) {
      out.push({
        kind: 'awaiting_reply', thread: t, daysSince: days,
        observed: `${whoLabel(t)} wrote ${days} day${days === 1 ? '' : 's'} ago${t.last_outbound_at ? ' after your last reply' : ''}. No later message from you is in this mailbox.`,
        inference: 'They are probably still waiting for an answer. If you replied by phone or WhatsApp, Revenue OS cannot see that.',
        recommendation: 'Reply, or mark it handled if you already did.',
      })
    } else if (t.last_direction === 'outbound' && t.last_inbound_at && days >= GONE_QUIET_AFTER_DAYS) {
      out.push({
        kind: 'gone_quiet', thread: t, daysSince: days,
        observed: `You last wrote to ${whoLabel(t)} ${days} days ago; they have not replied since.`,
        inference: 'The conversation may have stalled. It might also be finished.',
        recommendation: 'Send a short follow-up if this was a sales conversation.',
      })
    }
  }
  // Customers who wrote and are waiting come first; within a kind, the most recent first (still fresh enough to win).
  return out.sort((a, b) => (a.kind === b.kind ? a.daysSince - b.daysSince : a.kind === 'awaiting_reply' ? -1 : 1))
}

export const gmailThreadLink = (account: string | null, threadId: string) =>
  `https://mail.google.com/mail/${account ? `?authuser=${encodeURIComponent(account)}` : ''}#all/${encodeURIComponent(threadId)}`
