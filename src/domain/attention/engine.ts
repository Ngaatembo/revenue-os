import { addMoney, formatMoney } from '../money.ts'
import { INVOICE_RULES, invoiceSnoozedUntil } from './invoiceRules.ts'
import { LEAD_RULES } from './leadRules.ts'
import type { AttentionContext, AttentionFinding, AttentionItem, AttentionRule, ScorePart } from './types.ts'
import type { Money } from '../types.ts'

export const ALL_RULES: AttentionRule[] = [...INVOICE_RULES, ...LEAD_RULES]

export const WEIGHTS = { impact: 0.3, urgency: 0.3, evidence: 0.15, likelihood: 0.15, ease: 0.1 } as const

const subjectKey = (finding: AttentionFinding) => `${finding.subject.type}:${finding.subject.id}`
const moneyOf = (item: { knownMoney: Money | null; speculativeMoney: Money | null }): Money | null => item.knownMoney ?? item.speculativeMoney

/**
 * Runs every rule, merges findings about the same subject into ONE item (no duplicate alerts),
 * scores each item and sorts. A rule that throws is skipped and reported, never allowed to hide the others.
 */
export function evaluateAttention(context: AttentionContext, rules: AttentionRule[] = ALL_RULES): { items: AttentionItem[]; failedRules: string[] } {
  const findings: AttentionFinding[] = []
  const failedRules: string[] = []
  for (const rule of rules) {
    try { findings.push(...rule.run(context)) } catch { failedRules.push(rule.id) }
  }
  const grouped = new Map<string, AttentionFinding[]>()
  for (const finding of findings) grouped.set(subjectKey(finding), [...(grouped.get(subjectKey(finding)) ?? []), finding])

  const drafts = [...grouped].map(([id, list]) => {
    const sorted = [...list].sort((a, b) => b.severity - a.severity || b.urgency - a.urgency || a.ruleId.localeCompare(b.ruleId))
    const headline = sorted[0]
    // Money belongs to the subject, not to each finding, so it is taken once and never summed across findings.
    const knownMoney = sorted.find((finding) => finding.knownMoney)?.knownMoney ?? null
    const speculativeMoney = knownMoney ? null : sorted.find((finding) => finding.speculativeMoney)?.speculativeMoney ?? null
    const opportunity = headline.subject.type === 'invoice' ? context.opportunities.find((candidate) => candidate.id === headline.subject.id) : undefined
    const snoozedUntil = opportunity ? invoiceSnoozedUntil(opportunity, context.asOf) : null
    return { id, subject: headline.subject, headline, findings: sorted, knownMoney, speculativeMoney, snoozedUntil, snoozed: snoozedUntil !== null }
  })

  const largest = new Map<string, number>()
  for (const draft of drafts) {
    const m = moneyOf(draft)
    if (m) largest.set(m.currency, Math.max(largest.get(m.currency) ?? 0, m.amount))
  }

  const items: AttentionItem[] = drafts.map((draft) => {
    const m = moneyOf(draft)
    const scale = m ? m.amount / (largest.get(m.currency) || 1) : 0
    const impactRaw = m ? (draft.knownMoney ? scale : scale * 0.5) : 0.1
    const evidenceRaw = draft.findings.some((finding) => finding.strength === 'confirmed') ? 1 : 0.6
    const h = draft.headline
    const ranking: ScorePart[] = [
      { name: 'Impact', value: impactRaw, weight: WEIGHTS.impact, note: m ? `${formatMoney(m)} ${draft.knownMoney ? 'owed per your records' : 'possible pipeline value (counted at half weight; not owed)'}, relative to the largest ${m.currency} item.` : 'No amount is recorded for this item.' },
      { name: 'Urgency', value: h.urgency, weight: WEIGHTS.urgency, note: h.what },
      { name: 'Evidence', value: evidenceRaw, weight: WEIGHTS.evidence, note: evidenceRaw === 1 ? 'Read directly from your records.' : 'A reasonable reading of your records, not proven by them.' },
      { name: 'Likelihood', value: h.likelihood, weight: WEIGHTS.likelihood, note: 'How likely acting now is to change the outcome (a judgement, not a measured rate).' },
      { name: 'Ease', value: 1 - h.effort, weight: WEIGHTS.ease, note: 'Quick steps rank slightly higher than heavy ones.' },
    ]
    const priority = Math.round(ranking.reduce((sum, part) => sum + part.value * part.weight, 0) * 1000) / 10
    return { ...draft, priority, ranking }
  })

  items.sort((a, b) => b.priority - a.priority || b.headline.severity - a.headline.severity || a.id.localeCompare(b.id))
  return { items, failedRules }
}

export type AttentionSummary = {
  /** Unpaid money your records say is owed, per currency, for items needing attention. Snoozed items are included: snoozing never hides money. */
  knownExposure: Money[]
  /** Possible value from leads, per currency. Kept apart; never added to known exposure and never revenue. */
  pipeline: Money[]
  needingAttention: number
  snoozed: number
}

export function summarizeAttention(items: AttentionItem[]): AttentionSummary {
  const sum = (pick: (item: AttentionItem) => Money | null): Money[] => {
    const totals = new Map<string, Money>()
    for (const item of items) {
      const m = pick(item)
      if (m) totals.set(m.currency, totals.has(m.currency) ? addMoney(totals.get(m.currency)!, m) : m)
    }
    return [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency))
  }
  return { knownExposure: sum((item) => item.knownMoney), pipeline: sum((item) => item.speculativeMoney), needingAttention: items.filter((item) => !item.snoozed).length, snoozed: items.filter((item) => item.snoozed).length }
}

export function explainRanking(item: AttentionItem): string {
  return `Priority ${item.priority} of 100. ` + item.ranking.map((part) => `${part.name} ${Math.round(part.value * 100)}% × ${Math.round(part.weight * 100)}%`).join(', ') + '.'
}
