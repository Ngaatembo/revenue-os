import type { ResolvedSetting, BrainSettingKey } from '../businessBrain.ts'
import type { ActionProgress } from '../prioritization.ts'
import type { Money, RevenueOpportunity } from '../types.ts'
import type { BusinessSignal } from '../businessSignals.ts'
import type { Deposit, PaymentReviewItem, Quotation, Task } from '../records.ts'

export type SubjectType = 'invoice' | 'lead' | 'quotation' | 'deposit' | 'task' | 'payment_review' | 'action'
export type Subject = { type: SubjectType; id: string; label: string }

/**
 * One thing a rule noticed. Every finding must say what, the evidence, why it matters and the next step,
 * so the owner is never shown an unexplained alert.
 */
export type AttentionFinding = {
  ruleId: string
  subject: Subject
  what: string
  evidence: string[]
  why: string
  nextStep: string
  /** confirmed = read straight from records; inferred = a reasonable reading that records do not prove. */
  strength: 'confirmed' | 'inferred'
  /** 0..1: how soon this goes wrong if ignored. */
  urgency: number
  /** 0..1: how likely it is that acting changes the outcome. */
  likelihood: number
  /** 0..1: how much work the next step is (1 = a lot). */
  effort: number
  /** Money the records say is owed. Never a guess. */
  knownMoney?: Money
  /** Possible value (for example a lead's estimated worth). A pipeline figure, never revenue. */
  speculativeMoney?: Money
  /** 1..5. Breaks ties and picks the headline finding when one subject has several. */
  severity: number
}

export type LeadForAttention = {
  id: string
  name: string
  business: string
  status: 'new' | 'follow_up' | 'contacted' | 'converted' | 'closed'
  nextFollowUp: string
  value: string
  currency: string
  createdAt: string
}

export type RecordsContext = {
  quotations: Quotation[]
  deposits: Deposit[]
  tasks: Task[]
  paymentReviews: PaymentReviewItem[]
  /** Recovery actions still waiting on a person (draft or approved), with their owner if any. */
  openActions: { id: string; label: string; status: 'proposed' | 'approved'; ownerId: string | null }[]
  /** How many times each record's date was pushed back, keyed `quotation:<id>`, `deposit:<id>` or `task:<id>`. */
  rescheduleCounts: ReadonlyMap<string, number>
}

export type AttentionContext = {
  records?: RecordsContext
  asOf: string
  /** Open overdue-invoice issues, already carrying their workflow state. */
  opportunities: RevenueOpportunity[]
  progressByInvoiceId: ReadonlyMap<string, ActionProgress>
  /** When a reminder was marked as sent, per invoice id. */
  reminderSentAt: ReadonlyMap<string, string>
  /** Count of "no reply" responses recorded per opportunity id. */
  noReplyCounts: ReadonlyMap<string, number>
  leads: LeadForAttention[]
  leadActivities: { leadId: string; createdAt: string }[]
  settings: Record<BrainSettingKey, ResolvedSetting>
  /** Normalized signals derived from the same authorized records; enrich existing findings rather than creating duplicate queue items. */
  businessSignals?: BusinessSignal[]
}

export type AttentionRule = { id: string; description: string; run: (context: AttentionContext) => AttentionFinding[] }

export type ScorePart = { name: string; value: number; weight: number; note: string }
export type AttentionItem = {
  /** Stable per subject, so the same problem never produces two alerts. */
  id: string
  subject: Subject
  headline: AttentionFinding
  findings: AttentionFinding[]
  knownMoney: Money | null
  speculativeMoney: Money | null
  snoozedUntil: string | null
  snoozed: boolean
  priority: number
  ranking: ScorePart[]
}
